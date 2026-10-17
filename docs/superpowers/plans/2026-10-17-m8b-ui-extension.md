# Milestone 8b: UI Extension, Hooks and a Plugin's Own Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** What plugins can add to annai's screens (spec §16.4) and the rest of §5.2/§5.4/§5.5 that 8a left:
- **Slots:** status chips, Now-card sections, dock actions, trip tabs, settings pages.
- **Card types:** a plugin's renderer for a kind of card Shiori shows, with an optional schema her card must pass.
- **Named components** a plugin can replace: `avatar`, `now-card`, `dock`, `plan-row`.
- **Whole screens:** a new tab, or the home screen for an activity ("a mode such as hiking").
- **Themes:** a plugin's CSS file that sets annai's CSS variables.
- **Hooks** (§5.4: "subscribe to log appends; read-only in v1").
- **A plugin's own page** in Settings → Plugins, with the form its manifest's `settings` JSON Schema asks for (§5.2), and its settings pages.
- **The card when a running plugin is switched off** after repeated errors (§5.5).
- **Done when (§20 row 8), the code plugin's part, in Chromium and WebKit:** a third-party code plugin, from a zip and from an address, behind the full-trust screen, adds a tool and a status chip, survives a reload, and is updated only when the user taps Update.

**Architecture:**
- `src/core/hooks.js`: `watchAppends(store, onAppend)` wraps a store so committed log appends are reported; `deliverHooks(registry, events)` hands each plugin's hooks frozen copies.
- `src/core/ui-slots.js` (pure): what each slot, card type, component, screen and theme must be; `cardSchema(types)` for the `show` tool.
- `src/core/plugins.js`: `annai.ui.slot/cardType/component/screen/theme` and `annai.hooks.on`, each checked and registered as `ui:<kind>` (or `hook`) under the plugin's id, so they go when it stops.
- `src/ui/slots.js` (DOM): the `ui` object renderers get, guarded mounting (a renderer that throws counts against its plugin and never breaks the screen), the registry's UI signature, themes.
- The shell redraws what plugins add when their contributions change; the dock, Now, Plan, the trip page, Settings and the conversation use the slots and components.
- `src/ui/screens/plugin.js` (a plugin's page) and `src/ui/settings-form.js` (the form from a JSON Schema; `writeOnly` fields go to the plugin's secrets).
- Milestone 8c adds the MCP client and milestone 8's device checklist.

**Tech Stack:** as 8a: native ES modules, no build step, zero runtime dependencies, JSDoc types, `node:test`, Playwright 1.63.0 in Docker.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §16.4 (UI extension), §5.2 (`settings`), §5.4 (`ui`, `hooks`), §5.5 (the card), §3 (`ui:` slots, card types, components, screens, themes), §15 (rendering; full trust), §16.1, §16.5, §20 row 8. The mockups' "Where plugins change the UI" panel (`docs/mockups/ui-mockups-2026-10-15.html`). 8a's plan: `docs/superpowers/plans/2026-10-17-m8a-skills-and-packages.md`.

## Choices this plan makes (please check them)

1. **Every slot item draws itself:** annai hands it an empty element it made (a chip, a section, the tab's or page's body) and a `ui` object; the plugin fills it (its own UI is full trust, so it may use any DOM API). What annai draws from a plugin's words (a tab's label, a dock action's name, a screen's title, a card type's name) is text. *Cost if wrong:* a plugin draws its own label styles.
2. **Where slots go:** status chips in the dock's chip row, after the voice and live chips (the mockup's status bar is the dock's row here); Now-card sections inside the Now card, after its chips; dock actions as buttons after Type; trip tabs as buttons after Plan, Recap and Replay on a trip's page, opening `#/trip/<id>/ext/<plugin>/<tab>`; settings pages listed under "From plugins" in Settings and on the plugin's page, opening `#/plugin-page/<plugin>/<page>`. annai's own chips and sections stay as they are (they don't register through the registry). *Cost if wrong:* a layout move.
3. **A renderer that throws is the plugin's failure,** counted like a tool's crash (three in a row turn the plugin off, with §5.5's card); its element stays empty, and the screen draws everything else.
4. **Named components:** `avatar` (a factory with the built-in avatar's interface: `el`, `setState`, `setLevel`, `glance`, `blink`), `now-card` (draws the Now card's top: where you are, the chips and the live button), `dock` (makes the whole dock), `plan-row` (draws one row of the Plan's and Now's timetables). The last one registered wins; when it fails, annai's own is used. *Cost if wrong:* other names later ("and others", §16.4).
5. **Whole screens** open at `#/ext/<plugin>/<screen>`. `tab: true` adds them to the top bar after Settings. `homeFor: 'walking' | 'still' | 'moving-fast'` makes Now hand over to the screen when live mode says that activity starts, as it hands over to Driving for moving fast (a plugin's `moving-fast` home wins over Driving). *Cost if wrong:* "a mode such as hiking" read as an activity.
6. **Themes** are CSS files in the package: `annai.ui.theme('theme.css')` adds `<link rel="stylesheet" href="/plugins/<id>/theme.css">` (CSP `style-src 'self'` allows it), removed when the plugin stops. Only CSS variables are stable (§16.4), which `docs/plugins.md` lists. *Cost if wrong:* none.
7. **Card types:** `annai.ui.cardType({ type, name, description, schema?, render })`. Shiori's `show` card gains `type` and `data` once a type is registered; the tool's description lists the types; a card whose `data` fails the type's schema is refused with the reason, as a file write is. A typed card whose plugin is gone or off shows its title and text and says its kind came from a plugin that isn't on. Its label reads "SHIORI · <NAME>". *Cost if wrong:* the tool's definition changes when a type comes or goes (one cold cache).
8. **The `ui` object** a renderer gets: `h` (annai's DOM builder), `go(hash)`, `trip()` (the open trip's id or null), `toast(text)`, `card({ title, body, tone, actions })`, `shiori.state()`, `shiori.on(kind, fn)`, `shiori.tap()`, `shiori.send(text)`, `live.on()`, `live.activity()`, `live.onChange(fn)`. *Cost if wrong:* an interface plugins rely on; it only grows.
9. **What plugins add redraws when it changes:** when a plugin starts or stops, the dock's chips and actions, the top bar's tabs, the themes and the screen on show are drawn again. The whole dock is made again only when a `dock` or `avatar` component comes or goes. *Cost if wrong:* a form on screen loses what was typed when a plugin starts.
10. **Hooks:** `annai.hooks.on(fn, { types? })`: after each committed write, each appended log entry (a frozen copy; `types` filters) reaches every running plugin's hooks, never one its own plugin appended (so a hook that logs can't loop). A hook's error counts against its plugin. *Cost if wrong:* a hook can't see what its own plugin logged.
11. **A plugin's page** (`#/plugins/<id>`): name, version, author, homepage, where it came from, what it is doing (state), its skills and tools, its settings form, its settings pages, Update, Turn off/on, Remove. Rows on Settings → Plugins open it.
12. **The settings form** reads the manifest's `settings` (a JSON Schema object): each top-level property of type `string` (a select for `enum`, a password field for `writeOnly: true`), `number`, `integer` or `boolean`, labelled by `title` (else its key), with `description` under it and `default` when nothing is saved. Other kinds are listed as "annai can't show this setting". Values go to `/plugin-settings/<id>.json` (what `annai.settings.get()` reads), checked against the schema; `writeOnly` values go to the plugin's secrets (`annai.secrets.get(key)`), never into files, shown as "saved". *Cost if wrong:* nested settings need a plugin's own settings page.
13. **The card when a plugin is switched off** after repeated errors names the plugin and its last error (with any key blanked), and offers Settings → Plugins.
14. **The size budget** is raised in Task 8 to what 8b needs plus about 5 KiB, rounded to 10.

## Global Constraints

- All of 8a's Global Constraints hold (zero runtime dependencies; `npm run stamp && npm run check` before every commit, chained with `&&`; the two attribution lines; `SHELL` lists every file under `src/`, `assets/`, `skills/`; e2e only in Docker; never host ports 8765, 8790, 8791, 8792, 8796, 8797, 18010–18014; no `git stash`, push, merge into main or branch switch).
- **"Slots: status chips, Now-card sections, dock actions, trip tabs, settings pages. Card types: renderers, often paired with a schema. Named components that plugins can replace: avatar, now-card, dock, plan-row, and others. Whole screens: a new tab, or the home screen for a mode such as hiking. Themes: all colors, type and spacing are CSS variables. Only slots, components and variables are stable across updates" (§16.4).**
- **"settings: a JSON Schema, from which we render a settings form automatically" (§5.2).** "hooks (subscribe to log appends; read-only in v1)" (§5.4). "A plugin that keeps failing is disabled automatically, with a card saying why" (§5.5).
- **Rendering:** model output and plugin-supplied words that annai draws go in as text, never `innerHTML`; no `style` attribute (CSSOM `setProperty` is fine); links `https:`/`http:` only; CSP stays `script-src 'self'`. A code plugin's own UI is full trust.
- **Accessibility (§16.5):** labelled controls (dock actions have names), large targets, visible focus.
- **System cards are never in Shiori's voice; every error says what happened and what to do next.**
- **Keys never appear in files, the log or the trace;** `writeOnly` settings go to secrets.

## Review Focus

1. **A renderer that throws, hangs or returns nonsense** (a status chip whose render throws, a card type that throws, an avatar factory that returns `{}`): the screen draws the rest; annai's own part is used where one exists; the failure counts against the plugin. Pinned in Tasks 4, 5 and 6.
2. **A plugin that starts or stops while a screen is open** (Now, a trip, Settings): what it added appears or goes without a reload; its theme goes; its tab leaves the top bar. Pinned in Tasks 4 and 8.
3. **Shiori's card for a type that isn't there, or with bad data** (no such type, data failing the schema, a plugin turned off since): the tool refuses with the reason; an old card still shows its title and text. Pinned in Task 6.
4. **A hook that throws, logs, or alters what it was given:** others still run; it can't loop on its own entries; the log is unchanged. Pinned in Task 1.
5. **A settings form with odd schemas** (no properties, an unsupported type, a `writeOnly` field, a value outside its range, an enum): only what can be shown is shown; an invalid value is refused with the reason; a secret never lands in a file. Pinned in Task 7.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/hooks.js`, `src/core/plugins.js`, `src/app/main.js` | 1 | `watchAppends`, `deliverHooks`; `annai.hooks.on` |
| `src/core/registry.js`, `src/ui/plugin-cards.js`, `src/app/main.js` | 2 | `Registry.onDisabled`; the card when a plugin is switched off |
| `src/core/ui-slots.js`, `src/core/plugins.js` | 3 | the checks; `annai.ui.slot/cardType/component/screen/theme` |
| `src/ui/slots.js`, `src/ui/shell.js`, `src/ui/router.js`, `src/ui/screens/ext.js` | 4 | the `ui` object, guarded mounting, redraws, themes, tabs, `#/ext/…`, `#/plugin-page/…`, `#/trip/<id>/ext/…` |
| `src/ui/dock.js`, `src/ui/screens/now.js`, `src/ui/screens/plan.js`, `src/ui/screens/trip.js`, `src/ui/screens/settings.js`, `src/ui/base.css`, `test/fixtures/extensions/trail-ui/…`, `test/fixtures/extensions/trail-look/…`, `test/e2e/ui-extension.spec.js` | 5 | slots and components on annai's screens, end to end |
| `src/core/agent/loop.js`, `src/ui/cards.js`, `src/ui/screens/talk.js`, `src/ui/screens/now.js` | 6 | card types in `show`, and drawn |
| `src/ui/settings-form.js`, `src/ui/screens/plugin.js`, `src/ui/screens/plugins.js`, `src/core/packages.js` | 7 | a plugin's page and its settings form |
| `test/fixtures/extensions/tides/…`, `test/e2e/extensions.spec.js`, `docs/plugins.md`, `scripts/size.mjs` | 8 | the code plugin's Done when; the guide; the budget |

---

### Task 1: Hooks

**Files:**
- Create: `src/core/hooks.js`
- Modify: `src/core/plugins.js` (`annai.hooks`), `src/app/main.js` (the store is watched), `test/unit/package-kit.js` (`hostKit` watches its store), `sw.js` (`SHELL`)
- Test: `test/unit/hooks.test.js`

**Interfaces:**
- Produces:
  - `watchAppends(store: Store, onAppend: (events: EventRecord[]) => void): Store` — the same store, whose read-write transactions report the entries they appended, once they have committed (never for a transaction that failed).
  - `deliverHooks(registry: Registry, events: EventRecord[]): void` — for each running plugin's `hook` entries (`{ fn, types? }`), each event of a listed type (all when `types` is absent) not appended by `plugin:<that id>`, calls `registry.guard(pluginId, 'hook', fn)` with a deeply frozen copy, after the current task (`queueMicrotask`); errors are counted by `guard` and never thrown.
  - `annai.hooks.on(fn, { types? }?)` returns the function that removes it; `fn` must be a function (`PluginError(id, 'hooks.on needs a function')`).
  - `hostKit()` (8a's test kit) builds its store with `watchAppends(createMemoryStore(), (evs) => deliverHooks(registry, evs))`.

- [ ] **Step 1: Write the failing tests**

`test/unit/hooks.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { watchAppends, deliverHooks } from '../../src/core/hooks.js';
import { Registry } from '../../src/core/registry.js';
import { SYS } from '../../src/core/scopes.js';
import { files, hostKit } from './package-kit.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a watched store reports the entries a write appended, once it committed, and nothing for one that failed', async () => {
  /** @type {any[][]} */
  const seen = [];
  const store = watchAppends(createMemoryStore(), (evs) => seen.push(evs));
  await store.tx(['events'], 'readwrite', async (t) => {
    await t.appendEvent('a', { ts: 1, type: 'x', actor: 'user' });
    await t.appendEvent('a', { ts: 2, type: 'y', actor: 'user' });
  });
  await assert.rejects(store.tx(['events'], 'readwrite', async (t) => {
    await t.appendEvent('a', { ts: 3, type: 'z', actor: 'user' });
    throw new Error('no');
  }));
  await store.tx(['events'], 'readonly', (t) => t.listEvents('a'));
  assert.deepEqual(seen.map((evs) => evs.map((e) => [e.seq, e.type])), [[[1, 'x'], [2, 'y']]]);
});

test("hooks: a plugin's hook gets frozen copies of what is appended, of the types it asked for, never its own", async () => {
  const { host, ws, log } = await hostKit();
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'watcher', name: 'Watcher', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      globalThis.__seen = [];
      return annai.hooks.on(async (e) => {
        globalThis.__seen.push(e.type);
        try { e.data.path = 'changed'; } catch { globalThis.__seen.push('frozen'); }
        await annai.events.append('sys', 'watcher.saw', { type: e.type });
      }, { types: ['file.write', 'watcher.saw'] });
    }`,
  }));
  await host.start('watcher');
  await ws.write('me', '/notes/a.md', 'hi', { author: 'user' });
  await settle();
  await settle();
  const g = /** @type {any} */ (globalThis);
  assert.deepEqual(g.__seen, ['file.write', 'frozen']);
  assert.equal((await log()).filter((e) => e.type === 'watcher.saw').length, 1); // its own entry didn't come back to it
  const [write] = await ws.store.tx(['events'], 'readonly', (t) => t.listEvents('me', { types: ['file.write'], reverse: true, limit: 1 }));
  assert.equal(write.data.path, '/notes/a.md');
});

test('hooks: a hook that throws counts against its plugin, and the others still run', async () => {
  const registry = new Registry();
  /** @type {string[]} */
  const got = [];
  registry.add('bad', 'hook', { fn: () => { throw new TypeError('boom'); } });
  registry.add('good', 'hook', { fn: (/** @type {any} */ e) => { got.push(e.type); } });
  for (let i = 0; i < 3; i++) deliverHooks(registry, [{ scope: SYS, seq: i + 1, ts: 1, type: 'x', actor: 'system' }]);
  await settle();
  await settle();
  assert.deepEqual(got, ['x', 'x', 'x']);
  assert.equal(registry.isDisabled('bad'), true);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/hooks.test.js`
Expected: FAIL — `src/core/hooks.js` can't be found.

- [ ] **Step 3: Implement** `src/core/hooks.js` and `annai.hooks` as the Interfaces say; `main.js` makes the store with `watchAppends(await createIdbStore(), (evs) => deliver(evs))`, where `deliver` becomes `(evs) => deliverHooks(registry, evs)` once the registry exists; `hostKit` likewise. Add `'/src/core/hooks.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/hooks.test.js test/unit/plugin-packages.test.js test/unit/store-memory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Plugins can follow the log: annai.hooks.on gets frozen copies of each entry appended, never its own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: The card when a running plugin is switched off

**Files:**
- Create: `src/ui/plugin-cards.js`
- Modify: `src/core/registry.js` (`onDisabled`), `src/app/main.js`, `sw.js`
- Test: `test/unit/plugins.test.js`, `test/unit/ui-pure.test.js`

**Interfaces:**
- Produces:
  - `Registry.onDisabled(fn: (info: { pluginId: string, reason: string, message: string }) => void): () => void` — called once each time a plugin is switched off after repeated errors; `message` is the last error's message.
  - `disabledCard({ name, reason, message }): { tone: 'warn', title: string, body: string }` in `src/ui/plugin-cards.js`: title `The plugin "<name>" was turned off`, body `It failed ${reason}. The last error: ${message} You can turn it back on in Settings → Plugins.`
  - `main.js`: `registry.onDisabled(async (d) => shell.notices.card({ ...disabledCard({ name: <the plugin's name from plugins.describe(), else its id>, reason: d.reason, message: await withoutSecrets(store, d.message) }), actions: [{ label: 'Plugins', run: () => { location.hash = '#/plugins'; } }] }))` (cards before the shell is up wait, as push cards do).

- [ ] **Step 1: Write the failing tests**

In `test/unit/plugins.test.js`:
```js
test('registry: switching a plugin off after repeated errors is told once, with its last error (spec §5.5)', async () => {
  const r = new Registry();
  /** @type {any[]} */
  const told = [];
  r.onDisabled((d) => told.push(d));
  const f = r.guard('flaky', 'tool x', () => { throw new TypeError('boom 3'); });
  for (let i = 0; i < 4; i++) await f().catch(() => {});
  assert.deepEqual(told, [{ pluginId: 'flaky', reason: 'failed 3 times in a row', message: 'boom 3' }]);
});
```
In `test/unit/ui-pure.test.js`:
```js
test('the card when a plugin is switched off says which, why and where to turn it back on', async () => {
  const { disabledCard } = await import('../../src/ui/plugin-cards.js');
  assert.deepEqual(disabledCard({ name: 'Tides', reason: 'failed 3 times in a row', message: 'boom' }), {
    tone: 'warn', title: 'The plugin "Tides" was turned off',
    body: 'It failed 3 times in a row. The last error: boom You can turn it back on in Settings → Plugins.',
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/plugins.test.js test/unit/ui-pure.test.js`
Expected: FAIL — `r.onDisabled is not a function`; `plugin-cards.js` can't be found.

- [ ] **Step 3: Implement** as the Interfaces say. Add `'/src/ui/plugin-cards.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/plugins.test.js test/unit/ui-pure.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "A plugin switched off after repeated errors gets a card saying which, why and where to turn it back on (spec §5.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: What plugins add to the UI, checked and registered

**Files:**
- Create: `src/core/ui-slots.js`
- Modify: `src/core/plugins.js` (`annai.ui`), `sw.js`
- Test: `test/unit/ui-slots.test.js`

**Interfaces:**
- Produces (`src/core/ui-slots.js`):
  - `SLOTS = ['status-chip', 'now-section', 'dock-action', 'trip-tab', 'settings-page']`; `COMPONENTS = ['avatar', 'now-card', 'dock', 'plan-row']`; `ACTIVITIES = ['still', 'walking', 'moving-fast']`; `UI_ID = /^[a-z0-9][a-z0-9-]{0,39}$/`.
  - `checkSlot(slot, item): string | null` — every slot item has an `id` (`UI_ID`); `status-chip` and `now-section` have `render`; `now-section`, `trip-tab` and `settings-page` have a `title` (1–40 characters) and `render`; `dock-action` has a `label` (1–40), an `icon` (1–2 characters, text) and `run`.
  - `checkCardType(item)`: `type` (`UI_ID`), `name` (1–40), `description` (1–300), `render`, optional `schema` (an object).
  - `checkComponent(name, impl)`: a name in `COMPONENTS`; `avatar` needs `create`, `dock` needs `create`, `now-card` and `plan-row` need `render`.
  - `checkScreen(item)`: `id` (`UI_ID`), `title` (1–40), `render`, optional `tab` (boolean), optional `homeFor` (one of `ACTIVITIES`).
  - `checkTheme(file)`: a `.css` path inside the package (`insidePlugin`).
  - `cardSchema(types: { type, name, description, schema? }[]): any` — the `show` tool's card schema: the built-in properties, plus, when types are given, `type: { enum: [...], description }` and `data: { type: 'object', description }`.
  - Each message is in plain words, e.g. `"a status-chip needs an id of lowercase letters, digits and dashes"`, `"the dock action tide needs a label of 1 to 40 characters"`.
- Produces (plugin API): `annai.ui.slot(slot, item)` → registry kind `ui:<slot>`; `annai.ui.cardType(item)` → `ui:card-type`; `annai.ui.component(name, impl)` → `ui:component` (`{ name, ...impl }`); `annai.ui.screen(item)` → `ui:screen`; `annai.ui.theme(file)` → `ui:theme` (`{ file, href: pluginUrl(id, file) }`). Each returns its remover; a wrong item throws `PluginError(id, message)`. `annai.ui.card` and `annai.ui.toast` stay.

- [ ] **Step 1: Write the failing tests**

`test/unit/ui-slots.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlot, checkCardType, checkComponent, checkScreen, checkTheme, cardSchema, SLOTS, COMPONENTS } from '../../src/core/ui-slots.js';
import { files, hostKit } from './package-kit.js';

const draw = () => {};

test('what each slot needs, and the reason when something is missing (spec §16.4)', () => {
  assert.deepEqual(SLOTS, ['status-chip', 'now-section', 'dock-action', 'trip-tab', 'settings-page']);
  assert.equal(checkSlot('status-chip', { id: 'tide', render: draw }), null);
  assert.equal(checkSlot('now-section', { id: 'tide', title: 'Tide', render: draw }), null);
  assert.equal(checkSlot('dock-action', { id: 'tide', label: 'Tides now', icon: '≈', run: draw }), null);
  assert.equal(checkSlot('trip-tab', { id: 'tides', title: 'Tides', render: draw }), null);
  assert.equal(checkSlot('settings-page', { id: 'station', title: 'Tide station', render: draw }), null);
  assert.match(String(checkSlot('status-chip', { id: 'Tide!', render: draw })), /id of lowercase letters, digits and dashes/);
  assert.match(String(checkSlot('dock-action', { id: 'tide', label: '', icon: '≈', run: draw })), /label of 1 to 40 characters/);
  assert.match(String(checkSlot('dock-action', { id: 'tide', label: 'Tides', icon: 'abc', run: draw })), /icon of 1 or 2 characters/);
  assert.match(String(checkSlot('now-section', { id: 'tide', render: draw })), /title of 1 to 40 characters/);
  assert.match(String(checkSlot('trip-tab', { id: 'tides', title: 'Tides' })), /render/);
  assert.match(String(checkSlot('banner', { id: 'x', render: draw })), /isn't a slot.*status-chip/);
});

test('card types, components, screens and themes: what each needs', () => {
  assert.equal(checkCardType({ type: 'tides', name: 'Tides', description: 'Low and high tides.', render: draw }), null);
  assert.match(String(checkCardType({ type: 'tides', name: 'Tides', description: 'x', render: draw, schema: 'no' })), /schema/);
  assert.deepEqual(COMPONENTS, ['avatar', 'now-card', 'dock', 'plan-row']);
  assert.equal(checkComponent('avatar', { create: draw }), null);
  assert.equal(checkComponent('plan-row', { render: draw }), null);
  assert.match(String(checkComponent('avatar', { render: draw })), /create/);
  assert.match(String(checkComponent('header', { render: draw })), /isn't a component annai lets plugins replace/);
  assert.equal(checkScreen({ id: 'hike', title: 'Hike', render: draw, tab: true, homeFor: 'walking' }), null);
  assert.match(String(checkScreen({ id: 'hike', title: 'Hike', render: draw, homeFor: 'hiking' })), /homeFor.*walking/);
  assert.equal(checkTheme('theme.css'), null);
  assert.match(String(checkTheme('../theme.css')), /\.css file in the package/);
  assert.match(String(checkTheme('theme.js')), /\.css file in the package/);
});

test("the show tool's card: the built-in parts, and type and data once a plugin adds a type", () => {
  assert.equal(cardSchema([]).properties.type, undefined);
  const s = cardSchema([{ type: 'tides', name: 'Tides', description: 'Low and high tides.' }]);
  assert.deepEqual(s.properties.type.enum, ['tides']);
  assert.match(s.properties.type.description, /tides: Low and high tides\./);
  assert.equal(s.properties.data.type, 'object');
  assert.ok(s.properties.title && s.properties.choice);
});

test("a plugin's UI parts are registered under its id, refused with the reason when wrong, and go when it stops", async () => {
  const { host, registry } = await hostKit();
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      const offs = [
        annai.ui.slot('status-chip', { id: 'tide', render: (el) => { el.textContent = 'Tide'; } }),
        annai.ui.cardType({ type: 'tides', name: 'Tides', description: 'Low and high tides.', render: () => {} }),
        annai.ui.component('plan-row', { render: () => {} }),
        annai.ui.screen({ id: 'tides', title: 'Tides', render: () => {}, tab: true }),
        annai.ui.theme('theme.css'),
      ];
      return () => offs.forEach((f) => f());
    }`,
    'theme.css': ':root { --ai: #0a7; }',
  }));
  await host.start('tides');
  assert.deepEqual(['ui:status-chip', 'ui:card-type', 'ui:component', 'ui:screen', 'ui:theme'].map((k) => registry.entries(k).map((e) => e.pluginId)), [['tides'], ['tides'], ['tides'], ['tides'], ['tides']]);
  assert.equal(registry.list('ui:theme')[0].href, '/plugins/tides/theme.css');
  await host.setEnabled('tides', false);
  assert.equal(registry.list('ui:status-chip').length, 0);
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'wrong', name: 'Wrong', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': "export function activate(annai) { annai.ui.slot('dock-action', { id: 'x', label: 'X', icon: '≈' }); }",
  }));
  await assert.rejects(host.start('wrong'), /the dock action x needs run/);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/ui-slots.test.js`
Expected: FAIL — `src/core/ui-slots.js` can't be found.

- [ ] **Step 3: Implement** as the Interfaces say. Add `'/src/core/ui-slots.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/ui-slots.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Plugins can add slots, card types, components, screens and themes, each checked and gone when the plugin stops (spec §16.4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: The shell draws what plugins add

**Files:**
- Create: `src/ui/slots.js`, `src/ui/screens/ext.js`
- Modify: `src/ui/shell.js`, `src/ui/router.js`, `sw.js`
- Test: `test/unit/ui-pure.test.js`

**Interfaces:**
- Consumes: the registry kinds of Task 3.
- Produces (`src/ui/slots.js`):
  - `pluginUi(ctx, pluginId): PluginUi` — the object of choice 8.
  - `mount(ctx, entry: { pluginId, item }, el: HTMLElement, call: (ui) => any): void` — runs the plugin's drawing with `pluginUi`, keeps any cleanup it returns (a function) to run when the screen or dock is drawn again; anything it throws (or a promise it returns that rejects) is `ctx.registry.fail(pluginId, '<what> <id>', e)`, and `el` is left empty and hidden.
  - `cleanUp(group: 'screen' | 'dock')` — runs and forgets the cleanups of a group.
  - `uiSignature(registry): string` — the `ui:` contributions now (kind, plugin, id/type/name), to tell when they changed.
  - `component(ctx, name)` — the last running plugin's `{ pluginId, item }` for a component name, or null.
  - `syncThemes(registry, head)` — one `<link rel="stylesheet" data-plugin-theme>` per `ui:theme` entry, adding and removing as they come and go.
- Produces (routes, `src/ui/router.js`): `#/ext/<plugin>/<screen>` → name `ext`; `#/plugin-page/<plugin>/<page>` → name `plugin-page`; `#/trip/<trip>/ext/<plugin>/<tab>` → name `trip-ext`. `src/ui/screens/ext.js`: `renderExt(ctx, route)`, `renderPluginPage(ctx, route)`, `renderTripTab(ctx, route)` — crumbs (← Now, ← Settings, ← the trip), the item's title as the heading, and a body the plugin draws into; one that isn't there (its plugin off or removed): "This page belongs to a plugin that isn't on. Turn it on in Settings → Plugins." with a link.
- Produces (`src/ui/shell.js`): the top bar's links are the built-in ones then each `ui:screen` with `tab: true` (title as text); `shell.render()` runs `cleanUp('screen')` first; a `registry.onChange` listener that, when `uiSignature` changed (checked once per frame), syncs themes, redraws the top bar's tabs, calls `ctx.dock?.refreshSlots?.()` (Task 5), and redraws the current screen.

- [ ] **Step 1: Write the failing tests**

In `test/unit/ui-pure.test.js`:
```js
test("routes for plugins' screens, settings pages and trip tabs", () => {
  assert.deepEqual(parseHash('#/ext/tides/today'), { name: 'ext', parts: ['ext', 'tides', 'today'], params: {} });
  assert.deepEqual(parseHash('#/plugin-page/tides/station'), { name: 'plugin-page', parts: ['plugin-page', 'tides', 'station'], params: {} });
  assert.equal(parseHash('#/trip/trip-1/ext/tides/table').name, 'trip-ext');
  assert.equal(parseHash('#/plugins/tides').name, 'plugins');
});

test("what plugins add to the UI has a signature that changes only when they do", async () => {
  const { uiSignature } = await import('../../src/ui/slots.js');
  const { Registry } = await import('../../src/core/registry.js');
  const r = new Registry();
  const empty = uiSignature(r);
  r.add('tides', 'tool', { name: 'x' });
  assert.equal(uiSignature(r), empty);
  const off = r.add('tides', 'ui:status-chip', { id: 'tide', render: () => {} });
  const one = uiSignature(r);
  assert.notEqual(one, empty);
  off();
  assert.equal(uiSignature(r), empty);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL — `parseHash('#/ext/…')` gives name `ext` already? (It does: `parts[0]`.) The `trip-ext` and `slots.js` assertions fail.

- [ ] **Step 3: Implement** as the Interfaces say (`SUB` in the router gains `ext: 'trip-ext'`). Add the new files to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "The shell draws what plugins add: their screens and tabs, settings pages and trip tabs, and their themes, again whenever they change

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: Slots and components on annai's screens

**Files:**
- Create: `test/fixtures/extensions/trail-ui/annai-plugin.json`, `test/fixtures/extensions/trail-ui/index.js`, `test/fixtures/extensions/trail-ui/theme.css`, `test/fixtures/extensions/trail-look/annai-plugin.json`, `test/fixtures/extensions/trail-look/index.js`, `test/e2e/ui-extension.spec.js`
- Modify: `src/ui/dock.js` (status chips, dock actions, the `avatar` component, `refreshSlots`), `src/ui/shell.js` (the `dock` component), `src/ui/screens/now.js` (Now-card sections, the `now-card` component, `plan-row` in its timetable, `homeFor`), `src/ui/screens/plan.js` (`plan-row`), `src/ui/screens/trip.js` (trip tabs), `src/ui/screens/settings.js` (settings pages from plugins), `src/ui/base.css`
- Test: `test/e2e/ui-extension.spec.js`, `test/unit/ui-pure.test.js` (`handover`)

**Interfaces:**
- Consumes: `mount`, `component`, `pluginUi`, `cleanUp` (Task 4).
- Produces:
  - The dock: a `span.plugin-chips` in the chip row holding one `span.chip.plugin-chip` per `ui:status-chip` (drawn by its plugin); a button `button.ib.plugin-action` per `ui:dock-action` after Type, its name the action's `label`, its icon the action's `icon` as text, a click calling `run(ui)` guarded; the avatar from the `avatar` component's `create({ size: 'dock' })` when there is one and it returns `el`, `setState`, `setLevel` (else annai's own, and the failure is counted); `dock.refreshSlots()` redraws the chips and actions; the shell makes a new dock when the `dock` or `avatar` component changes (`dock.create(ui)` must return `{ el }`; else annai's own).
  - Now: each `ui:now-section` as `section.now-section` (aria-label its title) after the chips; with a `now-card` component, it draws the card's top (`render(el, ui, { title, place, chips, liveOn })`) instead of annai's place, chips and live button; its timetable rows and the Plan's use a `plan-row` component when there is one (`render(li, { trip, path, when, title, fixed, place, kind }, ui)`).
  - `handover(activity: string, was: string, screens: { pluginId: string, item: any }[]): string | null` (exported from `now.js`): when the activity changed to one a running `ui:screen` names in `homeFor`, that screen's `#/ext/<plugin>/<id>` (the last registered); else, for `moving-fast`, `#/drive`; else null. Now hands over with it while live mode is on.
  - The trip page: a link per `ui:trip-tab` after Replay, its label the tab's title.
  - Settings: a section "From plugins" listing each `ui:settings-page` as a link (`<title> (<plugin name>)`), when there are any.
- The `trail-ui` fixture (`id: 'trail-ui'`, name "Trail UI", entry `index.js`, `settings`: `trailhead` (string, title "Trailhead") and `token` (string, `writeOnly`, title "Token")) registers: a status chip "Trail ok"; a Now section "Trail" with the text "Trail section"; a dock action "Trail check" (icon "⛰") whose run toasts "Trail checked"; a trip tab "Trail log" drawing "Trail log for <trip id>"; a settings page "Trail settings" drawing "Trail settings page"; a card type `trail` (name "Trail", description "A trail, by name.", schema `{ type: 'object', required: ['name'], properties: { name: { type: 'string' } } }`) drawing `p.trail-card` with "Trail: <name>"; a `plan-row` component drawing `<when> · <title> (trail row)`; a screen `hike` (title "Hike", `tab: true`, `homeFor: 'walking'`) drawing "Hike screen"; a theme `theme.css` setting `--ai: rgb(0, 128, 96)`; and a hook on `file.write` that counts writes into `globalThis.__trailWrites`.
- The `trail-look` fixture (`id: 'trail-look'`, name "Trail look") replaces three components: `avatar` (`create` returns a `span.trail-avatar` with the text "⛰" and no-op methods), `now-card` (draws "Trail Now card: <title>"), and `dock` (`create(ui)` returns a `nav[aria-label=Shiori]` holding one button "Talk to Shiori" that calls `ui.shiori.tap()`).

- [ ] **Step 1: Write the failing tests**

In `test/unit/ui-pure.test.js`:
```js
test('Now hands over to the screen a plugin offers for an activity, else to Driving when moving fast (choice 5)', async () => {
  const { handover } = await import('../../src/ui/screens/now.js');
  const hike = { pluginId: 'trail-ui', item: { id: 'hike', homeFor: 'walking' } };
  const car = { pluginId: 'road', item: { id: 'road', homeFor: 'moving-fast' } };
  assert.equal(handover('walking', 'still', [hike]), '#/ext/trail-ui/hike');
  assert.equal(handover('walking', 'walking', [hike]), null);
  assert.equal(handover('moving-fast', 'walking', [hike]), '#/drive');
  assert.equal(handover('moving-fast', 'still', [hike, car]), '#/ext/road/road');
  assert.equal(handover('still', 'walking', [hike]), null);
});
```

`test/e2e/ui-extension.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, fixtureFiles, zipOf, modelSetUp } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

/** Installs a package from a zip through Settings → Plugins and its install screen. @param {any} page @param {Buffer} zip @param {string} name */
export async function install(page, zip, name) {
  await page.goto('/#/plugins');
  await page.getByLabel('Install from a file').setInputFiles({ name: `${name}.zip`, mimeType: 'application/zip', buffer: zip });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('.card', { hasText: name }).getByText('On', { exact: true })).toBeVisible();
}

test("a plugin's slots, plan row, screen and theme appear, and go when it is turned off (spec §16.4)", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.evaluate(async (trip) => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const store = await createIdbStore();
      await new Workspace(store).write(trip, '/plan/falls.json', { id: 'falls', title: 'Pfeiffer Falls', kind: 'sight', fixed: false, priority: 1, start: { at: '2030-11-27T10:00:00-08:00', tz: 'America/Los_Angeles' } }, { author: 'user' });
      store.close();
    }, trip);
    await install(page, await zipOf(await fixtureFiles('trail-ui')), 'Trail UI');
    const dock = page.getByRole('navigation', { name: 'Shiori' });
    await expect(dock.getByText('Trail ok')).toBeVisible();
    await dock.getByRole('button', { name: 'Trail check' }).click();
    await expect(page.getByText('Trail checked')).toBeVisible();
    const main = page.getByRole('navigation', { name: 'Main' });
    await main.getByRole('link', { name: 'Hike' }).click();
    await expect(page.getByText('Hike screen')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ai').trim())).toBe('rgb(0, 128, 96)');
    await page.goto('/#/now');
    await expect(page.getByRole('region', { name: 'Trail' }).getByText('Trail section')).toBeVisible();
    await expect(page.getByText('Pfeiffer Falls (trail row)')).toBeVisible();
    await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
    await page.getByRole('link', { name: 'Trail log' }).click();
    await expect(page.getByText(`Trail log for ${trip}`)).toBeVisible();
    await page.goto('/#/settings');
    await page.getByRole('link', { name: /Trail settings/ }).click();
    await expect(page.getByText('Trail settings page')).toBeVisible();
    // A write the app makes (a tool switch) reaches the plugin's hook.
    await page.goto('/#/tools');
    await page.getByRole('checkbox', { name: 'fetch', exact: true }).uncheck();
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__trailWrites ?? 0)).toBeGreaterThan(0);
    await page.goto('/#/plugins');
    await page.locator('.card', { hasText: 'Trail UI' }).getByRole('button', { name: 'Turn off' }).click();
    await expect(dock.getByText('Trail ok')).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Hike' })).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ai').trim())).not.toBe('rgb(0, 128, 96)');
  } finally {
    await llm.stop();
  }
});

test("a plugin can replace the avatar, the Now card and the dock; turned off, annai's own come back", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await install(page, await zipOf(await fixtureFiles('trail-look')), 'Trail look');
    const dock = page.getByRole('navigation', { name: 'Shiori' });
    await expect(dock.getByRole('button', { name: 'Talk to Shiori' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Type' })).toHaveCount(0);
    await page.goto('/#/now');
    await expect(page.getByText('Trail Now card: Big Sur')).toBeVisible();
    await page.goto('/#/plugins');
    await page.locator('.card', { hasText: 'Trail look' }).getByRole('button', { name: 'Turn off' }).click();
    await expect(dock.getByRole('button', { name: 'Type' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Talk to Shiori' })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test("a status chip that throws doesn't break the dock; it counts against its plugin", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    const broken = {
      'annai-plugin.json': Buffer.from(JSON.stringify({ id: 'chip-breaks', name: 'Chip breaks', version: '1.0.0', api: 1, entry: 'index.js' })),
      'index.js': Buffer.from("export function activate(annai) { return annai.ui.slot('status-chip', { id: 'boom', render: () => { throw new TypeError('chip broke'); } }); }"),
    };
    await install(page, await zipOf(broken), 'Chip breaks');
    await expect(page.getByRole('navigation', { name: 'Shiori' }).getByRole('button', { name: 'Type' })).toBeVisible();
    await page.goto('/#/trace?kind=Plugins');
    await expect(page.getByText(/chip broke/).first()).toBeVisible();
  } finally {
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/ui-pure.test.js` and `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/ui-extension.spec.js`
Expected: FAIL — `handover` isn't exported; no chip "Trail ok" in the dock.

- [ ] **Step 3: Implement** as the Interfaces say, with CSS for `.plugin-chips`, `.plugin-action`, `.now-section` from the existing tokens only, and the two fixtures.

- [ ] **Step 4: Run them to make sure they pass** — the same commands. Expected: PASS in Chromium and WebKit. Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Plugins' status chips, dock actions, Now sections, trip tabs, settings pages, screens and themes appear on annai's screens; the avatar, Now card, dock and plan rows can be replaced

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 6: Card types

**Files:**
- Modify: `src/core/agent/loop.js` (`show`: description and input follow the types; data checked), `src/ui/cards.js` (`renderCard` draws a typed card; `cardWho`), `src/ui/screens/talk.js`, `src/ui/screens/now.js` (the label)
- Test: `test/unit/agent-tools.test.js`, `test/unit/ui-pure.test.js`, `test/e2e/ui-extension.spec.js`

**Interfaces:**
- Consumes: `cardSchema`, `validate` (`schema.js`).
- Produces:
  - `show`'s `input` and `description` are getters: `cardSchema(types)` and the description plus, with types, ` Card types plugins add: <type> (<name>): <description>; …`.
  - In `show`'s `run`: a card with `type` that isn't registered: `{ content: 'Error: there is no card type <type>. Types: <list or "none">.', isError: true }`; one whose `data` fails the type's `schema`: `{ content: 'Error: the <type> card's data isn't valid: <errors>', isError: true }`; nothing is logged for a refused card.
  - `cardWho(ctx, card): string` — `'SHIORI'`, or `'SHIORI · <NAME>'` for a typed card whose type is registered (its `name`, upper-cased).
  - `renderCard(card, o)`: a typed card with its type registered draws through `mount` into the card's body (title above it as text, when given); not registered: title and text as usual, and `p.sub` "This card's kind (<type>) comes from a plugin that isn't on."

- [ ] **Step 1: Write the failing tests**

In the unit file where `show` is exercised through `agentKit` (e.g. `test/unit/agent-tools.test.js`):
```js
test("show: a plugin's card type joins the tool's card, its data is checked, and an unknown type is refused (spec §16.4)", async () => {
  const k = await agentKit([[{ toolCalls: [
    { name: 'show', input: { card: { type: 'tides', data: { low: '05:40' } } } },
    { name: 'show', input: { card: { type: 'tides', data: { low: 540 } } } },
    { name: 'show', input: { card: { type: 'ferries', data: {} } } },
    { name: 'sleep', input: {} },
  ] }]]);
  k.registry.add('tides', 'ui:card-type', { type: 'tides', name: 'Tides', description: 'Low and high tides.', schema: { type: 'object', required: ['low'], properties: { low: { type: 'string' } } }, render: () => {} });
  k.agent.send('Tides?');
  await k.agent.idle();
  const show = k.requests[0].tools.find((/** @type {any} */ t) => t.name === 'show');
  assert.deepEqual(show.input.properties.card.properties.type.enum, ['tides']);
  assert.match(show.description, /Card types plugins add: tides \(Tides\): Low and high tides\./);
  const results = (await k.events(['tool.result'])).filter((e) => e.data.name === 'show').map((e) => e.data.content);
  assert.equal(results[0], 'shown');
  assert.match(results[1], /^Error: the tides card's data isn't valid: .*low/);
  assert.equal(results[2], 'Error: there is no card type ferries. Types: tides.');
  assert.equal((await k.events(['out.show'])).length, 1);
});
```
In `test/unit/ui-pure.test.js`:
```js
test("a typed card's label names its kind; an unknown one is plain SHIORI", async () => {
  const { cardWho } = await import('../../src/ui/cards.js');
  const { Registry } = await import('../../src/core/registry.js');
  const registry = new Registry();
  registry.add('tides', 'ui:card-type', { type: 'tides', name: 'Tides', description: 'x', render: () => {} });
  assert.equal(cardWho({ registry }, { type: 'tides' }), 'SHIORI · TIDES');
  assert.equal(cardWho({ registry }, { type: 'ferries' }), 'SHIORI');
  assert.equal(cardWho({ registry }, { title: 'Hi' }), 'SHIORI');
});
```

In `test/e2e/ui-extension.spec.js`:
```js
test("Shiori shows a plugin's kind of card: the plugin draws it, and its label names the kind", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'show', input: { card: { type: 'trail', data: { name: 'Pfeiffer Falls' } } } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await install(page, await zipOf(await fixtureFiles('trail-ui')), 'Trail UI');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Show me the falls');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .trail-card')).toHaveText('Trail: Pfeiffer Falls');
    await expect(page.locator('.convo .who').last()).toHaveText('SHIORI · TRAIL');
  } finally {
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/agent-tools.test.js test/unit/ui-pure.test.js` and the e2e spec in Docker.
Expected: FAIL — `show`'s card has no `type`; `cardWho` isn't exported; the card shows no `.trail-card`.

- [ ] **Step 3: Implement** as the Interfaces say. `CARD` in `loop.js` becomes `cardSchema(...)` from `ui-slots.js`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/agent-tools.test.js test/unit/ui-pure.test.js test/unit/agent-loop.test.js` and the e2e spec in Docker.
Expected: PASS (Chromium and WebKit).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Shiori can show a plugin's kind of card: the type joins her show tool, its data is checked, and the plugin draws it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 7: A plugin's own page and its settings form

**Files:**
- Create: `src/ui/settings-form.js`, `src/ui/screens/plugin.js`
- Modify: `src/ui/screens/plugins.js` (rows open the plugin's page; `#/plugins/<id>` draws it), `src/core/packages.js` (`settings` must be an object schema with `properties`), `sw.js`
- Test: `test/unit/settings-form.test.js`, `test/unit/packages.test.js`, `test/e2e/ui-extension.spec.js`

**Interfaces:**
- Produces (`src/ui/settings-form.js`, pure parts first):
  - `formFields(schema): { key: string, kind: 'text' | 'select' | 'secret' | 'number' | 'integer' | 'boolean' | 'unsupported', label: string, hint?: string, options?: string[], min?: number, max?: number, default?: any }[]` (Choice 12).
  - `readForm(schema, raw: Record<string, string | boolean>): { values: Record<string, any>, secrets: Record<string, string>, errors: string[] }` — numbers parsed; empty text and number fields left out of `values` (`null` in the patch); `secret` fields that are empty are left unchanged (not in `secrets`); the values checked with `validate` against the schema without its `writeOnly` properties and without `required`.
  - `settingsForm(ctx, pluginId, schema): Promise<HTMLElement>` — the form: current values from `/plugin-settings/<id>.json`, a saved secret shown as placeholder "saved"; Save writes `values` with `ctx.ws.patch(SYS_SETTINGS, '/plugin-settings/<id>.json', changes, { author: 'user', create: true })` and each secret with `putSecret('plugin:<id>:<key>', value)`; errors in `p.error[role=alert]`; a toast "Saved."
- Produces (`src/ui/screens/plugin.js`): `renderPlugin(ctx, id)` — Choice 11; a built-in plugin's page shows its name, description and tools, without actions; an unknown id: "There's no plugin called <id> on this device." with a link back.
- Produces (`packages.js`): a manifest whose `settings` lacks an object `properties`: `PluginError(id, 'its settings must be a JSON Schema object with properties')`.

- [ ] **Step 1: Write the failing tests**

`test/unit/settings-form.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formFields, readForm } from '../../src/ui/settings-form.js';

const SCHEMA = {
  type: 'object',
  properties: {
    station: { type: 'string', title: 'Tide station', description: 'The nearest one.', default: 'Monterey' },
    units: { type: 'string', enum: ['ft', 'm'] },
    days: { type: 'integer', minimum: 1, maximum: 7, title: 'Days ahead' },
    alerts: { type: 'boolean', title: 'Alert me' },
    key: { type: 'string', writeOnly: true, title: 'API key' },
    nested: { type: 'object', properties: {} },
  },
  required: ['station'],
};

test("a plugin's settings schema becomes fields: text, a choice, numbers, a switch, a secret; other kinds said plainly (spec §5.2)", () => {
  assert.deepEqual(formFields(SCHEMA).map((f) => [f.key, f.kind, f.label]), [
    ['station', 'text', 'Tide station'], ['units', 'select', 'units'], ['days', 'integer', 'Days ahead'],
    ['alerts', 'boolean', 'Alert me'], ['key', 'secret', 'API key'], ['nested', 'unsupported', 'nested'],
  ]);
  assert.deepEqual(formFields(SCHEMA)[1].options, ['ft', 'm']);
  assert.deepEqual([formFields(SCHEMA)[2].min, formFields(SCHEMA)[2].max], [1, 7]);
  assert.deepEqual(formFields({ type: 'object' }), []);
});

test('reading the form: values checked against the schema, secrets apart, empty fields cleared', () => {
  assert.deepEqual(readForm(SCHEMA, { station: 'Carmel', units: 'm', days: '3', alerts: true, key: 'tide-secret-123456' }),
    { values: { station: 'Carmel', units: 'm', days: 3, alerts: true }, secrets: { key: 'tide-secret-123456' }, errors: [] });
  assert.deepEqual(readForm(SCHEMA, { station: '', units: 'ft', days: '', alerts: false, key: '' }),
    { values: { station: null, units: 'ft', days: null, alerts: false }, secrets: {}, errors: [] });
  assert.match(readForm(SCHEMA, { station: 'x', units: 'ft', days: '9', alerts: false, key: '' }).errors.join(' '), /days/);
  assert.match(readForm(SCHEMA, { station: 'x', units: 'ft', days: 'two', alerts: false, key: '' }).errors.join(' '), /Days ahead is a whole number/);
});
```
In `test/unit/packages.test.js`, in the refusals:
```js
    [{ 'annai-plugin.json': MANIFEST({ settings: { type: 'object' } }) }, /settings must be a JSON Schema object with properties/],
```

In `test/e2e/ui-extension.spec.js`:
```js
test("a plugin's page saves the settings its schema asks for; a secret is kept as one and never shown", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await install(page, await zipOf(await fixtureFiles('trail-ui')), 'Trail UI');
    await page.getByRole('link', { name: 'Trail UI' }).click();
    await expect(page.getByRole('heading', { name: 'Trail UI' })).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await page.getByLabel('Trailhead').fill('Pfeiffer Big Sur');
    await page.getByLabel('Token').fill('trail-secret-123456');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Trailhead')).toHaveValue('Pfeiffer Big Sur');
    await expect(page.getByLabel('Token')).toHaveAttribute('placeholder', 'saved');
    expect(await page.content()).not.toContain('trail-secret-123456');
    const stored = await page.evaluate(async () => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const store = await createIdbStore();
      const out = { file: await new Workspace(store).readText('sys:settings', '/plugin-settings/trail-ui.json'), secret: await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('plugin:trail-ui:token')) };
      store.close();
      return out;
    });
    expect(stored.file).toContain('Pfeiffer Big Sur');
    expect(stored.file).not.toContain('trail-secret-123456');
    expect(stored.secret).toBe('trail-secret-123456');
  } finally {
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/settings-form.test.js test/unit/packages.test.js` and the e2e spec in Docker.
Expected: FAIL — `settings-form.js` can't be found; the manifest is accepted; the plugin's name isn't a link.

- [ ] **Step 3: Implement** as the Interfaces say. Add the new files to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/settings-form.test.js test/unit/packages.test.js` and the e2e spec in Docker.
Expected: PASS (Chromium and WebKit).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Each plugin has its own page in Settings → Plugins, with the settings form its manifest asks for; secrets go to secrets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 8: The code plugin's "Done when" end to end; the plugin guide; the budget

**Files:**
- Modify: `test/fixtures/extensions/tides/index.js` (a status chip "Tide <VERSION>"), `test/e2e/extensions.spec.js`, `docs/plugins.md`, `scripts/size.mjs`

**Interfaces:**
- Consumes: everything above. The tides fixture's `activate` also registers `annai.ui.slot('status-chip', { id: 'tide', render: (el) => { el.textContent = \`Tide ${VERSION}\`; } })` and returns a cleanup removing both.

- [ ] **Step 1: Write the failing tests**

In `test/e2e/extensions.spec.js`'s code-plugin tests: after each install, and after the reload, `await expect(page.getByRole('navigation', { name: 'Shiori' }).getByText('Tide 1.0.0')).toBeVisible();`; in the update test, before tapping Update the chip still reads `Tide 1.0.0`, and after the restart `Tide 1.1.0` (and `Tide 1.0.0` is gone).

- [ ] **Step 2: Run them to make sure they fail**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/extensions.spec.js`
Expected: FAIL — no "Tide 1.0.0" chip.

- [ ] **Step 3: Add the chip to the fixture** as the Interfaces say.

- [ ] **Step 4: Run them to make sure they pass** — the same command. Expected: PASS in Chromium and WebKit.

- [ ] **Step 5: The plugin guide and the budget**
  - `docs/plugins.md`: a section "The UI" (each slot with its item's fields and where it appears, card types, components with their interfaces, screens, themes and the CSS variables in `src/ui/tokens.css` that are stable, the `ui` object), "Following the log" (hooks), "Settings" (the schema form; `writeOnly` and secrets), and the table rows for `annai.ui.*` and `annai.hooks.on`; the sentence that only slots, components and variables are stable across updates.
  - `scripts/size.mjs`: the budget to what `npm run size` needs plus about 5 KiB, rounded to 10; its comment says so for milestone 8b.

- [ ] **Step 6: The whole suite** — `npm run stamp && npm run check`, then the full e2e run in Docker into the plan's workspace log. Expected: all pass in Chromium and WebKit.

- [ ] **Step 7: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "The code plugin's Done when end to end: a tool and a status chip, from a zip and an address, through a reload and an update only on Update; the guide covers plugins' UI, hooks and settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
