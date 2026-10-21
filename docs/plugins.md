# Writing an annai plugin

This guide covers the plugin interface as it is built today: plugin API version 1, through milestone 8 (extensions). The full design is in the spec, [§5 Plugin system](superpowers/specs/2026-10-15-annai-design.md#5-plugin-system). The interface grows with later milestones, and this guide grows with it.

A code plugin is trusted fully. It runs on annai's own page, with the same powers as annai's built-in parts, and the install screen tells the user so (spec §5.1).

## The package

A package is one of two kinds:

- **A skill**, in the open [Agent Skills](https://agentskills.io/specification) format: a folder with `SKILL.md`, and optional `references/`, `assets/` and `scripts/` (annai never runs scripts). No `annai-plugin.json` is needed. See "Skills" below.
- **A plugin**: a folder or a zip with `annai-plugin.json` at its top, either directly or inside one top folder. It may have code (an `entry` module), and it may bring skills, personalities and a model provider's description without any code. A plugin without code is **data only**: it can't run anything, and its install screen has no full-access warning.

A plugin's manifest:

```json
{
  "id": "hello",
  "name": "Hello checks",
  "version": "1.0.0",
  "api": 1,
  "entry": "index.js",
  "description": "/hello/*.json files in a trip need a greeting."
}
```

- **Required fields:**
  - `id`: lowercase letters, digits, `.`, `_` and `-`, 2 to 64 characters, starting with a letter or digit.
  - `name`: up to 80 characters.
  - `version`: semantic, like `1.0.0`.
  - `api`: must be `1`. A plugin made for another API version is turned off cleanly.
- **Optional fields:**
  - `description` (up to 500 characters), `author`, `homepage`.
  - `entry`: an ES module inside the package, ending in `.js` or `.mjs`.
  - `skills`: skill folders in the package, each holding a `SKILL.md` (`"."` is the package's top).
  - `personalities`: Markdown files, each a personality named by its file (`ranger.md` is "ranger"). Settings → Shiori offers them; Add makes a copy the user owns.
  - `provider`: a model provider's description, inline. See "Model providers" below.
  - `requires`: the plugins yours needs, `[{ "id": "chat-completions", "version": "^0" }, { "id": "acme-proto", "version": "^2", "homepage": "https://…" }]`, at most 10. A range is `^N`, the same major; for a protocol plugin the major is its interface version. annai's own come with yours from its catalog; a third party's must be installed first, and the install stops naming it, with its `homepage` (https). A package can't require itself.
  - `category`: `providers`, `speech`, `backup`, `tools`, `skills` or `developer`, the kind it is listed under on the Add screen and in Settings → Plugins (Model providers, Voices and transcription, Backup places, Tools and MCP, Skills and personalities, Developer). When absent it is worked out: a provider with chat is `providers`, one with speech only `speech`, a backup place's plugin `backup`, a protocol `developer`, skills or personalities without code `skills`, other code `tools`.
  - `keywords`: up to 20 other names it is searched by, 1 to 40 characters each, written as they are shown (`["Unsloth", "LM Studio"]`). They aren't hidden: a row found by a keyword says so, "Also for: LM Studio". A name match ranks above a keyword match, so a plugin made for LM Studio comes before one that lists it as a keyword. Give the names of things your plugin also serves (a server built on the one you describe, a product's other spelling), not words for what it does: its description and its abilities are searched too.
  - `featured`: a sentence of up to 200 characters for the one-tap start on Models and the welcome. It counts only in annai's own catalog: a third party's is ignored.
  - `catchAll`: `true` for a provider of any address (annai's Another address), listed after the others when the Add screen is browsed.
  - `replaces`: up to 20 names your plugin registers and means to replace, such as `["weather", "avatar"]`: a tool, a component, a skill, a personality, a card type or a search provider, by its bare name. The install screen asks the user (see "Names and conflicts").
  - `templates` (endpoint templates, before providers) is refused: "Endpoint templates were replaced by `provider`".
  - `files`: every other file of the package, such as modules your entry imports. annai needs it only to install the package from an address (see "Installing"). A module you leave out isn't there once installed from an address, and the plugin won't start; the error is the browser's own, and it names your entry file, not the missing module (Chrome: "Failed to fetch dynamically imported module: …/index.js"; Safari names no file at all: "Importing a module script failed.").
  - `settings`: a JSON Schema object; annai draws a form from it on your plugin's page in Settings → Plugins. See "Settings" below.
- **Size:** a package may unpack to at most 64 MiB.

annai copies the package into its own storage, so the plugin works offline, and serves its files at `/plugins/<id>/…`. Relative imports between a plugin's own modules therefore just work. A package's files keep no history: installing it again replaces them.

A package's id is one name space with every other package: a skill is installed under its own name. The id of one of annai's own plugins (any in its catalog) can't be taken by a package from a file or an address: "annai's own plugin uses this name". Names inside a package (a tool, a skill, a component) can be shared: see "Names and conflicts".

## The entry module

The entry exports `activate(annai)`. It may return a cleanup function, which annai calls when the plugin is turned off or uninstalled.

```js
export function activate(annai) {
  return annai.schemas.register({ scope: 'trip', pattern: '/hello/*.json', schema: { type: 'object', required: ['greeting'] } });
}
```

- `activate` must finish within 10 seconds.
- A plugin that fails to start on 3 launches in a row is turned off, with a card saying why.
- An error from `activate` or from a tool's `run` is recorded as a `plugin.error` event and never stops annai. A plugin that fails several times in a row is switched off until the user turns it back on (spec §5.5).

## What `annai` gives you

| | |
|---|---|
| `annai.id` | your plugin's id |
| `annai.register(kind, item)` | adds something to the registry; returns a function that removes it. A kind with a call of its own isn't added this way, so its checks always run: tools, protocols, backup places, schemas, hooks, the UI's (`ui:…`), and a model provider's description and setup, which annai makes from your manifest and `annai.providers.setup`. |
| `annai.schemas.register({ scope, pattern, schema })` | a JSON Schema that files at matching paths must pass. An invalid write is refused, and the refusal says why. |
| `annai.tools.register(tool)` | a tool: a name (letters, digits, `_` and `-`, up to 64), a description, an input JSON Schema and `run(input, call)` (spec §5.4). `call` has `trip` (the open trip's scope, or null), `signal` (stop when it aborts), `model` (the model that called it) and `fetch` (traced). Errors become results Shiori sees. Every tool can be switched off in Settings → Tools. |
| `annai.events.append(scope, type, data, keep?)` | appends an entry to a scope's log, signed `plugin:<id>`. `keep = { texts: [[name, text]], blobs: [{ bytes, type }] }` stores content and names it in the entry's refs; long texts are kept that way, short ones go in `data`. Returns the entry. |
| `annai.files` | the files of every scope: `read`, `readText`, `readJSON`, `list`, `write`, `patch`, `delete`, `history`, `restore` |
| `annai.providers.register(type)` | an endpoint type (spec §9.1): `build()` and `read()` for an HTTP protocol, or `run()` for one that needs no network; see "Protocols (endpoint types)" below |
| `annai.providers.setup(setup)` | a provider plugin's own setup and quirks, once: see "Model providers with code" below |
| `annai.storage.register(type)` | a kind of place to back up to (spec §12.4); see "Backup places" below |
| `annai.helpers` | `sse` (server-sent events from a response body), `parsePartialJSON`, `ProviderError`, `errorFromResponse`, `retry`, `tsv(header, rows)` (TSV for the model, spec §4.7), `mergePatch`, `TargetError`, `readAnswer`, `xml` and `backupFiles` (see "Backup places"), `zip` (`ZipReader`, `ZipWriter`: annai's own zip), `addressProblem(url)` (why annai wouldn't send a key to an address, or null: it must be https, or http only for `localhost` or `127.0.0.1`), `base64` (`encode(bytes)`, `decode(text)`), `g711` (`pcmToUlaw`, `ulawToPcm`, `pcmToAlaw`, `alawToPcm`: 16-bit PCM in an `Int16Array` to and from G.711's bytes), `wav` (`encode(pcm, rate)`: 16-bit mono PCM as a WAV file; `decode(bytes)`: a 16-bit WAV file's first channel, `{ pcm, rate }`) |
| `annai.secrets.get(name)`, `.set(name, value)` | your plugin's own secrets, such as an API key; `get` gives null for one that isn't set. Never put them in files or log entries. |
| `annai.secrets.blank(value)` | a copy of a value (a string, or objects and lists of them, however deep) with every secret annai keeps, any plugin's or provider's, and anything shaped like a credential (a Bearer or Basic value, a signed address's signature) blanked as `«key»` in every string; a string that could still show one is replaced by a note. It is what annai's own cards and errors show. Use it on anything you send or show beyond annai. It reads every secret annai keeps at each call, so call it once for a batch, not once per string. It **rejects** when they can't be read (the database closed under it, as an iPhone's can), rather than give back text it couldn't check: send nothing then, and try again later. |
| `annai.llm(role, request)` | a model call through a role (`main`, `utility`, `decide`), with fallback; returns the reply. It is in the trace, tagged `plugin:<id>`. |
| `annai.llm.decide({ prompt, options, threshold? })` | a quick decision (spec §9.7): `{ optionId: probability }` |
| `annai.wake(reason)` | wakes Shiori, with the reason she sees. Quiet hours and the per-hour limit apply (spec §6.6). |
| `annai.net.fetch(url, init?)` | a web request, recorded in the trace without any secret annai keeps |
| `annai.ui.card({ title, body, tone?, actions? })`, `annai.ui.toast(text)` | a system card or a toast. These are never in Shiori's voice. |
| `annai.ui.slot(slot, item)`, `annai.ui.cardType(item)`, `annai.ui.component(name, impl)`, `annai.ui.screen(item)`, `annai.ui.theme(file)` | what your plugin adds to annai's screens: see "The UI" below. Each returns a function that removes it. |
| `annai.hooks.on(fn, { types? })` | follows the log: see "Following the log" below |
| `annai.cache.state()` | the prefix cache of the model Shiori used last: `{ modelId, ttlMs, expiresAt, warm }`, or null (spec §6.4) |
| `annai.settings.get()`, `.set(changes)` | your plugin's own settings, a JSON object (merge patch to change); a key nothing is saved for has your schema's `default` |
| `annai.searchProviders()` | the search providers, in the order the user set |
| `annai.register('skill', { name, description, text, files?, read? })` | a skill: Shiori sees its name and description, and loads the text with the `skill` tool. `text` is a string or a function returning one; `files()` lists its other files, and `read(file)` gives `{ bytes, type }` or null. A name another plugin or annai has isn't used until the user chooses yours (see "Names and conflicts"). Skills in a package's `skills` don't need this. |
| `annai.register('search', { id, name, needsKey?, search(query, { key, fetch, signal }) })` | a search provider for `web_search`: returns `[{ title, url, snippet }]` |

Every file write goes through one function. It keeps the old version and adds an entry to the log, so anything a plugin changes can be seen in the trace and undone (spec §4.2).

## Skills

A skill is instructions for Shiori, for a kind of situation: planning a hike, reading a tide table. annai reads `SKILL.md` in the Agent Skills format:

```markdown
---
name: tide-pools
description: When the user asks about tide pools - how to read a tide table, and when the pools are safe to visit.
license: CC-BY-4.0
metadata:
  author: Example Trails
  version: "1.2"
---
# Tide pools

Pools are safest from an hour before low tide until low tide. Read [the safety notes](references/safety.md) first.
```

- **The name** is 1 to 64 lowercase letters, digits and dashes, not starting or ending with a dash, without two in a row. **The description** is at most 1024 characters: say what the skill is for and when Shiori should use it, because that is all she sees until she loads it.
- **Only the name and description sit in Shiori's context.** She loads the body with `skill({ name })`, which also lists the skill's other files, and reads one with `skill({ name, file: "references/safety.md" })`: text comes back as text, a PNG, JPEG, WebP or GIF up to 5 MB as an image, anything else described.
- **`scripts/` are never run.** Shiori may read a script as text.
- **The front matter** is read by a small parser of annai's own: `key: value` (plain, quoted), `|` and `>` blocks, comments, a one-level `metadata:` map and a list (`allowed-tools`). Other YAML is skipped.
- **A skill installed or removed** shows in Shiori's context at her next wake.
- **What a skill says is the user's responsibility,** as anything they bring in is (spec §2). annai's install screen says so.

## Installing, updating, removing

- **From a file:** Settings → Plugins → Add, then Install from a file at the foot of the Add screen: a zip, or a `SKILL.md` on its own.
- **From an address:** the Add screen's Address of a plugin or skill. The address holds one of:
  - a zip file, whatever its name;
  - an `annai-plugin.json`: annai fetches the files it names (`entry`, each skill's `SKILL.md`, `personalities`, and `files`), relative to it;
  - a `SKILL.md`: annai fetches the files its links point to inside the skill's folder.

  The site must let web apps read it (GitHub's raw files do; a `github.com/…/blob/…` page is read from there). At most 200 files and 64 MB. A key in the address (a path segment or a query value that looks like one) is kept in a secret of annai's own, apart from your plugin's `annai.secrets`, which annai uses to look for updates; the address is shown and kept everywhere else with `«key»` in its place. An address with a name and password before an `@` is refused.
- **From annai's catalog:** the Add screen lists annai's own plugins and what is installed, yours among them, searched by name, `keywords` and description (see "The package"). A model provider is added there, which makes the provider too: Settings → Models → Add a provider opens it on model providers. Only annai's catalog and installed plugins are listed; a plugin of yours is found there once installed from its address.
- **The install screen** comes first, for a file or an address: what the package is, where it came from, what it brings, what it needs ("It needs: Chat Completions (from annai, installed with it)"), and what it replaces (see "Names and conflicts"). Over an installed package of its id, it says which version is there. When that one came from another place (another address, or a file over an address), it says so, with **Install, keep its settings and keys** (its settings, keys and the user's choices for its names go to the new one) and **Install fresh** (they are removed first). A package with code says, in the spec's words, "This plugin gets full access to your trips and API keys." A provider says where keys go, by origin: "Keys you give this provider are sent to https://llm.example." Install stays off while a requirement can't be had (a third party's not installed, or one the user switched off).
- **Requirements** are installed with your plugin, all or nothing: if a download fails or the connection drops, nothing stays half-installed. A plugin the user switched off is never switched on for yours: the install stops and says how.
- **Updates:** a package installed from an address is checked there when annai starts, when it comes back to the screen at most once a day (so your site isn't asked at every return), and on Check now in Settings → Updates; a changed package (its files, not just its version) is offered on a card, in Settings → Updates and in Settings → Plugins. Nothing changes until the user taps Update. An update that brings something new (code where there was none, new skills or personalities, or a provider that sends keys to a new origin: scheme, host and port) lists it and asks again, with the full-trust words for new code. What an update now requires is installed on Update. Code that already ran runs the new version from the next start.
- **Removing** removes everything the package stored: its files, its settings (`annai.settings`), its secrets (`annai.secrets`), its tools' switches, and what it kept in the system log with `annai.events.append('sys', …)`. What it wrote into a trip stays: that is the trip's. Removing a provider plugin removes the providers made from it, with their keys and models; removing the last provider made from it removes the plugin. Then annai's own protocol plugins that nothing requires and no switched-on ability uses go too; a third party's stays.

## Names and conflicts

Some things plugins register have a name only one plugin can hold: tools, protocols (endpoint types), kinds of backup place, skills, personalities, card types, search providers, and the components (`avatar`, `dock`, `now-card`, `plan-row`). Hooks and the slots that add things up (chips, Now sections, dock actions, tabs, settings pages, screens, themes) never clash.

- **One owner per name,** in a fixed order: annai's built-ins, then its official plugins, then third-party plugins by when each was first installed (an update keeps its place), then by id. Plugins start in that order. annai's own components, and the skills it ships, are annai's even when nothing draws them.
- **The user's choice comes first.** A plugin whose name is taken isn't used, and its page says "Not used: the tool weather is already provided by Places tools", with **Use this one instead**. The choice is kept, shown on both plugins' pages ("The tool weather: this one is used (your choice)") with **Undo**, and holds while your plugin runs; while it is off, the next in order is used. Removing a plugin forgets the choices that named it.
- **`replaces`** in your manifest names what you mean to replace. The install screen says "It replaces how Shiori looks from annai", with **Install and use it** and **Install, keep annai's**; nothing is chosen until one is tapped. Without `replaces`, your plugin installs, and the user finds the switch on its page.
- **What no choice moves:**
  - the agent loop's own tools (`speak`, `show`, `ask`, `wait`, `sleep`, `skill`, `tell_koe`, `tell_kokoro` and the rest of Shiori's own): a plugin's tool by one of those names is never used;
  - protocols and kinds of backup place: they are handed the keys the user gives (a provider's, a place's), so the one used is annai's own, else the one installed first. A name annai's own plugin provides is never yours, even before annai's is installed: while annai's is off or not there, nothing has it, and a call says its plugin isn't running. When a protocol annai has is needed, annai's own is installed, even if yours has its name. Give yours a name of its own.
- **Your provider's id is your plugin's id,** and only your plugin's description and setup are its.
- **Owners are named plainly:** annai, a built-in or an official plugin by its name, any other plugin by its name with its id, "Tides (tides)", so no manifest's name passes for annai's. A package named annai, or a built-in's name (whatever its case, spaces, width or invisible characters), isn't installed.
- **A bug counts against the plugin that registered the thing,** as annai's registry knows it, never against an id the thing says it has.
- **Removing a plugin** removes its tools' switches, but not one for a name another plugin, the loop or annai still has.

A plugin that registers a name twice uses the first.

## The UI

A code plugin's own UI is fully trusted: it draws with any DOM API it likes. Only the slots, components and CSS variables below are stable across annai's updates (spec §16.4); anything else on annai's pages can change without notice.

Every drawing function gets an element annai made, and a `ui` object:

| | |
|---|---|
| `ui.h(tag, attrs, ...children)` | annai's DOM builder (no `innerHTML`, no `style` attribute) |
| `ui.go(hash)` | goes to a screen, such as `'#/now'` |
| `ui.trip()` | the open trip's id, or null |
| `ui.toast(text)`, `ui.card({ title, body, tone, actions })` | a toast or a system card (never in Shiori's voice) |
| `ui.shiori.state()`, `ui.shiori.on(kind, fn)`, `ui.shiori.tap()`, `ui.shiori.send(text)` | Shiori: her state (`{ name, label }`), her events (`'state'`, `'event'`), a tap on her, a message to her |
| `ui.live.on()`, `ui.live.activity()`, `ui.live.onChange(fn)` | live mode: on or off, `still` / `walking` / `moving-fast`, changes |

A drawing may return a cleanup function, which annai calls when it draws that place again. A drawing that throws counts against your plugin as a tool's crash does; its element stays empty, and the rest of the screen draws.

Swiping sideways on a screen moves along annai's top bar. Something of yours that scrolls sideways keeps its swipes; for any other sideways gesture of your own (a slider you draw, a map), give its element the class `no-swipe`.

To change what a chip or a section shows, keep the element it was given and change it in place from your own code (a timer, `ui.live.onChange`, a hook), until its cleanup runs. Don't register it again for that: each registration, and each removal, makes annai draw the screen and the dock again.

- **Slots,** `annai.ui.slot(slot, item)`; every item has an `id` (lowercase letters, digits and dashes):
  - `'status-chip'`, `{ id, render(el, ui) }`: a chip in the dock's row of chips, after the voice and live chips.
  - `'now-section'`, `{ id, title, render(el, ui) }`: a section of the Now card, after its chips.
  - `'dock-action'`, `{ id, label, icon, run(ui) }`: a button in the dock after Type; `icon` is 1 or 2 characters, `label` its name.
  - `'trip-tab'`, `{ id, title, render(el, ui, { trip }) }`: a button on a trip's page, after Replay, opening a page of yours for that trip.
  - `'settings-page'`, `{ id, title, render(el, ui) }`: a page listed under Settings → From plugins and on your plugin's page.
- **Card types,** `annai.ui.cardType({ type, name, description, schema?, render(data, el, ui) })`: a kind of card Shiori can show. Her `show` tool gains `type` and `data`, and its description lists your type with its description; `data` must pass `schema` when you give one, or Shiori is told why. The card's label reads "SHIORI · <NAME>". A card of your type shown while your plugin is off shows its title and text.
- **Components,** `annai.ui.component(name, impl)`. A component is a name with one owner, annai's own until the user chooses yours: declare it in `replaces`, and your install screen asks ("It replaces how Shiori looks from annai"); without it, your plugin's page says Not used, with a switch. annai's own is used when yours fails:
  - `'avatar'`, `{ create({ size }) }` returning `{ el, setState(state), setLevel(0..1, who), glance(dx, dy), blink() }` (spec §16.3).
  - `'now-card'`, `{ render(el, ui, { title, place, chips, liveOn }) }`: the top of the Now card.
  - `'dock'`, `{ create(ui) }` returning `{ el }`: the whole dock.
  - `'plan-row'`, `{ render(li, row, ui) }` with `row = { trip, path, when, title, fixed, place, kind }`: one row of the Plan's and Now's timetables.
- **Screens,** `annai.ui.screen({ id, title, render(el, ui), tab?, homeFor? })`: a page at `#/ext/<your id>/<screen id>`. `tab: true` adds it to the top bar; `homeFor: 'walking'` (or `'still'`, `'moving-fast'`) makes Now hand over to it when live mode says that activity starts, as it hands over to Driving.
- **Themes,** `annai.ui.theme('theme.css')`: a CSS file in your package, loaded while your plugin runs. Set annai's CSS variables (in `src/ui/tokens.css`): colors (`--paper`, `--sheet`, `--ink`, `--ink-2`, `--line`, `--ai`, `--ai-ink`, `--ai-wash`, `--amber`, `--amber-wash`, `--risk`, `--risk-wash`, `--ok`, `--ok-wash`, `--lattice`, `--shadow`), type (`--f-display`, `--f-body`, `--f-mono`) and spacing (`--radius`, `--gap`); set them inside `@media (prefers-color-scheme: dark)` too for the dark theme.

## Following the log

`annai.hooks.on(fn, { types })` calls `fn` with each log entry appended after a write commits (`types` filters by entry type, such as `['file.write']`). Entries are frozen copies: hooks read the log, they can't change it (spec §5.4). Hooks follow what you, Shiori and annai do, never what plugins do: no entry a plugin caused reaches any plugin's hooks, yours or another's. That covers the entries a plugin appended and the ones annai logs for its `annai.net.fetch` requests, its `annai.llm` and `annai.llm.decide` calls and its `annai.wake`, so two plugins can't feed each other. What a plugin causes any other way (a file it writes, Shiori's turn after its wake) does come back, so don't answer every entry with another. Your hooks get at most 1,000 entries in 10 seconds: one more counts as your plugin's failure and switches it off, with a card saying why (spec §5.5). An error in a hook counts against your plugin.

## Settings

A manifest's `settings` is a JSON Schema object. annai draws a form from its top-level properties on your plugin's page:

- `string` as a text field, a choice when it has `enum`, a password field when it has `writeOnly: true`;
- `number` and `integer` (with `minimum` and `maximum`), `boolean` as a switch;
- `title` labels a field, `description` explains it, `default` fills it when nothing is saved.

What the user saves is checked against the schema and comes back from `annai.settings.get()`, over the schema's defaults. A `writeOnly` string goes to your secrets instead, never into a file: read it with `annai.secrets.get(key)`. A `writeOnly` field of any other type is one annai can't show, and it never goes into a file either. Other kinds of property are listed as ones annai can't show; draw a settings page of your own for them.

**Reset settings** on your plugin's page clears its settings file, with that file's history, and all its secrets; it keeps the package, the address it was installed from (annai's own secret, not one of yours), its on/off state, its tools' switches and what it wrote into trips. Your plugin keeps running, so read settings and secrets when you need them, and treat a missing setting as its default and a null secret as one not set.

## Tools Shiori uses

A tool is something Shiori can call: a name, a description she reads, an input JSON Schema, and `run(input, call)`.

```js
export function activate(annai) {
  const { tsv } = annai.helpers;
  return annai.tools.register({
    name: 'tides',
    description: 'Low and high tides near a point today, as TSV: time, kind, height_m.',
    input: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] },
    async run({ lat, lng }, call) {
      const res = await call.fetch(`https://tides.example/api?lat=${lat}&lng=${lng}`, { signal: call.signal });
      if (!res.ok) throw new Error(`The tide service answered ${res.status}. Try again later.`);
      const { tides } = await res.json();
      return tsv(['time', 'kind', 'height_m'], tides.map((t) => [t.time, t.kind, t.height]));
    },
  });
}
```

- **What `call` holds:** `trip` (the open trip's scope, or null), `signal` (stop when it aborts: the user tapped Shiori), `model` (the model that called the tool, with what it takes, such as `input: ['text', 'image']`), and `fetch` (traced).
- **What to return:** text, or an object (sent as JSON), or `{ content, images?, document? }`. Lists are best as TSV with `annai.helpers.tsv` (spec §4.7).
- **Photos in a result:** `images: [{ mediaType, data }]` (base64) or `[{ mediaType, hash }]` (content annai already stores). annai keeps them named by the result, so they survive a reload and go when the trip is removed (spec §4.9).
- **Errors are answers.** Throw an `Error` with plain words and what to do; Shiori sees it and adapts. Only a crash (a `TypeError` and the like) counts against your plugin, which annai switches off when it keeps crashing.
- **Keep results short.** A result over 40 000 characters is cut. Return a page of results, and take a `from` or `page` input for more.
- **Every tool can be switched off** in Settings → Tools, and every call, its input and its result are in the trace.
- **When Shiori is two halves** (Koe and Kokoro, spec §6.8), a plugin's tools are Kokoro's: the half that thinks and works. Koe, the half that talks, has annai's own quick set (reads, the offline pack's places, light changes), and asks Kokoro for the rest. annai's places tools are called with `call.offline` for Koe: read only what is on the device, and say so when it isn't there. A tool switched off is off for both halves.

## Model providers

A model provider is usually data: one `annai-plugin.json` with a `provider` description and no `entry`, requiring the protocol plugins its abilities speak through. annai's own are in `plugins-official/provider-*`. OpenAI's, trimmed:

```json
{
  "id": "provider-openai", "name": "OpenAI", "version": "1.0.0", "api": 1, "category": "providers",
  "requires": [{ "id": "openai-responses", "version": "^0" }, { "id": "speech-openai", "version": "^0" }],
  "provider": {
    "baseUrl": "https://api.openai.com/v1", "key": "required", "keyUrl": "https://platform.openai.com/api-keys",
    "abilities": {
      "chat": { "kind": "chat", "type": "openai-responses", "name": "Chat (Responses)",
        "models": [{ "providerId": "gpt-6-luna", "name": "GPT-6 Luna", "prices": { "input": 0.1, "output": 0.5 } }] },
      "chat-completions": { "kind": "chat", "type": "chat-completions", "on": false, "tunables": { "systemRole": "developer" } },
      "voice": { "kind": "voice", "type": "openai-speech", "models": [{ "providerId": "tts-1", "name": "OpenAI: TTS-1 (Nova)", "tunables": { "voice": "nova" }, "prices": { "perMillionChars": 15 } }] }
    },
    "roles": { "recommended": { "main": ["gpt-6-luna"], "speech-out": ["tts-1"] } }
  }
}
```

- **The provider:** `baseUrl` (empty when the user gives one); `key`: `required`, `optional` or `none` (no key field); `keyHeader` when the key goes in a header of its own rather than the protocol's way (annai puts it there and gives the protocol no key); `keyUrl` and `note` for its page; `headers` sent with every ability's requests; `local: true` for a server the user runs; `freeTier` when its keys may be on a free tier the user can't tell from the key (Gemini's): its page then offers "This key is on the free tier (… doesn't charge)", naming who by the string you give (Gemini's is `"Google"`), or your plugin's name for `true`; with it on, every call of that provider is free in the Trace and counts nothing toward Spend per day. Every address must be https, or http only for `localhost` or `127.0.0.1`.
- **Where a key goes is checked where it is sent.** annai fetches what a protocol builds only at the origin of its ability's address; any other request is refused, unsent ("…built a request to <origin>, not its address <origin>. Check its tunables."). A tunable a protocol joins onto the address (`path`, `listPath`), on an ability, a model or `modelDefaults`, must be a path from it: starting with `/`, with no `//` or `@`.
- **Each ability** (an id of lowercase letters, digits and dashes) has a `kind` (`chat`, `transcription`, `voice`, `realtime`), a protocol's `type`, and optionally a `name`, `on: false` to start switched off, its own `baseUrl`, `tunables`, `extraBody`, a `note`, a `noWindowNote` (shown only while one of its models has no context window, such as one added before your list gave windows: what to do about it), `modelDefaults` (what a model added by id or from a list starts with, such as `providerTools` or `cacheTtls`) and `models` (each with a `providerId`, and the model settings of spec §9.2).
- **`roles`** suggests models: `recommended` and `free`, each role to provider model ids among the abilities of its kind (chat roles `main`, `utility`, `decide`; `koe`, chat or realtime; `speech-in` transcription; `speech-out` voices). Adding a provider fills chat roles still empty, never Koe's (only "Use the recommended models" does); its speech models go behind the free entries. Koe's list was two, `koe-talk` and `koe-type`, before 2026-10-19: a description that still names them checks, and they are ignored.
- **`requires`** must cover every protocol of an ability that starts on. One that starts off brings its protocol when the user turns it on.
- **One key per provider.** The user may add several providers from one plugin (two accounts); each has its own key, models and places in roles. annai keeps the key in its secrets, and hands it only to the protocol a call goes through, never to another provider's plugin. A data-only provider can't read it at all; a plugin with code runs with annai's full access (the install screen says so), so the user trusts it with every key.
- **Updates:** when your plugin's version changes, the providers made from it take the new description; the user's own changes stay, new models join no role, and a new ability arrives switched off.

**Quirks are data.** A server's differences are written in its description, not in code. The servers people run show how (`plugins-official/provider-llamacpp`, `-vllm`, `-sglang`, `-ollama`, `-lmstudio`): each has its default address, `local: true`, notes on how to let annai's address in, and how its thinking is switched, as the reasoning map every model added from its list starts with. llama.cpp's, trimmed:

```json
"chat": { "kind": "chat", "type": "chat-completions",
  "modelDefaults": { "reasoning": {
    "off": { "reasoning_effort": "none", "chat_template_kwargs": { "enable_thinking": false } },
    "medium": { "reasoning_effort": "medium", "chat_template_kwargs": { "enable_thinking": true } } } } }
```

Each level is a patch merged into the request body (spec §9.3), and level off is what a quick decision asks for. vLLM's and SGLang's maps send `reasoning_effort` and `chat_template_kwargs` (`enable_thinking` and `thinking`, as their models' templates read one or another; the explicit kwargs win where a server derives them from the effort); Ollama's names only off (`"reasoning_effort": "none"`) and leaves low, medium and high empty, so they send nothing: it refuses any named level for a model that can't think. (Its plugin's list gives a model that can think the named levels: see below.) An empty level is still a level, and the nearest one to a level the map lacks. A tunable can be a quirk too: llama.cpp's chat turns on Chat Completions' `enforceToolCall`, so a tool annai forces (the quick decision's) goes as `tool_choice: "required"` when it is the only tool offered, as llama-server accepts a named tool but doesn't force it. Where reasoning comes back, and usage in the stream, are the protocol's (Chat Completions reads `reasoning_content` and `reasoning`), so they need nothing. `keywords` let a search find a plugin by another name: llama.cpp's include Unsloth and KoboldCpp, which run it.

## Model providers with code

Most providers are data. A provider with quirks no data can carry (a sign-in, a model list in a shape of its own, an error that means something else) has an `entry` too, and its `activate` calls `annai.providers.setup` once. It must describe a provider (`provider` in its manifest). Every part is optional:

```js
export function activate(annai) {
  return annai.providers.setup({
    panel(ui, provider) { … },          // → an element, or null
    keyField: true,                     // false: no standard key field after the panel
    async returned(params, ui) { … },   // annai's address came back after ui.expectReturn()
    classify(status, body, ability) { … },  // → an error kind, or null
    headers(ability) { … },             // → { name: value }
    async list({ ability, endpoint, key, fetch, protocolList }) { … },  // → listed models
  });
}
```

- **`panel(ui, provider)`** draws your part of the setup. With `provider` `{ id, name, key }` (key: whether one is saved), it is drawn on that provider's page, in the key's place; the standard key field follows unless `keyField` is false. With `provider` null, it is your own Add flow: Add on your provider installs your plugin and opens it on a screen of its own, with Add by hand beside it (the provider as your description has it, set up on its page), and a provider your panel adds with `ui.add` opens its page. Leaving that screen with no provider made from your plugin removes it again, if Add installed it for this. annai also draws it as the one-tap start when your plugin is the featured one. Return null where you have nothing to add (Another address does on a provider's page, which keeps annai's switches). Build it with `ui.h`, with handlers as `on…` attributes. What it throws, or a panel that isn't an element, counts against your plugin, and the screen draws without it.
- **`ui`** (the setup's own) has `h`, `render()` (draws the screen again) and `returnsElsewhere` (true on an iPhone Home Screen app, where a page you open comes back to Safari, not to annai: show a code to paste there). Cards and toasts are `annai.ui.card` and `annai.ui.toast`. And:
  - `ui.add({ key, roles, name, baseUrl, abilities })` adds a provider from your description, installing the protocols of the abilities turned on; `roles` is `"recommended"` (the default), `"free"` or null. An address (`baseUrl`, or an ability's) must be one annai takes, at an origin your description names, as your install screen said keys go there; a `catchAll` provider may give any. It gives the provider's id.
  - `ui.keep(providerId, key)` sets the key of one of your own providers (null removes it). Another plugin's provider is refused.
  - Both keep the key in annai's secrets, for that provider alone: your plugin needn't store it, and the provider contract never hands it another provider's. A key given as a function is called only once everything else is in place (the plugin, what it requires, the provider found), so a key made for annai, such as a sign-in's, is never lost to a failed install.
  - `ui.expectReturn()` says you are sending the browser away, to come back to annai's address (`location.origin + '/'`). The next load of that address with a query, within 15 minutes, calls your `returned(params, ui)` once plugins have started, with the query's parameters; the query leaves the address, Settings → Models says the sign-in is being finished, and what you throw is shown on a card titled by your plugin's name. A query no plugin expected (or one past the 15 minutes) is removed, and a card says a sign-in came back too late, to start it again.
- **The page must not wait before opening another.** An iPhone opens a page only from the tap itself: make a link's address before the tap (a pending sign-in can wait in your own localStorage key), never after an `await`.
- **`classify(status, body, ability)`** is asked before the protocol's own, for an error response from one of your abilities: give a sharper kind (`rate`, `credit`, …) or null. Anything but one of annai's error kinds counts as null.
- **`headers(ability)`** gives headers that join each request of that ability, after the description's and the user's. A header that carries the key (`authorization`, `x-api-key`, or the provider's `keyHeader`, in any case) is left out: the key is the user's, in annai's keeping.
- **`list(...)`** lists an ability's models in the protocol's place. `protocolList()` gives the protocol's own list, to build on. `fetch` sends only to the ability's address (another origin is refused, unsent) and never follows a redirect, as annai's own requests with a key don't. A crash in it counts against your plugin, and the protocol's list answers.
- **`featured`** in your manifest counts only in annai's own catalog.

OpenRouter's (`plugins-official/provider-openrouter`) is a sign-in panel, `returned` and `classify` (its free-model limit is too many requests, not an account out of credit).

Another address's (`plugins-official/provider-another-address`) is an Add flow: a panel that looks for what an address offers, at no cost, then adds the provider with what it found. `probe.js` asks for the model list and sends an empty request (no model, no input; a chat path's carries an output limit of one token, in case a lax server runs it anyway) to each path annai knows, at most four at a time, reading each answer against a control request to a path that can't exist, so auth in front of every path, or JSON for anything, finds nothing. Its panel, trimmed:

```js
import { probe, LOOKS } from './probe.js';
export function activate(annai) {
  const io = {
    fetch: (url, init) => annai.net.fetch(url, init),   // traced; the probe sends each with redirect: 'manual'
    reach: (url) => annai.net.fetch(url, { mode: 'no-cors', credentials: 'omit' }).then(() => true, () => false),  // there at all?
    problem: annai.helpers.addressProblem,             // an address annai sends keys to
  };
  return annai.providers.setup({
    panel(ui, provider) {
      if (provider) return null;                        // a provider's own page: annai's switches
      const address = ui.h('input', { id: 'probe-address', type: 'url' });
      const key = ui.h('input', { id: 'probe-key', type: 'password' });
      const look = ui.h('button', { type: 'button', onclick: async () => {
        const r = await probe(address.value, key.value || null, io);
        const found = LOOKS.filter((l) => r.abilities[l.id].state === 'found');
        await ui.add({ name: new URL(r.base).host, baseUrl: r.base, key: key.value || undefined, roles: null,
          abilities: Object.fromEntries(found.map((l) => [l.id, { on: true, ...(l.root ? { baseUrl: r.root } : {}) }])) });
      } }, 'Look for what it offers');
      return ui.h('div', {}, address, key, look);
    },
  });
}
```

The real one shows what was found (✓, ✗, or ? with the reason) and adds only on Add with these, a speech path switched on only where the model list names a model for it: some servers answer a speech path whatever their models can do. A request a browser couldn't make is told apart by `reach`, a no-cors GET: it reaches a server whatever its CORS says, so a server that answers it doesn't allow web apps, and one that doesn't isn't there. A browser sends a no-cors request only if it may follow a redirect, which is why it carries no key, body or cookies. llama.cpp's, Ollama's and LM Studio's are a `list` each, which reads the context a server serves from its own API. llama.cpp's, whole:

```js
const root = (base) => String(base).replace(/\/+$/, '').replace(/\/v1$/, '');
export async function list({ endpoint, key, fetch, protocolList }) {
  const listed = await protocolList();
  const props = await fetch(`${root(endpoint.baseUrl)}/props`, { headers: { ...endpoint.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) } })
    .then((res) => (res.ok ? res.json() : null)).catch(() => null);
  const n = props?.default_generation_settings?.n_ctx;
  const kinds = props?.modalities;
  const loaded = listed.find((m) => m.providerId === props?.model_alias) ?? (listed.length === 1 ? listed[0] : null);
  return listed.map((m) => (m !== loaded ? m : {
    ...m,
    ...(Number.isInteger(n) && n > 0 ? { contextWindow: n } : {}),
    ...(kinds && typeof kinds === 'object' ? { input: ['text', ...(kinds.vision ? ['image'] : []), ...(kinds.audio ? ['audio'] : [])] } : {}),
  }));
}
export function activate(annai) {
  return annai.providers.setup({ list });
}
```

## Protocols (endpoint types)

An endpoint type teaches annai one model protocol. The core contains none (spec §9.1).
annai's own Chat Completions, Anthropic Messages, OpenAI Responses and Gemini API types are plugins too: see `plugins-official/`. A protocol's `endpoint` is a provider's ability: `{ id: "<provider>/<ability>", provider, ability, type, name, baseUrl, headers, tunables, extraBody }`, its `name` the provider's, with `free: true` when the user marked its key as on a free tier. Providers require a protocol as `^N` of its version's major, so its major is its interface: change it only when a provider would have to change.

```js
export function activate(annai) {
  const { sse, ProviderError } = annai.helpers;
  return annai.providers.register({
    type: 'my-protocol',                 // lowercase letters, digits and dashes
    name: 'My protocol',
    tunables: { path: '/v1/chat' },      // defaults the user can change per ability and model
    build({ endpoint, model, key, tunables, request }) {
      return { url: endpoint.baseUrl + tunables.path, headers: { authorization: `Bearer ${key}` }, body: { model: model.providerId } };
    },
    async *read(res) {
      for await (const { data } of sse(res.body)) {
        // yield { type: 'text', text }, { type: 'tool_call', id, name, input }, { type: 'usage', usage }, …
      }
      yield { type: 'stop', reason: 'end' };
    },
  });
}
```

- **What annai does around it:**
  - It merges the ability's and the model's extra fields, and the reasoning level's patch, into the body `build()` returns.
  - It sends the request and reads it until the first output arrives in time.
  - It assembles the reply, and works out its cost.
  - It falls back to the next model of the role when this one fails.
  - It records every attempt in the trace, without keys.
- **Show progress:** yield `{ type: 'reasoning_delta', text }` for each piece of thinking as it arrives, and the whole block as `{ type: 'reasoning', text, signature? }` when it ends. annai gives up on a model that sends nothing for a while (spec §9.6), so a model that thinks silently looks like one that never started.
- **The request** may carry:
  - `tail`: the now block. Put it last, inside the final user message, after any cache marker, and declare `tail: true`. Without `tail: true`, annai adds it as the last text itself.
  - `toolChoice`: the name of a tool the model must call.
  - `logprobs`: how many alternatives to report for the first token, as `{ type: 'logprobs', top: [{ token, logprob }] }`.
  - `document` parts: PDFs, base64.
- **A paused turn** (the provider stopped early and wants the reply back) stops with `pause`.
- **A server that ignores `stream`** may answer with one whole JSON reply. Read it as the same events, in a stream's order, when the answer is `application/json` (and only then: NDJSON and `problem+json` are not whole replies): annai's Chat Completions and OpenAI Responses do. A connection that drops while you read it is `network`, as a stream's is.
- **Errors:** throw a `ProviderError` with a kind (`auth`, `credit`, `rate`, `overloaded`, `context`, `network`, …) and the fallback will know what to do. Anything else you throw counts as a bug in your plugin.
- **Optional parts:**
  - `classify(status, body)` can give a sharper kind for an error response.
  - `listRequest()` and `readList()` make "Fetch model list" work. A listed model may carry its `contextWindow`, `maxOutput`, `input` and its `reasoning` map (spec §9.3), as Gemini API's list does.
  - `retryAfter(body)` gives the wait, in ms, an error response's words ask for, when no `retry-after` header or Google RetryInfo says (Gemini: "Please retry in 7h40m31s"). A rest over 10 minutes is said in words.
  - `refusal(status, body, c)` gives words for an error response that is the model declining, such as Gemini's safety block (a 400): the turn ends with them, stopping with `refusal`, and no other model is tried. Null for any other error. `c` is the call, so your type can keep what was blocked out of its later requests: Gemini API leaves the blocked message out of what it sends Gemini from then on, kept by a fingerprint in its own settings.
  - `uploadRequest({ endpoint, key, tunables, bytes, mediaType, name, expiresInSeconds })` and `readUpload(json)` let photos go to the provider's files API (spec §4.8). annai uploads each photo once, sets it to expire after 48 hours, uploads it again when it expires or the provider no longer knows it (classify that error as `upload`), and sends the bytes instead if uploading fails. Image parts then carry `fileId`: send that instead of the bytes. A user can turn uploads off on the provider's page, per ability (the `uploads` tunable).

### Kept turns

A protocol whose server can keep a conversation's turns, so the next sends only what is new, says so with `keeps: { name, days, hours }`: who keeps them, for the switch's words (Gemini API's: "Let Google keep the conversation between turns: sends less each time."); the longest the server keeps a turn (annai tracks each that long, to delete it); and how long after a chain's first turn annai continues it (the shortest any key keeps a turn, less a margin: Gemini's 55 and 23). It must place the now block itself (`tail: true`): annai's own tail would change the last message every turn, and nothing would ever match. annai does the rest, because only it sees trips, removals, Erase and the key:

- **Which calls:** only a conversation's own turns, Main's and Koe's, while the ability's `keep` tunable is on (the switch on the provider's page). Those calls carry `keep: true`; every other call, a one-off (utility, a quick decision, Test, Try this model), doesn't, and must keep nothing (Gemini: `store: false`).
- **Your side:**
  - With `keep`, have the server keep the turn, and yield `{ type: 'kept', id }` as soon as it names it, before any output.
  - With `kept: { id, from }`, continue that turn (Gemini: `previous_interaction_id`) and send only `request.messages.slice(from)`, with the system prompt, tools and the now block as always. Work out names and turns from the whole conversation all the same.
  - Classify the error for a turn the server no longer has as `forgotten`. annai then sends the conversation whole to the same model, once, as it does after a chained call's `bad-request`. On a call that continued nothing, annai reads `forgotten` as `not-found`.
  - `forgetRequest({ endpoint, key, id })` gives the server's delete call for one turn: `{ url, headers, method: 'DELETE' }`, to the ability's address. annai counts a 200 or a 404 as done, and a 429 rests that address as long as it asks.
- **annai's side:** it remembers each kept turn by its id, its trip and fingerprints of the messages sent (never their content), on this device alone, and matches the longest one the new request begins with, then its reply, within `hours` of its chain's first turn (src/core/llm/kept.js says why). It keeps a turn only if, when it is recorded, its provider, key and address, switch and trip still allow it; otherwise the call deletes it at once. It deletes them when the user removes their trip, the provider or everything, changes or removes the key or address, or turns the switch off, only ever with the key and address that made them. Deletions wait for a connection, and each is in the trace.

### Audio formats

Speech travels in the smallest format both the phone and the provider handle (spec §10.6). Your protocol and your provider description say what that is, as tunables. annai reads them; your code only names files and formats.

- **Formats are named by file kind:** `ogg` and `webm` (Opus), `mp4` and `aac` (AAC; `aac` is ADTS), `mp3`, `flac`, `wav`. On a voice's side, `opus` is OpenAI's name for Ogg Opus.
- **`audioIn`** (a transcription type, or a chat type that takes `audio` parts): what it takes, its preferred first. annai sends the first, in its codec order, that the phone makes: Opus, then AAC, MP3, FLAC, WAV. Within a codec, your order wins. Always include `wav`: annai makes WAV itself, so it's the format that always works.
- **`audioOut`** (a voice type): the formats `response_format` (or your equivalent) can ask for. With your `format` tunable set to `"auto"`, annai puts the smallest one the phone plays in `tunables.format` before calling `speechRequest`. Still treat `"auto"` as your default, as an older annai leaves it as it is.
- **In a description,** set them per ability where the provider differs from the protocol, as the official ones do:
  - Groq's transcription takes `["webm", "ogg", "mp4", "mp3", "flac", "wav"]`;
  - Gemini, through its own API (the Gemini API type), all of them, so no phone sends it WAV; Chat Completions takes only `["wav", "mp3"]`, as OpenAI's and Gemini's compatible endpoints do;
  - OpenRouter's voices give only `["mp3"]`.

  A user can change them on the provider's page, per ability or model.
- **What your code gets:** an `audio` part's `mediaType` (`audio/ogg`, `audio/webm`, `audio/mp4`, `audio/aac`, `audio/mpeg`, `audio/flac` or `audio/wav`), or a transcription's `audio.mediaType`. Name the file or format for it, as Chat Completions does (`audio/mp4` → `m4a`).
- **When a provider refuses** a format it was said to take, annai asks again in WAV (a transcription after any bad request; a chat model when the 400 names the audio or its format), and keeps sending that model WAV until it restarts if WAV works. A voice that refuses its format is asked for MP3, then WAV. So keep `classify` from turning such a refusal into another kind.
- **A failed upload** (network or server) is sent again with the very same bytes: don't change the audio between attempts.

### Streamed voices

A voice type can stream (G3): give `readSpeechStream(res, c)`, an async iterable of `{ pcm, rate }` (16-bit PCM in an `Int16Array`, as the reply arrives), beside `readSpeech`, which stays for a whole clip. Gemini API's voice does, and its `readSpeech` reads the same stream whole into one WAV clip.

- **annai asks for a stream** only once a tap has unlocked sound and the phone's player streams, and only while the ability's `stream` tunable isn't `false`. Otherwise it calls `readSpeech`, as for any voice: build one request that works for both.
- **Time limits:** the first piece must come within the voice's wait (Settings → Models, "Wait for the voice"), and then no gap may be longer. A stream that fails partway is a failed clip: the sentence goes to the next voice, and the trace counts it once, with its cost, for the voice that said it.
- **It never stutters:** annai holds the pieces until the rest, at the rate they arrive, will be in before playback reaches them, then plays them through the stream player (the one live sessions use). On a good connection that's about half a second; on a weak one it waits.
- **G.711 and WAV:** a provider that sends μ-law or A-law is decoded with `annai.helpers.g711`; `annai.helpers.wav` writes (and reads) a WAV clip.
- **`choices`** (any type): tunables the provider's page offers in words, `{ tunable: { label, options? } }`. With `options` (value → its words), one of them; without, a switch for a tunable that is on unless `false`. Gemini API's voice offers its sound (`format`: full quality or phone quality) and `stream`.

### Realtime voice protocols

A realtime protocol speaks to a model that hears and talks in one stream over a WebSocket, such as Gemini Live (`plugins-official/gemini-live`) or OpenAI Realtime (`plugins-official/openai-realtime`). annai opens the socket; your type builds its address and drives it. A provider's ability of kind `realtime` uses it, and Koe talks through it.

```js
export function activate(annai) {
  const { base64 } = annai.helpers;
  return annai.providers.register({
    type: 'my-live',
    name: 'My live voice',
    realtime: true,
    tunables: { voice: '' },
    audio: { in: [{ format: 'pcm16', rate: 16000 }], out: [{ format: 'pcm16', rate: 24000 }] },   // preferred first
    open: ({ endpoint, key, tunables }) => ({ url: `${endpoint.baseUrl.replace(/^http/, 'ws')}/live?key=${encodeURIComponent(key)}`, protocols: [] }),
    attach(socket, { model, tunables, setup, emit }) {
      let ready;
      socket.on((data) => {                     // a string, or bytes
        const m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
        if (m.ready) ready();
        if (m.audio) emit({ type: 'audio', data: base64.decode(m.audio) });
        if (m.said) emit({ type: 'said', text: m.said });
        // { type: 'heard', text }, { type: 'tool', id, name, input }, { type: 'turn', end: 'complete' | 'interrupted' },
        // { type: 'usage', usage: { input, output, audioIn, audioOut, image } }, { type: 'resume', handle }, { type: 'goaway', ms }
      });
      socket.send(JSON.stringify({ setup: { model: model.providerId, instructions: setup.instructions + '\n\n' + setup.context, tools: setup.tools, resume: setup.resume } }));
      return {
        ready: new Promise((r) => { ready = r; }),
        audio: (chunk) => socket.send(JSON.stringify({ audio: base64.encode(chunk) })),   // 16-bit PCM at setup.audioIn's rate
        activity: (edge) => socket.send(JSON.stringify({ activity: edge })),                // 'start' or 'end' of someone speaking
        text: (text, { interrupt } = {}) => socket.send(JSON.stringify({ text, interrupt })),
        image: ({ mediaType, data }) => socket.send(JSON.stringify({ image: { mediaType, data } })),
        answer: (id, name, output, { silent } = {}) => socket.send(JSON.stringify({ answer: { id, name, output, silent } })),
      };
    },
    classifyClose: (code, reason) => (/bad key/i.test(reason) ? 'auth' : null),
  });
}
```

- **What annai does around it:**
  - It opens the socket at the address `open()` gives, only at the origin of the ability's address: `wss:` for an `https` address, `ws:` only for `localhost` and `127.0.0.1`. Any other is refused before anything opens. A socket can't follow a redirect, so the key reaches only the provider.
  - It calls `attach()` once the socket is open. Set `socket.on()` there: messages before it are dropped.
  - It waits for `ready` (15 s), then hands the session to Koe. If the provider refuses the session in words before then (a key, a model, a field), reject `ready` with a `ProviderError` (`annai.helpers.ProviderError`) of the right kind and its words: the session ends with them, the key blanked, and it doesn't count against your plugin. Any other failure of `ready` does. Before `ready`, a close may ask for one more try: `reopen(code, reason, tunables)` gives the tunables to open with (Gemini Live answers v1alpha's proactive audio, refused on v1beta, so).
  - It reads a close into an error kind: your `classifyClose`, then annai's (a refused key is `auth`; quota `rate`; 1008 or "not found" `not-found`; 1011 `server`; anything else `network`).
  - It prices each `usage` you emit (one per turn) by the model's prices, `audioIn`, `audioOut`, `cacheReadAudio` and `cacheReadImage` (cached audio and image tokens, else priced as `cacheRead`) and `image` (image and video tokens) among them, and counts it in Spend per day. Once the session has closed, what you emit reaches no one: a timer of yours that fires late is harmless. It traces the session's life as `live.session` entries, with the data both ways, and never its address, subprotocols or key.
  - A crash in your code counts against your plugin, as for any protocol.
- **Audio:** `audio()` gets 16-bit PCM at `setup.audioIn`'s rate, and `audio` events carry it at `setup.audioOut`'s. annai streams only speech: `activity('start')`, the audio, then `activity('end')` at the end of the sentence, from its own end-of-sentence detector. Nothing is sent while nobody speaks.
- **Cut off:** when the user's voice or an immediate note cuts Koe off, `activity('start', { playedMs })` and `text(t, { interrupt: true, playedMs })` say how much of its turn was heard, and a tap on Shiori, which says nothing more, calls `cut(playedMs)`: for a protocol that cuts its record of the turn there (OpenAI Realtime's truncate). Gemini Live cuts its turn itself, and needs none of them.
- **Answers:** annai answers every tool call at once. `silent` means "say nothing more for this answer" (Gemini's `scheduling: "SILENT"`, without which it adds a filler turn).
- **Audio formats:** `audio` lists what your protocol takes and gives, preferred first; a tunable `input` or `output` that names one of them (`pcm16`, `pcmu`, `pcma`) chooses it instead, and the session says which (`audioIn`, `audioOut`). Either way annai speaks 16-bit PCM at the format's rate: a G.711 format is yours to code at the wire, as OpenAI Realtime's `audio/pcmu` is (annai's microphone then sends 8 kHz).
- **Cutting in:** `activity('start')` while Koe speaks, `text(…, { interrupt: true })` and `cancel()` cut her off; the first two may say how much of her turn was heard (`playedMs`). Gemini does it on its own (`interrupted`); a protocol whose server doesn't must do it and emit `{ type: 'turn', end: 'interrupted' }` itself. Emit `complete` when the turn's voice would have finished playing, not when the server has sent it all: annai plays audio as it comes, and a cut before then ends the turn as `interrupted` alone.
- **OpenAI Realtime, the second example** (`plugins-official/openai-realtime`), differs from Gemini Live where the APIs do:
  - the key goes as a subprotocol (`open()` gives `protocols: ['realtime', 'openai-insecure-api-key.<key>']`), not in the address;
  - turns are by hand (`turn_detection: null`): `activity('end')` commits the audio and sends `response.create`;
  - a response arrives faster than it plays: a cut-in sends `response.cancel` while the response is still being made, and `conversation.item.truncate` where the player says it stopped (`playedMs`), else where the clock says; `complete` waits for the voice to have played by the clock;
  - OpenAI makes one response at a time, so what annai sends while one is being made waits, in order, for it to end; a silent answer is a `function_call_output` with no `response.create`;
  - errors are `error` events; before `session.updated` they reject `ready`; after, a refused `response.create` (named by its `event_id`) ends that turn with nothing said, and the queue moves on;
  - there's no resume handle, and a session lasts at most an hour: it emits `goaway` after its `renewMinutes` (55), and Koe starts a fresh session from its setup.
- **The stand-in** (`test/fakes/realtime-server.js`) speaks Gemini Live as it was measured to, and OpenAI Realtime as its docs describe it, for your tests: `startRealtimeServer({ flavour: 'gemini' | 'openai', key, turns })`.

## Backup places

A backup place keeps annai's backups somewhere else: a git repository, a bucket, a folder on a server. annai builds each backup (a Backup of everything, spec §12.2) and decides when; your type only moves it. annai's own GitHub and Forgejo / Gitea types are plugins too: see `plugins-official/storage-github/` and `plugins-official/storage-forgejo/`.

```js
export function activate(annai) {
  const { TargetError } = annai.helpers;
  return annai.storage.register({
    type: 'my-place',                    // lowercase letters, digits and dashes
    name: 'My place',
    stores: 'file',                      // "tree": the archive's files, unpacked; "file": the archive file itself
    fields: [{ key: 'url', label: 'Address', placeholder: 'https://…' }],
    secret: [{ key: 'password', label: 'Password' }],
    where: (config) => config.url,
    async check(c) { return { note: 'Works.' }; },
    async list(c) { return [/* { id, at, device?, label? }, newest first */]; },
    async put(c, archive, o) { /* … */ return { id, at }; },
    async get(c, id, o) { /* … */ return blob; },
  });
}
```

- **`c`** is `{ config, secret, device: { id, label }, app }`. `secret` holds what the user typed in your `secret` fields. annai keeps it in its secrets store, never in files, backups or the trace.
- **`put(c, archive, o)`** gets `archive = { blob, name, manifest }` and `o = { base, maxUpload, signal, onProgress }`.
  - **Single writer:** refuse with `new TargetError('newer', words, { remote })` when the place's newest backup is neither `o.base` nor one this device made (`c.device.id`). annai then asks the user.
  - **Size:** refuse with `TargetError('large', words, { bytes })`, before uploading anything, when you would send more than `o.maxUpload` bytes.
  - **Progress:** call `o.onProgress({ phase: 'uploading', done, total })` as you go, and stop when `o.signal` aborts.
  - **Whole files** (`stores: 'file'`): annai names the file (`archive.name`, made with `annai.helpers.backupFiles.name`), encrypts it when the place says so, checks its size and the place's newest backup before calling `put`, and deletes this device's older backups with your `delete`. Your `list` turns file names back into backups with `annai.helpers.backupFiles.parse(name)`, which returns null for other files. `put` only stores the file.
- **`get(c, id, o)`** returns the backup as an annai archive file (a `Blob`), which annai opens on its import screen.
- **`check(c)`** tests the place for Save and test, and returns `{ note }`, the words shown.
  - **Fields left empty:** a place that can find one (the Forgejo place finds the repository from the token) returns it as `config` too, such as `{ note, config: { repo } }`. annai keeps it as the place's own setting, so later calls get it.
  - **Several to choose from:** refuse with `new TargetError('setup', words, { choices: [{ label, config }] })`. The place's screen shows a button for each, which fills in its `config` and tests again.
- **`delete(c, id)`**, optional, removes one backup.
- **`browserAccess(origin)`**, optional, returns `{ text, code }`: what the place must allow for annai at that origin (CORS rules, server headers). The place's screen shows it, with a Copy button.
- **Read every answer with `annai.helpers.readAnswer(res, 'json' | 'text' | 'blob' | 'arrayBuffer', where)`.** Whatever is wrong with an answer (not JSON, cut off, over 8 MB of text) becomes a `TargetError`, so a broken or hostile server never counts as a bug in your plugin. `annai.helpers.xml.elements(xml, name)` and `.text(xml, name)` read XML answers in one pass, and never throw.
- **Errors are answers:** throw a `TargetError` with a kind and plain words:
  - `auth`, `refused`, `missing` and `setup` need the user, so annai shows a card once.
  - `rate` (with `retryAt`) and `other` are tried again later.
  - A `TypeError` and the like count as a bug in your plugin.
- **Send every request through `annai.net.fetch`,** so the trace shows it.

## MCP servers

annai's own MCP client (a built-in plugin) gives Shiori the tools of the MCP servers a user adds in Settings → Tools → MCP servers; a plugin doesn't need code for that. What annai needs from a server:

- **The Streamable HTTP transport** (MCP 2025-03-26 or later; annai asks for 2025-06-18): one JSON-RPC message per POST, answered as JSON or as an SSE stream. annai doesn't open the GET stream, and skips the server's own requests and notifications.
- **Browser access (CORS):** allow annai's address (or `*`), the methods POST, DELETE and OPTIONS, the headers `Content-Type`, `Accept`, `Authorization`, `Mcp-Session-Id`, `MCP-Protocol-Version` and any header the user adds, and list `Mcp-Session-Id` in `Access-Control-Expose-Headers`.
- **Auth:** a bearer token, or headers; annai keeps them in its secrets and never in a file, the log or the trace. A key in the address itself (a path segment or a query value that looks like one) is kept in secrets too, and the address is shown with it blanked; an address with a name and password before an `@` is refused. OAuth isn't there yet.
- **Tools** come as `mcp_<server>_<tool>` (letters, digits, `_` and `-`); the first 100 of a server are used. Text, images (PNG, JPEG, WebP, GIF up to 5 MB) and embedded text resources reach Shiori; `isError` is an error she sees.

## Remote trace (for developers)

annai's official plugin **Remote trace (for developers)** sends annai's trace to a server you run, so you can watch a phone's entries, requests and errors as they happen. Install it from Settings → Plugins → From annai's catalog. It sends nothing until you give it a server address (https, or http only for `localhost` or `127.0.0.1`, with no name or password in it) and the server's token, and turn Send on. The token is kept with your keys, never in a file. Off, reset, removed, or switched off by annai after repeated errors, it stops at once; Reset and Remove also take its settings, device id and token.

- **What it sends:** every entry the log records from the moment Send is on, in every scope, as an opened row of the Trace screen shows it: `{ scope, seq, ts, type, actor, data, refs }`. That is what you write, what Shiori says, her tool calls and results, model turns, web requests (their addresses as the trace keeps them) and errors.
  - It sends a batch 3 seconds after the first entry waiting, or at once when 100 wait.
  - The batch is a POST of `{ app, build, device, dropped, entries }` with `Authorization: Bearer <token>`. `app` is "annai" and its version, `build` annai's build stamp, `device` an id made at the first send and kept in the plugin's settings (its page shows it as Device id, which you may change to a name of your own, so two phones are easy to tell apart), and `dropped` how many entries it dropped since the last batch the server took.
  - Its own requests are in annai's trace, as any plugin's are.
- **What it never sends:**
  - **Keys and its token.** Every entry first goes through `annai.secrets.blank`, annai's own blanking, as annai's cards do, so a key you type into a message is blanked too.
  - **Stored content:** texts over 2,000 characters (such as model replies and their reasoning), photos and other bytes. Only their names and hashes go.
  - **Location points,** unless you turn on Send location points. Other entries can still name a place, as the Trace shows them: a weather request's address, a tool's input.
  - **Entries from before Send was on, or after it went off.**
  - **Entries a plugin caused** (its own requests and model calls, its `plugin.error`), because no plugin's hooks get those (see "Following the log").
- **Offline, or refused:**
  - It keeps the newest 2,000 entries, and at most 4 MiB of them, and counts the ones it drops.
  - It tries again after 3 seconds, then twice as long each time, up to once a minute. While the browser says it is offline it doesn't try, and it tries at once when it is back online.
  - A server that keeps refusing (any answer that isn't 2xx) gives one card, not one per batch.
  - A server that answers 413 or 400 gets half the batch next, and an entry it still refuses on its own is dropped and counted, so one entry can't hold up the rest.
  - Without a token, or with one a request can't carry (spaces, letters beyond ASCII), it says so on one card and keeps what waits; the token is read at every try, so saving it is enough.
- **The dock** shows a "Trace" chip while it is sending; tapping it opens the plugin's page.

**The sink.** `scripts/trace-sink.mjs` is a small receiving server with no dependencies:

```bash
node scripts/trace-sink.mjs --port <p> (--token-file <path> | --token <t>) --out <file.jsonl> [--origin <allowed origin>]...
```

- **The token** must be at least 16 characters; `openssl rand -hex 16` makes one. Give it in a file (`--token-file`, which keeps it out of your shell's history and the process list) or in `TRACE_SINK_TOKEN`; `--token` works too.
- **What it takes:** batches with that token, from `https://annai.guide` and each `--origin` you add (more than one is fine), at most 1 MiB each. It listens on 127.0.0.1 only. Ports 8765, 8790–8792, 8796, 8797 and 18010–18014 are annai's own, so it refuses them.
- **What it writes:** each entry, appended to the file as one JSON line `{ received, device, build, ...entry }`, and one line `{ received, device, build, dropped }` when a batch says entries were dropped. Watch it with `tail -f trace.jsonl`, or pick from it with `jq`, such as `jq -c 'select(.type == "error")' trace.jsonl`. A disk that fills up while it writes can leave a line cut short, a torn line: the sink answers 500, so the plugin sends that batch again, and the sink starts its next write on a new line, so the torn one stays alone. `jq -cR 'fromjson? // empty' trace.jsonl` reads the file past it.
- **From a phone:** the phone needs https. On a tailnet, `tailscale serve` gives that:

  ```bash
  (umask 077; openssl rand -hex 16 > trace-token)
  node scripts/trace-sink.mjs --port 8798 --token-file trace-token --out trace.jsonl
  tailscale serve --bg --https=8443 http://127.0.0.1:8798
  cat trace-token   # to type into annai on the phone
  ```

  Then, in annai on the phone, set the server address to `https://<this machine's name on your tailnet>:8443/`, give the same token, and turn Send on. `tailscale serve --https=8443 off` stops the https side.

**A server of your own** needs to:

- take the POST;
- answer 2xx;
- allow annai's origin for CORS, with the `Authorization` and `Content-Type` headers, on its error answers too, so the plugin can tell a refused token from a server it can't reach.

## Rules

- **Keep content as files.** annai stores each piece of content once and points files and log entries at it. Removing *any* trip deletes every stored piece that no file and no log entry points at, wherever it came from (spec §4.9).
  - Content a plugin writes with `annai.files` is always safe.
  - Content put into storage any other way, for example through the database directly, disappears the next time someone removes a trip.
  - Content a plugin keeps in a log entry goes through `annai.events.append(scope, type, data, { texts, blobs })`, which stores it and names it in the entry's refs.
- **Use only what `annai` gives you.** Anything else annai has is internal and changes without notice.
- **Never put API keys or other secrets in files or log entries.** Files and logs end up in exports and backups.
