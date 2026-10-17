# Plugin settings Reset — Implementation Plan

**Asked for by the user on 2026-10-18:** "a plugin's setting page can have a reset button to reset user settings including secrets." Brief: `.superpowers/briefs/plugin-reset.md`.

## Choices this plan makes

1. **No restart.** `annai.settings.get()` and `annai.secrets.get()` read storage at every call, so a running plugin sees the reset at its next read. Restarting would run `activate()` again (its screens and tools drawn again, a tool call under way cut off) and can't be done for a built-in without importing it again. The plugin guide says to read settings and secrets when they are needed.
2. **`annai.settings.get()` gives the schema's defaults** for every key nothing is saved for: the manifest's `settings` defaults (writeOnly ones aside), with what is saved over them. That is what the form shows (`default fills it when nothing is saved`), so the plugin and its form now agree on a fresh install as after a Reset. A key without a default stays missing, and the guide says to treat it as the plugin's own default. No shipped plugin has `settings`, so nothing shipped changes.
3. **`annai.secrets.get(name)` gives null** for a secret that isn't there (it gave undefined).
4. **What Reset clears:** `/plugin-settings/<id>.json` in sys:settings with its history, through `forget()` as Remove does, and every secret `plugin:<id>:<name>`. The install address (8a-1) is annai's own secret `package:<id>:address` (fix pass R1; it was `plugin:<id>:address`, which `address()` moves from), so it stays. Everything else stays: the package, its on/off state, its tool switches, what it wrote into trips.
5. **When Reset shows:** on `#/plugins/<id>`, built-in or installed, when the plugin has a settings form, or a settings file (or a version of one) is stored, or it has a secret Reset would clear. So the web plugin's page shows it while a Jina key is set, and Reset clears the key. **Not for the MCP client** (`mcp`): its secrets are its servers' (spec §5.1), which its own screen removes; `PluginHost.saved('mcp')` is null and `reset('mcp')` refuses.
6. **One confirmation** with `twoStep('Reset settings', 'Tap again to reset', …)`, as Remove. The page then says what was cleared, by the form's labels: "Cleared its settings (Trailhead) and its secrets (Token)." It is kept in a note for the next draw, as the backup place screen does.
7. **The log:** `plugin.reset` in the system log, actor `user`, data `{ plugin, name, settings: [keys], otherSettings, secrets: [names], otherSecrets, bytes }`: names only, never values, and only the names the manifest's schema gives (settings keys it has, secrets that are its writeOnly fields); the rest are counted, since a plugin could name one after the user's data (fix pass M6); bytes is what `forget()` freed. A Reset that finds nothing saved changes nothing and logs nothing. Trace → Plugins lists `plugin.reset`.
8. **Ledger** in the worktree's own git-ignored `.superpowers/sdd/plugin-reset/progress.md`, so the main checkout stays untouched.

## Tasks (test-first)

1. **Core** (`src/core/plugins.js`): `saved(id)` → `{ file, keys, secrets } | null`; `reset(id)` → `{ keys, secrets, bytes }`; `settings.get()` with defaults; `secrets.get()` null. Unit tests in `test/unit/plugin-packages.test.js`:
   - a plugin with values in its settings file and two secrets, plus an address secret: no settings file, no history, neither secret afterwards; the address secret, the package, its on/off state, its tool switch and its trip file stay;
   - the `plugin.reset` entry has names and no values;
   - a running plugin reads the defaults and null secrets afterwards;
   - Reset of a plugin with nothing saved is harmless; `mcp` is refused.
2. **The page** (`src/ui/screens/plugin.js`), the trace kind, and the e2e in `test/e2e/ui-extension.spec.js` (both browsers): trail-ui (its Trailhead gets a default) saves a value and a token, Reset twice, reload: the form shows the default, the token field is empty, IndexedDB holds neither the file, its history nor the secret.
3. **docs/plugins.md:** what Reset clears and keeps; treat missing settings as defaults.
4. `npm run stamp && npm run check`, full Docker e2e, size.
