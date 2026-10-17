# Writing an annai plugin

This guide covers the plugin interface as it is built today: plugin API version 1, through milestone 8a (skills and packages). The full design is in the spec, [§5 Plugin system](superpowers/specs/2026-10-15-annai-design.md#5-plugin-system). The interface grows with later milestones, and this guide grows with it.

A code plugin is trusted fully. It runs on annai's own page, with the same powers as annai's built-in parts, and the install screen tells the user so (spec §5.1).

## The package

A package is one of two kinds:

- **A skill**, in the open [Agent Skills](https://agentskills.io/specification) format: a folder with `SKILL.md`, and optional `references/`, `assets/` and `scripts/` (annai never runs scripts). No `annai-plugin.json` is needed. See "Skills" below.
- **A plugin**: a folder or a zip with `annai-plugin.json` at its top, either directly or inside one top folder. It may have code (an `entry` module), and it may bring skills, personalities and endpoint templates without any code.

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
  - `templates`: JSON files of endpoint templates, `{ "endpoints": [{ "id", "version", "type", "name", … }] }`, in the format of annai's own `catalog/templates.json`. They join annai's in Settings → Models; annai's own win on the same id.
  - `files`: every other file of the package, such as modules your entry imports. annai needs it only to install the package from an address (see "Installing").
  - `settings` (spec §5.2).
- **Size:** a package may unpack to at most 64 MiB.

annai copies the package into its own storage, so the plugin works offline, and serves its files at `/plugins/<id>/…`. Relative imports between a plugin's own modules therefore just work. A package's files keep no history: installing it again replaces them.

A package's id is one name space with every other package: a skill is installed under its own name, and a skill name Shiori already has (one of annai's own, or another package's, on or off) can't be installed again.

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
| `annai.providers.register(type)` | an endpoint type (spec §9.1): `build()` and `read()` for an HTTP protocol, or `run()` for one that needs no network; see "Endpoint types" below |
| `annai.storage.register(type)` | a kind of place to back up to (spec §12.4); see "Backup places" below |
| `annai.helpers` | `sse` (server-sent events from a response body), `parsePartialJSON`, `ProviderError`, `errorFromResponse`, `retry`, `tsv(header, rows)` (TSV for the model, spec §4.7), `mergePatch`, `TargetError`, `readAnswer`, `xml` and `backupFiles` (see "Backup places"), `zip` (`ZipReader`, `ZipWriter`: annai's own zip) |
| `annai.secrets.get(name)`, `.set(name, value)` | your plugin's own secrets, such as an API key. Never put them in files or log entries. |
| `annai.llm(role, request)` | a model call through a role (`main`, `utility`, `decide`), with fallback; returns the reply. It is in the trace, tagged `plugin:<id>`. |
| `annai.llm.decide({ prompt, options, threshold? })` | a quick decision (spec §9.7): `{ optionId: probability }` |
| `annai.wake(reason)` | wakes Shiori, with the reason she sees. Quiet hours and the per-hour limit apply (spec §6.6). |
| `annai.net.fetch(url, init?)` | a web request, recorded in the trace without any secret annai keeps |
| `annai.ui.card({ title, body, tone?, actions? })`, `annai.ui.toast(text)` | a system card or a toast. These are never in Shiori's voice. |
| `annai.cache.state()` | the prefix cache of the model Shiori used last: `{ modelId, ttlMs, expiresAt, warm }`, or null (spec §6.4) |
| `annai.settings.get()`, `.set(changes)` | your plugin's own settings, a JSON object (merge patch to change) |
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
  - an `annai-plugin.json`: annai fetches the files it names (`entry`, each skill's `SKILL.md`, `personalities`, `templates`, and `files`), relative to it;
  - a `SKILL.md`: annai fetches the files its links point to inside the skill's folder.

  The site must let web apps read it (GitHub's raw files do; a `github.com/…/blob/…` page is read from there). At most 200 files and 64 MB.
- **From annai's catalog:** Settings → Plugins lists annai's own plugins that aren't installed.
- **The install screen** comes first, for a file or an address: what the package is, where it came from, and what it brings. A package with code says, in the spec's words, "This plugin gets full access to your trips and API keys."
- **Updates:** a package installed from an address is checked there when annai starts and once a day; a changed package (its files, not just its version) is offered on a card and in Settings → Plugins. Nothing changes until the user taps Update. An update that brings something new (code where there was none, or new skills, personalities or templates) lists it and asks again, with the full-trust words for new code. Code that already ran runs the new version from the next start.
- **Removing** removes everything the package stored: its files, its settings (`annai.settings`), its secrets (`annai.secrets`), its tools' switches, and what it kept in the system log with `annai.events.append('sys', …)`. What it wrote into a trip stays: that is the trip's.

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

## Endpoint types

An endpoint type teaches annai one model protocol. The core contains none (spec §9.1).
annai's own Chat Completions and Anthropic Messages types are plugins too: see `plugins-official/`.

```js
export function activate(annai) {
  const { sse, ProviderError } = annai.helpers;
  return annai.providers.register({
    type: 'my-protocol',                 // lowercase letters, digits and dashes
    name: 'My protocol',
    tunables: { path: '/v1/chat' },      // defaults the user can change per endpoint and model
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
  - It merges the endpoint's and the model's extra fields, and the reasoning level's patch, into the body `build()` returns.
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
- **Errors:** throw a `ProviderError` with a kind (`auth`, `credit`, `rate`, `overloaded`, `context`, `network`, …) and the fallback will know what to do. Anything else you throw counts as a bug in your plugin.
- **Optional parts:**
  - `classify(status, body)` can give a sharper kind for an error response.
  - `listRequest()` and `readList()` make "Fetch model list" work.
  - `uploadRequest({ endpoint, key, tunables, bytes, mediaType, name, expiresInSeconds })` and `readUpload(json)` let photos go to the provider's files API (spec §4.8). annai uploads each photo once, sets it to expire after 48 hours, uploads it again when it expires or the provider no longer knows it (classify that error as `upload`), and sends the bytes instead if uploading fails. Image parts then carry `fileId`: send that instead of the bytes. A user can turn uploads off on the endpoint's page (the `uploads` tunable).

## Backup places

A backup place keeps annai's backups somewhere else: a git repository, a bucket, a folder on a server. annai builds each backup (a Backup of everything, spec §12.2) and decides when; your type only moves it. annai's own GitHub type is a plugin too: see `plugins-official/storage-github/`.

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
- **`delete(c, id)`**, optional, removes one backup.
- **`browserAccess(origin)`**, optional, returns `{ text, code }`: what the place must allow for annai at that origin (CORS rules, server headers). The place's screen shows it, with a Copy button.
- **Read every answer with `annai.helpers.readAnswer(res, 'json' | 'text' | 'blob' | 'arrayBuffer', where)`.** Whatever is wrong with an answer (not JSON, cut off, over 8 MB of text) becomes a `TargetError`, so a broken or hostile server never counts as a bug in your plugin. `annai.helpers.xml.elements(xml, name)` and `.text(xml, name)` read XML answers in one pass, and never throw.
- **Errors are answers:** throw a `TargetError` with a kind and plain words:
  - `auth`, `refused`, `missing` and `setup` need the user, so annai shows a card once.
  - `rate` (with `retryAt`) and `other` are tried again later.
  - A `TypeError` and the like count as a bug in your plugin.
- **Send every request through `annai.net.fetch`,** so the trace shows it.

## Rules

- **Keep content as files.** annai stores each piece of content once and points files and log entries at it. Removing *any* trip deletes every stored piece that no file and no log entry points at, wherever it came from (spec §4.9).
  - Content a plugin writes with `annai.files` is always safe.
  - Content put into storage any other way, for example through the database directly, disappears the next time someone removes a trip.
  - Content a plugin keeps in a log entry goes through `annai.events.append(scope, type, data, { texts, blobs })`, which stores it and names it in the entry's refs.
- **Use only what `annai` gives you.** Anything else annai has is internal and changes without notice.
- **Never put API keys or other secrets in files or log entries.** Files and logs end up in exports and backups.
