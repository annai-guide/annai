# Writing an annai plugin

This guide covers the plugin interface as it is built today: plugin API version 1, the milestone 1 subset of the design. The full design is in the spec, [§5 Plugin system](superpowers/specs/2026-10-15-annai-design.md#5-plugin-system). The interface grows with later milestones, and this guide grows with it.

A code plugin is trusted fully. It runs on annai's own page, with the same powers as annai's built-in parts, and the install screen tells the user so (spec §5.1).

## The package

A plugin is a folder or a zip with `annai-plugin.json` at its top, either directly or inside one top folder:

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
  - `skills`, `personalities`, `templates`, `settings` (spec §5.2).
- **Size:** a package may unpack to at most 64 MiB.

annai copies the package into its own storage, so the plugin works offline, and serves its files at `/plugins/<id>/…`. Relative imports between a plugin's own modules therefore just work.

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
| `annai.tools.register(tool)` | a tool: a name, a description, an input JSON Schema and `run` (spec §5.4). Only `run` is checked today. Its errors are recorded, then reach the caller as a `PluginError`. |
| `annai.events.append(scope, type, data)` | appends an entry to a scope's log, signed `plugin:<id>` |
| `annai.files` | the files of every scope: `read`, `readText`, `readJSON`, `list`, `write`, `patch`, `delete`, `history`, `restore` |

Every file write goes through one function. It keeps the old version and adds an entry to the log, so anything a plugin changes can be seen in the trace and undone (spec §4.2).

## Rules

- **Keep content as files.** annai stores each piece of content once and points files and log entries at it. Removing *any* trip deletes every stored piece that no file and no log entry points at, wherever it came from (spec §4.9).
  - Content a plugin writes with `annai.files` is always safe.
  - Content put into storage any other way, for example through the database directly, disappears the next time someone removes a trip.
  - `annai.events.append` doesn't take references to stored content yet. Until it does (spec §5.4), keep anything worth keeping in a file.
- **Use only what `annai` gives you.** Anything else annai has is internal and changes without notice.
- **Never put API keys or other secrets in files or log entries.** Files and logs end up in exports and backups.
