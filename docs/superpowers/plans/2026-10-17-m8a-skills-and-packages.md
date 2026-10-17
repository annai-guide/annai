# Milestone 8a: Skills, Packages and Installing From an Address — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone 8's packages and skills (spec §5.1–§5.3, §5.5, §6.3, §7.2 `skill`, §4.9):
- **Skills** in the open Agent Skills format: a folder with `SKILL.md` (front matter read by a small parser of our own), `references/`, `assets/`; `scripts/` never run. Only the name and description sit in Shiori's context; she loads the body, and any file of the skill, with the `skill` tool. annai's own skills move to `skills/` (§19) in the same format.
- **Packages:** a plugin is a folder, zip or address holding `annai-plugin.json`, or a bare skill. Its manifest's `skills[]`, `personalities[]` and `templates` take effect; a new optional `files` list lets a package install from an address.
- **Installing** from a file, from an address (a zip, an `annai-plugin.json`, a `SKILL.md`; GitHub pages read from GitHub's raw files) and from annai's catalog, always through one install screen that says what the package is; code gets the spec's sentence, "This plugin gets full access to your trips and API keys."
- **Updates from an address** are checked at start and once a day with the official ones, offered on the same card and in Settings → Plugins, and change nothing until the user taps Update (§5.3: "those installed from a URL get the same check when that arrives (milestone 8)").
- **Removing means removing:** a package's files, their history, its settings and their history, its secrets, its tool switches and the content it kept in the system log go, and the space comes back.
- **E2E in Chromium and WebKit:** a third-party skill from a zip and from an address, in Shiori's context by name and description only, loaded with the `skill` tool by a stand-in model, then removed; a code plugin from a zip and from an address behind the full-trust screen, working and surviving a reload; an update from an address only on Update.

**Architecture:**
- `src/core/forget.js`: removes files, their history and log entries for good, and frees the content only they named; the stores gain `Tx.deleteEvent`.
- `src/core/skills.js`: the `SKILL.md` parser (front matter subset: strings, a one-level map), name rules, the files a skill links to.
- `src/core/packages.js`: a package as annai reads it (`inspectPackage`), its fingerprint, and `fetchPackage` from an address. The manifest schema and checks move here from `plugins.js`.
- `src/core/plugins.js`: `PluginHost.inspect`, `install` of any package kind, start registering a package's skills, personalities and templates, `uninstall` that forgets.
- `src/core/package-updates.js`: updates for packages installed from an address; `src/ui/plugin-updates.js` offers both kinds.
- `src/plugins/skills/`: the built-in plugin that loads `skills/*/SKILL.md`.
- `src/ui/screens/plugins.js`, `src/ui/screens/plugin-install.js`, `src/ui/plugin-pending.js`: the Plugins screen (file, address, catalog) and the install screen.
- Milestone 8b (`2026-10-17-m8b-ui-extension.md`, written after this plan is built) adds the UI slots, card types, components, screens, themes, hooks, the plugin page with its settings form; 8c adds the MCP client.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26); the store contract also runs against IndexedDB in Chromium and WebKit; Playwright 1.63.0 in Docker.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §5.1 (skills; code plugins' install screen), §5.2 (package and manifest), §5.3 (sources, files copied into storage, updates), §5.4 (content a plugin keeps), §5.5, §4.1–§4.2, §4.9 (everything stored is named; removing frees), §6.3 (skill index), §7.2 (`skill`), §15 (full trust said plainly), §17, §18, §19 (`skills/`), §20 row 8. Agent Skills format: <https://agentskills.io/specification>.

**Not in this plan:**
- 8b: UI slots (status chips, Now-card sections, dock actions, trip tabs, settings pages), card types, replaceable components, whole screens, themes, hooks, a plugin's own page with its settings form (§5.2 `settings`), the card when a running plugin is switched off; the code plugin's UI slot in the "Done when".
- 8c: the MCP client, its stand-in server, Settings → Tools → MCP servers; milestone 8's device checklist.

## Choices this plan makes (please check them)

1. **One name space for packages.** A bare skill installs as a package whose id is its name. A skill and a code plugin can't share an id; a skill name Shiori already has (built in, or from another package) is refused, and so is the name of one of annai's own parts. *Cost if wrong:* two packages with the same name can't both be installed; renaming one is the fix.
2. **A bare skill is stored exactly as shipped,** with no `annai-plugin.json` made up for it; `installed.json` records `kind: "skill"`. Its version is `metadata.version` made semantic ("1.2" → 1.2.0), else 0.0.0, shown as no version. The folder's name needn't match the skill's name (a GitHub download is called `<repo>-main/`). *Cost if wrong:* a stricter reading of the format refuses fewer skills.
3. **Package files keep no history.** An install replaces a package's files outright; the old versions' history and content go at once. File history (§4.2) is for the user's content, and nothing offers to restore a plugin's old code. The system log records `plugin.install`, `plugin.update` and `plugin.remove`. *Cost if wrong:* a broken update can't be rolled back from history (installing the old file again still works).
4. **What removing a package removes:** its files and their history, its settings file (`/plugin-settings/<id>.json`) and its history, its secrets (`plugin:<id>:…`), its tools' switches (the names are recorded at each start, so an off plugin's go too), and what it kept in the system log (entries signed `plugin:<id>` that name content). **What it wrote into a trip stays:** that is the trip's own content and history. The space comes back at once; Trace → Plugins shows `plugin.remove` with the bytes freed. *Cost if wrong:* files a plugin wrote into trips outlive it; deleting them would delete the user's trip content.
5. **annai's own skills move to `skills/<name>/SKILL.md`** (§19), in the format third parties use, loaded by a built-in plugin, "skills", at start (cached for offline use by the service worker). Live mode and the Go tools no longer register them. *Cost if wrong:* none to the user; a skill file missing from the cache is left out, and the others still load.
6. **Installing from an address** reads one address: a zip (by its first bytes, whatever its name), an `annai-plugin.json` (then the files it names: `entry`, each skill's `SKILL.md`, `personalities`, `templates`, and a new optional `files` list for everything else, such as modules the entry imports), or a `SKILL.md` (then the files its links point to inside the skill's folder; a linked file that can't be downloaded is left out). A GitHub page address (`github.com/…/blob/…`) is read from `raw.githubusercontent.com`. At most 200 files and 64 MiB. Each request is in the trace (system log, "plugins"). Nothing is stored until the user taps Install. *Cost if wrong:* a package whose code imports files it doesn't list in `files` fails to start, and says which file.
7. **Updates from an address** are found by the package's fingerprint (a SHA-256 of every file and its name), so a changed skill without a version is offered too, as "changed". Checked with the official ones: at start and once a day. Update downloads again and installs what is there then; it is refused if the address now holds another id; an off package stays off; code already running needs a restart, as for official updates. *Cost if wrong:* a daily request to each package's address while annai is open.
8. **The install screen** comes before every install from a file or an address: name, version, author, homepage, where it came from, what it brings (code; each skill with its description; personalities; templates), and what it replaces. A package with code says, as its own paragraph, "This plugin gets full access to your trips and API keys." A package without code says that a skill is instructions Shiori follows, and that annai never runs anything in it. annai's catalog lists its own plugins with an Install button and no extra screen: they are annai's, checked against the catalog's hashes. *Cost if wrong:* one more tap for annai's own plugins.
9. **The `skill` tool takes an optional `file`:** the body comes with a line listing the skill's other files; a file comes back as text when it is text (scripts included: Shiori may read them, annai never runs them), as an image for PNG, JPEG, WebP and GIF up to 5 MB, else described. *Cost if wrong:* none; it is one input.
10. **A skill installed or removed shows in Shiori's context at her next wake,** warm cache or not, the way a new tool already does; the skill index is listed once per name (the first one wins). *Cost if wrong:* one cold cache after an install.
11. **The front matter parser reads** `key: value` (plain, `'…'`, `"…"` with escapes), `|` and `>` blocks, folded continuation lines, `#` comments, a one-level map (`metadata:`) and a list (joined with spaces, for `allowed-tools`); everything else is skipped; values are trimmed; a plain value may hold `: `. It accepts CRLF and a byte-order mark. A skill's name is 1 to 64 lowercase letters, digits and dashes, not starting or ending with a dash, without two in a row; its description at most 1024 characters. A zip with several bare skills is refused: install each on its own, or add an `annai-plugin.json` that lists them. *Cost if wrong:* a SKILL.md using more of YAML loses the parts we skip.
12. **Personalities from a package** are offered in Settings → Shiori ("From plugins"); Add copies one into `/me/personalities/` as the user's own file, so removing the package leaves it. **Templates from a package** join the endpoint templates in Settings → Models; annai's own catalog wins on the same id. *Cost if wrong:* a plugin's personality isn't updated with the plugin once added.
13. **Junk in zips is skipped:** `__MACOSX/`, `.DS_Store`, `Thumbs.db`, `desktop.ini` and folder entries. A Windows path (a backslash) is refused with its name.
14. **Copy:** the Plugins screen's "Uninstall" becomes **Remove** ("Tap again to remove"), as the spec says removing; the file button is **Install from a file** (zips and `SKILL.md` files); the address field is **Address of a plugin or skill** with **Get it**.
15. **The size budget** is raised in Task 11 by what this plan adds (estimated +40 KiB, to 1360 KiB); the report lists it.

## Global Constraints

- **Zero runtime dependencies;** native ES modules; no build step; JSDoc types pass `npm run typecheck`.
- **Before every commit:** `npm run stamp && npm run check` must pass, chained with `&&`, then the commit. Commit messages: a plain-words summary line, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB
  ```
- **Every file under `src/`, `assets/` and (from Task 3) `skills/` is listed in `sw.js` `SHELL`;** a unit test checks it. Run `npm run stamp` after shipped files change; `npm run catalog` after changing `plugins-official/`.
- **"Skills. The open Agent Skills format: a folder with SKILL.md, plus optional references/ and assets/. Only name and description sit in Shiori's context. She loads the body with the skill tool. The front matter is parsed by a small parser for the subset the standard uses: strings, plus a one-level metadata map. scripts/ are not run" (§5.1).**
- **"Code plugins. Full-trust ES modules with the same powers as built-ins. The install screen says so plainly: 'This plugin gets full access to your trips and API keys.'" (§5.1).** That sentence, exactly.
- **"Files are copied into storage. They work offline, and they change only when the user accepts an update" (§5.3).** "nothing changes until the user taps Update, and the new code runs from the next start" (§5.3).
- **"Everything stored must be named… Whatever annai or a plugin keeps… is a file, or is listed in the refs of the log entry that made it" (§4.9).** Removing a plugin, skill or MCP server removes everything it stored; no recycle bin (the user's rule).
- **Keys never appear in context, files, events or the trace (§9.9).** A package's address is shown and traced as `traceUrl` keeps it.
- **Anything parsed from a server's answer goes through `answerJSON`, `answerBytes` (Task 8) or is guarded,** so a broken answer is a plain `Error`, never a `TypeError`/`SyntaxError`/`RangeError`.
- **Rendering:** plugin- and package-supplied text (names, descriptions, authors) only as text; links only `https:`/`http:`; no `innerHTML`; no `style` attribute; CSP stays `script-src 'self'`.
- **Copy:** plain words; every error says what happened and what to do next; system cards are never in Shiori's voice (§16.1).
- **E2E in Docker only:** `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test <spec>`; stand-in servers on port 0; never host ports 8765, 8790, 8791, 8792, 8796, 8797; delete any `core*` file a WebKit crash leaves; WebKit can't `page.route` a page the service worker controls (use `startModelServer`).
- **Work in the worktree** `/mnt/optane/work/annai/.claude/worktrees/m8-extensions`, branch `m8-extensions`; never `git stash`, push, merge or switch branches.

## Review Focus

1. **Zips as people make them:** macOS's `__MACOSX/` and `.DS_Store`, GitHub's "Download ZIP" (`<repo>-main/` around everything), a Windows backslash path, a package nested two folders deep: the skill or plugin installs, or the refusal names the file. Pinned in Task 4.
2. **`SKILL.md` as people write it:** CRLF line endings, a byte-order mark, a quoted description with `\"`, a plain description holding `: `, a folded `>` description, a comment line, an unclosed front matter, an uppercase name: read, or refused with the reason. Pinned in Task 2.
3. **Addresses that aren't packages, or fail:** a GitHub folder page (HTML), a 404, a server that doesn't let web apps read it (a fetch `TypeError`), an answer too large, a manifest naming `../x.js`, an `ftp:` address: a plain error that says what to do, nothing stored. Pinned in Task 8.
4. **An address that changes underneath:** offline at the check, now serving a broken package, now serving another id, the package off when updated: no offer or a plain refusal, nothing changes, an off package stays off. Pinned in Task 9.
5. **Removing while content is shared or the plugin is off:** content a trip also uses stays; an off plugin's tool switches go; a removed skill is gone from Shiori's next wake. Pinned in Tasks 1, 6 and 7.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/types.js`, `src/core/store-idb.js`, `src/core/store-memory.js`, `test/contract/store-contract.js`, `src/core/forget.js` | 1 | `Tx.deleteEvent`; `forget(store, scope, match)` |
| `src/core/skills.js` | 2 | `parseSkill`, `frontMatter`, `checkSkillName`, `skillLinks`, `skillVersion`, `SkillError`, `SKILL_FILE` |
| `skills/*/SKILL.md`, `src/plugins/skills/index.js`, `src/core/live/live.js`, `src/plugins/go/index.js`, `src/app/main.js` | 3 | annai's own skills as files; the built-in loader |
| `src/core/packages.js` | 4 | manifest schema and checks (moved), `inspectPackage`, `skillManifest`, `fingerprint` |
| `src/core/plugins.js` | 5 | `inspect`, `install` of any kind, content at start, `describe` rows |
| `src/core/agent/self-tools.js`, `src/core/agent/context.js`, `src/core/llm/templates.js`, `src/core/llm/service.js` | 6 | `skill({ name, file })`; the skill index at the next wake; templates from packages |
| `src/core/plugins.js` | 7 | `uninstall` that removes everything the package stored |
| `src/core/answer.js`, `src/core/packages.js` | 8 | `answerBytes`; `fetchPackage`, `rawAddress` |
| `src/core/package-updates.js`, `src/ui/plugin-updates.js`, `src/app/main.js` | 9 | `addressUpdates`, `updateFromAddress`; one offer for both kinds |
| `src/ui/screens/plugins.js`, `src/ui/screens/plugin-install.js`, `src/ui/plugin-pending.js`, `src/ui/router.js`, `src/ui/shell.js`, `src/ui/screens/shiori.js`, `src/ui/screens/trace.js`, `src/ui/base.css` | 10 | the Plugins screen, the install screen, personalities from plugins, Trace → Plugins |
| `test/e2e/extensions.spec.js`, `test/e2e/helpers.js`, `test/fixtures/extensions/…`, `docs/plugins.md`, `scripts/size.mjs` | 11 | the "Done when" parts of 8a end to end; the plugin guide; the size budget |

---

### Task 1: Removing frees space (`Tx.deleteEvent`, `forget`)

**Files:**
- Modify: `src/core/types.js` (the `Tx` typedef), `src/core/store-idb.js` (`makeTx`), `src/core/store-memory.js` (`makeTx`), `test/contract/store-contract.js`, `sw.js` (`SHELL`)
- Create: `src/core/forget.js`
- Test: `test/contract/store-contract.js` (runs in Node through `test/unit/store-memory.test.js` and in browsers through `test/browser/suites/store-idb.js`), `test/unit/forget.test.js`

**Interfaces:**
- Produces: `Tx.deleteEvent(scope: string, seq: number): Promise<void>` (no error when nothing is there). `forget(store: Store, scope: string, match: { files?: (path: string) => boolean, history?: (path: string) => boolean, events?: (e: EventRecord) => boolean }): Promise<{ files: number, events: number, bytes: number }>` — one read-write transaction over `files`, `events`, `blobs`, `scopes`: deletes the scope's current files whose path matches `files`, its `file.write`/`file.delete` entries whose `data.path` matches `history`, and its entries matching `events`; then deletes every blob those named (file hashes, `data.old`, `data.new`, `refs`) that `blobInUse` no longer finds, and returns how many of each went and the bytes freed (sizes from `listBlobs`).

- [ ] **Step 1: Write the failing tests**

In `test/contract/store-contract.js`, after "events: putEvent keeps its seq…":
```js
  test('events: deleteEvent removes one entry, from every index', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', async (t) => {
      await t.appendEvent('a', { ts: 1, type: 'x', actor: 'user' });
      await t.appendEvent('a', { ts: 2, type: 'file.write', actor: 'user', data: { path: '/p', old: null, new: 'h-new' }, refs: ['h-ref'] });
      await t.appendEvent('a', { ts: 3, type: 'x', actor: 'user' });
      await t.appendEvent('b', { ts: 1, type: 'file.write', actor: 'user' });
    });
    await s.tx(['events'], 'readwrite', (t) => t.deleteEvent('a', 2));
    await s.tx(['events'], 'readwrite', (t) => t.deleteEvent('a', 99)); // nothing there: no error
    const got = await s.tx(['files', 'events'], 'readonly', async (t) => ({
      seqs: (await t.listEvents('a')).map((e) => e.seq),
      typed: (await t.listEvents('a', { types: ['file.write'] })).length,
      b: (await t.listEvents('b')).length,
      used: [await t.blobInUse('h-new'), await t.blobInUse('h-ref')],
    }));
    assert.deepEqual(got, { seqs: [1, 3], typed: 0, b: 1, used: [false, false] });
  });
```

`test/unit/forget.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, SYS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { forget } from '../../src/core/forget.js';
import { record } from '../../src/core/agent/log.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
}
const stored = async (/** @type {any} */ store, /** @type {string} */ s) => store.tx(['blobs'], 'readonly', async (/** @type {any} */ t) => t.hasBlob(await sha256Hex(utf8(s))));
const inTides = (/** @type {string} */ p) => p.startsWith('/tides/');

test('forget: files under a prefix go with their whole history, and the space their content took comes back', async () => {
  const { store, ws } = await setup();
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v1 code', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v2 code', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/tides/notes.md', 'notes', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/other/index.js', 'other code', { author: 'system' });
  const r = await forget(store, SYS_PLUGINS, { files: inTides, history: inTides });
  assert.deepEqual(r, { files: 2, events: 3, bytes: 'v1 code'.length + 'v2 code'.length + 'notes'.length });
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/')).map((f) => f.path), ['/other/index.js']);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tides/index.js'), []);
  assert.equal(await stored(store, 'v1 code'), false);
  assert.equal(await stored(store, 'other code'), true);
});

test('forget: content something else still names stays', async () => {
  const { store, ws } = await setup();
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(SYS_PLUGINS, '/tides/table.md', 'shared', { author: 'system' });
  await ws.write(trip, '/notes/table.md', 'shared', { author: 'user' });
  const r = await forget(store, SYS_PLUGINS, { files: inTides, history: inTides });
  assert.equal(r.bytes, 0);
  assert.equal(await ws.readText(trip, '/notes/table.md'), 'shared');
});

test("forget: history alone drops the old versions and keeps the current files", async () => {
  const { store, ws } = await setup();
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v1 code', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v2 code', { author: 'system' });
  const r = await forget(store, SYS_PLUGINS, { history: inTides });
  assert.deepEqual(r, { files: 0, events: 2, bytes: 'v1 code'.length });
  assert.equal(await ws.readText(SYS_PLUGINS, '/tides/index.js'), 'v2 code');
});

test('forget: log entries that match go, with the content only they named', async () => {
  const { store } = await setup();
  await record(store, SYS, { type: 'tides.cache', actor: 'plugin:tides', data: {}, texts: [['table', 'x'.repeat(3000)]] });
  await record(store, SYS, { type: 'plugin.error', actor: 'plugin:tides', data: { message: 'boom' } });
  const r = await forget(store, SYS, { events: (e) => e.actor === 'plugin:tides' && Boolean(e.refs?.length) });
  assert.deepEqual(r, { files: 0, events: 1, bytes: 3000 });
  assert.deepEqual((await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS))).map((e) => e.type), ['plugin.error']);
});

test('forget: nothing that matches changes nothing', async () => {
  const { store } = await setup();
  assert.deepEqual(await forget(store, SYS_PLUGINS, { files: inTides, history: inTides }), { files: 0, events: 0, bytes: 0 });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/forget.test.js test/unit/store-memory.test.js`
Expected: FAIL — `forget.js` can't be found; the contract test fails with "t.deleteEvent is not a function".

- [ ] **Step 3: Implement**
  - `src/core/types.js`: add `@property {(scope: string, seq: number) => Promise<void>} deleteEvent  removes one log entry (spec §4.9: removing a plugin frees what only its entries named)` to `Tx`.
  - `store-idb.js`: `deleteEvent: async (scope, seq) => { await req(os('events').delete([scope, seq])); }`.
  - `store-memory.js`: `async deleteEvent(scope, seq) { use('events', true).delete(ekey(scope, seq)); }`.
  - `src/core/forget.js`: `forget(store, scope, match)` as the Interfaces say. Read the file entries with `listFiles(scope)`, the history with `listEvents(scope, { types: ['file.write', 'file.delete'] })`, and, only when `match.events` is given, the whole log with `listEvents(scope)`; a set of candidate hashes; after the deletes, one `listBlobs()` for the sizes of the candidates nothing names any more. Add `'/src/core/forget.js'` to `SHELL` (alphabetical among `src/core`).

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/forget.test.js test/unit/store-memory.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Removing can free space: a log entry can be deleted, and forget() drops files, their history and log entries with the content only they named

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: Reading `SKILL.md`

**Files:**
- Create: `src/core/skills.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/skills.test.js`

**Interfaces:**
- Produces:
  - `SKILL_FILE = 'SKILL.md'`; `class SkillError extends Error` (name `'SkillError'`).
  - `frontMatter(text: string): { data: Record<string, string | Record<string, string>>, body: string }` — throws `SkillError` when the text doesn't start with a `---` line, or the front matter has no closing `---` line.
  - `parseSkill(text: string): Skill` with `Skill = { name: string, description: string, license?: string, compatibility?: string, allowedTools?: string, metadata: Record<string, string>, body: string }` — throws `SkillError` in plain words.
  - `checkSkillName(name: unknown): string | null` — what is wrong with a name, or null.
  - `skillLinks(body: string): string[]` — the files the body's Markdown links and images point to inside the skill's folder, normalized (`./` and `%20` read), fragments and queries cut, each once, in order.
  - `skillVersion(metadata: Record<string, string>): string` — `metadata.version` as `x.y.z` when it is one to three groups of digits, else `'0.0.0'`.

- [ ] **Step 1: Write the failing tests**

`test/unit/skills.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkill, frontMatter, checkSkillName, skillLinks, skillVersion, SkillError, SKILL_FILE } from '../../src/core/skills.js';

const SKILL = `---
name: tide-pools
description: When the user asks about tide pools - how to read a tide table, and when pools are safe to visit.
license: CC-BY-4.0
metadata:
  author: Example Trails
  version: "1.2"
---
# Tide pools

Check [the safety notes](references/safety.md) and ![a chart](assets/chart.png).
`;

test('a skill: name, description and metadata from the front matter, and the body after it (spec §5.1)', () => {
  const s = parseSkill(SKILL);
  assert.equal(SKILL_FILE, 'SKILL.md');
  assert.equal(s.name, 'tide-pools');
  assert.match(s.description, /^When the user asks about tide pools - how to read/);
  assert.equal(s.license, 'CC-BY-4.0');
  assert.deepEqual(s.metadata, { author: 'Example Trails', version: '1.2' });
  assert.match(s.body, /^# Tide pools\n\nCheck/);
  assert.equal(skillVersion(s.metadata), '1.2.0');
});

test('front matter as people write it: CRLF, a byte-order mark, escapes, a colon in a plain value, blocks, comments, lists', () => {
  const crlf = '﻿---\r\nname: a-b\r\ndescription: "Says \\"hi\\": a test"\r\n---\r\nBody\r\n';
  assert.deepEqual([parseSkill(crlf).description, parseSkill(crlf).body], ['Says "hi": a test', 'Body\n']);
  const s = parseSkill(`---
name: x-y
# a comment
description: >
  Folded onto
  one line.
license: 'It''s free'
compatibility: |
  Line one
  Line two
allowed-tools:
  - Read
  - Bash(git:*)
other: Tide pools: when they are safe # not part of it
---
B`);
  assert.equal(s.description, 'Folded onto one line.');
  assert.equal(s.license, "It's free");
  assert.equal(s.compatibility, 'Line one\nLine two');
  assert.equal(s.allowedTools, 'Read Bash(git:*)');
  assert.equal(frontMatter(`---\nname: x\nother: Tide pools: when they are safe # not part of it\n---\n`).data.other, 'Tide pools: when they are safe');
  assert.equal(parseSkill('---\nname: c-d\ndescription: A long one\n  that goes on here.\n---\n').description, 'A long one that goes on here.');
});

test('a SKILL.md annai refuses says why, in plain words', () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['# No front matter', /starts with front matter/],
    ['---\nname: a-b\ndescription: x\n', /isn't closed/],
    ['---\ndescription: x\n---\n', /needs a name/],
    ['---\nname: a-b\n---\n', /needs a description/],
    ['---\nname: Tide_Pools\ndescription: x\n---\n', /lowercase letters, digits and dashes/],
    ['---\nname: -tides\ndescription: x\n---\n', /can't start or end with a dash/],
    ['---\nname: ti--des\ndescription: x\n---\n', /two dashes in a row/],
    [`---\nname: a-b\ndescription: ${'x'.repeat(1025)}\n---\n`, /at most 1024 characters/],
    [`---\nname: ${'a'.repeat(65)}\ndescription: x\n---\n`, /1 to 64/],
  ];
  for (const [text, why] of cases) assert.throws(() => parseSkill(text), (e) => e instanceof SkillError && why.test(e.message), String(why));
  assert.equal(checkSkillName('tide-pools'), null);
  assert.match(String(checkSkillName(42)), /lowercase/);
});

test('the files a SKILL.md links to, inside its folder, each once', () => {
  const body = 'See [a](references/a.md), [again](references/a.md#part), ![img](./assets/c%20d.png "t"), [q](references/q.md?x=1), '
    + '[web](https://example.com/x), [top](#top), [abs](/etc/passwd), [up](../secret.md), [mail](mailto:x@y.z).';
  assert.deepEqual(skillLinks(body), ['references/a.md', 'assets/c d.png', 'references/q.md']);
});

test("a skill's version: digits made semantic, anything else 0.0.0", () => {
  assert.deepEqual(['2', '1.2', '1.2.3', 'v1', '1.2.3.4', undefined].map((v) => skillVersion(v === undefined ? {} : { version: v })), ['2.0.0', '1.2.0', '1.2.3', '0.0.0', '0.0.0', '0.0.0']);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/skills.test.js`
Expected: FAIL — `src/core/skills.js` can't be found.

- [ ] **Step 3: Implement `src/core/skills.js`**

The parser, line by line after the BOM is dropped and `\r\n`/`\r` become `\n`:
- The first line must be `---` (trailing spaces allowed): else `SkillError("SKILL.md starts with front matter: a line with just ---, then name: and description:, then another ---.")`. The next line that is `---` (or `...`) closes it: else `SkillError("SKILL.md's front matter isn't closed: it needs a line with just --- after it.")`.
- A top-level line is `key: value` at column 0 (`/^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/`); blank lines and lines starting with `#` (after spaces) are skipped.
- The value: `"…"` (escapes `\"`, `\\`, `\n`, `\t`, `\/`, `\uXXXX`); `'…'` (`''` is a quote); `|` or `>` (with `-` or `+`) takes the following lines indented more than 0, de-indented by the first one's indent, joined with `\n` (`|`) or folded with spaces (`>`; blank lines stay line breaks); empty, then indented `key: value` lines make a one-level map, or indented `- item` lines a list joined with one space; otherwise a plain value, cut at ` #`, with indented continuation lines folded in with one space. A plain value keeps any `: ` in it.
- Every string value is trimmed; map values the same.
- `parseSkill`: `name` (string, `checkSkillName`), `description` (string, 1 to 1024 characters: `"A skill's description is at most 1024 characters; this one has N."`; missing: `"SKILL.md needs a description: what the skill is for and when to use it."`), optional `license`, `compatibility`, `allowed-tools` (as `allowedTools`), `metadata` (a map; a string there is ignored), `body` (everything after the closing line).
- `checkSkillName` messages: not a string or empty: `"SKILL.md needs a name: lowercase letters, digits and dashes, like tide-pools."` (also used when `name` is missing); other characters or longer than 64: `"A skill's name is 1 to 64 lowercase letters, digits and dashes, like tide-pools."`; `"A skill's name can't start or end with a dash."`; `"A skill's name can't have two dashes in a row."`.
- `skillLinks`: `/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g`; skip targets with a scheme (`/^[a-z][a-z0-9+.-]*:/i`), starting with `#` or `/`; cut `#…` and `?…`; `decodeURIComponent` (a bad escape skips it); drop a leading `./`; keep only those for which `normPath('/' + target)` succeeds and equals `'/' + target` (no `..`).

Add `'/src/core/skills.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/skills.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "annai reads SKILL.md: a small front matter parser for what the Agent Skills format uses, and the files a skill links to

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: annai's own skills are SKILL.md files in `skills/`

**Files:**
- Create: `skills/driving-companion/SKILL.md`, `skills/replanning/SKILL.md`, `skills/plan-a-trip/SKILL.md`, `src/plugins/skills/index.js`
- Delete: `src/core/live/skills.js`
- Modify: `src/core/live/live.js` (no skills), `src/plugins/go/index.js` (no `PLANNING`; its description drops "and how Shiori plans a trip"), `src/app/main.js` (`addBuiltin` the skills plugin, after go), `sw.js` (`SHELL`: the three `SKILL.md` files and the plugin in; `live/skills.js` out), `test/unit/sw-shell.test.js` (expected includes `walk('skills')`), `test/unit/live-engine.test.js` (drop the line asserting live mode's skills), `test/unit/plugin-go.test.js` (the planning skill's tests read the file)
- Test: `test/unit/builtin-skills.test.js`

**Interfaces:**
- Consumes: `parseSkill` (Task 2).
- Produces: `src/plugins/skills/index.js`: `manifest` (`id: 'skills'`, `name: 'Built-in skills'`, `version: VERSION`, `api: 1`, description "Shiori's own skills: the driving companion, replanning, and planning a trip."); `BUILT_IN = ['driving-companion', 'replanning', 'plan-a-trip']`; `loadBuiltinSkills(read: (path: string) => Promise<string | null>): Promise<{ name: string, description: string, text: string }[]>` (path `/skills/<name>/SKILL.md`; a missing or unreadable one is left out); `activate(annai)` registers each with `annai.register('skill', …)`, reading with `fetch` (any failure is null), and returns the cleanup.

- [ ] **Step 1: Write the failing tests**

`test/unit/builtin-skills.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadBuiltinSkills, BUILT_IN } from '../../src/plugins/skills/index.js';

const read = async (/** @type {string} */ p) => readFile(new URL(`../..${p}`, import.meta.url), 'utf8').catch(() => null);

test("Shiori's own skills are SKILL.md files in skills/, in the format third parties use (spec §19, §5.1)", async () => {
  const skills = await loadBuiltinSkills(read);
  assert.deepEqual(skills.map((s) => s.name), BUILT_IN);
  assert.deepEqual(BUILT_IN, ['driving-companion', 'replanning', 'plan-a-trip']);
  for (const s of skills) {
    assert.ok(s.description.length > 20, s.name);
    assert.doesNotMatch(s.text, /^---/);
  }
  assert.match(skills[0].text, /^# Driving companion\n/);
  assert.match(skills[1].description, /off plan or running late/);
});

test('a built-in skill that is missing is left out; the others still load', async () => {
  const skills = await loadBuiltinSkills(async (p) => (p.includes('replanning') ? null : read(p)));
  assert.deepEqual(skills.map((s) => s.name), ['driving-companion', 'plan-a-trip']);
});
```

In `test/unit/plugin-go.test.js`, the three planning-skill assertions read the skill from the file: add
```js
import { loadBuiltinSkills } from '../../src/plugins/skills/index.js';
const planning = async () => (await loadBuiltinSkills(async (p) => readFile(new URL(`../..${p}`, import.meta.url), 'utf8').catch(() => null))).find((s) => s.name === 'plan-a-trip');
```
and use `(await planning()).text` where the tests used `registry.list('skill').find((s) => s.name === 'plan-a-trip').text` (with `readFile` imported from `node:fs/promises`); the first test's name drops "; the planning skill is there" and keeps its other assertions.

In `test/unit/sw-shell.test.js`: `const expected = ['/', '/index.html', '/manifest.webmanifest', ...(await walk('src')), ...(await walk('assets')), ...(await walk('skills'))].sort();`

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/builtin-skills.test.js test/unit/plugin-go.test.js test/unit/sw-shell.test.js`
Expected: FAIL — `src/plugins/skills/index.js` can't be found; the shell test lacks `skills/`.

- [ ] **Step 3: Implement**
  - Each `SKILL.md`: front matter `name:` and `description:` as the skill has today (the descriptions in `src/core/live/skills.js` and the `plan-a-trip` registration in `src/plugins/go/index.js`), then the text exactly as it is today.
  - `src/plugins/skills/index.js` as the Interfaces say.
  - Remove the skill registration from `live.js` and `go/index.js`, and delete `src/core/live/skills.js`.
  - `main.js`: `await plugins.addBuiltin(new URL('../plugins/skills/index.js', import.meta.url).href);` after the Go tools.
  - `SHELL`: `'/skills/driving-companion/SKILL.md'`, `'/skills/plan-a-trip/SKILL.md'`, `'/skills/replanning/SKILL.md'` (after `/manifest.webmanifest`'s assets block, sorted), `'/src/plugins/skills/index.js'`; remove `'/src/core/live/skills.js'`.
  - `live-engine.test.js`: delete `assert.deepEqual(k.registry.list('skill').map((s) => s.name), ['driving-companion', 'replanning']);`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/builtin-skills.test.js test/unit/plugin-go.test.js test/unit/sw-shell.test.js test/unit/live-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "annai's own skills are SKILL.md files in skills/, loaded by a built-in plugin, in the format anyone's skills use

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: A package as annai reads it (`inspectPackage`)

**Files:**
- Create: `src/core/packages.js`
- Modify: `src/core/plugins.js` (the manifest schema, `checkManifest`, `insidePlugin`, `findRoot`, `API_VERSION`, `MANIFEST_FILE`, `PLUGIN_MAX_BYTES` move to `packages.js`; `plugins.js` re-exports `API_VERSION`, `MANIFEST_FILE`, `PLUGIN_MAX_BYTES`, `PLUGIN_MANIFEST_SCHEMA`), `sw.js` (`SHELL`)
- Test: `test/unit/packages.test.js`

**Interfaces:**
- Consumes: `parseSkill`, `skillVersion`, `SkillError`, `SKILL_FILE` (Task 2); `PluginError` (`registry.js`).
- Produces:
  - `PLUGIN_MANIFEST_SCHEMA` gains `files: { type: 'array', items: { type: 'string' }, maxItems: 200 }`.
  - `checkManifest(manifest)` (moved; same messages).
  - `isJunk(name: string): boolean` — `__MACOSX` anywhere in the path, a last part of `.DS_Store`, `Thumbs.db` or `desktop.ini`, or a folder entry (ends with `/`).
  - `skillManifest(skill: Skill): any` — `{ id: skill.name, name: skill.name, version: skillVersion(skill.metadata), api: API_VERSION, description: skill.description, skills: ['.'], ...(author) }`.
  - `fingerprint(files: Map<string, Uint8Array>): Promise<string>` — SHA-256 hex of the sorted lines `<name>\0<sha256 of bytes>\n`.
  - `inspectPackage(files: Map<string, Uint8Array>, { maxBytes = PLUGIN_MAX_BYTES } = {}): Promise<Package>` with
    ```js
    /**
     * @typedef {{ name: string, description: string, folder: string }} SkillInfo  folder: '' for the package's top, else "skills/tides"
     * @typedef {{ kind: 'plugin' | 'skill', id: string, name: string, version: string, shownVersion: string, manifest: any,
     *   files: Map<string, Uint8Array>, code: boolean, skills: SkillInfo[], personalities: { name: string, path: string }[],
     *   templates: any[], description: string, author?: string, homepage?: string, license?: string, fingerprint: string }} Package
     *   files: by name inside the package (its top folder taken off); shownVersion: '' for a skill without a version
     */
    ```
    Refuses with `PluginError` (the id when known, else `'plugin'` or `'skill'`).

- [ ] **Step 1: Write the failing tests**

`test/unit/packages.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPackage, fingerprint, isJunk } from '../../src/core/packages.js';
import { PluginError } from '../../src/core/registry.js';
import { utf8 } from '../../src/core/bytes.js';

/** @param {Record<string, string>} o */
export const files = (o) => new Map(Object.entries(o).map(([k, v]) => [k, utf8(v)]));
export const SKILL = '---\nname: tide-pools\ndescription: Tide pools: when they are safe to visit.\nmetadata:\n  author: Example Trails\n  version: "1.2"\n---\n# Tide pools\nSee [safety](references/safety.md).\n';
const MANIFEST = (/** @type {any} */ more = {}) => JSON.stringify({ id: 'trail-kit', name: 'Trail kit', version: '1.0.0', api: 1, description: 'Skills for trails.', ...more });

test('a bare skill: at the top or in one folder, with the junk zips carry left out', async () => {
  for (const top of ['', 'tide-pools-main/']) {
    const pkg = await inspectPackage(files({ [`${top}SKILL.md`]: SKILL, [`${top}references/safety.md`]: 'Watch the waves.', [`${top}.DS_Store`]: 'x', '__MACOSX/._SKILL.md': 'x', [`${top}references/`]: '' }));
    assert.deepEqual([pkg.kind, pkg.id, pkg.name, pkg.version, pkg.shownVersion, pkg.code, pkg.author], ['skill', 'tide-pools', 'tide-pools', '1.2.0', '1.2', false, 'Example Trails']);
    assert.deepEqual([...pkg.files.keys()].sort(), ['SKILL.md', 'references/safety.md']);
    assert.deepEqual(pkg.skills, [{ name: 'tide-pools', description: 'Tide pools: when they are safe to visit.', folder: '' }]);
    assert.equal(pkg.manifest.id, 'tide-pools');
    assert.match(pkg.fingerprint, /^[0-9a-f]{64}$/);
  }
  assert.equal((await inspectPackage(files({ 'SKILL.md': SKILL.replace(/metadata:[\s\S]*?---/, '---') }))).shownVersion, '');
});

test('a plugin package: its code, the skills it lists, personalities, templates and files', async () => {
  const pkg = await inspectPackage(files({
    'trail-kit/annai-plugin.json': MANIFEST({ entry: 'index.js', files: ['index.js', 'lib.js'], skills: ['skills/trail-safety'], personalities: ['personalities/ranger.md'], templates: ['templates.json'], author: 'Trails', homepage: 'https://trails.example/' }),
    'trail-kit/index.js': 'export function activate() {}', 'trail-kit/lib.js': 'export const x = 1;',
    'trail-kit/skills/trail-safety/SKILL.md': '---\nname: trail-safety\ndescription: Before a hike, what to check.\n---\nCarry water.',
    'trail-kit/personalities/ranger.md': '# Ranger\nCalm and practical.',
    'trail-kit/templates.json': JSON.stringify({ endpoints: [{ id: 'trail-llm', version: 1, type: 'chat-completions', name: 'Trail LLM', baseUrl: 'https://llm.example/v1' }] }),
  }));
  assert.deepEqual([pkg.kind, pkg.id, pkg.version, pkg.shownVersion, pkg.code, pkg.author, pkg.homepage], ['plugin', 'trail-kit', '1.0.0', '1.0.0', true, 'Trails', 'https://trails.example/']);
  assert.deepEqual(pkg.skills.map((s) => [s.name, s.folder]), [['trail-safety', 'skills/trail-safety']]);
  assert.deepEqual(pkg.personalities, [{ name: 'ranger', path: 'personalities/ranger.md' }]);
  assert.deepEqual(pkg.templates.map((t) => t.id), ['trail-llm']);
  assert.ok(pkg.files.has('annai-plugin.json'));
});

test('packages annai refuses, each with the reason', async () => {
  /** @type {[Record<string, string>, RegExp][]} */
  const cases = [
    [{ 'readme.txt': 'hi' }, /no annai-plugin\.json or SKILL\.md/],
    [{ 'a/SKILL.md': SKILL, 'b/SKILL.md': SKILL }, /several skills/],
    [{ 'SKILL.md': SKILL.replace('name: tide-pools', 'name: t') }, /at least 2 characters/],
    [{ 'SKILL.md': '# none' }, /front matter/],
    [{ 'annai-plugin.json': MANIFEST({ skills: ['skills/none'] }) }, /skills\/none.*SKILL\.md/],
    [{ 'annai-plugin.json': MANIFEST({ skills: ['a', 'b'] }), 'a/SKILL.md': SKILL, 'b/SKILL.md': SKILL }, /two skills called tide-pools/],
    [{ 'annai-plugin.json': MANIFEST({ skills: ['../up'] }) }, /isn't a folder inside/],
    [{ 'annai-plugin.json': MANIFEST({ personalities: ['ranger.txt'] }), 'ranger.txt': 'x' }, /personality.*\.md/],
    [{ 'annai-plugin.json': MANIFEST({ personalities: ['Ranger Bob.md'] }), 'Ranger Bob.md': 'x' }, /personality's file name/],
    [{ 'annai-plugin.json': MANIFEST({ templates: ['t.json'] }), 't.json': '{"endpoints":[{"id":1}]}' }, /template/],
    [{ 'annai-plugin.json': MANIFEST({ templates: ['t.json'] }), 't.json': 'not json' }, /t\.json isn't valid JSON/],
    [{ 'annai-plugin.json': MANIFEST({ files: ['gone.js'] }) }, /gone\.js.*missing/],
    [{ 'annai-plugin.json': MANIFEST(), 'a\\b.js': 'x' }, /"a\\b\.js" isn't allowed/],
    [{ 'annai-plugin.json': MANIFEST({ entry: 'index.js' }) }, /entry file index\.js is missing/],
  ];
  for (const [f, why] of cases) await assert.rejects(inspectPackage(files(f)), (e) => e instanceof PluginError && why.test(e.message), String(why));
  await assert.rejects(inspectPackage(files({ 'SKILL.md': SKILL, 'big.txt': 'x'.repeat(5000) }), { maxBytes: 4000 }), /too large/);
});

test('the fingerprint changes when any file or name does, and only then', async () => {
  const a = await fingerprint(files({ 'SKILL.md': SKILL, 'b.md': 'b' }));
  assert.equal(await fingerprint(files({ 'b.md': 'b', 'SKILL.md': SKILL })), a);
  assert.notEqual(await fingerprint(files({ 'SKILL.md': SKILL, 'b.md': 'c' })), a);
  assert.notEqual(await fingerprint(files({ 'SKILL.md': SKILL, 'c.md': 'b' })), a);
  assert.deepEqual(['__MACOSX/x', 'a/.DS_Store', 'Thumbs.db', 'a/desktop.ini', 'a/', 'a/b.md'].map(isJunk), [true, true, true, true, true, false]);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/packages.test.js`
Expected: FAIL — `src/core/packages.js` can't be found.

- [ ] **Step 3: Implement `src/core/packages.js`**

`inspectPackage`, in order:
1. Drop junk names. The root: `''` or the single top folder that holds `annai-plugin.json` (a plugin), else `''` or the single top folder that holds `SKILL.md` (a bare skill); else, with two or more `…/SKILL.md`, refuse `PluginError('skill', "this zip holds several skills. Install each one on its own, or add an annai-plugin.json that lists them.")`; else refuse `PluginError('plugin', "there is no annai-plugin.json or SKILL.md in this package")`.
2. Names relative to the root; each must equal `normPath('/' + name).slice(1)`, else `PluginError(id, \`the file name "${name}" isn't allowed\`)`. The sum of sizes over `maxBytes`: `PluginError(id, \`is too large: it unpacks to more than ${maxBytes / 1048576} MB\`)` (the same words `readZip`'s limit gives today, so the existing 64 MB test keeps passing).
3. A plugin: JSON (`"its annai-plugin.json is not valid JSON"`), `checkManifest`; `entry` present (`"its entry file X is missing"`); each `files` entry present (`"its file X, listed in files, is missing"`); each `skills` entry a folder inside (`'.'` is the top; else `"its skill folder X isn't a folder inside the package"`), holding `SKILL.md` (`"its skill folder X has no SKILL.md"`) that parses (`"its skill X: <SkillError message>"`), names unique (`"it has two skills called X"`); each `personalities` entry an `.md` file present (`"its personality X must be a .md file in the package"`), named by its file (`/^[a-z0-9][a-z0-9-]{0,39}$/`, else `"its personality's file name X must be lowercase letters, digits and dashes, like ranger.md"`); each `templates` entry a JSON file present (`"its template file X isn't valid JSON"`) of the form `{ endpoints: [{ id: string, version: integer, type: string, name: string, … }] }` (else `"its template file X doesn't hold endpoint templates annai can read"`).
4. A bare skill: `parseSkill` (a `SkillError` becomes `PluginError('skill', message)`), a name of at least 2 characters (`"A skill's name needs at least 2 characters to install: X"`), `skillManifest`.
5. `code: Boolean(manifest.entry)`; `shownVersion`: the manifest's version, or a skill's `metadata.version` as written ('' when none); `fingerprint(files)`.

`plugins.js` imports these instead of its own copies. Add `'/src/core/packages.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/packages.test.js test/unit/plugins.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "annai reads a package before installing it: a plugin with its skills, personalities and templates, or a bare skill, with a fingerprint of its files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: The host installs and starts any package

**Files:**
- Modify: `src/core/plugins.js`
- Test: `test/unit/plugin-packages.test.js`

**Interfaces:**
- Consumes: `inspectPackage`, `skillManifest`, `isJunk` (Task 4); `parseSkill`, `SKILL_FILE` (Task 2); `forget` (Task 1); `logEvent`.
- Produces (on `PluginHost`):
  - `inspect(files: Map<string, Uint8Array>): Promise<Package & { replaces: { version: string, kind: string } | null }>` — `inspectPackage` (with `maxPackageBytes`), then refuses: an id that is a built-in plugin's (`PluginError(id, 'has the same id as a plugin built into annai')`; for a skill `PluginError(id, "A skill can't be called X: annai uses that name for one of its own parts.")`); an installed package of the other kind (`"X is installed already as a plugin. Remove it first."` / `"… as a skill. …"`); a skill name another running plugin provides (`"Shiori already has a skill called X, built into annai."` when that plugin is a built-in, else `"Shiori already has a skill called X, from <its name>. Remove that one first."`).
  - `install(files, { source = 'file', file?, url? } = {}): Promise<any>` (the manifest) — `inspect`, then one `writeMany` (the package's files under `/<id>/`, deleting the ones it no longer has, and `installed.json`), then `forget(store, SYS_PLUGINS, { history: under /<id>/ })`, then a `plugin.install` (new) or `plugin.update` (replacing) entry in the system log: `{ plugin, name, version, kind, from: source }` (and `url` for an address). The state record: `{ version, name, kind, enabled: true, installed, source, fingerprint, file?, url?, tools? }` (`tools` kept from before).
  - Only a package with code is marked to need a restart when its code was imported this session.
  - Starting: a stored package's manifest is `#stored(id)`: for `kind: 'skill'`, `skillManifest(parseSkill(<stored SKILL.md>))` (a broken one: `PluginError(id, …)`), else as today. After `activate`, the package's content registers under its id: each skill as `{ name, description, text: () => body read fresh, files: () => its files but SKILL.md, relative to its folder, sorted, read: (file) => { bytes, type } | null for a file inside its folder }`; each personality as `{ name, text }`; each endpoint template as itself (kind `'template'`). After a successful start, its tool names are kept in its state as `tools` when they changed.
  - `describe()` rows gain `kind` (`'plugin'` for built-ins), `shownVersion` (as `Package.shownVersion`: a skill's version as written, '' when none), `source` (`'builtin'` for built-ins), `url`, `file`, `author`, `homepage`, `skills` (names).
  - A legacy state with a file name as its `source` (from before this plan) reads as `source: 'file'`, `file: <that name>`.

- [ ] **Step 1: Write the failing tests**

`test/unit/plugin-packages.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { text, utf8 } from '../../src/core/bytes.js';
import { files, SKILL } from './packages.test.js';

/** A host on memory storage that loads installed modules from storage as data: URLs (as plugins.test.js does). */
export async function hostKit() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = new PluginHost({ registry, workspace: ws, importModule });
  const log = async () => store.tx(['events'], 'readonly', (t) => t.listEvents(SYS));
  return { registry, store, ws, host, importModule, log, relaunch: () => new PluginHost({ registry: new Registry(), workspace: ws, importModule }) };
}

export const KIT = (/** @type {any} */ more = {}) => files({
  'annai-plugin.json': JSON.stringify({ id: 'trail-kit', name: 'Trail kit', version: '1.0.0', api: 1, skills: ['skills/trail-safety'], personalities: ['personalities/ranger.md'], templates: ['templates.json'], ...more }),
  'skills/trail-safety/SKILL.md': '---\nname: trail-safety\ndescription: Before a hike, what to check.\n---\nCarry water.',
  'personalities/ranger.md': '# Ranger\nCalm and practical.',
  'templates.json': JSON.stringify({ endpoints: [{ id: 'trail-llm', version: 1, type: 'chat-completions', name: 'Trail LLM' }] }),
});

test('host: a bare skill installs as a package; at start Shiori has it, its text and files read from storage', async () => {
  const { host, registry, ws } = await hostKit();
  const m = await host.install(files({ 'tide-pools/SKILL.md': SKILL, 'tide-pools/references/safety.md': 'Watch the waves.' }), { source: 'url', url: 'https://trails.example/tide-pools/SKILL.md' });
  assert.equal(m.id, 'tide-pools');
  const state = (await host.installed())['tide-pools'];
  assert.deepEqual([state.kind, state.source, state.url, state.version, state.enabled], ['skill', 'url', 'https://trails.example/tide-pools/SKILL.md', '1.2.0', true]);
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/tide-pools/')).map((f) => f.path), ['/tide-pools/SKILL.md', '/tide-pools/references/safety.md']);
  await host.start('tide-pools');
  const s = registry.list('skill').find((x) => x.name === 'tide-pools');
  assert.equal(s.description, 'Tide pools: when they are safe to visit.');
  assert.match(await s.text(), /^# Tide pools\n/);
  assert.deepEqual(await s.files(), ['references/safety.md']);
  assert.equal(text((await s.read('references/safety.md')).bytes), 'Watch the waves.');
  assert.equal(await s.read('../installed.json'), null);
  assert.equal(await s.read('missing.md'), null);
  const row = (await host.describe()).find((r) => r.id === 'tide-pools');
  assert.deepEqual([row.kind, row.version, row.source, row.skills], ['skill', '1.2.0', 'url', ['tide-pools']]);
});

test("host: a package's skills, personalities and templates join the registry at start and leave when it stops", async () => {
  const { host, registry } = await hostKit();
  await host.install(KIT());
  await host.start('trail-kit');
  assert.deepEqual(registry.list('skill').map((s) => s.name), ['trail-safety']);
  assert.deepEqual(registry.list('personality').map((p) => [p.name, p.text]), [['ranger', '# Ranger\nCalm and practical.']]);
  assert.deepEqual(registry.list('template').map((t) => t.id), ['trail-llm']);
  await host.setEnabled('trail-kit', false);
  assert.deepEqual([registry.list('skill'), registry.list('personality'), registry.list('template')], [[], [], []]);
});

test('host: a package keeps no history; installing again replaces its files outright, and the log says so', async () => {
  const { host, ws, log } = await hostKit();
  await host.install(files({ 'SKILL.md': SKILL, 'references/old.md': 'old' }), { source: 'file', file: 'tide-pools.zip' });
  await host.install(files({ 'SKILL.md': SKILL.replace('# Tide pools', '# Tide pools, new') }), { source: 'file', file: 'tide-pools.zip' });
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/tide-pools/')).map((f) => f.path), ['/tide-pools/SKILL.md']);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tide-pools/references/old.md'), []);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tide-pools/SKILL.md'), []);
  assert.deepEqual((await log()).filter((e) => e.type.startsWith('plugin.')).map((e) => [e.type, e.data.plugin, e.data.from]), [['plugin.install', 'tide-pools', 'file'], ['plugin.update', 'tide-pools', 'file']]);
  assert.equal((await host.installed())['tide-pools'].file, 'tide-pools.zip');
});

test("host: names already taken are refused: annai's own parts, a skill Shiori has, a package of the other kind", async () => {
  const { host, registry } = await hostKit();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  registry.add('skills', 'skill', { name: 'plan-a-trip', description: 'x', text: 'x' });
  host.builtins.set('skills', { id: 'skills', name: 'Built-in skills' });
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'plan-a-trip') })), /already has a skill called plan-a-trip, built into annai/);
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'core-schemas') })), /can't be called core-schemas/);
  await host.install(KIT());
  await host.start('trail-kit');
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'trail-safety') })), /already has a skill called trail-safety, from Trail kit/);
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'trail-kit') })), /trail-kit is installed already as a plugin/);
  await host.install(KIT()); // the same package again replaces itself
  assert.equal((await host.inspect(KIT())).replaces?.version, '1.0.0');
});

test('host: a package without code needs no restart after an update; one whose code ran does', async () => {
  const { host } = await hostKit();
  await host.install(KIT());
  await host.start('trail-kit');
  await host.install(KIT({ version: '1.1.0' }));
  assert.equal(host.needsRestart('trail-kit'), false);
  await host.start('trail-kit');
});

test('host: a stored skill is read again before it starts', async () => {
  const { host, ws } = await hostKit();
  await host.install(files({ 'SKILL.md': SKILL }));
  await ws.write(SYS_PLUGINS, '/tide-pools/SKILL.md', 'no front matter', { author: 'system' });
  await assert.rejects(host.start('tide-pools'), (e) => e instanceof PluginError && /front matter/.test(e.message));
  assert.match(String((await host.describe()).find((r) => r.id === 'tide-pools')?.problem), /front matter/);
});

test("host: a running plugin's tool names are kept in its state, for removing its switches later", async () => {
  const { host } = await hostKit();
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': "export function activate(annai) { return annai.tools.register({ name: 'tide_times', description: 'Tides.', input: { type: 'object' }, run: () => 'low 05:40' }); }",
  }));
  await host.start('tides');
  assert.deepEqual((await host.installed()).tides.tools, ['tide_times']);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/plugin-packages.test.js`
Expected: FAIL — `host.install` refuses a bare skill ("there is no annai-plugin.json in this package").

- [ ] **Step 3: Implement it in `src/core/plugins.js`** as the Interfaces say. `installZip` keeps its signature and calls `install`. Keep every existing message `plugins.test.js` checks.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/plugin-packages.test.js test/unit/plugins.test.js test/unit/plugin-updates.test.js test/unit/llm-plugins.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "annai installs any package: a bare skill or a plugin, with its skills, personalities and templates registered at start, and no history for package files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 6: Shiori loads skills and their files; the index follows installs; templates from packages

**Files:**
- Modify: `src/core/agent/self-tools.js` (`skill`), `src/core/agent/context.js` (`takeSnapshot`, `nextSnapshot`), `src/core/llm/templates.js` (`loadTemplates`), `src/core/llm/service.js`
- Test: `test/unit/agent-self.test.js`, `test/unit/agent-context.test.js`, `test/unit/llm-templates.test.js`

**Interfaces:**
- Consumes: the registry's skill items (Task 5: `text`, `files?`, `read?`), its `'template'` items.
- Produces:
  - `skill` tool: input `{ name: string, file?: string }` (`file`: "A file of the skill, such as references/safety.md, as listed after its text."). Without `file`: the text, then, when `files()` lists any, `\n\nFiles in this skill (read one with skill({ name: "<name>", file })): <comma-separated>`. With `file`: a text file (`isTextType(type)`, or `.py`, `.sh`, `.js`, `.ts`, `.yaml`, `.yml`, `.toml`) as its text; `image/png|jpeg|webp|gif` up to 5 MB as `{ content: '<file>, an image from the skill <name>.', images: [{ mediaType, data: base64 }] }`; anything else `"<file> is <type>, <n> bytes: annai can't show this kind of file."`; missing: `There is no file <file> in the skill <name>. Its files: <list or "none">.`; a skill without `read`: `The skill <name> has no files.` A name not there keeps today's answer. The first skill with a name wins.
  - `takeSnapshot` lists each skill name once (the first). `nextSnapshot(prev, fresh, { cold })`: when the skill index differs, the result is `{ ...prev(or as today), skills: fresh.skills }`.
  - `loadTemplates({ ws, fetch, base, extra = [] })`: the catalog's endpoints, then each of `extra` whose id the catalog lacks, in order. `createLlm` passes `extra: plugins.registry.list('template')`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/agent-self.test.js`:
```js
test('skill: a file from the skill, as text or as an image; a missing one says what there is (choice 9)', async () => {
  const k = await agentKit([[{ toolCalls: [
    { name: 'skill', input: { name: 'tide-pools' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'references/safety.md' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'assets/chart.png' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'scripts/fetch.py' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'assets/data.bin' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'nope.md' } },
    { name: 'sleep', input: {} },
  ] }]]);
  const kept = new Map([['references/safety.md', utf8('Watch the waves.')], ['assets/chart.png', new Uint8Array([137, 80, 78, 71])], ['scripts/fetch.py', utf8('print(1)')], ['assets/data.bin', new Uint8Array(3)]]);
  k.registry.add('tide-pools', 'skill', {
    name: 'tide-pools', description: 'Tide pools.', text: async () => '# Tide pools',
    files: async () => [...kept.keys()], read: async (/** @type {string} */ f) => (kept.has(f) ? { bytes: kept.get(f), type: typeForPath(f) } : null),
  });
  k.agent.send('Go');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).filter((e) => e.data.name === 'skill');
  assert.equal(r[0].data.content, '# Tide pools\n\nFiles in this skill (read one with skill({ name: "tide-pools", file })): references/safety.md, assets/chart.png, scripts/fetch.py, assets/data.bin');
  assert.equal(r[1].data.content, 'Watch the waves.');
  assert.equal(r[2].data.images.length, 1);
  assert.equal(r[3].data.content, 'print(1)');
  assert.equal(r[4].data.content, "assets/data.bin is application/octet-stream, 3 bytes: annai can't show this kind of file.");
  assert.match(r[5].data.content, /^There is no file nope\.md in the skill tide-pools\. Its files: references\/safety\.md/);
});
```
(imports: `utf8` from `../../src/core/bytes.js`, `typeForPath` from `../../src/core/paths.js`.)

In `test/unit/agent-context.test.js`:
```js
test('a skill installed or removed shows at her next wake, warm cache or not; each name once (choice 10)', async () => {
  const { ws, trip, registry } = await setup();
  const take = () => takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const first = await take();
  const off = registry.add('kit', 'skill', { name: 'tide-pools', description: 'Tide pools.', text: '' });
  registry.add('other', 'skill', { name: 'tide-pools', description: 'A second one.', text: '' });
  const warm = nextSnapshot(first, await take(), { cold: false });
  assert.deepEqual(warm.skills.map((s) => [s.name, s.description]), [['driving', 'How to guide while the user drives.'], ['tide-pools', 'Tide pools.']]);
  assert.equal(warm.memory, first.memory);
  off();
  assert.deepEqual(nextSnapshot(warm, await take(), { cold: false }).skills.map((s) => s.description), ['How to guide while the user drives.', 'A second one.']);
  const same = await take();
  assert.equal(nextSnapshot(same, await take(), { cold: false }), same); // nothing changed: the snapshot it had
});
```

In `test/unit/llm-templates.test.js`:
```js
test("a package's templates join annai's; the catalog's own win on the same id (choice 12)", async () => {
  const ws = await freshWorkspace();
  const get = async () => new Response(JSON.stringify({ format: 1, endpoints: [{ id: 'openai', version: 1, type: 'chat-completions', name: 'OpenAI' }] }));
  const out = await loadTemplates({ ws, fetch: get, extra: [{ id: 'openai', version: 9, type: 'x', name: 'Fake OpenAI' }, { id: 'trail-llm', version: 1, type: 'chat-completions', name: 'Trail LLM' }] });
  assert.deepEqual(out.endpoints.map((t) => [t.id, t.name]), [['openai', 'OpenAI'], ['trail-llm', 'Trail LLM']]);
});
```
(`freshWorkspace`: whatever that file already uses to make a `Workspace` with `ensureBaseScopes`; if it has none, a memory store and `ensureBaseScopes`.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/agent-self.test.js test/unit/agent-context.test.js test/unit/llm-templates.test.js`
Expected: FAIL — the skill result has no files line; the warm snapshot keeps the old skills; `extra` is ignored.

- [ ] **Step 3: Implement** as the Interfaces say. Base64 with `toBase64` from `bytes.js`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/agent-self.test.js test/unit/agent-context.test.js test/unit/llm-templates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Shiori reads a skill's files with the skill tool, sees a new skill at her next wake, and packages' endpoint templates join annai's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 7: Removing a package removes everything it stored

**Files:**
- Modify: `src/core/plugins.js` (`uninstall`)
- Test: `test/unit/plugin-packages.test.js`

**Interfaces:**
- Consumes: `forget` (Task 1); the state's `tools` (Task 5); `updateAppSettings`.
- Produces: `uninstall(id): Promise<{ bytes: number }>` — stops it; removes it from `installed.json`; `forget(SYS_PLUGINS, { files, history }: under /<id>/)`; `forget(SYS_SETTINGS, { files, history }: path === /plugin-settings/<id>.json)`; deletes every secret whose id starts `plugin:<id>:`; removes the switches (`tools: { name: null }`) of the tools it registers now or listed in its state; `forget(SYS, { events: actor === 'plugin:<id>' and refs not empty })`; logs `plugin.remove { plugin, name, kind, bytes }` to the system log; marks a package whose code ran as needing a restart. Returns the bytes freed.

- [ ] **Step 1: Write the failing tests**

In `test/unit/plugin-packages.test.js`:
```js
const TIDES = files({
  'annai-plugin.json': JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js' }),
  'index.js': `export async function activate(annai) {
    await annai.settings.set({ station: 'Monterey' });
    await annai.secrets.set('key', 'tide-secret-123456');
    await annai.events.append('sys', 'tides.cache', {}, { texts: [['table', 'x'.repeat(3000)]] });
    return annai.tools.register({ name: 'tide_times', description: 'Tides.', input: { type: 'object' }, run: () => 'low 05:40' });
  }`,
});

test('host: removing a package removes everything it stored and gives the space back; what it wrote in a trip stays (choice 4)', async () => {
  const { host, ws, store, registry, log } = await hostKit();
  await host.install(TIDES);
  await host.start('tides');
  await setToolSwitch(ws, 'tide_times', false);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(trip, '/notes/tides.md', 'from the plugin', { author: 'plugin:tides' });
  const { bytes } = await host.uninstall('tides');
  assert.ok(bytes >= 3000);
  assert.equal((await host.installed()).tides, undefined);
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/tides/'), []);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tides/index.js'), []);
  assert.equal(await ws.read(SYS_SETTINGS, '/plugin-settings/tides.json'), undefined);
  assert.deepEqual(await ws.history(SYS_SETTINGS, '/plugin-settings/tides.json'), []);
  assert.equal(await store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:tides:key')), undefined);
  assert.equal((await readAppSettings(ws)).tools?.tide_times, undefined);
  const sys = await log();
  assert.equal(sys.filter((e) => e.type === 'tides.cache').length, 0);
  assert.deepEqual(sys.filter((e) => e.type === 'plugin.remove').map((e) => [e.data.plugin, e.data.bytes]), [['tides', bytes]]);
  assert.equal(await ws.readText(trip, '/notes/tides.md'), 'from the plugin');
  assert.deepEqual(registry.list('tool'), []);
});

test('host: removing a package that is off still removes its tool switches', async () => {
  const { host, ws } = await hostKit();
  await host.install(TIDES);
  await host.start('tides');
  await setToolSwitch(ws, 'tide_times', false);
  await host.setEnabled('tides', false);
  await host.uninstall('tides');
  assert.equal((await readAppSettings(ws)).tools?.tide_times, undefined);
});

test('host: removing a skill takes it from Shiori and frees its files', async () => {
  const { host, registry, ws } = await hostKit();
  await host.install(files({ 'SKILL.md': SKILL, 'references/safety.md': 'Watch the waves.' }));
  await host.start('tide-pools');
  await host.uninstall('tide-pools');
  assert.deepEqual(registry.list('skill'), []);
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/tide-pools/'), []);
});
```
(imports: `createTrip`, `SYS_SETTINGS` from `scopes.js`; `setToolSwitch` from `../../src/core/agent/tools.js`; `readAppSettings` from `../../src/core/settings.js`.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/plugin-packages.test.js`
Expected: FAIL — the files' history, the settings file, the secret, the switch and the cache entry are still there; `uninstall` returns undefined.

- [ ] **Step 3: Implement `uninstall`** as the Interfaces say.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/plugin-packages.test.js test/unit/plugins.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Removing a plugin or skill removes everything it stored: its files and their history, settings, secrets, tool switches and kept log content

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 8: Packages from an address

**Files:**
- Modify: `src/core/answer.js` (`answerBytes`), `src/core/packages.js` (`fetchPackage`, `rawAddress`)
- Test: `test/unit/answer.test.js`, `test/unit/package-address.test.js`

**Interfaces:**
- Consumes: `readZip` (`zip.js`), `skillLinks` (Task 2), `MANIFEST_FILE`, `PLUGIN_MAX_BYTES`.
- Produces:
  - `answerBytes(res: Response, where: string, max?: number): Promise<Uint8Array>` — not ok: `Error("<where> answered <status>.")` with `status`; a `content-length` over `max`, or more bytes than `max` as it reads (it stops reading): `Error("<where> sent more than annai reads (<MB> MB).")`; a broken stream: `Error("<where>'s answer was cut off.")`; an `AbortError` stays one.
  - `rawAddress(address: string): string` — `https://github.com/<o>/<r>/blob/<ref>/<path>` and `…/raw/<ref>/<path>` become `https://raw.githubusercontent.com/<o>/<r>/<ref>/<path>`; anything else as it is.
  - `fetchPackage(address: string, { fetch, max = PLUGIN_MAX_BYTES }): Promise<Map<string, Uint8Array>>` — the package's files by name inside it, ready for `inspectPackage`. Every error is a plain `Error` in words for the user.
  - `ADDRESS_MAX_FILES = 200`, `SKILL_MAX_LINKS = 50`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/answer.test.js`:
```js
test('answerBytes: the bytes, or a plain error for a bad status, too much, or a cut-off answer', async () => {
  assert.deepEqual([...await answerBytes(new Response('abc'), 'trails.example')], [97, 98, 99]);
  await assert.rejects(answerBytes(new Response('x', { status: 404 }), 'trails.example'), /^Error: trails\.example answered 404\.$/);
  await assert.rejects(answerBytes(new Response('x'.repeat(20)), 'trails.example', 10), /sent more than annai reads/);
  const broken = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new TypeError('network')); } }));
  await assert.rejects(answerBytes(broken, 'trails.example'), (e) => !(e instanceof TypeError) && /answer was cut off/.test(e.message));
});
```

`test/unit/package-address.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPackage, rawAddress } from '../../src/core/packages.js';
import { ZipWriter } from '../../src/core/zip.js';
import { utf8 } from '../../src/core/bytes.js';
import { SKILL } from './packages.test.js';

/** A web of addresses: a string or bytes is a 200 answer, an Error is thrown as fetch would, a number is a status. */
function web(/** @type {Record<string, any>} */ routes) {
  /** @type {string[]} */
  const asked = [];
  const fetch = async (/** @type {string} */ url) => {
    asked.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('', { status: r });
    if (r === undefined) return new Response('not found', { status: 404 });
    return new Response(r);
  };
  return { fetch, asked };
}
const names = (/** @type {Map<string, Uint8Array>} */ m) => [...m.keys()];
const T = 'https://trails.example/kits';

test('a SKILL.md address: the skill, and the files it links to inside its folder', async () => {
  const { fetch, asked } = web({ [`${T}/tide-pools/SKILL.md`]: SKILL, [`${T}/tide-pools/references/safety.md`]: 'Watch the waves.' });
  assert.deepEqual(names(await fetchPackage(`${T}/tide-pools/SKILL.md`, { fetch })), ['SKILL.md', 'references/safety.md']);
  assert.equal(asked.length, 2);
});

test('a file a SKILL.md links to that is missing is left out (choice 6)', async () => {
  const { fetch } = web({ [`${T}/tide-pools/SKILL.md`]: SKILL });
  assert.deepEqual(names(await fetchPackage(`${T}/tide-pools/SKILL.md`, { fetch })), ['SKILL.md']);
});

test('an annai-plugin.json address: the manifest and every file it names', async () => {
  const manifest = JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js', files: ['index.js', 'lib.js'], skills: ['skills/tide-pools'] });
  const { fetch } = web({
    [`${T}/tides/annai-plugin.json`]: manifest, [`${T}/tides/index.js`]: 'import "./lib.js";', [`${T}/tides/lib.js`]: '',
    [`${T}/tides/skills/tide-pools/SKILL.md`]: SKILL, [`${T}/tides/skills/tide-pools/references/safety.md`]: 'Watch the waves.',
  });
  assert.deepEqual(names(await fetchPackage(`${T}/tides/annai-plugin.json`, { fetch })).sort(),
    ['annai-plugin.json', 'index.js', 'lib.js', 'skills/tide-pools/SKILL.md', 'skills/tide-pools/references/safety.md']);
});

test('a zip address: its files, whatever the address ends with', async () => {
  const z = new ZipWriter();
  await z.add('tide-pools/SKILL.md', utf8(SKILL));
  const { fetch } = web({ [`${T}/download?id=7`]: new Uint8Array(await z.finish().arrayBuffer()) });
  assert.deepEqual(names(await fetchPackage(`${T}/download?id=7`, { fetch })), ['tide-pools/SKILL.md']);
});

test("a GitHub page's address is read from GitHub's raw files", () => {
  assert.equal(rawAddress('https://github.com/o/r/blob/main/skills/x/SKILL.md'), 'https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md');
  assert.equal(rawAddress('https://github.com/o/r/raw/v1/annai-plugin.json'), 'https://raw.githubusercontent.com/o/r/v1/annai-plugin.json');
  assert.equal(rawAddress('https://trails.example/SKILL.md'), 'https://trails.example/SKILL.md');
});

test('addresses that hold no package, or fail, say what to do; nothing half-read is returned', async () => {
  const many = JSON.stringify({ id: 'many', name: 'Many', version: '1.0.0', api: 1, files: Array.from({ length: 201 }, (_, i) => `f${i}.js`) });
  const { fetch } = web({
    [`${T}/page`]: '<!DOCTYPE html><html>a folder page</html>',
    [`${T}/gone/SKILL.md`]: 404,
    [`${T}/closed/SKILL.md`]: new TypeError('Failed to fetch'),
    [`${T}/big/SKILL.md`]: SKILL,
    [`${T}/up/annai-plugin.json`]: JSON.stringify({ id: 'up', name: 'Up', version: '1.0.0', api: 1, entry: '../x.js' }),
    [`${T}/many/annai-plugin.json`]: many,
  });
  /** @type {[string, RegExp, number?][]} */
  const cases = [
    ['ftp://trails.example/x', /isn't a web address/],
    ['not an address', /isn't a web address/],
    [`${T}/page`, /no annai plugin or skill at that address/],
    [`${T}/gone/SKILL.md`, /answered 404/],
    [`${T}/closed/SKILL.md`, /couldn't reach trails\.example/],
    [`${T}/big/SKILL.md`, /more than annai reads/, 10],
    [`${T}/up/annai-plugin.json`, /"\.\.\/x\.js" isn't allowed/],
    [`${T}/many/annai-plugin.json`, /more than 200 files/],
  ];
  for (const [address, why, max] of cases) await assert.rejects(fetchPackage(address, { fetch, ...(max ? { max } : {}) }), (e) => e.constructor === Error && why.test(e.message), address);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/answer.test.js test/unit/package-address.test.js`
Expected: FAIL — `answerBytes` and `fetchPackage` aren't exported.

- [ ] **Step 3: Implement**
  - `answerBytes` reads the body with a reader, counting.
  - `fetchPackage(address, o)`: `new URL(rawAddress(address.trim()))` with `http:`/`https:` only, else `Error("That isn't a web address. Paste the address of a zip file, an annai-plugin.json or a SKILL.md.")`. Each request: `o.fetch(url)`; anything it throws (not an `AbortError`) becomes `Error("annai couldn't reach <host>. Check the address, and that the site lets web apps read it.")`; then `answerBytes(res, host, remaining)`. The first answer: bytes starting `PK\x03\x04` → `readZip(bytes, { maxTotal: max })` (a failure: `Error("<host> sent a zip annai can't open: <why>")`); else, as text after a BOM, a path ending `/annai-plugin.json` or a JSON object with `api` → the manifest's files (Choice 6) relative to the manifest's folder, each name checked like `inspectPackage` (`Error('The file name "<name>" isn\'t allowed.')`), plus each listed skill's links; a text starting `---` or a path ending `/SKILL.md` → `SKILL.md` and its links (at most `SKILL_MAX_LINKS`; a link that fails is left out); else `Error("There's no annai plugin or skill at that address. annai looks for a zip file, an annai-plugin.json or a SKILL.md.")`, with `" For a folder on GitHub, use the address of its SKILL.md or annai-plugin.json."` added for `github.com` addresses. More than `ADDRESS_MAX_FILES` files: `Error("That package has more than 200 files; annai installs packages of up to 200 from an address. Use a zip instead.")`. The total stays under `max` across requests.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/answer.test.js test/unit/package-address.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "annai can fetch a package from an address: a zip, an annai-plugin.json and the files it names, or a SKILL.md and the files it links to

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 9: Updates for packages installed from an address

**Files:**
- Create: `src/core/package-updates.js`
- Modify: `src/ui/plugin-updates.js`, `src/app/main.js`, `sw.js` (`SHELL`)
- Test: `test/unit/plugin-updates.test.js`

**Interfaces:**
- Consumes: `fetchPackage` (Task 8); `host.inspect`, `host.install`, `host.installed`, `host.setEnabled`, `host.needsRestart`, `host.start` (Task 5); `officialUpdates`, `updateOfficial` (`official.js`).
- Produces:
  - `addressUpdates(host, { fetch }): Promise<{ id: string, name: string, installed: string, available: string, url: string, kind: string, changed: boolean }[]>` — for each package with `source: 'url'`: fetch and inspect it; offered when its fingerprint differs from the stored one and its id is the same; `changed: true` when the version is the same. Anything that fails (offline, broken, another id) is skipped quietly.
  - `updateFromAddress(host, id, { fetch }): Promise<'started' | 'restart'>` — downloads again, refuses another id (`PluginError(id, "the address now holds another package (<other>), so it wasn't updated. Remove this one and install that one if you want it.")`), installs with the same `source` and `url`, keeps it off when it was off, and otherwise starts it or says a restart is needed.
  - `src/ui/plugin-updates.js`: `pluginUpdates(host, env): Promise<Update[]>` with `Update = { id, name, installed, available, entry?, url?, changed? }` (official ones carry `entry`, address ones `url`); `offerPluginUpdates(ctx, env)` and `applyUpdates(ctx, updates, env)` handle both; env gains `addressFetch` (the fetch for addresses). A changed package with the same version reads `<name> (changed)` on the card.
  - `main.js`: `offerPluginUpdates({ plugins, notices: shell.notices }, { addressFetch: tracedFetch(store, SYS, { tool: 'plugin updates' }) })`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/plugin-updates.test.js`:
```js
const ADDR = 'https://trails.example/tide-pools/SKILL.md';

test('a package from an address is checked there, offered when it changed, and changes only on Update (spec §5.3)', async () => {
  let served = SKILL;
  const get = async (/** @type {string} */ url) => (url === ADDR ? new Response(served) : new Response('', { status: 404 }));
  const { host, registry } = await hostKit();
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  await host.start('tide-pools');
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  served = SKILL.replace('version: "1.2"', 'version: "1.3"').replace('# Tide pools', '# Tide pools, new');
  const offers = await pluginUpdates(host, { addressFetch: get, fetch: async () => new Response(JSON.stringify({ plugins: [] })) });
  assert.deepEqual(offers.map((u) => [u.id, u.installed, u.available, u.url]), [['tide-pools', '1.2.0', '1.3.0', ADDR]]);
  const skill = () => registry.list('skill').find((s) => s.name === 'tide-pools');
  assert.match(await skill().text(), /^# Tide pools\n/);
  /** @type {any[]} */
  const said = [];
  await applyUpdates({ plugins: host, notices: { card: (/** @type {any} */ c) => said.push(c.title), toast: (/** @type {string} */ t) => said.push(t) } }, offers, { addressFetch: get });
  assert.deepEqual(said, ['Plugins updated.']);
  assert.match(await skill().text(), /^# Tide pools, new/);
  assert.equal((await host.installed())['tide-pools'].version, '1.3.0');
});

test('a changed skill with the same version is offered as changed', async () => {
  let served = SKILL;
  const get = async () => new Response(served);
  const { host } = await hostKit();
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  served = SKILL.replace('# Tide pools', '# Tide pools, reworded');
  const [u] = await addressUpdates(host, { fetch: get });
  assert.deepEqual([u.installed, u.available, u.changed], ['1.2.0', '1.2.0', true]);
});

test('an address that is offline, broken or now holds another package offers nothing; Update says why; an off package stays off', async () => {
  let answer = /** @type {() => Promise<Response>} */ (async () => new Response(SKILL));
  const get = () => answer();
  const { host } = await hostKit();
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  answer = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  answer = async () => new Response('---\nbroken');
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  answer = async () => new Response(SKILL.replace('name: tide-pools', 'name: other-skill'));
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  await assert.rejects(updateFromAddress(host, 'tide-pools', { fetch: get }), /now holds another package \(other-skill\)/);
  answer = async () => new Response(SKILL.replace('version: "1.2"', 'version: "2"'));
  await host.setEnabled('tide-pools', false);
  assert.equal(await updateFromAddress(host, 'tide-pools', { fetch: get }), 'started');
  assert.deepEqual([(await host.installed())['tide-pools'].version, (await host.installed())['tide-pools'].enabled], ['2.0.0', false]);
});
```
(imports: `hostKit` from `./plugin-packages.test.js`; `SKILL` from `./packages.test.js`; `fetchPackage` from `../../src/core/packages.js`; `addressUpdates`, `updateFromAddress` from `../../src/core/package-updates.js`; `pluginUpdates` added to the `plugin-updates.js` import.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/plugin-updates.test.js`
Expected: FAIL — `package-updates.js` can't be found.

- [ ] **Step 3: Implement** as the Interfaces say. The existing official-update tests keep passing unchanged. Add `'/src/core/package-updates.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/plugin-updates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Packages installed from an address are checked there at start and daily, offered on the plugin updates card, and change only on Update

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 10: The Plugins screen and the install screen

**Files:**
- Create: `src/ui/plugin-pending.js`, `src/ui/screens/plugin-install.js`
- Modify: `src/ui/screens/plugins.js`, `src/ui/router.js` (doc comment), `src/ui/shell.js` (`SCREENS['plugin-install']`), `src/ui/screens/shiori.js` (From plugins), `src/ui/screens/trace.js` (`KINDS.Plugins`), `src/ui/base.css`, `sw.js` (`SHELL`), `test/e2e/plugins.spec.js` (the install screen's tap; Remove)
- Test: `test/unit/ui-pure.test.js` (`whatItBrings`, `sourceLine`), and `test/e2e/plugins.spec.js` updated

**Interfaces:**
- Consumes: `host.inspect`, `host.install`, `host.start`, `host.needsRestart`, `host.describe` (Task 5); `host.uninstall` (Task 7); `fetchPackage` (Task 8); `pluginUpdates`, `applyUpdates` (Task 9); `officialPlugins`, `installOfficial` (`official.js`); `readZip`; `tracedFetch`.
- Produces:
  - `src/ui/plugin-pending.js`: `setPendingPackage(p: { files: Map<string, Uint8Array>, pkg: Package & { replaces }, from: { source: 'file', file: string } | { source: 'url', url: string } } | null)`, `pendingPackage()` (it stays until install or cancel).
  - `src/ui/screens/plugin-install.js`: `renderPluginInstall(ctx)`, and pure helpers `whatItBrings(pkg): string[]` and `sourceLine(from | row): string`.
  - Route `#/plugin-install`.
  - The Plugins screen: the risk note (as today); the installed rows ("<name> <shownVersion>", the state, "Skill" for a bare skill, `sourceLine`, the description; Update to <available>, Restart annai, Turn off/on, **Remove** with "Tap again to remove"); **Install from a file** (`accept=".zip,.md,application/zip,text/markdown"`; a `.md` file is a bare skill whose `SKILL.md` it is); **Address of a plugin or skill** and **Get it** (an error shows under the field, `role="alert"`); **From annai's catalog**: each official plugin not installed, with Install.
  - The install screen: heading `Install <name>?`; a line "<A plugin | A skill | A package without code> · version <v> · by <author>" (parts only when known); the homepage as a link when it is `https:`/`http:`; the description; "From <file name | address>"; "What it brings" as a list (`whatItBrings`); for code a paragraph `class="risk-note"` with exactly "This plugin gets full access to your trips and API keys." and a second sentence "Only install it if you trust where it came from."; without code a paragraph "A skill is instructions for Shiori: she reads them when they fit what you ask, and follows what they say. annai never runs anything in it, so install skills you trust."; when replacing "Version <v> is installed now. Installing replaces it."; buttons **Install** (primary) and **Cancel**. With nothing pending: "There's nothing to install. Go back to Plugins." and a link.
  - Install: for code, the service worker must control the page (today's message); `install(files, from)`, then start it unless a restart is needed (today's restart card), toast `Installed <name>.`, go to `#/plugins`; a failure is a card that says what happened.
  - `whatItBrings(pkg)`: `'Code that runs in annai'` when `code`; `'Skill "<name>": <description>'` for each skill; `'Personality "<name>"'` for each; `'Endpoint templates: <names joined with ", ">'` when any; `'Nothing annai uses yet'` when the list is empty.
  - `sourceLine`: `'From annai'` (official, built-in), `'From <host><path>'` for an address (the address as `traceUrl` keeps it, without the scheme, its percent-escapes read with `decodeURI` when they can be), `'From a file: <name>'` (`'From a file'` when no name).
  - Settings → Shiori, under Personality: "From plugins", each `registry.entries('personality')` item not already a file in `/me/personalities/`, as `<name> (from <plugin name>)` with an **Add** button that writes `/me/personalities/<name>.md` (author `user`), toasts `Added the personality "<name>". Choose it above.` and redraws.
  - Trace → Kind gains `Plugins: ['plugin.install', 'plugin.update', 'plugin.remove', 'plugin.error', 'plugin.disabled']`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/ui-pure.test.js`:
```js
test('the install screen says what a package brings and where it came from', async () => {
  const { whatItBrings, sourceLine } = await import('../../src/ui/screens/plugin-install.js');
  assert.deepEqual(whatItBrings({ code: true, skills: [{ name: 'trail-safety', description: 'Before a hike.' }], personalities: [{ name: 'ranger' }], templates: [{ name: 'Trail LLM' }, { name: 'Trail mini' }] }),
    ['Code that runs in annai', 'Skill "trail-safety": Before a hike.', 'Personality "ranger"', 'Endpoint templates: Trail LLM, Trail mini']);
  assert.deepEqual(whatItBrings({ code: false, skills: [], personalities: [], templates: [] }), ['Nothing annai uses yet']);
  assert.equal(sourceLine({ source: 'url', url: 'https://trails.example/kits/SKILL.md?token=abc' }), 'From trails.example/kits/SKILL.md?token=«key»');
  assert.equal(sourceLine({ source: 'file', file: 'tides.zip' }), 'From a file: tides.zip');
  assert.equal(sourceLine({ source: 'official' }), 'From annai');
  assert.equal(sourceLine({ source: 'builtin' }), 'From annai');
});
```

`test/e2e/plugins.spec.js`, its uses of the file input: the label becomes `Install from a file`; after each `setInputFiles`, `await page.getByRole('button', { name: 'Install', exact: true }).click();` on the install screen (and, in the first test, before that: `await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();`); Uninstall becomes `Remove` / `Tap again to remove`. The "bad plugin file" test expects the card `That file isn't something annai can install` (the file never reaches the install screen).

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL — `plugin-install.js` can't be found.

- [ ] **Step 3: Implement** as the Interfaces say. A file or address that can't be read or inspected is a card titled `That file isn't something annai can install` (or, for an address, the error under the field) with the reason. Address requests use `tracedFetch(ctx.store, SYS, { tool: 'plugins' })`. Styles for the install screen's list and the risk paragraph in `base.css` (existing tokens only). Add both new files to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/ui-pure.test.js` and `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/plugins.spec.js test/e2e/trace.spec.js`
Expected: PASS in Chromium and WebKit.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Settings → Plugins installs from a file, an address or annai's catalog, always through an install screen that says what the package is and what it may do

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 11: Skills and code plugins end to end; the plugin guide; the size budget

**Files:**
- Create: `test/fixtures/extensions/tide-pools/SKILL.md`, `test/fixtures/extensions/tide-pools/references/safety.md`, `test/fixtures/extensions/tide-pools/scripts/fetch.py`, `test/fixtures/extensions/tides/annai-plugin.json`, `test/fixtures/extensions/tides/index.js`, `test/fixtures/extensions/tides/lib.js`, `test/fixtures/extensions/trail-kit/annai-plugin.json`, `test/fixtures/extensions/trail-kit/skills/trail-safety/SKILL.md`, `test/fixtures/extensions/trail-kit/personalities/ranger.md`, `test/e2e/extensions.spec.js`
- Modify: `test/e2e/helpers.js` (`fixtureFiles`, `zipOf`, `modelSetUp`), `docs/plugins.md`, `scripts/size.mjs` (the budget)

**Interfaces:**
- Consumes: everything above.
- Produces: `test/e2e/helpers.js`: `fixtureFiles(dir: string): Promise<Record<string, Buffer>>` (every file under `test/fixtures/extensions/<dir>/`, by path inside it), `zipOf(files: Record<string, Buffer>, top?: string): Promise<Buffer>`, `modelSetUp(page, origin, trip = 'Big Sur')` (the stand-in Anthropic endpoint in the main role and a trip, as `shiori.spec.js`'s `setUp` does; `shiori.spec.js` keeps its own).

The fixtures:
- `tide-pools/SKILL.md`: front matter `name: tide-pools`, `description: When the user asks about tide pools - how to read a tide table, and when the pools are safe to visit.`, `license: CC-BY-4.0`, `metadata: { author: Example Trails, version: "1.2" }`; body `# Tide pools`, the sentence "Pools are safest from an hour before low tide until low tide.", a link `[the safety notes](references/safety.md)`, and "Never run scripts/fetch.py; it is only an example."
- `references/safety.md`: "Watch the waves: never turn your back on the ocean."; `scripts/fetch.py`: `print("tides")`.
- `tides/annai-plugin.json`: `{ "id": "tides", "name": "Tides", "version": "1.0.0", "api": 1, "entry": "index.js", "files": ["index.js", "lib.js"], "description": "Test plugin: today's tides as a tool.", "author": "annai tests", "homepage": "https://annai.guide/" }`; `index.js` imports `VERSION` and `TABLE` from `./lib.js` and registers `tide_times` (description `Today's tides near the user.`, input `{ type: 'object', properties: {} }`, run → `Tides ${VERSION}: ${TABLE}`); `lib.js`: `export const VERSION = '1.0.0'; export const TABLE = 'low 05:40, high 11:52';`.
- `trail-kit/annai-plugin.json`: `{ "id": "trail-kit", "name": "Trail kit", "version": "1.0.0", "api": 1, "description": "Test package: a skill and a personality, no code.", "skills": ["skills/trail-safety"], "personalities": ["personalities/ranger.md"] }` with its `SKILL.md` (`name: trail-safety`, `description: Before a hike - water, light, and telling someone where you go.`) and `ranger.md` ("# Ranger\nCalm and practical, and brief on the trail.").

- [ ] **Step 1: Write the failing tests**

`test/e2e/extensions.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, fixtureFiles, zipOf, modelSetUp } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const file = (/** @type {Buffer} */ body, type = 'text/plain') => ({ status: 200, type, body });

/** What annai stores for a package: files and their history in sys:plugins. @param {any} page @param {string} id */
async function storedFor(page, id) {
  return page.evaluate(async (id) => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const store = await createIdbStore();
    const out = await store.tx(['files', 'events'], 'readonly', async (/** @type {any} */ t) => ({
      files: (await t.listFiles('sys:plugins', `/${id}/`)).length,
      history: (await t.listEvents('sys:plugins', { types: ['file.write', 'file.delete'] })).filter((/** @type {any} */ e) => String(e.data?.path).startsWith(`/${id}/`)).length,
    }));
    store.close();
    return out;
  }, id);
}

test('a skill from a zip: the install screen says what a skill is; Shiori sees only its name and description, loads it and one of its files; Remove removes it', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'skill', input: { name: 'tide-pools' } }])),
    sse(anthropicToolReply([{ name: 'skill', input: { name: 'tide-pools', file: 'references/safety.md' } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Go an hour before low tide.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Install from a file').setInputFiles({ name: 'tide-pools.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('tide-pools'), 'tide-pools-main') });
    await expect(page.getByRole('heading', { name: 'Install tide-pools?' })).toBeVisible();
    await expect(page.getByText('A skill is instructions for Shiori')).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toHaveCount(0);
    await expect(page.getByText('by Example Trails')).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('tide-pools 1.2')).toBeVisible();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Are the tide pools safe now?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Go an hour before low tide.');
    const [first, second, third] = llm.bodies('/b/v1/messages').map((b) => JSON.stringify(b));
    expect(first).toContain('tide-pools: When the user asks about tide pools - how to read a tide table, and when the pools are safe to visit.');
    expect(first).not.toContain('Pools are safest from an hour before low tide');
    expect(first).not.toContain('Example Trails');
    expect(first).not.toContain('CC-BY-4.0');
    expect(second).toContain('Pools are safest from an hour before low tide');
    expect(second).toContain('references/safety.md');
    expect(third).toContain('never turn your back on the ocean');
    await page.goto('/#/plugins');
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Tap again to remove' }).click();
    await expect(page.getByText('tide-pools 1.2')).toHaveCount(0);
    expect(await storedFor(page, 'tide-pools')).toEqual({ files: 0, history: 0 });
  } finally {
    await llm.stop();
  }
});

test('a skill from an address, with the file it links to', async ({ page }) => {
  const skill = await fixtureFiles('tide-pools');
  const site = await startModelServer({ '/kits/tide-pools/SKILL.md': file(skill['SKILL.md'], 'text/markdown'), '/kits/tide-pools/references/safety.md': file(skill['references/safety.md'], 'text/markdown') });
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tide-pools/SKILL.md`);
    await page.getByRole('button', { name: 'Get it' }).click();
    await expect(page.getByRole('heading', { name: 'Install tide-pools?' })).toBeVisible();
    await expect(page.getByText(`From 127.0.0.1:${new URL(site.origin).port}/kits/tide-pools/SKILL.md`)).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('tide-pools 1.2')).toBeVisible();
    expect(await storedFor(page, 'tide-pools')).toEqual({ files: 2, history: 0 });
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('a code plugin from a zip and from an address, behind the full-trust screen: Cancel installs nothing; Install works and survives a reload', async ({ page }) => {
  const tides = await fixtureFiles('tides');
  const site = await startModelServer(Object.fromEntries(Object.entries(tides).map(([n, b]) => [`/kits/tides/${n}`, file(b, n.endsWith('.js') ? 'text/javascript' : 'application/json')])));
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'tide_times', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Install from a file').setInputFiles({ name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf(tides) });
    await expect(page.getByRole('heading', { name: 'Install Tides?' })).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await expect(page.getByText('Code that runs in annai')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Tides 1.0.0')).toHaveCount(0);
    await page.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tides/annai-plugin.json`);
    await page.getByRole('button', { name: 'Get it' }).click();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('Tides 1.0.0')).toBeVisible();
    await page.reload();
    // Installed plugins start after the first screen; the Plugins screen redraws once they have.
    await expect(page.locator('.card', { hasText: 'Tides 1.0.0' }).getByText('On', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.goto('/#/tools');
    await expect(page.getByRole('checkbox', { name: 'tide_times', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Tides today?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Tides 1.0.0: low 05:40, high 11:52');
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('an update from an address is offered after a reload and changes nothing until Update; then the new code runs after the restart', async ({ page }) => {
  const tides = await fixtureFiles('tides');
  /** @type {Record<string, any>} */
  const routes = Object.fromEntries(Object.entries(tides).map(([n, b]) => [`/kits/tides/${n}`, file(b, n.endsWith('.js') ? 'text/javascript' : 'application/json')]));
  const site = await startModelServer(routes);
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'tide_times', input: {} }])), sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tides/annai-plugin.json`);
    await page.getByRole('button', { name: 'Get it' }).click();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('Tides 1.0.0')).toBeVisible();
    routes['/kits/tides/annai-plugin.json'] = file(Buffer.from(tides['annai-plugin.json'].toString().replace('"1.0.0"', '"1.1.0"')), 'application/json');
    routes['/kits/tides/lib.js'] = file(Buffer.from(tides['lib.js'].toString().replace("'1.0.0'", "'1.1.0'")), 'text/javascript');
    await page.reload();
    await expect(page.getByText('Plugin updates are ready')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Tides 1.0.0 → 1.1.0')).toBeVisible();
    await page.goto('/#/plugins');
    await expect(page.getByText('Tides 1.0.0')).toBeVisible();
    await page.getByRole('button', { name: 'Update to 1.1.0' }).click();
    await expect(page.getByText('Restart annai to use the new versions')).toBeVisible();
    await page.getByRole('status').getByRole('button', { name: 'Restart now' }).click();
    await expect(page.getByText('Tides 1.1.0')).toBeVisible();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Tides today?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Tides 1.1.0: low 05:40');
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('a package without code brings a skill and a personality; Settings → Shiori offers the personality to add', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Install from a file').setInputFiles({ name: 'trail-kit.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('trail-kit')) });
    await expect(page.getByText('Skill "trail-safety": Before a hike - water, light, and telling someone where you go.')).toBeVisible();
    await expect(page.getByText('Personality "ranger"')).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await page.goto('/#/shiori');
    await expect(page.getByText('ranger (from Trail kit)')).toBeVisible();
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('radio', { name: 'ranger' })).toBeVisible();
  } finally {
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/extensions.spec.js`
Expected: FAIL — the fixtures and helpers don't exist yet ("fixtureFiles is not a function").

- [ ] **Step 3: Write the fixtures and the helpers** as the Interfaces say; fix whatever the run shows. The update test is the one most likely to show a real gap (a module URL the browser keeps until restart, the card's timing): debug with `superpowers:systematic-debugging`, never by loosening what it checks.

- [ ] **Step 4: Run them to make sure they pass**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/extensions.spec.js test/e2e/plugins.spec.js`
Expected: PASS in Chromium and WebKit. Delete any `core*` file in the worktree afterwards.

- [ ] **Step 5: The plugin guide and the budget**
  - `docs/plugins.md`: "The package" covers both kinds (a bare skill; a plugin), the manifest's `skills`, `personalities`, `templates` and `files`; a new "Skills" section (the format, what Shiori sees, the `skill` tool with `file`, scripts never run, a skill from a code plugin with `annai.register('skill', { name, description, text, files?, read? })`); "Installing" (a file, an address and what an address may hold, annai's catalog; the install screen; updates from an address by fingerprint); "Removing" (what goes, what stays); the table's `annai.register('skill', …)` row updated.
  - `scripts/size.mjs`: raise `BUDGET` to what `npm run size` now needs plus about 5 KiB, rounded to 10 (expected 1360); its comment gains "; 1360 for milestone 8a (skills and packages)" with the real number.

- [ ] **Step 6: The whole suite**

Run: `npm run stamp && npm run check` then `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test > .superpowers/sdd/2026-10-17-m8a-skills-and-packages/e2e.log 2>&1; tail -20 .superpowers/sdd/2026-10-17-m8a-skills-and-packages/e2e.log`
Expected: every check passes; the e2e run passes in Chromium and WebKit (a `push-sw.spec.js` failure once: run the suite again and note it).

- [ ] **Step 7: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Skills and code plugins end to end: from a zip and an address, in Shiori's context by name and description, loaded with the skill tool, updated only on Update

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
