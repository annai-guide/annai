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
  - `category`: `providers`, `speech`, `backup`, `tools`, `skills` or `developer`, the kind it is listed under. When absent it is worked out: a provider with chat is `providers`, one with speech only `speech`, a backup place's plugin `backup`, a protocol `developer`, skills or personalities without code `skills`, other code `tools`.
  - `keywords`: up to 20 other names it is searched by, written as they are shown (`["Unsloth", "LM Studio"]`).
  - `templates` (endpoint templates, before providers) is refused: "Endpoint templates were replaced by `provider`".
  - `files`: every other file of the package, such as modules your entry imports. annai needs it only to install the package from an address (see "Installing"). A module you leave out isn't there once installed from an address, and the plugin won't start; the error is the browser's own, and it names your entry file, not the missing module (Chrome: "Failed to fetch dynamically imported module: …/index.js"; Safari names no file at all: "Importing a module script failed.").
  - `settings`: a JSON Schema object; annai draws a form from it on your plugin's page in Settings → Plugins. See "Settings" below.
- **Size:** a package may unpack to at most 64 MiB.

annai copies the package into its own storage, so the plugin works offline, and serves its files at `/plugins/<id>/…`. Relative imports between a plugin's own modules therefore just work. A package's files keep no history: installing it again replaces them.

A package's id is one name space with every other package: a skill is installed under its own name, and a skill name Shiori already has (one of annai's own, or another package's, on or off) can't be installed again. The id of one of annai's own plugins (any in its catalog) can't be taken by a package from a file or an address: "annai's own plugin uses this name".

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
| `annai.register(kind, item)` | adds something to the registry; returns a function that removes it |
| `annai.schemas.register({ scope, pattern, schema })` | a JSON Schema that files at matching paths must pass. An invalid write is refused, and the refusal says why. |
| `annai.tools.register(tool)` | a tool: a name (letters, digits, `_` and `-`, up to 64), a description, an input JSON Schema and `run(input, call)` (spec §5.4). `call` has `trip` (the open trip's scope, or null), `signal` (stop when it aborts), `model` (the model that called it) and `fetch` (traced). Errors become results Shiori sees. Every tool can be switched off in Settings → Tools. |
| `annai.events.append(scope, type, data, keep?)` | appends an entry to a scope's log, signed `plugin:<id>`. `keep = { texts: [[name, text]], blobs: [{ bytes, type }] }` stores content and names it in the entry's refs; long texts are kept that way, short ones go in `data`. Returns the entry. |
| `annai.files` | the files of every scope: `read`, `readText`, `readJSON`, `list`, `write`, `patch`, `delete`, `history`, `restore` |
| `annai.providers.register(type)` | an endpoint type (spec §9.1): `build()` and `read()` for an HTTP protocol, or `run()` for one that needs no network; see "Protocols (endpoint types)" below |
| `annai.storage.register(type)` | a kind of place to back up to (spec §12.4); see "Backup places" below |
| `annai.helpers` | `sse` (server-sent events from a response body), `parsePartialJSON`, `ProviderError`, `errorFromResponse`, `retry`, `tsv(header, rows)` (TSV for the model, spec §4.7), `mergePatch`, `TargetError`, `readAnswer`, `xml` and `backupFiles` (see "Backup places"), `zip` (`ZipReader`, `ZipWriter`: annai's own zip) |
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
| `annai.register('skill', { name, description, text, files?, read? })` | a skill: Shiori sees its name and description, and loads the text with the `skill` tool. `text` is a string or a function returning one; `files()` lists its other files, and `read(file)` gives `{ bytes, type }` or null. A name another plugin or annai has is refused. Skills in a package's `skills` don't need this. |
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

- **From a file:** Settings → Plugins → Install from a file: a zip, or a `SKILL.md` on its own.
- **From an address:** Settings → Plugins → Address of a plugin or skill. The address holds one of:
  - a zip file, whatever its name;
  - an `annai-plugin.json`: annai fetches the files it names (`entry`, each skill's `SKILL.md`, `personalities`, and `files`), relative to it;
  - a `SKILL.md`: annai fetches the files its links point to inside the skill's folder.

  The site must let web apps read it (GitHub's raw files do; a `github.com/…/blob/…` page is read from there). At most 200 files and 64 MB. A key in the address (a path segment or a query value that looks like one) is kept in a secret of annai's own, apart from your plugin's `annai.secrets`, which annai uses to look for updates; the address is shown and kept everywhere else with `«key»` in its place. An address with a name and password before an `@` is refused.
- **From annai's catalog:** Settings → Plugins lists annai's own plugins that aren't installed; a model provider is added from Settings → Models.
- **The install screen** comes first, for a file or an address: what the package is, where it came from, what it brings, and what it needs ("It needs: Chat Completions (from annai, installed with it)"). A package with code says, in the spec's words, "This plugin gets full access to your trips and API keys." A provider says where keys go, by origin: "Keys you give this provider are sent to https://llm.example." Install stays off while a requirement can't be had (a third party's not installed, or one the user switched off).
- **Requirements** are installed with your plugin, all or nothing: if a download fails or the connection drops, nothing stays half-installed. A plugin the user switched off is never switched on for yours: the install stops and says how.
- **Updates:** a package installed from an address is checked there when annai starts, when it comes back to the screen at most once a day (so your site isn't asked at every return), and on Check now in Settings → Updates; a changed package (its files, not just its version) is offered on a card, in Settings → Updates and in Settings → Plugins. Nothing changes until the user taps Update. An update that brings something new (code where there was none, new skills or personalities, or a provider that sends keys to a new origin: scheme, host and port) lists it and asks again, with the full-trust words for new code. What an update now requires is installed on Update. Code that already ran runs the new version from the next start.
- **Removing** removes everything the package stored: its files, its settings (`annai.settings`), its secrets (`annai.secrets`), its tools' switches, and what it kept in the system log with `annai.events.append('sys', …)`. What it wrote into a trip stays: that is the trip's. Removing a provider plugin removes the providers made from it, with their keys and models; removing the last provider made from it removes the plugin. Then annai's own protocol plugins that nothing requires and no switched-on ability uses go too; a third party's stays.

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
- **Components,** `annai.ui.component(name, impl)`; the last plugin to register one wins, and annai's own is used when yours fails:
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

- **The provider:** `baseUrl` (empty when the user gives one); `key`: `required`, `optional` or `none` (no key field); `keyHeader` when the key goes in a header of its own rather than the protocol's way (annai puts it there and gives the protocol no key); `keyUrl` and `note` for its page; `headers` sent with every ability's requests; `local: true` for a server the user runs. Every address must be https, or http only for `localhost` or `127.0.0.1`.
- **Where a key goes is checked where it is sent.** annai fetches what a protocol builds only at the origin of its ability's address; any other request is refused, unsent ("…built a request to <origin>, not its address <origin>. Check its tunables."). A tunable a protocol joins onto the address (`path`, `listPath`), on an ability, a model or `modelDefaults`, must be a path from it: starting with `/`, with no `//` or `@`.
- **Each ability** (an id of lowercase letters, digits and dashes) has a `kind` (`chat`, `transcription`, `voice`), a protocol's `type`, and optionally a `name`, `on: false` to start switched off, its own `baseUrl`, `tunables`, `extraBody`, a `note`, `modelDefaults` (what a model added by id or from a list starts with, such as `providerTools` or `cacheTtls`) and `models` (each with a `providerId`, and the model settings of spec §9.2).
- **`roles`** suggests models: `recommended` and `free`, each role to provider model ids among the abilities of its kind (chat roles `main`, `utility`, `decide`; `speech-in` transcription; `speech-out` voices). Adding a provider fills chat roles still empty; its speech models go behind the free entries.
- **`requires`** must cover every protocol of an ability that starts on. One that starts off brings its protocol when the user turns it on.
- **One key per provider.** The user may add several providers from one plugin (two accounts); each has its own key, models and places in roles. annai keeps the key in its secrets; your plugin never sees it.
- **Updates:** when your plugin's version changes, the providers made from it take the new description; the user's own changes stay, new models join no role, and a new ability arrives switched off.

**Quirks are data.** A server's differences are written in its description, not in code. The servers people run show how (`plugins-official/provider-llamacpp`, `-vllm`, `-sglang`, `-ollama`, `-lmstudio`): each has its default address, `local: true`, notes on how to let annai's address in, and how its thinking is switched, as the reasoning map every model added from its list starts with. llama.cpp's, trimmed:

```json
"chat": { "kind": "chat", "type": "chat-completions",
  "modelDefaults": { "reasoning": {
    "off": { "reasoning_effort": "none", "chat_template_kwargs": { "enable_thinking": false } },
    "medium": { "reasoning_effort": "medium", "chat_template_kwargs": { "enable_thinking": true } } } } }
```

Each level is a patch merged into the request body (spec §9.3), and level off is what a quick decision asks for. vLLM's and SGLang's maps send `reasoning_effort` and `chat_template_kwargs` (`enable_thinking` and `thinking`, as their models' templates read one or another; the explicit kwargs win where a server derives them from the effort); Ollama's names only off (`"reasoning_effort": "none"`) and leaves low, medium and high empty, so they send nothing and Ollama decides how hard a model thinks: it refuses any named level for a model that can't think. An empty level is still a level, and the nearest one to a level the map lacks. A tunable can be a quirk too: llama.cpp's chat turns on Chat Completions' `enforceToolCall`, so a tool annai forces (the quick decision's) goes as `tool_choice: "required"` when it is the only tool offered, as llama-server accepts a named tool but doesn't force it. Where reasoning comes back, and usage in the stream, are the protocol's (Chat Completions reads `reasoning_content` and `reasoning`), so they need nothing. `keywords` let a search find a plugin by another name: llama.cpp's include Unsloth and KoboldCpp, which run it.

## Protocols (endpoint types)

An endpoint type teaches annai one model protocol. The core contains none (spec §9.1).
annai's own Chat Completions, Anthropic Messages and OpenAI Responses types are plugins too: see `plugins-official/`. A protocol's `endpoint` is a provider's ability: `{ id: "<provider>/<ability>", provider, ability, type, name, baseUrl, headers, tunables, extraBody }`, its `name` the provider's. Providers require a protocol as `^N` of its version's major, so its major is its interface: change it only when a provider would have to change.

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
  - `listRequest()` and `readList()` make "Fetch model list" work.
  - `uploadRequest({ endpoint, key, tunables, bytes, mediaType, name, expiresInSeconds })` and `readUpload(json)` let photos go to the provider's files API (spec §4.8). annai uploads each photo once, sets it to expire after 48 hours, uploads it again when it expires or the provider no longer knows it (classify that error as `upload`), and sends the bytes instead if uploading fails. Image parts then carry `fileId`: send that instead of the bytes. A user can turn uploads off on the provider's page, per ability (the `uploads` tunable).

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
