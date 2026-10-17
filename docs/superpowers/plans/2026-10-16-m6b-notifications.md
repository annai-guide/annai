# Milestone 6b: Notifications in annai Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** annai's side of the push relay (spec §11.6). A reminder reaches a locked iPhone while annai is closed, and opening it starts a catch-up wake (§20 row 6):
- **What is mirrored:** the time reminders live mode would give (Shiori's time watches, and the plan's "coming up" and "leave soon"), encrypted on the phone and kept at the relay while notifications are on. Location triggers never leave the phone.
- **No second reminder:** with annai on screen, the phone says a reminder at its time and calls the relay's copy off; the relay sends 30 seconds after its time.
- **Cancelling or changing a watch, or removing its trip,** deletes or reschedules it at the relay.
- **The service worker** shows each push as a notification; tapping it opens annai, and the catch-up wake says "the user opened the reminder …". It handles `pushsubscriptionchange`.
- **Settings → Notifications:** on and off, the relay's address (`https://push.annai.guide` unless changed), plain words on what the relay learns, and a test notification.
- **The trace** shows every relay request; cancel tokens and the subscription's keys are never in it.

Milestone 6a (`docs/superpowers/plans/2026-10-16-m6a-push-relay.md`) built the relay, the page's encryption (`src/core/push/webpush.js`), the stand-in push service and the Node runner.

**Architecture:**
- **Live mode** (`src/core/live/live.js`) says what a closed annai can still say: `reminders()` lists the time reminders with the time the phone itself would give each, `onReminders(fn)` says when that may have changed, and `forget(scope)` drops a removed trip. It also hears what the service worker saw (`news`, read at each catch-up; `pushNews` while on screen) and puts it in the catch-up wake.
- **The mirror** (`src/core/push/mirror.js`, `PushMirror`) keeps the relay in step with live mode: what to send, call off or move (`plan`, `moves`), the subscription, retries, on and off. Its state is `/push.json` in "This device" (never exported); the cancel tokens are the secret `push:tokens` (never exported, even with API keys).
- **The relay client** (`src/core/push/relay-client.js`): the three API calls through annai's traced fetch; every answer, whatever it is, becomes a `RelayError` in plain words.
- **The service worker** (`sw.js`) shows notifications and keeps what happened (shown, opened, renewed) in a small cache until annai reads it.
- **Browser glue** (`src/ui/push.js`): the phone's push subscription (`browserSource`), reading the service worker's news, closing a notification annai already said.
- **Settings → Notifications** (`src/ui/screens/notifications.js`, `#/notifications`).

All core modules are tested in Node: live mode on a manual clock, against the real relay code in memory and the stand-in push service over HTTP. The end-to-end tests run the page against `relay/serve.mjs` and the stand-in, in both browsers.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26), and Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. This plan covers:
- §11.6 scope, cancelling, opening a notification; §11.7 privacy
- §11.3–11.4 watches, the plan's own reminders, catch-up
- §6.1 wakes: "a push notification being opened"
- §3 "service worker … push → notification"
- §4.9 everything stored is named; removing a trip removes everything
- §15 keys never in context, files or the trace; §17 rule 3 permission help per phone
- §18 the device checklist ("push notifications on iOS")

Done when: a reminder arrives on a locked iPhone and opens a catch-up wake. Task 6's end-to-end tests prove each link that browsers let a test drive. The device checklist (`docs/testing/device-checklist-m6.md`) is the real thing.

**Not in this plan:** deploying the relay (the user's step, `relay/README.md`).

## Choices this plan makes (please check them)

1. **What is mirrored at the relay:**
   - **Yes:** Shiori's (and plugins') `time` watches in every trip and outside one, and the open trip's plan reminders that the clock alone brings: "coming up" (a fixed item without a place, 15 minutes before) and "leave soon" (a fixed item with a place).
   - **No:**
     - `every` watches: intervals, such as narration while driving or a check-in. They are for while annai runs, and would bring a notification every few minutes.
     - Anything that needs the position: `enter`, `leave`, `dwell`, `arrived`, `moved`, `activity`, and the plan's "arrived", "running late", "off plan" and "lingering". Location triggers never leave the phone (§11.6).
   - **The open trip's plan only,** as on the phone: live mode follows the open trip's plan.
   - The cost if wrong: an interval reminder never reaches a closed annai. Sending each next occurrence would be the change.
2. **"Leave soon"'s time is the phone's own estimate**, from where annai last saw you (with live mode on), else from the plan's stop before, else 30 minutes before. It moves at the relay when it becomes 5+ minutes earlier, or, within 10 minutes of the relay's time, when it would come after it, so the relay's copy never comes first while annai is on screen. A few moves a day at most.
   - **The privacy cost:** that time, to someone who also knew your plan, says roughly how far away you were. The relay doesn't know your plan. Like any server, it also sees the internet address each request comes from, which says more.
   - **The alternative:** times from the plan alone. A closed annai's reminder would then come early or late when you aren't where the plan says, and twice while annai is open.
3. **No second reminder: the relay sends 30 seconds after a reminder's time.** With annai on screen, the phone says it at its time and calls the relay's copy off at once.
   - **The cost:** a reminder through the relay comes 30 seconds late.
   - **iOS forbids the other way.** Every push must show a notification: WebKit takes the subscription away after 3 pushes that show none, counted forever, even with annai open (6a's verified facts). So the service worker always shows one.
   - **When a push still comes for a reminder annai already said** (the cancel didn't reach the relay in time), annai closes that notification as soon as it hears of it.
4. **Notifications look like annai's own Reminder cards:** the title is the trip's name ("Reminder" outside a trip), the text the reminder's own words. Tapping opens annai at its first screen.
5. **Opening one starts a catch-up wake** that says `The user opened the reminder "…" from its notification at 18:05.`
   - A firing that came due while annai was closed also says when its notification was shown: `(late by 5 min: annai was closed; its notification was shown at 18:00)`. Shiori can then choose not to say it all again.
   - Opened while annai is already on screen, the wake comes at once. One for another trip waits in that trip's conversation.
6. **Turning notifications on sends one at once**, "Notifications are on…". The relay keeps only 3 reminders, due within 10 minutes, for a subscription that hasn't had a push yet (6a choice 13); this one confirms it, and shows you the chain works. A renewed subscription (the phone's or the relay's key changed) gets "…on again". A test button sends one 15 seconds later, to lock the phone and watch it arrive.
7. **The nearest 150 reminders within 29 days wait at the relay** (it holds 200 and takes 30 days); later ones go as they come within reach, whenever annai runs. A push service keeps an undelivered one for an hour (`TTL`); after that, catch-up covers it.
8. **What annai keeps:**
   - `/push.json` in "This device" (never exported, §12.4): on or off, the relay's address, the key and endpoint subscribed with, and for each reminder at the relay its id, times and a hash of its words. No reminder text: a removed trip's words don't linger in this device's history.
   - The cancel tokens are one secret, `push:tokens`, which no export holds, even an encrypted Backup with API keys (like `backup:` secrets).
   - The subscription's keys are never stored: the browser keeps them, and annai asks for them to encrypt.
   - Before sending a reminder, annai writes down its id and token, so a send cut off by a crash is sent again with the same id and kept once.
9. **Removing a trip calls off its reminders at once;** with no connection, the cancels wait and go when it's back.
   - **Turning notifications off** calls everything off, then unsubscribes.
   - **An archived trip's reminders** go at the next start, as its watches do in live mode (milestone 5).
10. **What the service worker saw** (shown, opened, renewed) waits in a cache, `annai-push`, only until annai reads it: at start, on coming back on screen, or at once when annai is open. Entries for a removed trip are dropped then.
11. **Asking permission:** the tap on "Turn on notifications" calls `Notification.requestPermission()` before anything else, since iOS requires a user activation and nothing may be awaited first. Only then is the relay asked for its key.
    - **Refused:** the screen says where to allow it, for iPhone, Android or a computer (§17 rule 3).
    - **iPhone in a Safari tab:** the screen says notifications need the Home Screen app, and how to add it.
12. **When the phone drops the subscription** (iOS can; it has no `pushsubscriptionchange`), annai notices at its next start. With permission still granted, it subscribes again by itself and sends everything again; otherwise one card says how to turn notifications back on.
13. **The relay's address** is `https://push.annai.guide` by default; https only, or http on localhost for testing. Changing it calls everything off at the old relay and sends it all to the new one.
14. **CSP: no change.** `connect-src` already allows `https:` and localhost.
15. **The trace:**
    - Every relay request is a `net.request` in "This device", tool "push relay": its URL and status, never a header, so never a token.
    - Each change a `push.sync` line.
    - Shown and opened notifications are `push.shown` and `push.opened` in the trip's log.
    - Trace → Notifications shows them.
16. **The test hook:** `localStorage['annai.pushSubscription']` (an endpoint and keys) stands in for the phone's subscription in the end-to-end tests, the way `annai.forceDownload` works. Playwright's browsers have no push service.
17. **The size budget** grows from 1150 KiB to 1215 KiB (1198.6 used at the end).
18. **How soon annai tells the relay** (decided while building Task 2):
    - **Half a second after a reminder came or changed.**
    - **Half a second after one went** (said, cancelled, its trip removed). A batch still being sent then stops, so the call-off goes first.
    - **At most every 30 seconds when only times may have moved:** each GPS fix while driving moves "leave soon" a little.
    - The cost: a moved "leave soon" reaches the relay up to 30 seconds later.
19. **The phone's side runs in Chromium's new headless mode** (Task 6). The end-to-end project `chromium-notifications` runs `test/e2e/push-sw.spec.js` there, because Playwright's default headless shell refuses notifications.

## Global Constraints

- All of milestone 2b's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m2b-shiori.md`). In particular:
  - Model output never goes into `innerHTML`, and no `style` attribute is set.
  - Every write is one transaction; everything stored is named by a file or a log entry (§4.9).
  - Every file under `src/` and `assets/` is in `sw.js` `SHELL`; run `npm run stamp` after shipped files change.
- **"Only time watches are mirrored, and only when notifications are enabled. Location triggers never leave the phone"** (§11.6).
- **"The page encrypts each notification itself… The relay never sees the content"** (§11.6): `encryptPush`, padded to 3,072 bytes.
- **"Cancelling a watch deletes it at the relay. Opening a notification starts a catch-up wake with 'opened the reminder for X'"** (§11.6).
- **"It learns only the push endpoint, the timing, and how many reminders there are"** (§11.6). The Settings screen says so in plain words.
- **Keys** (cancel tokens, the subscription's p256dh and auth) are never in context, files, events or the trace (§15).
- **Errors from the relay** are plain Errors (`RelayError`), never a TypeError or SyntaxError.
- **Copy:** plain words; every error says what happened and what to do next; system cards are never in Shiori's voice.
- **Tests:**
  - Playwright only in Docker: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`.
  - Stand-in servers on port 0. Never ports 8765 or 8790–8792 on the host.
  - Delete any `core*` file WebKit leaves.
  - A test that changes a Trace filter uses `filterTrace`.
- **Before every commit:** `npm run stamp && npm run check && git commit …`, chained with `&&`.

## Verified facts (checked 2026-10-16)

In addition to 6a's:
- **Apple** (Home Screen web apps, iOS 16.4+): push works only in a web app added to the Home Screen whose manifest has `display: standalone` (annai's has). Permission "can only be requested in response to direct user interaction".
- **WebKit's `PushManager.subscribe`** (`PushManager.cpp`): while permission is "default", it consumes the window's transient activation ("Push notification prompting can only be done from a user gesture"); with permission "granted", it needs none. So annai can subscribe again by itself once the user has allowed notifications.
- **iOS has no `pushsubscriptionchange`** (WebKit bug 273063).
- **`notificationclick` on iOS** (WebKit bugs 252544, 263687, Apple forums): `clients.openWindow(url)` may open the app at its start URL instead of the URL given; `navigate()` and `postMessage` to a just-launched window may fail. So annai never depends on the URL or a message: the service worker writes the click down before opening annai, and annai reads it as it starts.
- **Chromium's DevTools protocol** has `ServiceWorker.deliverPushMessage({ origin, registrationId, data })`, which fires the service worker's `push` event with the data as given. No protocol command clicks a notification.

## Review Focus

1. **annai hidden but not frozen** (Android Chrome behind another app) when a reminder comes due. Expected: live mode doesn't fire it (hidden), the relay's copy arrives, and the catch-up on return says it fired late with its notification shown, once. Pinned in Task 1 (news at a catch-up) and Task 2 (hidden: the relay sends).
2. **The live-mode list read while it is being reloaded** (another trip opened). Expected: never a half list that calls off what should stay. `reminders()` runs in live mode's own queue. Pinned in Task 2.
3. **Many reminders at once at turn-on, then one fires while they are still being sent.** Expected: the cancel goes before the remaining sends; the rest follow. Pinned in Task 2 (`#dirty`).
4. **The relay forgets this phone** (a relay restart, 60 days without a reminder). Expected: the relay answers "unconfirmed", annai sends "notifications are on again", then the rest. Pinned in Task 2.
5. **A token in an error.** A relay echoes a cancel token in its message. Expected: blanked before it is kept or shown (`withoutSecrets`). Pinned in Task 2.

## File map

- Modify `src/core/live/live.js`: `reminders`, `onReminders`, `forget`, `pushNews`, the `news` option, catch-up text.
- Create `src/core/push/relay-client.js`, `src/core/push/mirror.js`.
- Modify `sw.js`: `push`, `notificationclick`, `pushsubscriptionchange`; `SHELL`.
- Create `src/ui/push.js`, `src/ui/screens/notifications.js`.
- Modify `src/app/main.js`, `src/ui/shell.js`, `src/ui/router.js`, `src/ui/screens/settings.js`, `src/ui/screens/trace.js`, `src/ui/screens/trip.js`, `src/core/scopes.js`, `src/core/archive.js`, `scripts/size.mjs`.
- Tests: `test/unit/live-push.test.js`, `test/unit/push-kit.js`, `test/unit/push-mirror.test.js`, `test/unit/sw-push.test.js`, `test/unit/push-secrets.test.js`, `test/e2e/notifications.spec.js`, `test/e2e/push.spec.js`; `test/unit/live-kit.js` (a `news` option).
- Docs: `docs/testing/device-checklist-m6.md`, `README.md`, the spec's §11.7.

---

### Task 1: What a closed annai can still say, and what its notifications did

**Files:**
- Modify: `src/core/live/live.js`, `test/unit/live-kit.js` (option `news`)
- Test: `test/unit/live-push.test.js`

**Interfaces:**
- Consumes: Live's internals: `#watches`, `#plan`, `#mem`, `#spent`, `#broken`, `#moment`, `#run`, `#catch`, `#deliver`, `#reason`, `forAt`; `PLAN.next`; `timeIn`; `logEvent`.
- Produces:
  - `Mirrored = { key: string, scope: string, watch: string, due: number, text: string }`. key is `<scope>|<watch id>`, plus `|<item time>` for the plan's reminders bound to an item's time.
  - `PushNews = { kind: 'shown' | 'opened' | 'changed', key?, scope?, watch?, at?, title?, body?, test?, t? }`.
  - `live.reminders(): Promise<Mirrored[] | null>`: null until `start` has loaded; sorted by due; in live mode's queue.
  - `live.onReminders(fn: (level: 'calm' | 'prompt' | 'urgent') => void): () => void`. Told after each check: urgent if it fired something, calm otherwise. Prompt after a watch is set, or a watch file or the plan changes; urgent after a watch is dropped or a trip forgotten (choice 18).
  - `live.forget(scope: string): Promise<void>`: a removed trip's watches, memory and firings leave live mode.
  - `live.pushNews(list: PushNews[]): Promise<string[]>`: hears the service worker's news while on screen. Opened ones become a catch-up wake now (or join the running catch-up); returns the keys of notifications for reminders annai had already said on screen.
  - `new Live({ …, news })`: `news: () => Promise<PushNews[]>`, read at the start of each catch-up.
  - Events: `push.shown`, `push.opened` `{ key, watch, at }` in the reminder's scope.

- [ ] **Step 1: Write the failing test**

In `test/unit/live-kit.js`, `liveKit` takes `news` and passes it on:

```js
 * @param {{ plan?: Record<string, any>, bookings?: Record<string, any>, live?: boolean, start?: number, news?: () => Promise<any[]> }} [o]
 */
export async function liveKit({ plan = {}, bookings = {}, live = true, start = at('08:30'), news } = {}) {
```

and `new Live({ store, ws, registry, agent, clock, timeZone: () => LA, ...(news ? { news } : {}) })`.

`test/unit/live-push.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, iso, LA, MONTEREY, RIVER_INN, NEPENTHE } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { createTrip } from '../../src/core/scopes.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const TEA = { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } };

test('what a closed annai can still say: time watches in every conversation, and the open trip\'s "coming up" and "leave soon"; never a place (spec §11.6)', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP, tea: TEA, bixby: BIX } });
  const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const home = await k.live.setWatch('me', { when: { type: 'time', at: iso('11:00') }, fallback: 'Call home.' });
  await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 30 }, fallback: 'Look around.' });
  await k.live.setWatch(k.trip, { when: { type: 'enter', lat: NEPENTHE.lat, lng: NEPENTHE.lng }, fallback: 'Here.' });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('13:00') }, fallback: 'Gone by then.', expires: iso('12:00') });
  const list = await k.live.reminders();
  assert.deepEqual(list?.map((r) => [r.key, r.scope, r.watch, r.due, r.text]), [
    [`${k.trip}|${tea.id}`, k.trip, tea.id, at('10:00'), 'Tea time.'],
    [`me|${home.id}`, 'me', home.id, at('11:00'), 'Call home.'],
    [`${k.trip}|plan:nepenthe:leave|${at('12:00')}`, k.trip, 'plan:nepenthe:leave', at('11:09'), 'Leave soon: Lunch at Nepenthe at 12:00.'], // from Bixby, the stop before
    [`${k.trip}|plan:tea:coming-up|${at('16:00')}`, k.trip, 'plan:tea:coming-up', at('15:45'), 'In 15 min: Tea at the inn at 16:00.'],
  ]);
});

test('before live mode has loaded, it says nothing rather than an empty list', async () => {
  const k = await liveKit();
  const fresh = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA });
  assert.equal(await fresh.reminders(), null);
  await fresh.start();
  assert.deepEqual(await fresh.reminders(), []);
  fresh.dispose();
});

test('"leave soon" is when the phone itself would say it: from where annai last saw the user; once there, none', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  const leave = async () => (await k.live.reminders())?.find((r) => r.watch === 'plan:nepenthe:leave')?.due ?? null;
  assert.equal(await leave(), at('11:30'), 'no position and no stop before: half an hour before');
  await k.fix(at('09:00'), MONTEREY);
  const far = await leave();
  await k.fix(at('09:01'), RIVER_INN);
  const near = await leave();
  assert.ok(far !== null && near !== null && far < near, `${far} < ${near}`);
  await k.fix(at('09:02'), NEPENTHE);
  assert.equal(await leave(), null, 'already there');
});

test('a fired time watch and a spent plan reminder leave the list; an item moved later comes back under a new key', async () => {
  const k = await liveKit({ plan: { tea: TEA }, live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  assert.equal((await k.live.reminders())?.some((r) => r.watch === w.id), false);
  await k.to(at('15:45'));
  assert.deepEqual((await k.live.reminders())?.map((r) => r.key), []);
  await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...TEA, start: { at: iso('17:00'), tz: LA } }, { author: 'user' });
  await k.settle();
  assert.deepEqual((await k.live.reminders())?.map((r) => [r.key, r.due]), [[`${k.trip}|plan:tea:coming-up|${at('17:00')}`, at('16:45')]]);
});

test('onReminders is told whenever the list may have changed', async () => {
  const k = await liveKit({ live: false });
  let told = 0;
  const off = k.live.onReminders(() => { told++; });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  assert.ok(told >= 1, 'set');
  let before = told;
  await k.live.cancelWatch(k.trip, w.id);
  assert.ok(told > before, 'cancelled');
  before = told;
  await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...TEA }, { author: 'user' });
  await k.settle();
  assert.ok(told > before, 'the plan changed');
  before = told;
  await k.live.forget(k.trip);
  assert.ok(told > before, 'forgotten');
  off();
  before = told;
  await k.live.setWatch('me', { when: { type: 'time', at: iso('11:00') }, fallback: 'x' });
  assert.equal(told, before, 'no longer told');
});

test('forget: a removed trip\'s watches leave live mode at once (spec §4.9)', async () => {
  const k = await liveKit({ live: false });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.live.setWatch('me', { when: { type: 'time', at: iso('11:00') }, fallback: 'Call home.' });
  k.agent.opened(null);
  await k.live.forget(k.trip);
  assert.deepEqual((await k.live.reminders())?.map((r) => r.scope), ['me']);
  await k.to(at('10:30'));
  assert.equal(k.agent.wakes.length, 0, 'nothing of it fires');
});

test('opened from its notification while annai was closed: the catch-up wake says so, and that the notification was shown (spec §11.6)', async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.settle(); // the watch's own file change is looked at before annai closes
  k.live.dispose();
  await k.clock.advanceTo(at('10:05'));
  const key = `${k.trip}|${w.id}`;
  /** @type {import('../../src/core/live/live.js').PushNews[]} */
  const news = [
    { kind: 'shown', key, scope: k.trip, watch: w.id, at: at('10:00'), t: at('10:00:30') },
    { kind: 'opened', key, scope: k.trip, watch: w.id, title: 'Big Sur', body: 'Tea time.', t: at('10:05') },
  ];
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, news: async () => news.splice(0) });
  await again.start();
  await again.settled();
  assert.equal(k.agent.wakes.length, 1);
  const wake = k.agent.wakes[0];
  assert.equal(wake.kind, 'catch-up');
  assert.match(wake.text, /^Catch-up: annai was closed for /);
  assert.ok(wake.text.includes('The user opened the reminder "Tea time." from its notification at 10:05.'), wake.text);
  assert.ok(wake.text.includes('(late by 5 min: annai was closed; its notification was shown at 10:00)'), wake.text);
  assert.deepEqual((await k.events(['push.shown', 'push.opened'])).map((e) => [e.type, e.data.watch]), [['push.shown', w.id], ['push.opened', w.id]]);
  again.dispose();
});

test('opened while annai is on screen: a catch-up wake at once; another trip\'s waits there; a removed trip\'s and test ones are dropped', async () => {
  const k = await liveKit({ live: false });
  const other = await createTrip(k.ws, { title: 'Tahoe' });
  await k.live.pushNews([{ kind: 'opened', key: `${k.trip}|w-1`, scope: k.trip, watch: 'w-1', body: 'Tea time.', t: at('08:31') }]);
  assert.deepEqual(k.agent.wakes.map((w) => [w.kind, w.text, w.scope]), [['catch-up', 'Catch-up: the user opened the reminder "Tea time." from its notification at 08:31.', undefined]]);
  await k.live.pushNews([
    { kind: 'opened', key: `${other}|w-2`, scope: other, watch: 'w-2', body: 'Skis.', t: at('08:32') },
    { kind: 'opened', key: 'trip-gone|w-3', scope: 'trip-gone', watch: 'w-3', body: 'Gone.', t: at('08:32') },
    { kind: 'opened', key: 'hello|x', scope: '', test: true, body: 'Notifications are on.', t: at('08:32') },
  ]);
  assert.equal(k.agent.wakes.length, 2);
  assert.equal(k.agent.wakes[1].scope, other);
  assert.match(k.agent.wakes[1].text, /"Skis\."/);
});

test("a notification for a reminder annai already said on screen is a double: pushNews names it, so the page closes it", async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const v = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Walk.' });
  await k.to(at('10:00'));
  const doubles = await k.live.pushNews([
    { kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:00:30') },
    { kind: 'shown', key: `${k.trip}|${v.id}`, scope: k.trip, watch: v.id, t: at('10:00:30') },
  ]);
  assert.deepEqual(doubles, [`${k.trip}|${w.id}`]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/live-push.test.js`
Expected: FAIL: `k.live.reminders is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/core/live/live.js`:

Add to the header's typedefs:

```js
 * @typedef {{ key: string, scope: string, watch: string, due: number, text: string }} Mirrored
 *   a reminder a closed annai can still give through the push relay (spec §11.6): key names it and, for the plan's, the item's time
 * @typedef {{ kind: 'shown' | 'opened' | 'changed', key?: string, scope?: string, watch?: string, at?: number, title?: string, body?: string, test?: boolean, t?: number }} PushNews
 *   what the service worker saw: a notification shown or opened, or the subscription renewed; t, when
```

New fields in `Live`:

```js
  /** @type {Set<() => void>} */
  #reminderChanges = new Set();
  /** The watches and the plan are loaded (start). */
  #loaded = false;
  /** @type {Map<string, number>} reminders whose notification the phone showed, by key: when (spec §11.6) */
  #notified = new Map();
  /** @type {{ scope: string, text: string }[]} notifications the user opened, for the next catch-up wake */
  #openedNews = [];
  /** @type {Set<string>} reminders annai said itself on screen, by key: a notification for one is a double (6b choice 3) */
  #said = new Set();
```

The constructor takes `news`:

```js
  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry,
   *   agent: AgentLike, clock?: import('./clock.js').Clock, timeZone?: () => string, news?: () => Promise<PushNews[]> }} c
   *   news: what the service worker saw while annai was away, read at each catch-up (spec §11.6)
   */
  constructor({ store, ws, registry, agent, clock = realClock(), timeZone = deviceZone, news = async () => [] }) {
    …
    this.news = news;
  }
```

In `start`, inside its `#run`, after `await this.#follow();`: `this.#loaded = true;`.

New public methods, after `cancelWatch`:

```js
  /**
   * What a closed annai can still say through the push relay (spec §11.6, 6b choices 1 and 2): time
   * watches in every conversation, and the open trip's "coming up" and "leave soon", each at the time
   * the phone itself would say it. Null until live mode has loaded; read in its own queue, so never
   * half of a list being reloaded.
   * @returns {Promise<Mirrored[] | null>}
   */
  reminders() {
    return this.#run(async () => {
      if (!this.#loaded) return null;
      const m = this.#moment();
      const time = this.types().get('time');
      /** @type {Mirrored[]} */
      const out = [];
      for (const [scope, list] of this.#watches) {
        for (const w of list) {
          if (w.when?.type !== 'time' || !time || this.#broken(time, w)) continue;
          const due = Date.parse(w.when.at);
          if (Number.isFinite(due) && !expired(w, due)) out.push({ key: this.#keyOf(scope, w), scope, watch: w.id, due, text: w.fallback });
        }
      }
      const open = this.#scope();
      for (const w of this.#plan) {
        const event = /** @type {any} */ (w.when).event;
        if ((event !== 'coming-up' && event !== 'leave') || this.#spent(open, w)) continue;
        /** @type {number | null} */
        let due = null;
        try {
          due = PLAN.next?.(w.when, m, this.#mem.get(this.#key(open, w.id)) ?? {}) ?? null;
        } catch {
          due = null;
        }
        if (typeof due === 'number' && Number.isFinite(due)) out.push({ key: this.#keyOf(open, w), scope: open, watch: w.id, due, text: w.fallback });
      }
      return out.sort((a, b) => a.due - b.due);
    });
  }

  /** Hears when what reminders() says may have changed. @param {() => void} fn @returns {() => void} */
  onReminders(fn) {
    this.#reminderChanges.add(fn);
    return () => { this.#reminderChanges.delete(fn); };
  }

  /** A trip was removed (spec §4.9): its watches, memory and firings leave live mode at once. @param {string} scope */
  forget(scope) {
    return this.#run(async () => {
      this.#watches.delete(scope);
      const prefix = `${scope}\n`;
      for (const k of [...this.#mem.keys()]) if (k.startsWith(prefix)) this.#mem.delete(k);
      for (const k of [...this.#fired.keys()]) if (k.startsWith(prefix)) this.#fired.delete(k);
      this.#tellReminders();
    });
  }

  /**
   * What the service worker saw while annai is on screen (spec §11.6): opened notifications become a
   * catch-up wake now, or join the one running. Returns the keys of shown notifications for reminders
   * annai had already said itself on screen, for the page to close (6b choice 3).
   * @param {PushNews[]} list @returns {Promise<string[]>}
   */
  pushNews(list) {
    return this.#run(async () => {
      const doubles = await this.#hear(list);
      if (!this.#catch) await this.#deliverOpened();
      return doubles;
    });
  }
```

Private helpers, after `#tellActivity`:

```js
  #tellReminders() {
    for (const fn of this.#reminderChanges) {
      try {
        fn();
      } catch (e) {
        console.warn('a reminders listener failed', e);
      }
    }
  }

  /** A reminder's name at the relay: its conversation, its watch, and for the plan's, the item's time. @param {string} scope @param {Watch} w */
  #keyOf(scope, w) {
    const f = forAt(w);
    return f === null ? `${scope}|${w.id}` : `${scope}|${w.id}|${f}`;
  }

  /** The service worker's news, never failing. */
  async #readNews() {
    try {
      const list = await this.news();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /**
   * Takes in the service worker's news: shown ones are told with the firing they were for, opened
   * ones wait for a wake. A removed trip's, and annai's own test notifications, are dropped.
   * @param {PushNews[]} list @returns {Promise<string[]>} the doubles
   */
  async #hear(list) {
    const now = this.clock.now();
    for (const [k, t] of this.#notified) if (now - t > 86_400_000) this.#notified.delete(k);
    /** @type {string[]} */
    const doubles = [];
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== 'object' || n.test || typeof n.key !== 'string' || typeof n.scope !== 'string' || !n.scope) continue;
      if (n.kind !== 'shown' && n.kind !== 'opened') continue;
      if (!(await this.#exists(n.scope))) continue;
      const t = typeof n.t === 'number' && Number.isFinite(n.t) ? n.t : now;
      if (n.kind === 'shown') {
        this.#notified.set(n.key, t);
        if (this.#said.has(n.key)) doubles.push(n.key);
      } else {
        const words = String(n.body ?? '').trim().slice(0, 300);
        this.#openedNews.push({ scope: n.scope, text: `The user opened the reminder ${words ? `"${words}"` : `for ${String(n.watch ?? 'a watch')}`} from its notification at ${timeIn(t, this.timeZone())}.` });
      }
      await logEvent(this.store, n.scope, { type: n.kind === 'shown' ? 'push.shown' : 'push.opened', actor: 'system', data: { key: n.key, watch: String(n.watch ?? ''), at: t } }, now);
    }
    return doubles;
  }

  /** Opened notifications with no catch-up running: a catch-up wake of their own, in each one's conversation. */
  async #deliverOpened() {
    /** @type {Map<string, string[]>} */
    const by = new Map();
    for (const o of this.#openedNews.splice(0)) by.set(o.scope, [...(by.get(o.scope) ?? []), o.text]);
    for (const [scope, lines] of by) {
      const text = `Catch-up: ${lines.join(' ').replace(/^The user/, 'the user')}`;
      await this.agent.wake({ kind: 'catch-up', text, ...(scope === this.#scope() ? {} : { scope }) });
    }
  }
```

In `setWatch`, inside its `#run`, after `this.#schedule(m);`: `this.#tellReminders();`.

At the end of `#check`, after `this.#schedule(m);`: `this.#tellReminders();`.

At the end of `#drop`: `this.#tellReminders();`.

In `#catchUp`, before `await this.#check({ past: true });`: `await this.#hear(await this.#readNews());`.

In `#endCatchUp`, replace the delivery line with:

```js
    const opened = this.#openedNews.splice(0);
    if (c.fired.length || opened.length) await this.#deliver(c.fired, 'catch-up', this.#catchUpHeader(c), opened);
```

`#deliver` takes the opened ones and gives every conversation with news a wake:

```js
  /**
   * …(as before)…
   * @param {Fired[]} list @param {'trigger' | 'catch-up'} [kind] @param {string} [header] @param {{ scope: string, text: string }[]} [opened] notifications the user opened
   */
  async #deliver(list, kind = 'trigger', header = '', opened = []) {
    const open = this.#scope();
    /** @type {Map<string, Fired[]>} */
    const by = new Map();
    for (const x of list) by.set(x.scope, [...(by.get(x.scope) ?? []), x]);
    /** @type {Map<string, string[]>} */
    const notes = new Map();
    for (const o of opened) notes.set(o.scope, [...(notes.get(o.scope) ?? []), o.text]);
    for (const scope of notes.keys()) if (!by.has(scope)) by.set(scope, []);
    for (const [scope, xs] of by) {
      const reasons = xs.map((x) => this.#reason(x));
      const fallbacks = xs.map((x) => ({ watch: x.watch.id, text: x.fallback }));
      const lines = notes.get(scope) ?? [];
      if (scope !== open) {
        if (fallbacks.length) await this.agent.remind(fallbacks, scope);
        await this.agent.wake({ kind, text: [...lines, ...reasons].join(' '), scope });
        continue;
      }
      const text = [header, ...lines, ...reasons].filter(Boolean).join(' ');
      if (!this.online) {
        // No connection: annai says the reminders itself now; Shiori hears of them when it is back (spec §17, choice 8).
        if (fallbacks.length) await this.agent.remind(fallbacks);
        this.#held.push({ scope, text });
        continue;
      }
      await this.agent.wake({ kind, text, fallbacks });
    }
  }
```

`#reason` says when the notification was shown:

```js
  /** What fired, in words for Shiori's wake. @param {Fired} x */
  #reason(x) {
    const key = this.#keyOf(x.scope, x.watch);
    const shown = this.#notified.get(key);
    this.#notified.delete(key);
    const notes = [
      x.late ? `late by ${x.late} min: annai was ${x.away === 'start' ? 'closed' : 'off screen'}` : '',
      shown !== undefined ? `its notification was shown at ${timeIn(shown, this.timeZone())}` : '',
    ].filter(Boolean);
    const late = notes.length ? ` (${notes.join('; ')})` : '';
    if (x.watch.owner === 'system') return `${x.firing.text}${late}.`;
    const whose = x.watch.owner === 'shiori' ? 'Your watch' : `The watch of ${x.watch.owner}`;
    return `${whose} ${x.watch.id} (${this.#describe(x.type, x.watch)}) fired: ${x.firing.text}${late}. Its reminder: "${x.watch.fallback}"`;
  }
```

In `#fire`, after `done.push(x);`, remember what annai said itself on screen, by the relay's key:

```js
      if (!this.#catch && this.shown) {
        this.#said.add(this.#keyOf(x.scope, x.watch));
        if (this.#said.size > 200) this.#said.delete(/** @type {string} */ (this.#said.values().next().value));
      }
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/live-push.test.js test/unit/live-*.test.js`
Expected: PASS: the 10 new tests, and every live-mode test before them unchanged.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/live.js test/unit/live-kit.js test/unit/live-push.test.js && git commit -m "Live mode says which reminders a closed annai can still give, and its catch-up says when a notification was shown or opened

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: The relay client, and the mirror that keeps the relay in step

**Files:**
- Create: `src/core/push/relay-client.js`, `src/core/push/mirror.js`, `test/unit/push-kit.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/push-mirror.test.js`

**Interfaces:**
- Consumes: `live.reminders()`, `live.onReminders()` (Task 1); `encryptPush`, `toBase64Url`, `fromBase64Url` (6a); `tracedFetch`, `withoutSecrets` (`src/core/agent/net.js`); `SYS_DEVICE`, `ensureDeviceScope`, `ME`; `realClock`; for tests, `makeRelay`, `memoryNamespace`, `newVapidJwk`, `readVapidKey`, `startPushService`.
- Produces:
  - `relay-client.js`: `DEFAULT_RELAY = 'https://push.annai.guide'`; `relayAddress(url): string | null`; `class RelayError extends Error { code: 'offline' | 'rate' | 'full' | 'unconfirmed' | 'key' | 'gone' | 'refused' | 'relay', status, retryAfter, get passing }`; `relayClient({ base, fetch })` → `{ vapid(): Promise<string>, schedule({ endpoint, key, id, token, sendAt, ttl, payload }): Promise<{ id, sendAt, sent }>, cancel(id, token): Promise<'cancelled' | 'gone'> }`.
  - `mirror.js`: `FILE = '/push.json'`, `TOKENS = 'push:tokens'`, `GRACE_MS = 30_000`, `MAX_WAITING = 150`, `AHEAD_MS` (29 days), `PAD = 3072`, `TTL_S = 3600`, `MOVE_MS` (5 min), `NEAR_MS` (10 min), `TEST_IN_MS = 15_000`; `moves(was, due, now): boolean`; `plan(items, wanted, now): { off: string[], send: Want[] }`; `subscriptionName(endpoint): Promise<string>`.
  - `class PushMirror` with `new PushMirror({ store, ws, live, source, fetch?, clock?, notice? })`, `start()`, `dispose()`, `sync()`, `settled()`, `status(): Promise<{ on, relay, waiting, problem, supported, permission }>`, `turnOn(relay?)`, `turnOff()`, `setRelay(url)`, `test()`, `delivered(news)`, `onChange(fn)`, `source`.
  - `Source = { supported(): 'yes' | 'install' | 'no', permission(): string, ask(): Promise<string>, get(): Promise<Sub | null>, subscribe(key: string): Promise<Sub>, unsubscribe(): Promise<void> }`; `Sub = { endpoint, p256dh: Uint8Array, auth: Uint8Array }`.
  - Events: `push.sync` `{ relay, sent, calledOff, waiting, error? }` in `sys:device`.

- [ ] **Step 1: Write the failing test**

`test/unit/push-kit.js`:

```js
import { liveKit, at, iso, LA } from './live-kit.js';
import { makeRelay } from '../../relay/src/relay.js';
import { memoryNamespace } from '../../relay/memory.js';
import { newVapidJwk, readVapidKey } from '../../relay/src/vapid.js';
import { startPushService } from '../fakes/push-service.js';
import { PushMirror } from '../../src/core/push/mirror.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { SYS_DEVICE } from '../../src/core/scopes.js';

export { at, iso, LA };
export const RELAY = 'https://push.annai.guide';

/**
 * The phone's push subscription, as a test drives it: a subscription at the stand-in push service,
 * made with whatever key annai gives, and the permission the user gave.
 * @param {Awaited<ReturnType<typeof startPushService>>} service
 */
export function fakeSource(service) {
  const s = {
    allowed: 'granted',
    /** @type {any} */
    sub: null,
    made: 0,
    supported: () => /** @type {const} */ ('yes'),
    permission: () => s.allowed,
    ask: async () => s.allowed,
    get: async () => s.sub,
    /** @param {string} key */
    subscribe: async (key) => {
      if (s.allowed !== 'granted') throw new Error('not allowed');
      s.sub = await service.subscribe(key);
      s.made++;
      return s.sub;
    },
    unsubscribe: async () => {
      if (s.sub) service.drop(s.sub.endpoint);
      s.sub = null;
    },
  };
  return s;
}

/**
 * Live mode (liveKit) with a mirror, against the relay's own code in memory, which sends to the
 * stand-in push service over HTTP. Everything runs on the live kit's clock.
 * @param {Parameters<typeof liveKit>[0]} [o]
 */
export async function pushKit(o) {
  const k = await liveKit(o);
  const service = await startPushService({ now: () => k.clock.now() });
  const { worker, PushRelay } = makeRelay({ now: () => k.clock.now(), send: (url, init) => fetch(url, init) });
  const jwk = await newVapidJwk();
  /** @type {any} */
  const env = { VAPID_KEY: jwk, ORIGINS: '', EXTRA_PUSH_ORIGINS: service.origin };
  env.RELAY = memoryNamespace(PushRelay, env, { now: () => k.clock.now(), timers: false });
  const net = { offline: false, calls: /** @type {{ method: string, url: string, auth: string | null }[]} */ ([]) };
  const relayFetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
    if (net.offline) throw new TypeError('Failed to fetch');
    const req = new Request(url, init);
    net.calls.push({ method: req.method, url: req.url, auth: req.headers.get('Authorization') });
    return worker.fetch(req, env);
  };
  const source = fakeSource(service);
  /** @type {any[]} */
  const notices = [];
  const mirror = new PushMirror({ store: k.store, ws: k.ws, live: k.live, source, fetch: tracedFetch(k.store, SYS_DEVICE, { tool: 'push relay' }, relayFetch), clock: k.clock, notice: (n) => notices.push(n) });
  await mirror.start();
  const kit = {
    ...k, service, env, net, source, mirror, notices,
    key: async () => (await readVapidKey(env.VAPID_KEY)).publicKey,
    /**
     * Lets the clock and the mirror catch up, 5 s at a time, each step's syncs done: a retry the mirror
     * sets during a sync is a timer the manual clock must still meet.
     */
    async flush(ms = 1000) {
      const end = k.clock.now() + ms;
      for (;;) {
        const step = Math.min(end, k.clock.now() + 5000);
        await k.to(step);
        await mirror.settled();
        await k.settle();
        await mirror.settled();
        if (step >= end) break;
      }
      // News that came while settling set a half-second timer: one more short step meets it.
      await k.to(k.clock.now() + 600);
      await mirror.settled();
      await k.settle();
      await mirror.settled();
    },
    /** What waits at the relay, every subscription. @returns {Promise<any[]>} */
    waiting: () => env.RELAY.waiting(),
    /** The relay's payloads, in bytes. */
    async payloads() {
      const out = [];
      for (const o of env.RELAY.objects.values()) for (const [, p] of await o.storage.list({ prefix: 'p:' })) out.push(Buffer.from(p, 'base64url'));
      return out;
    },
    /** The clock to t, and what came due at the relay sent. @param {number} t */
    async deliver(t) {
      await k.to(t);
      await env.RELAY.runDue();
    },
    /** What the push service delivered, opened. */
    pushed: () => service.received.filter((r) => r.status === 201).map((r) => JSON.parse(String(r.plaintext))),
    async stop() {
      mirror.dispose();
      k.live.dispose();
      await service.stop();
    },
  };
  return kit;
}
```

`test/unit/push-mirror.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushKit, RELAY, at, iso, LA } from './push-kit.js';
import { moves, plan, GRACE_MS, MAX_WAITING, PAD, FILE, TOKENS, MOVE_MS, NEAR_MS } from '../../src/core/push/mirror.js';
import { relayAddress, relayClient, RelayError } from '../../src/core/push/relay-client.js';
import { SYS_DEVICE, ME } from '../../src/core/scopes.js';
import { toBase64Url } from '../../src/core/bytes.js';
import { newVapidJwk } from '../../relay/src/vapid.js';

const MIN = 60_000;
const TEA = { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } };

test('turning on: one notification at once, then each time reminder waits at the relay, encrypted, all one size, 30 s after its time (spec §11.6)', async () => {
  const k = await pushKit({ plan: { tea: TEA }, live: false });
  try {
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const [hello] = k.pushed();
    assert.equal(hello.title, 'annai');
    assert.match(hello.body, /^Notifications are on\./);
    assert.equal(hello.test, true);
    const waiting = (await k.waiting()).sort((a, b) => a.sendAt - b.sendAt);
    assert.deepEqual(waiting.map((x) => x.sendAt), [at('10:00') + GRACE_MS, at('15:45') + GRACE_MS]);
    assert.deepEqual((await k.payloads()).map((p) => p.length), [86 + PAD + 16, 86 + PAD + 16]);
    k.sensors.visible(false); // annai off screen: only the relay can say it
    await k.settle();
    await k.deliver(at('10:00') + GRACE_MS);
    const tea = k.pushed().at(-1);
    assert.deepEqual({ ...tea }, { v: 1, key: `${k.trip}|${w.id}`, title: 'Big Sur', body: 'Tea time.', at: at('10:00'), scope: k.trip, watch: w.id });
    assert.deepEqual(await k.mirror.status().then((s) => [s.on, s.relay, s.waiting]), [true, RELAY, 2], 'it waits as "sent" until annai hears');
  } finally {
    await k.stop();
  }
});

test('annai on screen says it at its time and calls off the relay\'s copy before the relay would send it: no second reminder', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    assert.equal((await k.waiting()).length, 1);
    await k.to(at('10:00'));
    assert.equal(k.agent.wakes.length, 1, 'said on the phone');
    await k.flush();
    assert.deepEqual(await k.waiting(), [], 'called off, before its send');
    await k.deliver(at('10:01'));
    assert.equal(k.pushed().length, 1, 'only the turn-on notification ever came');
  } finally {
    await k.stop();
  }
});

test('cancelling a watch calls it off; a new one is sent; a plan item moved later moves its reminder', async () => {
  const k = await pushKit({ plan: { tea: TEA }, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    assert.equal((await k.waiting()).length, 2);
    await k.live.cancelWatch(k.trip, w.id);
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('15:45') + GRACE_MS]);
    await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...TEA, start: { at: iso('17:00'), tz: LA } }, { author: 'user' });
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('16:45') + GRACE_MS]);
    const deletes = k.net.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 2);
  } finally {
    await k.stop();
  }
});

test('when a reminder moves at the relay (6b choice 2)', () => {
  const now = at('09:00');
  assert.equal(moves(at('11:30'), at('11:30'), now), false);
  assert.equal(moves(at('11:30'), at('11:30') - MOVE_MS, now), true, '5 minutes earlier: a closed annai would be late');
  assert.equal(moves(at('11:30'), at('11:27'), now), false, 'a little earlier: annai on screen says it first anyway');
  assert.equal(moves(at('11:30'), at('11:40'), now), false, 'later, but the relay\'s time is far off: there is time');
  assert.equal(moves(at('09:08'), at('09:12'), now), true, 'later, and the relay\'s copy comes within 10 minutes: it would come first');
  assert.equal(moves(at('09:00') + NEAR_MS + 1, at('09:30'), now), false);
  const m = (/** @type {string} */ key, /** @type {number} */ due) => ({ m: { key, scope: 't', watch: key, due, text: '' }, sendAt: due + GRACE_MS, title: 'T', body: '', hash: 'h' });
  const items = { a: { id: 'x.a', due: at('10:00'), sendAt: at('10:00') + GRACE_MS, hash: 'h', scope: 't' }, b: { id: 'x.b', due: at('11:00'), sendAt: 0, hash: 'h', scope: 't' }, c: { id: 'x.c', due: at('12:00'), sendAt: 0, hash: 'h', scope: 't', sending: true } };
  const wanted = new Map([['a', m('a', at('10:00'))], ['b', { ...m('b', at('11:00')), hash: 'changed' }], ['c', m('c', at('12:00'))], ['d', m('d', at('13:00'))]]);
  const p = plan(items, wanted, now);
  assert.deepEqual(p.off, ['b']);
  assert.deepEqual(p.send.map((w) => [w.m.key, Boolean(w.reuse)]), [['b', false], ['c', true], ['d', false]]);
});

test('"leave soon" moves at the relay only when it matters, not at every fix', async () => {
  const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } };
  const k = await pushKit({ plan: { nepenthe: NEP } });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('11:30') + GRACE_MS]);
    await k.fix(at('09:00'), { lat: 36.6036, lng: -121.8916 }); // Monterey: much further than the plan said
    await k.flush();
    const [far] = await k.waiting();
    assert.ok(far.sendAt < at('11:30'), 'moved earlier');
    const posts = k.net.calls.filter((c) => c.method === 'POST').length;
    for (let i = 1; i <= 5; i++) await k.fix(at('09:00') + i * 10_000, { lat: 36.6036 - i * 0.0001, lng: -121.8916 });
    await k.flush();
    assert.equal(k.net.calls.filter((c) => c.method === 'POST').length, posts, 'a few meters changes nothing at the relay');
  } finally {
    await k.stop();
  }
});

test("removing a trip calls off its reminders at once (spec §4.9)", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.live.setWatch(ME, { when: { type: 'time', at: iso('11:00') }, fallback: 'Call home.' });
    await k.flush();
    assert.equal((await k.waiting()).length, 2);
    k.agent.opened(null);
    await k.live.forget(k.trip);
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('11:00') + GRACE_MS]);
    const st = await k.ws.readJSON(SYS_DEVICE, FILE);
    assert.equal(JSON.stringify(st).includes(k.trip), false, "the trip's id is gone from this device's state");
  } finally {
    await k.stop();
  }
});

test('no connection: nothing is lost; what failed goes when it is back; a restart sends again what it began, kept once', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    k.net.offline = true;
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    assert.deepEqual(await k.waiting(), []);
    const st = await k.mirror.status();
    assert.match(String(st.problem?.message), /couldn't reach the relay/);
    k.net.offline = false;
    await k.mirror.sync();
    assert.equal((await k.waiting()).length, 1);
    assert.equal((await k.mirror.status()).problem, null);
    await k.live.cancelWatch(k.trip, w.id);
    k.net.offline = true;
    await k.flush();
    assert.equal((await k.waiting()).length, 1, 'the cancel waits');
    k.net.offline = false;
    await k.flush(31 * MIN); // the retry
    assert.deepEqual(await k.waiting(), [], 'called off once the connection is back');
  } finally {
    await k.stop();
  }
});

test('a send cut off before its answer is sent again with the same id and token, and kept once', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    const st = await k.ws.readJSON(SYS_DEVICE, FILE);
    const [key] = Object.keys(st.items);
    await k.ws.write(SYS_DEVICE, FILE, { ...st, items: { [key]: { ...st.items[key], sending: true } } }, { author: 'system' }); // as if the answer never came
    await k.mirror.sync();
    assert.equal((await k.waiting()).length, 1);
    assert.equal((await k.ws.readJSON(SYS_DEVICE, FILE)).items[key].sending, undefined);
  } finally {
    await k.stop();
  }
});

test('turning off calls everything off and unsubscribes; turning on again sends again', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    await k.mirror.turnOff();
    assert.deepEqual(await k.waiting(), []);
    assert.equal(k.source.sub, null);
    assert.deepEqual(await k.mirror.status().then((s) => [s.on, s.waiting]), [false, 0]);
    assert.deepEqual(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret(TOKENS)), undefined, 'no token left');
    await k.mirror.turnOn(RELAY);
    await k.flush();
    assert.equal((await k.waiting()).length, 1);
    assert.equal(k.pushed().filter((p) => p.test).length, 2, 'a new subscription: a new "notifications are on"');
  } finally {
    await k.stop();
  }
});

test("the relay's key changed: annai subscribes again by itself, says so once, and sends everything again", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.env.VAPID_KEY = await newVapidJwk();
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Walk.' });
    await k.flush();
    await k.flush();
    assert.equal(k.source.made, 2);
    assert.equal(k.source.sub.serverKey, await k.key());
    const mine = (await k.waiting()).filter((x) => x.endpoint === k.source.sub.endpoint);
    assert.equal(mine.length, 2);
    assert.match(k.pushed().at(-1).body, /on again/);
  } finally {
    await k.stop();
  }
});

test('the relay forgot this phone (unconfirmed): "on again", then the rest', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    for (const o of k.env.RELAY.objects.values()) await o.storage.delete('confirmed'); // a relay restart
    for (let h = 10; h < 15; h++) await k.live.setWatch(k.trip, { when: { type: 'time', at: iso(`${h}:00`) }, fallback: `At ${h}.` });
    await k.flush();
    await k.flush(2 * MIN);
    assert.equal((await k.waiting()).length, 5);
    assert.match(k.pushed().at(-1).body, /on again/);
  } finally {
    await k.stop();
  }
});

test('the phone dropped the subscription: with permission, annai subscribes again by itself; without, one notice', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.source.sub = null;
    await k.mirror.sync();
    await k.flush();
    assert.equal(k.source.made, 2);
    assert.equal((await k.waiting()).filter((x) => x.endpoint === k.source.sub.endpoint).length, 1);
    k.source.sub = null;
    k.source.allowed = 'denied';
    await k.mirror.sync();
    await k.mirror.sync();
    assert.equal(k.notices.length, 1);
    assert.match(k.notices[0].body, /Settings → Notifications/);
    const st = await k.mirror.status();
    assert.equal(st.problem?.needsYou, true);
  } finally {
    await k.stop();
  }
});

test('the nearest 150, within 29 days, wait at the relay', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    for (let i = 0; i < 160; i++) {
      const t = new Date(at('10:00') + i * 3 * 3_600_000);
      await k.live.setWatch(k.trip, { when: { type: 'time', at: t.toISOString().replace('.000Z', 'Z') }, fallback: `No. ${i}` });
    }
    await k.live.setWatch(k.trip, { when: { type: 'time', at: new Date(at('10:00') + 31 * 86_400_000).toISOString().replace('.000Z', 'Z') }, fallback: 'Too far.' });
    await k.flush(5 * MIN);
    const waiting = await k.waiting();
    assert.equal(waiting.length, MAX_WAITING);
    assert.ok(Math.max(...waiting.map((x) => x.sendAt)) < at('10:00') + 150 * 3 * 3_600_000);
  } finally {
    await k.stop();
  }
});

test('keys never show: no cancel token, p256dh or auth in any event or file; every relay request is in the trace', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    await k.live.cancelWatch(k.trip, w.id);
    await k.flush();
    const tokens = k.net.calls.map((c) => c.auth?.replace('Bearer ', '')).filter((x) => typeof x === 'string' && x.length > 20);
    assert.ok(tokens.length >= 2);
    const secrets = [...tokens, toBase64Url(k.source.sub.p256dh), toBase64Url(k.source.sub.auth)];
    const scopes = await k.store.tx(['scopes'], 'readonly', (t) => t.listScopes());
    let everything = '';
    for (const s of scopes) everything += JSON.stringify(await k.store.tx(['events'], 'readonly', (t) => t.listEvents(s.id)));
    // Every stored content, every file's history included.
    await k.store.tx(['blobs'], 'readonly', async (t) => {
      for (const b of await t.listBlobs()) everything += new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0)));
    });
    for (const s of secrets) assert.equal(everything.includes(s), false, 'a key in an event or a file');
    const traced = (await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS_DEVICE, { types: ['net.request'] }))).map((e) => `${e.data.tool} ${e.data.method} ${new URL(e.data.url).pathname}`);
    assert.equal(traced.length, k.net.calls.length, 'every relay request');
    assert.ok(traced.includes('push relay GET /v1/vapid'));
    assert.ok(traced.includes('push relay POST /v1/schedule'));
    assert.ok(traced.some((x) => /^push relay DELETE \/v1\/schedule\/[\w-]+\.[\w-]+$/.test(x)));
    assert.ok((await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS_DEVICE, { types: ['push.sync'] }))).length >= 2);
  } finally {
    await k.stop();
  }
});

test('a notification shown means its copy left the relay: forgotten without a DELETE', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.mirror.delivered([{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:00:30') }]);
    await k.mirror.settled();
    assert.equal((await k.mirror.status()).waiting, 0);
  } finally {
    await k.stop();
  }
});

test('the test notification reaches the push service 15 s later', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    await k.mirror.test();
    await k.deliver(k.clock.now() + 15_000);
    assert.match(k.pushed().at(-1).body, /^A test/);
  } finally {
    await k.stop();
  }
});

test("errors in plain words: an address that isn't one; a relay that can't be reached; one reminder refused", async () => {
  const k = await pushKit({ live: false });
  try {
    await assert.rejects(k.mirror.turnOn('ftp://push.example'), /must start with https:\/\//);
    assert.equal(relayAddress('http://localhost:8796/'), 'http://localhost:8796');
    assert.equal(relayAddress('https://push.annai.guide/'), 'https://push.annai.guide');
    assert.equal(relayAddress('http://push.annai.guide'), null);
    k.net.offline = true;
    await assert.rejects(k.mirror.turnOn(RELAY), /couldn't reach the relay at push\.annai\.guide/);
    assert.equal((await k.mirror.status()).on, false, 'nothing turned on');
    k.net.offline = false;
    const client = relayClient({ base: RELAY, fetch: async () => new Response('<html>', { status: 502 }) });
    await assert.rejects(client.vapid(), (e) => e instanceof RelayError && e.code === 'relay' && /answered 502/.test(e.message));
    const odd = relayClient({ base: RELAY, fetch: async () => new Response('{"key":5}', { status: 200 }) });
    await assert.rejects(odd.vapid(), (e) => e instanceof RelayError && /a key annai can't use/.test(e.message));
  } finally {
    await k.stop();
  }
});

test("a relay's message holding a cancel token is blanked before annai keeps or shows it", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const real = k.env.RELAY.get;
    k.env.RELAY.get = (/** @type {any} */ id) => ({
      fetch: async (/** @type {Request} */ req) => {
        const t = JSON.parse(await req.clone().text()).token;
        return new Response(JSON.stringify({ error: 'nope', message: `I saw ${t}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.env.RELAY.get = real;
    const st = await k.mirror.status();
    assert.match(String(st.problem?.message), /refused/);
    assert.doesNotMatch(String(st.problem?.message), /[\w-]{40,}/, 'no token in it');
  } finally {
    await k.stop();
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/push-mirror.test.js`
Expected: FAIL: `src/core/push/mirror.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

`src/core/push/relay-client.js`:

```js
import { toBase64Url, fromBase64Url } from '../bytes.js';

/**
 * The push relay's API (spec §11.6): the public key, a reminder scheduled, a reminder cancelled.
 * Through annai's traced fetch, so every request shows in the trace (§15); the cancel token goes
 * only in the Authorization header, which the trace doesn't keep. Whatever the relay answers, a
 * failure is a RelayError in plain words, never a TypeError or SyntaxError.
 */

export const DEFAULT_RELAY = 'https://push.annai.guide';
export const ADDRESS = 'The relay address must start with https:// (http:// only for localhost, to test).';

export class RelayError extends Error {
  /**
   * @param {string} message
   * @param {{ code: 'offline' | 'rate' | 'full' | 'unconfirmed' | 'key' | 'gone' | 'refused' | 'relay', status?: number, retryAfter?: number }} o
   *   retryAfter: seconds the relay asked annai to wait
   */
  constructor(message, { code, status = 0, retryAfter = 0 }) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** Worth trying again later by itself: no connection, the relay busy or down, the subscription not confirmed yet. */
  get passing() {
    return this.code === 'offline' || this.code === 'rate' || this.code === 'relay' || this.code === 'unconfirmed';
  }
}

/** The relay's address as annai keeps it, or null when it isn't one: https, or http on this computer. @param {string} url */
export function relayAddress(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** @param {{ base: string, fetch: (url: string, init?: RequestInit) => Promise<Response> }} c */
export function relayClient({ base, fetch }) {
  const host = new URL(base).host;

  /** @param {string} path @param {RequestInit} init @returns {Promise<{ res: Response, body: any }>} */
  async function call(path, init) {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(`${base}${path}`, init);
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      throw new RelayError(`annai couldn't reach the relay at ${host}. Is the phone offline? annai tries again by itself.`, { code: 'offline' });
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    /** @type {any} */
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { res, body: body && typeof body === 'object' && !Array.isArray(body) ? body : null };
  }

  /** @param {Response} res @param {any} body */
  function failure(res, body) {
    const said = typeof body?.message === 'string' ? body.message.slice(0, 300) : '';
    const code = typeof body?.error === 'string' ? body.error : '';
    const retryAfter = Number(res.headers.get('Retry-After')) || 0;
    if (res.status === 429 && code === 'unconfirmed') return new RelayError(said || 'The relay is waiting for this phone\'s first notification.', { code: 'unconfirmed', status: 429, retryAfter: retryAfter || 10 });
    if (res.status === 429) {
      return new RelayError(said || `The relay at ${host} is busy. annai tries again in a minute.`, { code: code === 'full' ? 'full' : 'rate', status: 429, retryAfter: code === 'full' ? 0 : retryAfter || 60 });
    }
    if (res.status === 409 && code === 'key') return new RelayError(said || "The relay's key changed.", { code: 'key', status: 409 });
    if (res.status === 410) return new RelayError(said || "The phone's push service says this subscription no longer exists.", { code: 'gone', status: 410 });
    if (res.status >= 500) return new RelayError(`The relay at ${host} answered ${res.status}${said ? `: ${said}` : ''}. annai tries again later.`, { code: 'relay', status: res.status });
    return new RelayError(`The relay at ${host} refused it (${res.status}${said ? `: ${said}` : ''}).`, { code: 'refused', status: res.status });
  }

  return {
    /** The relay's VAPID public key, which the phone subscribes with. @returns {Promise<string>} */
    async vapid() {
      const { res, body } = await call('/v1/vapid', { method: 'GET' });
      if (!res.ok) throw failure(res, body);
      const raw = typeof body?.key === 'string' ? fromBase64Url(body.key) : null;
      if (!raw || raw.length !== 65 || raw[0] !== 4) throw new RelayError(`The relay at ${host} sent a key annai can't use. Is this the address of an annai push relay?`, { code: 'refused', status: res.status });
      return body.key;
    },
    /**
     * Keeps one encrypted reminder at the relay until sendAt.
     * @param {{ endpoint: string, key: string, id: string, token: string, sendAt: number, ttl: number, payload: Uint8Array }} r
     * @returns {Promise<{ id: string, sendAt: number, sent: boolean }>}
     */
    async schedule({ endpoint, key, id, token, sendAt, ttl, payload }) {
      const { res, body } = await call('/v1/schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint, key, id, sendAt, ttl, urgency: 'high', payload: toBase64Url(payload) }),
      });
      if (res.status !== 201) throw failure(res, body);
      return { id: typeof body?.id === 'string' ? body.id : '', sendAt: Number(body?.sendAt), sent: body?.sent === true };
    },
    /** Calls a reminder off. "gone": it was sent already, or isn't there. @param {string} id @param {string} token @returns {Promise<'cancelled' | 'gone'>} */
    async cancel(id, token) {
      const { res, body } = await call(`/v1/schedule/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 204) return 'cancelled';
      if (res.status === 404 || res.status === 403) return 'gone';
      throw failure(res, body);
    },
  };
}
```

`src/core/push/mirror.js`:

```js
import { SYS_DEVICE, ensureDeviceScope, ME } from '../scopes.js';
import { logEvent } from '../events.js';
import { utf8, toBase64Url, hex, ownBuffer } from '../bytes.js';
import { encryptPush } from './webpush.js';
import { relayClient, relayAddress, RelayError, DEFAULT_RELAY, ADDRESS } from './relay-client.js';
import { tracedFetch, withoutSecrets } from '../agent/net.js';
import { realClock } from '../live/clock.js';

/**
 * Reminders for a closed annai (spec §11.6): while notifications are on, the time reminders live
 * mode would give wait at the push relay, each encrypted on the phone and padded to one size, sent
 * 30 seconds after its time. annai on screen says one itself and calls the relay's copy off.
 * State: /push.json in this device's own scope; the cancel tokens, the secret push:tokens.
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {import('../live/live.js').Mirrored} Mirrored
 * @typedef {{ endpoint: string, p256dh: Uint8Array, auth: Uint8Array }} Sub  the phone's push subscription
 * @typedef {{ supported: () => 'yes' | 'install' | 'no', permission: () => string, ask: () => Promise<string>,
 *   get: () => Promise<Sub | null>, subscribe: (key: string) => Promise<Sub>, unsubscribe: () => Promise<void> }} Source
 *   the phone's push subscription and notification permission (src/ui/push.js; a fake in tests)
 * @typedef {{ reminders: () => Promise<Mirrored[] | null>, onReminders: (fn: () => void) => () => void }} LiveLike
 * @typedef {{ id: string, due: number, sendAt: number, hash: string, scope: string, sending?: boolean }} Item
 *   a reminder at the relay; sending: written down before it was sent, not yet known to have arrived
 * @typedef {{ m: Mirrored, sendAt: number, title: string, body: string, hash: string, reuse?: boolean }} Want
 * @typedef {{ on: boolean, relay: string, key: string | null, endpoint: string | null, hello: { endpoint: string, at: number } | null,
 *   items: Record<string, Item>, cancels: { id: string, relay: string }[], problem: { message: string, at: number, needsYou: boolean } | null }} State
 *   key, endpoint: what the phone subscribed with; hello: the "notifications are on" sent for that endpoint
 */

export const FILE = '/push.json';
export const TOKENS = 'push:tokens';
/** The relay sends this long after a reminder's time, so annai on screen says it first and calls it off (6b choice 3). */
export const GRACE_MS = 30_000;
/** At most this many wait at the relay (it keeps 200): the nearest (choice 7). */
export const MAX_WAITING = 150;
/** The furthest ahead annai sends: the relay takes 30 days. */
export const AHEAD_MS = 29 * 86_400_000;
/** Every reminder is padded to this size before it is encrypted (6a choice 4). */
export const PAD = 3072;
/** A push service keeps a reminder it can't deliver yet this long; catch-up covers the rest. */
export const TTL_S = 3600;
/** A reminder moves at the relay when its time comes this much earlier… (choice 2) */
export const MOVE_MS = 5 * 60_000;
/** …or, within this long of the relay's time, when it would come later than the relay's. */
export const NEAR_MS = 10 * 60_000;
/** The test notification comes this long after the tap. */
export const TEST_IN_MS = 15_000;
const MIN = 60_000;
/** A reminder this long past its send is not called off: it was sent. */
const LONG_SENT_MS = 10 * MIN;
/** The mirror waits this long after live mode's news, so a burst of changes is one sync. */
const SOON_MS = 500;
const HELLO = 'Notifications are on. Reminders come like this while annai is closed.';
const AGAIN = 'Notifications are on again: reminders come like this while annai is closed.';
const OFF_BY_PHONE = "The phone turned annai's notifications off, or they were turned off in its settings, so reminders don't reach a closed annai. Turn them on again in Settings → Notifications.";

/**
 * Whether a reminder's time moved enough to move it at the relay (choice 2): 5 minutes earlier (a
 * closed annai would be late), or later when the relay's copy comes within 10 minutes (it would come
 * before annai's own). @param {number} was the relay's @param {number} due annai's own @param {number} now
 */
export function moves(was, due, now) {
  if (due === was) return false;
  if (was - due >= MOVE_MS) return true;
  return due > was && was - now <= NEAR_MS;
}

/**
 * What to change at the relay: reminders no longer wanted, whose words changed, or whose time moved,
 * are called off; new and moved ones are sent; one written down but not known to have arrived is
 * sent again as it was. @param {Record<string, Item>} items @param {Map<string, Want>} wanted @param {number} now
 * @returns {{ off: string[], send: Want[] }}
 */
export function plan(items, wanted, now) {
  /** @type {string[]} */
  const off = [];
  for (const [key, item] of Object.entries(items)) {
    const w = wanted.get(key);
    if (!w || w.hash !== item.hash || moves(item.due, w.m.due, now)) off.push(key);
  }
  /** @type {Want[]} */
  const send = [];
  for (const [key, w] of wanted) {
    const item = items[key];
    if (!item || off.includes(key)) send.push(w);
    else if (item.sending) send.push({ ...w, reuse: true });
  }
  return { off, send };
}

/** The relay's name for a subscription's object: the SHA-256 of its endpoint (6a choice 1). @param {string} endpoint */
export async function subscriptionName(endpoint) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', ownBuffer(utf8(endpoint)))));
}

/** @param {number} n */
const random = (n) => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));

/** @param {string} text */
async function digest(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', ownBuffer(utf8(text))))).slice(0, 16);
}

/** @param {any} v @returns {State} */
function stateOf(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const items = o.items && typeof o.items === 'object' && !Array.isArray(o.items) ? o.items : {};
  return {
    on: o.on === true,
    relay: relayAddress(o.relay ?? '') ?? DEFAULT_RELAY,
    key: typeof o.key === 'string' ? o.key : null,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : null,
    hello: o.hello && typeof o.hello.endpoint === 'string' && Number.isFinite(o.hello.at) ? { endpoint: o.hello.endpoint, at: o.hello.at } : null,
    items: Object.fromEntries(Object.entries(items).filter(([, i]) => i && typeof i.id === 'string' && Number.isFinite(i.sendAt) && Number.isFinite(i.due))),
    cancels: Array.isArray(o.cancels) ? o.cancels.filter((/** @type {any} */ c) => c && typeof c.id === 'string' && typeof c.relay === 'string') : [],
    problem: o.problem && typeof o.problem.message === 'string' ? { message: o.problem.message, at: Number(o.problem.at) || 0, needsYou: o.problem.needsYou === true } : null,
  };
}

export class PushMirror {
  /** @type {Promise<unknown>} */
  #turn = Promise.resolve();
  /** Live mode changed while a sync was sending: the rest wait for the next, which calls off first. */
  #dirty = false;
  /** @type {any} */
  #soonTimer = null;
  /** @type {any} */
  #retryTimer = null;
  #retries = 0;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {(() => void)[]} */
  #offs = [];
  /** The "notifications are off" card, once a run. */
  #warned = false;
  #lastState = '';
  #lastTokens = '';

  /**
   * @param {{ store: Store, ws: Workspace, live: LiveLike, source: Source, fetch?: (url: string, init?: RequestInit) => Promise<Response>,
   *   clock?: import('../live/clock.js').Clock, notice?: (n: { title: string, body: string }) => void }} c
   */
  constructor({ store, ws, live, source, fetch, clock = realClock(), notice = () => {} }) {
    this.store = store;
    this.ws = ws;
    this.live = live;
    this.source = source;
    this.clock = clock;
    this.notice = notice;
    this.fetch = fetch ?? tracedFetch(store, SYS_DEVICE, { tool: 'push relay' });
  }

  /** Follows live mode, and brings the relay into step. */
  start() {
    this.#offs.push(this.live.onReminders(() => this.#soon()));
    return this.sync();
  }

  dispose() {
    for (const off of this.#offs.splice(0)) off();
    if (this.#soonTimer !== null) this.clock.clear(this.#soonTimer);
    if (this.#retryTimer !== null) this.clock.clear(this.#retryTimer);
    this.#soonTimer = null;
    this.#retryTimer = null;
  }

  /** Hears when the state changes (the Notifications screen). @param {() => void} fn */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /** Settles once nothing is left to do. */
  async settled() {
    /** @type {Promise<unknown>} */
    let t;
    do {
      t = this.#turn;
      await t;
    } while (t !== this.#turn);
  }

  /** How things stand, for the Notifications screen. */
  async status() {
    const st = await this.#read();
    return {
      on: st.on, relay: st.relay, problem: st.problem,
      waiting: Object.values(st.items).filter((i) => !i.sending).length,
      supported: this.source.supported(), permission: this.source.permission(),
    };
  }

  /**
   * Turns notifications on, once the user has allowed them (the screen asks first, choice 11):
   * subscribes with the relay's key, says so with a notification at once (choice 6), then sends
   * every reminder. @param {string} [relay] its address; the one kept if not given
   */
  turnOn(relay) {
    return this.#run(async () => {
      const st = await this.#read();
      const tokens = await this.#readTokens();
      const base = relayAddress(relay ?? st.relay);
      if (!base) throw new Error(ADDRESS);
      const key = await this.#client(base).vapid();
      if (base !== st.relay) this.#moveAll(st); // the old relay's copies are called off there (choice 13)
      const had = await this.source.get().catch(() => null);
      /** @type {Sub} */
      let sub;
      if (had && had.endpoint === st.endpoint && st.key === key && st.on) {
        sub = had;
      } else {
        if (had) await this.source.unsubscribe().catch(() => {});
        this.#moveAll(st);
        sub = await this.source.subscribe(key);
        st.hello = null;
      }
      st.on = true;
      st.relay = base;
      st.key = key;
      st.endpoint = sub.endpoint;
      st.problem = null;
      if (st.hello?.endpoint !== sub.endpoint) await this.#hello(st, sub, HELLO);
      await this.#save(st, tokens);
      this.#tell();
    }).then(() => this.sync());
  }

  /** Turns notifications off: everything at the relay is called off, then the subscription goes (choice 9). */
  turnOff() {
    return this.#run(async () => {
      const st = await this.#read();
      const tokens = await this.#readTokens();
      this.#moveAll(st);
      st.on = false;
      st.problem = null;
      st.hello = null;
      await this.#save(st, tokens);
      try {
        await this.#callOff(st, tokens);
      } catch (e) {
        if (!(e instanceof RelayError)) throw e;
        // The rest wait, and go at the next sync.
      }
      await this.source.unsubscribe().catch(() => {});
      st.endpoint = null;
      st.key = null;
      await this.#save(st, tokens);
      this.#tell();
    });
  }

  /** Changes the relay's address; while on, everything moves there (choice 13). @param {string} url */
  async setRelay(url) {
    const base = relayAddress(url);
    if (!base) throw new Error(ADDRESS);
    const st = await this.#run(() => this.#read());
    if (base === st.relay) return;
    if (st.on) {
      await this.turnOn(base);
      return;
    }
    await this.#run(async () => {
      const now = await this.#read();
      now.relay = base;
      await this.#save(now, await this.#readTokens());
      this.#tell();
    });
  }

  /** A test notification, TEST_IN_MS from now (choice 6). */
  test() {
    return this.#run(async () => {
      const st = await this.#read();
      if (!st.on || !st.key) throw new Error('Turn notifications on first.');
      const sub = await this.source.get();
      if (!sub) throw new Error(OFF_BY_PHONE);
      const rand = random(16);
      const payload = await encryptPush(sub, utf8(JSON.stringify({ v: 1, key: `test|${rand}`, title: 'annai', body: 'A test: reminders reach this phone through the relay.', test: true })), { pad: PAD });
      await this.#client(st.relay).schedule({ endpoint: sub.endpoint, key: st.key, id: rand, token: random(32), sendAt: this.clock.now() + TEST_IN_MS, ttl: 600, payload });
    });
  }

  /**
   * What the service worker saw (choice 10): a notification shown means its copy left the relay; a
   * renewed subscription is sent everything again. @param {import('../live/live.js').PushNews[]} news
   */
  delivered(news) {
    const list = Array.isArray(news) ? news : [];
    const shown = list.filter((n) => n?.kind === 'shown' && !n.test && typeof n.key === 'string').map((n) => /** @type {string} */ (n.key));
    if (shown.length) {
      this.#run(async () => {
        const st = await this.#read();
        const tokens = await this.#readTokens();
        for (const key of shown) {
          const item = st.items[key];
          if (!item) continue;
          delete st.items[key];
          delete tokens[item.id];
        }
        await this.#save(st, tokens);
        this.#tell();
      }).catch((e) => console.warn('push: could not note a notification', e));
    }
    if (list.some((n) => n?.kind === 'changed')) this.#soon();
  }

  /** Brings the relay into step with live mode. */
  sync() {
    return this.#run(() => this.#sync());
  }

  async #sync() {
    this.#dirty = false;
    if (this.#retryTimer !== null) this.clock.clear(this.#retryTimer);
    this.#retryTimer = null;
    const st = await this.#read();
    const tokens = await this.#readTokens();
    const before = st.problem; // a passing one from an earlier sync clears once this one goes well
    let sent = 0;
    let calledOff = 0;
    /** @type {RelayError | null} */
    let error = null;
    try {
      /** @type {Want[]} */
      let send = [];
      /** @type {Sub | null} */
      let sub = null;
      if (st.on) {
        sub = await this.#subscription(st);
        const wanted = sub ? await this.#wanted() : null;
        if (sub && wanted) {
          const p = plan(st.items, wanted, this.clock.now());
          for (const key of p.off) this.#offLater(st, tokens, key);
          send = p.send;
        }
      }
      calledOff = await this.#callOff(st, tokens);
      if (sub && send.length) sent = await this.#send(st, tokens, sub, send);
      if (st.problem && st.problem === before && !before.needsYou) st.problem = null;
      this.#retries = 0;
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      error = e;
      await this.#trouble(st, e);
    } finally {
      await this.#save(st, tokens);
    }
    if (sent || calledOff || error) {
      const data = { relay: new URL(st.relay).host, sent, calledOff, waiting: Object.keys(st.items).length, ...(error ? { error: st.problem?.message ?? '' } : {}) };
      await logEvent(this.store, SYS_DEVICE, { type: 'push.sync', actor: 'system', data }, this.clock.now()).catch(() => {});
    }
    this.#tell();
    if (this.#dirty) this.#soon();
  }

  /** The phone's subscription, renewed by itself when it is gone and permission stays (choice 12). @param {State} st */
  async #subscription(st) {
    /** @type {Sub | null} */
    let sub;
    try {
      sub = await this.source.get();
    } catch (e) {
      // It can't be asked yet (annai's offline service starting): later, not "off".
      throw new RelayError(String(/** @type {any} */ (e)?.message ?? e), { code: 'offline' });
    }
    if (sub) {
      if (sub.endpoint !== st.endpoint) this.#renewed(st, sub);
      return sub;
    }
    if (this.source.permission() === 'granted' && st.key) {
      try {
        const again = await this.source.subscribe(st.key);
        this.#renewed(st, again);
        return again;
      } catch {
        // falls through: the user is asked
      }
    }
    this.#moveAll(st);
    st.problem = { message: OFF_BY_PHONE, at: this.clock.now(), needsYou: true };
    if (!this.#warned) {
      this.#warned = true;
      this.notice({ title: 'Notifications are off', body: OFF_BY_PHONE });
    }
    return null;
  }

  /** A new subscription: what waited for the old one is called off, and all is sent again. @param {State} st @param {Sub} sub */
  #renewed(st, sub) {
    this.#moveAll(st);
    st.endpoint = sub.endpoint;
    st.hello = null;
  }

  /** What should wait at the relay now: the nearest reminders within reach (choice 7). null: live mode hasn't loaded. */
  async #wanted() {
    const list = await this.live.reminders();
    if (!list) return null;
    const now = this.clock.now();
    /** @type {Map<string, Want>} */
    const out = new Map();
    /** @type {Map<string, string>} */
    const titles = new Map();
    for (const m of list) {
      const sendAt = m.due + GRACE_MS;
      if (sendAt <= now + 5000 || sendAt > now + AHEAD_MS) continue; // about to be said on screen, or too far
      if (out.size >= MAX_WAITING) break;
      const title = await this.#title(m.scope, titles);
      const body = String(m.text).slice(0, 500);
      out.set(m.key, { m, sendAt, title, body, hash: await digest(`${title}\n${body}`) });
    }
    return out;
  }

  /** A notification's title: the trip's name, or "Reminder" (choice 4). @param {string} scope @param {Map<string, string>} cache */
  async #title(scope, cache) {
    if (scope === ME) return 'Reminder';
    const had = cache.get(scope);
    if (had !== undefined) return had;
    const rec = await this.store.tx(['scopes'], 'readonly', (t) => t.getScope(scope)).catch(() => null);
    const title = String(rec?.title ?? 'Reminder').slice(0, 120);
    cache.set(scope, title);
    return title;
  }

  /** Moves a reminder from the relay's list to the calls-off; one long sent is just forgotten. @param {State} st @param {Record<string, string>} tokens @param {string} key */
  #offLater(st, tokens, key) {
    const item = st.items[key];
    if (!item) return;
    delete st.items[key];
    if (!item.sending && item.sendAt + LONG_SENT_MS < this.clock.now()) {
      delete tokens[item.id];
      return;
    }
    st.cancels.push({ id: item.id, relay: st.relay });
  }

  /** Every reminder at the relay is to be called off. @param {State} st */
  #moveAll(st) {
    for (const item of Object.values(st.items)) st.cancels.push({ id: item.id, relay: st.relay });
    st.items = {};
  }

  /** Calls off what waits to be (first, before anything is sent: choice 3). @param {State} st @param {Record<string, string>} tokens */
  async #callOff(st, tokens) {
    let n = 0;
    while (st.cancels.length) {
      const c = st.cancels[0];
      const token = tokens[c.id];
      const base = relayAddress(c.relay);
      if (token && base) {
        await this.#client(base).cancel(c.id, token);
        n++;
      }
      st.cancels.shift();
      delete tokens[c.id];
    }
    return n;
  }

  /**
   * Sends reminders, nearest first. Each id and token is written down before it is sent (choice 8).
   * A change in live mode meanwhile stops this, so the next sync calls off first (choice 3).
   * @param {State} st @param {Record<string, string>} tokens @param {Sub} sub @param {Want[]} list
   */
  async #send(st, tokens, sub, list) {
    if (st.hello?.endpoint !== sub.endpoint) await this.#hello(st, sub, AGAIN);
    const name = await subscriptionName(sub.endpoint);
    for (const w of list) {
      if (w.reuse) continue;
      const id = `${name}.${random(16)}`;
      tokens[id] = random(32);
      st.items[w.m.key] = { id, due: w.m.due, sendAt: w.sendAt, hash: w.hash, scope: w.m.scope, sending: true };
    }
    await this.#save(st, tokens);
    const client = this.#client(st.relay);
    let n = 0;
    for (const w of list) {
      if (this.#dirty) break;
      const item = st.items[w.m.key];
      if (!item?.sending || !st.key) continue;
      try {
        await client.schedule({ endpoint: sub.endpoint, key: st.key, id: item.id.slice(item.id.indexOf('.') + 1), token: tokens[item.id], sendAt: item.sendAt, ttl: TTL_S, payload: await this.#seal(sub, w) });
        delete item.sending;
        n++;
      } catch (e) {
        if (!(e instanceof RelayError) || e.code !== 'refused') throw e;
        // This one, for good: noted, and the others go on.
        delete st.items[w.m.key];
        delete tokens[item.id];
        st.problem = { message: await withoutSecrets(this.store, e.message), at: this.clock.now(), needsYou: false };
      }
    }
    return n;
  }

  /** A reminder as the service worker reads it, padded to one size. @param {Sub} sub @param {Want} w */
  async #seal(sub, w) {
    let body = w.body;
    for (;;) {
      const bytes = utf8(JSON.stringify({ v: 1, key: w.m.key, title: w.title, body, at: w.m.due, scope: w.m.scope, watch: w.m.watch }));
      if (bytes.length < PAD || !body) return encryptPush(sub, bytes, { pad: PAD });
      body = body.slice(0, -20);
    }
  }

  /** The notification that confirms a subscription at the relay, sent at once (choice 6). @param {State} st @param {Sub} sub @param {string} words */
  async #hello(st, sub, words) {
    if (!st.key) return;
    const rand = random(16);
    const payload = await encryptPush(sub, utf8(JSON.stringify({ v: 1, key: `hello|${rand}`, title: 'annai', body: words, test: true })), { pad: PAD });
    await this.#client(st.relay).schedule({ endpoint: sub.endpoint, key: st.key, id: rand, token: random(32), sendAt: this.clock.now(), ttl: 600, payload });
    st.hello = { endpoint: sub.endpoint, at: this.clock.now() };
  }

  /**
   * What a failure means: a new relay key or a gone subscription, subscribe again; passing, try again
   * later with growing waits; otherwise, note it for the user. @param {State} st @param {RelayError} e
   */
  async #trouble(st, e) {
    const now = this.clock.now();
    if (e.code === 'key' || e.code === 'gone') {
      try {
        const key = e.code === 'key' ? await this.#client(st.relay).vapid() : st.key;
        if (!key) throw e;
        await this.source.unsubscribe().catch(() => {});
        const sub = await this.source.subscribe(key);
        st.key = key;
        this.#renewed(st, sub);
        this.#soon();
        return;
      } catch (again) {
        e = again instanceof RelayError ? again : new RelayError(OFF_BY_PHONE, { code: 'refused' });
      }
    }
    // The "notifications are on" never arrived (the relay forgot this phone): another, next time.
    if (e.code === 'unconfirmed' && st.hello && now - st.hello.at > MIN) st.hello = null;
    const message = await withoutSecrets(this.store, e.message);
    if (e.passing) {
      st.problem = { message, at: now, needsYou: false };
      const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(30 * MIN, MIN * 2 ** this.#retries);
      this.#retries++;
      this.#retryTimer = this.clock.set(() => {
        this.#retryTimer = null;
        this.sync().catch((x) => console.warn('push: a sync failed', x));
      }, wait);
      return;
    }
    st.problem = { message, at: now, needsYou: e.code !== 'full' };
  }

  /** @param {string} base */
  #client(base) {
    return relayClient({ base, fetch: this.fetch });
  }

  /** A sync soon: live mode changed. */
  #soon() {
    this.#dirty = true;
    if (this.#soonTimer !== null) return;
    this.#soonTimer = this.clock.set(() => {
      this.#soonTimer = null;
      this.sync().catch((e) => console.warn('push: a sync failed', e));
    }, SOON_MS);
  }

  #tell() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a push listener failed', e);
      }
    }
  }

  /** One piece of work after another; its result or error is the caller's. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  #run(fn) {
    const job = this.#turn.then(fn);
    this.#turn = job.catch(() => {});
    return job;
  }

  /** @returns {Promise<State>} */
  async #read() {
    await ensureDeviceScope(this.store, this.clock.now());
    const st = stateOf(await this.ws.readJSON(SYS_DEVICE, FILE).catch(() => null));
    this.#lastState = JSON.stringify(st);
    return st;
  }

  /** @returns {Promise<Record<string, string>>} */
  async #readTokens() {
    const v = await this.store.tx(['secrets'], 'readonly', (t) => t.getSecret(TOKENS)).catch(() => null);
    /** @type {Record<string, string>} */
    const out = {};
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
    this.#lastTokens = JSON.stringify(out);
    return out;
  }

  /** Writes what changed: the state file, and the tokens' secret. @param {State} st @param {Record<string, string>} tokens */
  async #save(st, tokens) {
    const text = JSON.stringify(st);
    if (text !== this.#lastState) {
      await this.ws.write(SYS_DEVICE, FILE, st, { author: 'system' });
      this.#lastState = text;
    }
    const t = JSON.stringify(tokens);
    if (t !== this.#lastTokens) {
      await this.store.tx(['secrets'], 'readwrite', (x) => (Object.keys(tokens).length ? x.putSecret(TOKENS, { ...tokens }) : x.deleteSecret(TOKENS)));
      this.#lastTokens = t;
    }
  }
}
```

In `sw.js` `SHELL`, after `'/src/core/push/webpush.js',` add `'/src/core/push/mirror.js',` and `'/src/core/push/relay-client.js',`.

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/push-mirror.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/push/relay-client.js src/core/push/mirror.js sw.js test/unit/push-kit.js test/unit/push-mirror.test.js && git commit -m "annai keeps the push relay in step with live mode: each time reminder sent encrypted, called off once said on screen, moved, or its trip removed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: The service worker shows each push, and keeps what happened

**Files:**
- Modify: `sw.js`
- Test: `test/unit/sw-push.test.js`

**Interfaces:**
- Consumes: the payload the mirror seals: `{ v, key, title, body, at, scope, watch, test? }`.
- Produces:
  - `push` → `registration.showNotification(title, { body, tag: key, data: { key, scope, watch, at, test? }, icon })`, always, even for a message it can't read.
  - `notificationclick` → the notification closed, annai focused or opened at `/`.
  - `pushsubscriptionchange` → subscribes again with the old key where the browser gives it.
  - Each puts a `PushNews` into the cache `annai-push` (`/push-news/<t>-<random>`) and posts `{ type: 'annai.push', kind }` to annai's open windows.

- [ ] **Step 1: Write the failing test**

`test/unit/sw-push.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

/** The service worker in a context of its own, with a fake registration, clients and caches. */
async function swKit({ windows = 0 } = {}) {
  const source = await readFile(new URL('sw.js', root), 'utf8');
  /** @type {Record<string, (e: any) => void>} */
  const handlers = {};
  /** @type {any[]} */
  const shown = [];
  /** @type {any[]} */
  const subscribed = [];
  /** @type {string[]} */
  const opened = [];
  /** @type {Map<string, string>} */
  const inbox = new Map();
  /** @type {any[]} */
  const posted = [];
  let focused = 0;
  const clients = Array.from({ length: windows }, () => ({ url: 'https://annai.guide/#/now', focus: async () => { focused++; }, postMessage: (/** @type {any} */ m) => posted.push(m) }));
  const self = {
    location: new URL('https://annai.guide/sw.js'),
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { handlers[type] = fn; },
    registration: {
      showNotification: async (/** @type {string} */ title, /** @type {any} */ o) => { shown.push({ title, ...o }); },
      pushManager: { subscribe: async (/** @type {any} */ o) => { subscribed.push(o); return {}; } },
    },
    clients: { matchAll: async () => clients, openWindow: async (/** @type {string} */ u) => { opened.push(u); return null; } },
  };
  const caches = {
    open: async (/** @type {string} */ name) => ({
      put: async (/** @type {string} */ key, /** @type {Response} */ res) => { inbox.set(`${name} ${key}`, await res.text()); },
    }),
  };
  vm.runInNewContext(source, { self, caches, Request, Response, URL, console });
  /** @param {string} type @param {any} ev */
  const fire = async (type, ev) => {
    /** @type {Promise<unknown> | undefined} */
    let done;
    handlers[type]({ ...ev, waitUntil: (/** @type {Promise<unknown>} */ p) => { done = p; } });
    await done;
  };
  const news = () => [...inbox].filter(([k]) => k.startsWith('annai-push /push-news/')).map(([, v]) => JSON.parse(v));
  return { fire, shown, subscribed, opened, news, posted, focused: () => focused };
}

const REMINDER = { v: 1, key: 'trip-1|w-1', title: 'Big Sur', body: 'Tea time.', at: 1764266400000, scope: 'trip-1', watch: 'w-1' };

test("a push shows its reminder as a notification, and annai hears of it (spec §3: push → notification)", async () => {
  const k = await swKit({ windows: 1 });
  await k.fire('push', { data: { json: () => REMINDER } });
  assert.equal(k.shown.length, 1);
  const [n] = k.shown;
  assert.equal(n.title, 'Big Sur');
  assert.equal(n.body, 'Tea time.');
  assert.equal(n.tag, 'trip-1|w-1');
  assert.deepEqual({ ...n.data }, { key: 'trip-1|w-1', scope: 'trip-1', watch: 'w-1', at: 1764266400000 });
  assert.equal(n.icon, '/assets/icons/icon-192.png');
  const [news] = k.news();
  assert.equal(news.kind, 'shown');
  assert.equal(news.key, 'trip-1|w-1');
  assert.ok(Number.isFinite(news.t));
  assert.deepEqual(k.posted.map((m) => ({ ...m })), [{ type: 'annai.push', kind: 'shown' }]);
});

test('a push it cannot read still shows a notification: Safari takes the subscription away after a few that show none', async () => {
  for (const data of [null, { json: () => { throw new SyntaxError('not JSON'); } }, { json: () => ({ v: 1 }) }, { json: () => 'text' }]) {
    const k = await swKit();
    await k.fire('push', { data });
    assert.equal(k.shown.length, 1);
    assert.equal(k.shown[0].title, 'annai');
    assert.equal(k.shown[0].body, 'annai has a reminder for you. Open annai to see it.');
  }
});

test("tapping it opens annai, after writing the tap down, so a launch that ignores the URL still catches up (spec §11.6)", async () => {
  const none = await swKit();
  let closed = 0;
  const notification = { title: 'Big Sur', body: 'Tea time.', data: { key: 'trip-1|w-1', scope: 'trip-1', watch: 'w-1', at: 1 }, close: () => { closed++; } };
  await none.fire('notificationclick', { notification });
  assert.equal(closed, 1);
  assert.deepEqual(none.opened, ['/']);
  const [news] = none.news();
  assert.deepEqual({ kind: news.kind, key: news.key, scope: news.scope, watch: news.watch, title: news.title, body: news.body }, { kind: 'opened', key: 'trip-1|w-1', scope: 'trip-1', watch: 'w-1', title: 'Big Sur', body: 'Tea time.' });
  const open = await swKit({ windows: 1 });
  await open.fire('notificationclick', { notification: { ...notification, close: () => {} } });
  assert.deepEqual(open.opened, [], 'an open annai is brought forward instead');
  assert.equal(open.focused(), 1);
  assert.deepEqual(open.posted.map((m) => m.kind), ['opened']);
});

test('a renewed subscription: subscribed again with the old key, and annai sends everything again at its next start', async () => {
  const k = await swKit();
  const key = new Uint8Array([4, 1, 2]);
  await k.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } }, newSubscription: null });
  assert.equal(k.subscribed.length, 1);
  assert.equal(k.subscribed[0].userVisibleOnly, true);
  assert.equal(k.subscribed[0].applicationServerKey, key);
  assert.equal(k.news()[0].kind, 'changed');
  const given = await swKit();
  await given.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } }, newSubscription: {} });
  assert.equal(given.subscribed.length, 0, 'the browser made the new one itself');
  assert.equal(given.news()[0].kind, 'changed');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/sw-push.test.js`
Expected: FAIL: `handlers.push is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `sw.js`, after the line `const INBOX = 'annai-inbox';`:

```js
const PUSH_NEWS = 'annai-push';
```

and at the end of `sw.js`:

```js
// A reminder from the push relay (spec §11.6). Every push shows a notification, readable or not:
// Safari takes the subscription away after a few pushes that show none, even with annai open.
sw.addEventListener('push', (event) => {
  event.waitUntil(showReminder(/** @type {any} */ (event).data));
});

/** @param {any} data */
async function showReminder(data) {
  /** @type {any} */
  let m = null;
  try {
    m = data ? data.json() : null;
  } catch {
    m = null;
  }
  const ok = m !== null && typeof m === 'object' && typeof m.body === 'string' && m.body.trim() !== '' && typeof m.key === 'string';
  const title = ok && typeof m.title === 'string' && m.title.trim() ? m.title.slice(0, 120) : 'annai';
  const body = ok ? m.body.slice(0, 500) : 'annai has a reminder for you. Open annai to see it.';
  /** @type {Record<string, unknown>} */
  const info = ok ? { key: m.key.slice(0, 300), scope: String(m.scope ?? ''), watch: String(m.watch ?? ''), at: Number(m.at) || 0, ...(m.test ? { test: true } : {}) } : {};
  await sw.registration.showNotification(title, { body, tag: typeof info.key === 'string' ? info.key : 'annai-reminder', data: info, icon: '/assets/icons/icon-192.png' });
  await keepNews({ kind: 'shown', ...info, t: Date.now() });
}

// Tapping one opens annai, whose catch-up says "opened the reminder for …" (spec §11.6). The tap is
// written down first: on iPhone the app may open at its start URL, and a message may not arrive.
sw.addEventListener('notificationclick', (event) => {
  const e = /** @type {any} */ (event);
  e.notification.close();
  e.waitUntil(openReminder(e.notification));
});

/** @param {any} n */
async function openReminder(n) {
  const info = n.data && typeof n.data === 'object' ? n.data : {};
  await keepNews({ kind: 'opened', ...info, title: String(n.title ?? ''), body: String(n.body ?? ''), t: Date.now() });
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((c) => new URL(c.url).origin === sw.location.origin);
  if (open) {
    await open.focus().catch(() => {});
    return;
  }
  await sw.clients.openWindow('/');
}

// Chrome and Firefox renew a subscription themselves; annai sends its reminders to the new one next time it runs.
sw.addEventListener('pushsubscriptionchange', (event) => {
  /** @type {any} */ (event).waitUntil(renewSubscription(/** @type {any} */ (event)));
});

/** @param {any} event */
async function renewSubscription(event) {
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!event.newSubscription && key) {
    try {
      await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch {
      // annai notices at its next start, and asks
    }
  }
  await keepNews({ kind: 'changed', t: Date.now() });
}

/** Keeps what happened until annai reads it (6b choice 10), and tells an open annai now. @param {Record<string, unknown>} news */
async function keepNews(news) {
  try {
    const box = await caches.open(PUSH_NEWS);
    await box.put(`/push-news/${Date.now()}-${Math.random().toString(36).slice(2)}`, new Response(JSON.stringify(news), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    // storage full: catch-up still covers the reminder
  }
  for (const c of await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'annai.push', kind: news.kind });
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/sw-push.test.js test/unit/sw-shell.test.js`
Expected: PASS: 4 new tests, and the shell's.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add sw.js test/unit/sw-push.test.js && git commit -m "The service worker shows every push as a notification, opens annai on a tap, and writes down what happened for annai to read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: annai follows the push relay: the phone's subscription, the news, trip removal, the trace

**Files:**
- Create: `src/ui/push.js`
- Modify: `src/app/main.js`, `src/ui/screens/trip.js`, `src/core/scopes.js`, `src/core/archive.js`, `src/ui/screens/trace.js`, `src/ui/shell.js` (`push` in ctx), `sw.js` (`SHELL`)
- Test: `test/unit/push-secrets.test.js`, and in `test/unit/ui-pure.test.js` the trace lines

**Interfaces:**
- Consumes: `PushMirror` (Task 2), `live.pushNews`, `live.forget` (Task 1), the service worker's news (Task 3).
- Produces:
  - `browserSource(): Source` (with the `localStorage['annai.pushSubscription']` test hook, choice 16); `takeNews(): Promise<PushNews[]>`; `onPushMessage(fn: () => void)`; `closeNotifications(keys: string[]): Promise<void>`.
  - `isDeviceSecret(id: string): boolean` in `src/core/scopes.js`: `backup:` and `push:` secrets, which no archive holds.
  - The Trace screen's kind "Notifications": `push.sync`, `push.shown`, `push.opened`.
  - `ctx.push` (the mirror) on every screen.

- [ ] **Step 1: Write the failing tests**

`test/unit/push-secrets.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, isDeviceSecret } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS, MANIFEST_NAME } from '../../src/core/archive.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8, text } from '../../src/core/bytes.js';

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  return { store, ws };
}

test("the relay's cancel tokens never leave this device: not even an encrypted Backup with API keys holds them", async () => {
  const a = await device();
  await a.store.tx(['secrets'], 'readwrite', async (t) => {
    await t.putSecret('push:tokens', { 'x.y': 'cancel-token-never-exported-01' });
    await t.putSecret('endpoint:e', 'sk-model-key-0001');
  });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: { ...PRESETS.backup }, secrets: true, passphrase: 'correct horse battery', app: 'test' });
  const b = await device();
  const result = await importArchive(b.store, await openArchive(blob, 'correct horse battery'), { secrets: true });
  assert.equal(result.secrets, 1);
  assert.deepEqual(await b.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), ['endpoint:e']);
  assert.equal(isDeviceSecret('push:tokens'), true);
  assert.equal(isDeviceSecret('backup:bt-1'), true);
  assert.equal(isDeviceSecret('endpoint:e'), false);
});

test("an archive that holds push tokens anyway (made elsewhere) doesn't bring them in", async () => {
  const a = await device();
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: { ...PRESETS.backup }, app: 'test' });
  const entries = await readZip(blob);
  const manifest = JSON.parse(text(/** @type {Uint8Array} */ (entries.get(MANIFEST_NAME))));
  const body = utf8(JSON.stringify([{ id: 'push:tokens', value: { 'x.y': 'cancel-token-from-elsewhere-01' } }, { id: 'endpoint:y', value: 'sk-model-key-0002' }]));
  manifest.extras.push({ name: 'system/secrets.json', hash: await sha256Hex(body) });
  manifest.secrets = 'system/secrets.json';
  const zip = new ZipWriter();
  for (const [name, bytes] of entries) if (name !== MANIFEST_NAME) await zip.add(name, bytes);
  await zip.add('system/secrets.json', body);
  await zip.add(MANIFEST_NAME, utf8(JSON.stringify(manifest)));
  const b = await device();
  await importArchive(b.store, await openArchive(zip.finish()), { secrets: true });
  assert.deepEqual(await b.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), ['endpoint:y']);
});
```

In `test/unit/ui-pure.test.js`, after the `backup` trace line test, add:

```js
test('Trace lines for notifications', () => {
  assert.equal(traceSummary({ type: 'push.sync', data: { relay: 'push.annai.guide', sent: 2, calledOff: 1, waiting: 5 } }), 'push.annai.guide · 2 sent, 1 called off · 5 waiting');
  assert.equal(traceSummary({ type: 'push.sync', data: { relay: 'push.annai.guide', sent: 0, calledOff: 0, waiting: 5, error: "annai couldn't reach the relay." } }), "push.annai.guide · 0 sent, 0 called off · 5 waiting · annai couldn't reach the relay.");
  assert.equal(traceSummary({ type: 'push.shown', data: { watch: 'w-1', at: 1 } }), 'notification shown · w-1');
  assert.equal(traceSummary({ type: 'push.opened', data: { watch: 'plan:tea:coming-up', at: 1 } }), 'notification opened · plan:tea:coming-up');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/push-secrets.test.js test/unit/ui-pure.test.js`
Expected: FAIL: `isDeviceSecret` isn't exported; the trace lines are empty.

- [ ] **Step 3: Write the implementation**

`src/core/scopes.js`, after `SYS_DEVICE`:

```js
/** Secrets that belong to this device alone: backup places' sign-ins and the push relay's cancel tokens. No archive holds them. @param {string} id */
export const isDeviceSecret = (id) => id.startsWith('backup:') || id.startsWith('push:');
```

`src/core/archive.js`: import `isDeviceSecret` from `./scopes.js` instead of `BACKUP_SECRET_PREFIX`, and use it in both places:

```js
      // This device's own sign-ins and tokens stay on it (spec §12.4, §11.6): their screens promise so.
      for (const id of await t.listSecretIds()) if (!isDeviceSecret(id)) out.push({ id, value: await t.getSecret(id) });
```

```js
    // Never this device's own secrets, even from an archive made before annai left them out.
    .filter((/** @type {any} */ s) => typeof s?.id === 'string' && !isDeviceSecret(s.id));
```

`src/ui/screens/trace.js`: in `KINDS`, after `Backups`, `Notifications: ['push.sync', 'push.shown', 'push.opened'],`; in `traceSummary`, before the `decide` line:

```js
  if (e.type === 'push.sync') return `${d.relay} · ${d.sent ?? 0} sent, ${d.calledOff ?? 0} called off · ${d.waiting ?? 0} waiting${d.error ? ` · ${cut(d.error)}` : ''}`;
  if (e.type === 'push.shown') return `notification shown · ${d.watch}`;
  if (e.type === 'push.opened') return `notification opened · ${d.watch}`;
```

`src/ui/push.js`:

```js
import { fromBase64Url, ownBuffer } from '../core/bytes.js';
import { platform, isStandalone } from './platform.js';

/**
 * The phone's side of notifications (spec §11.6): its push subscription and permission, what the
 * service worker saw, and closing a notification annai already said. Browser only.
 * @typedef {import('../core/push/mirror.js').Source} Source
 * @typedef {import('../core/push/mirror.js').Sub} Sub
 */

/** The service worker's news cache (sw.js PUSH_NEWS). */
export const PUSH_NEWS = 'annai-push';
/** The end-to-end tests' stand-in subscription (6b choice 16). */
const FAKE = 'annai.pushSubscription';

/** The service worker's registration, or a plain error after 10 s. @returns {Promise<ServiceWorkerRegistration>} */
function registration() {
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error("This browser can't run annai's offline service, which shows notifications."));
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("annai's offline service isn't running yet. Try again in a moment.")), 10_000)),
  ]);
}

/** @param {PushSubscription} s @returns {Sub} */
function subOf(s) {
  const p256dh = s.getKey('p256dh');
  const auth = s.getKey('auth');
  if (!p256dh || !auth) throw new Error("The phone's push subscription has no keys. Turn notifications off and on again.");
  return { endpoint: s.endpoint, p256dh: new Uint8Array(p256dh), auth: new Uint8Array(auth) };
}

/** The stand-in subscription, when a test set one. @returns {Sub | null} */
function fake() {
  try {
    const v = JSON.parse(localStorage.getItem(FAKE) ?? 'null');
    const p256dh = fromBase64Url(v?.p256dh);
    const auth = fromBase64Url(v?.auth);
    return typeof v?.endpoint === 'string' && p256dh && auth ? { endpoint: v.endpoint, p256dh, auth } : null;
  } catch {
    return null;
  }
}

/** @returns {Source} */
export function browserSource() {
  const stand = fake();
  let dropped = false;
  return {
    supported() {
      if (stand) return 'yes';
      // On iPhone, push works only in the Home Screen app (Apple, iOS 16.4+).
      if (platform() === 'ios' && !isStandalone()) return 'install';
      return 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined' ? 'yes' : 'no';
    },
    permission() {
      if (stand) return 'granted';
      return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    },
    // Called first thing in the tap: iOS asks only during a user activation (6b choice 11).
    ask() {
      if (stand) return Promise.resolve('granted');
      if (typeof Notification === 'undefined') return Promise.resolve('denied');
      return Promise.resolve(Notification.requestPermission());
    },
    async get() {
      if (stand) return dropped ? null : stand;
      const s = await (await registration()).pushManager.getSubscription();
      return s ? subOf(s) : null;
    },
    async subscribe(key) {
      if (stand) {
        dropped = false;
        return stand;
      }
      const raw = fromBase64Url(key);
      if (!raw) throw new Error("The relay's key isn't one annai can use.");
      return subOf(await (await registration()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: ownBuffer(raw) }));
    },
    async unsubscribe() {
      if (stand) {
        dropped = true;
        return;
      }
      const s = await (await registration()).pushManager.getSubscription();
      await s?.unsubscribe();
    },
  };
}

/** What the service worker saw since annai last looked, oldest first; read once (6b choice 10). @returns {Promise<any[]>} */
export async function takeNews() {
  if (typeof caches === 'undefined') return [];
  const box = await caches.open(PUSH_NEWS);
  /** @type {any[]} */
  const out = [];
  for (const req of await box.keys()) {
    const res = await box.match(req);
    try {
      const v = await res?.json();
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // unreadable: dropped
    }
    await box.delete(req);
  }
  return out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
}

/** Hears the service worker's "something happened" while annai is open. @param {() => void} fn */
export function onPushMessage(fn) {
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data && typeof e.data === 'object' && e.data.type === 'annai.push') fn();
  });
}

/** Closes the notifications for reminders annai already said on screen (6b choice 3). @param {string[]} keys */
export async function closeNotifications(keys) {
  if (!keys.length) return;
  for (const n of await (await registration()).getNotifications()) if (keys.includes(n.tag)) n.close();
}
```

`src/app/main.js`:

```js
import { PushMirror } from '../core/push/mirror.js';
import { browserSource, takeNews, onPushMessage, closeNotifications } from '../ui/push.js';
```

Replace `const live = new Live({ store, ws, registry, agent });` with:

```js
  // Notifications for a closed annai (spec §11.6): what the service worker saw is read at each
  // catch-up; the mirror keeps the push relay in step with live mode.
  /** @type {PushMirror | null} */
  let push = null;
  const news = async () => {
    const list = await takeNews().catch(() => []);
    push?.delivered(list);
    return list;
  };
  const live = new Live({ store, ws, registry, agent, news });
  /** @type {any[]} cards from before the shell is up */
  const early = [];
  let pushCard = (/** @type {any} */ n) => { early.push(n); };
  push = new PushMirror({ store, ws, live, source: browserSource(), notice: (n) => pushCard(n) });
```

Replace `live.start().catch((e) => console.warn('Live mode could not start', e));` with:

```js
  live.start().then(() => push?.start()).catch((e) => console.warn('Live mode could not start', e));
```

Pass `push` to `startShell` (`{ …, backups, push, version: VERSION }`), and after `startShell`:

```js
  pushCard = (n) => shell.notices.card({ tone: 'warn', title: n.title, body: n.body, actions: [{ label: 'Notifications', run: () => { location.hash = '#/notifications'; } }] });
  for (const n of early.splice(0)) pushCard(n);
  // Open and on screen: the service worker's news now (a notification annai already said is closed).
  onPushMessage(async () => {
    if (document.visibilityState !== 'visible') return; // read at the catch-up
    const list = await takeNews().catch(() => []);
    if (!list.length) return;
    push?.delivered(list);
    closeNotifications(await live.pushNews(list)).catch(() => {});
  });
  addEventListener('online', () => { push?.sync().catch(() => {}); });
```

`src/ui/shell.js`: in `startShell`'s parameter type, add `push?: any`.

`src/ui/screens/trip.js`: after `const { bytes: freed } = await removeTrip(ctx.store, id);`:

```js
    // Its reminders leave live mode, and so the push relay, at once (spec §4.9).
    await ctx.live?.forget(id);
```

In `sw.js` `SHELL`, add `'/src/ui/push.js',` after `'/src/ui/plugin-updates.js',`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/push-secrets.test.js test/unit/ui-pure.test.js test/unit/backup-targets.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui/push.js src/app/main.js src/ui/shell.js src/ui/screens/trip.js src/core/scopes.js src/core/archive.js src/ui/screens/trace.js sw.js test/unit/push-secrets.test.js test/unit/ui-pure.test.js && git commit -m "annai follows the push relay from start: the phone's subscription, what its notifications did, a removed trip's reminders called off, and Trace → Notifications

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: Settings → Notifications

**Files:**
- Create: `src/ui/screens/notifications.js`, `test/e2e/push-helpers.js`
- Modify: `src/ui/shell.js` (route), `src/ui/router.js` (comment), `src/ui/screens/settings.js` (a section), `sw.js` (`SHELL`)
- Test: `test/e2e/notifications.spec.js`

**Interfaces:**
- Consumes: `ctx.push` (`status`, `turnOn`, `turnOff`, `setRelay`, `test`, `source.ask`); `platform()`.
- Produces: `#/notifications`; `renderNotifications(ctx)`; for the end-to-end tests, `pushKit()` in `test/e2e/push-helpers.js` → `{ service, relay, sub, at(ms), waiting(), pushed(), stop() }`, and `fakeSubscription(page, sub)`, `notificationsOn(page, relayOrigin)`.

- [ ] **Step 1: Write the failing test**

`test/e2e/push-helpers.js`:

```js
import { expect } from '@playwright/test';
import { startRelay } from '../../relay/serve.mjs';
import { newVapidJwk } from '../../relay/src/vapid.js';
import { startPushService } from '../fakes/push-service.js';

export const APP = 'http://127.0.0.1:8790';

/**
 * The relay (relay/serve.mjs, in memory) on a clock that runs with real time plus what the test
 * adds, sending to a stand-in push service; and a subscription there for the page.
 */
export async function pushKit() {
  const service = await startPushService();
  let ahead = 0;
  const relay = await startRelay({ origins: [APP], jwk: await newVapidJwk(), extraPushOrigins: [service.origin], now: () => Date.now() + ahead, timers: false });
  const sub = await service.subscribe(relay.key);
  return {
    service, relay, sub,
    /** Moves the relay's clock on to t (ms), and sends what came due. @param {number} t */
    async at(t) {
      ahead = Math.max(ahead, t - Date.now());
      await relay.env.RELAY.runDue();
    },
    /** @returns {Promise<any[]>} */
    waiting: () => relay.env.RELAY.waiting(),
    /** What the push service delivered, opened. */
    pushed: () => service.received.filter((r) => r.status === 201).map((r) => JSON.parse(String(r.plaintext))),
    async stop() {
      await relay.close();
      await service.stop();
    },
  };
}

/** The page uses the stand-in subscription (6b choice 16). @param {import('@playwright/test').Page} page @param {{ endpoint: string, p256dh: Uint8Array, auth: Uint8Array }} sub */
export async function fakeSubscription(page, sub) {
  const s = { endpoint: sub.endpoint, p256dh: Buffer.from(sub.p256dh).toString('base64url'), auth: Buffer.from(sub.auth).toString('base64url') };
  await page.addInitScript((v) => { try { localStorage.setItem('annai.pushSubscription', JSON.stringify(v)); } catch { /* storage blocked */ } }, s);
}

/** Settings → Notifications: the relay's address, then on. @param {import('@playwright/test').Page} page @param {string} relay */
export async function notificationsOn(page, relay) {
  await page.goto('/#/notifications');
  await page.getByLabel('Relay address').fill(relay);
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(page.getByLabel('Relay address')).toHaveValue(relay);
  await page.getByRole('button', { name: 'Turn on notifications' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^On · / })).toBeVisible({ timeout: 20_000 });
}
```

`test/e2e/notifications.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker } from './helpers.js';
import { pushKit, fakeSubscription, notificationsOn } from './push-helpers.js';

test('iPhone in a Safari tab: notifications need the Home Screen app, and the screen says how', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'the iPhone case');
  await openApp(page, '#/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText(/work only in the Home Screen app/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on notifications' })).toHaveCount(0);
});

test('Settings → Notifications: what the relay learns, the address, on, a test, and off', async ({ page }) => {
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    await openApp(page, '#/settings');
    await waitForServiceWorker(page);
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByLabel('Relay address')).toHaveValue('https://push.annai.guide');
    const learns = page.getByRole('region', { name: 'What the relay learns' });
    await expect(learns).toContainText("can't read it");
    await expect(learns).toContainText('how many are waiting');
    await expect(learns).toContainText('never leave the phone');
    await page.getByLabel('Relay address').fill('ftp://push.example');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByRole('alert')).toContainText('must start with https://');
    await notificationsOn(page, kit.relay.origin);
    await expect.poll(() => kit.pushed().length).toBe(1);
    expect(kit.pushed()[0]).toMatchObject({ title: 'annai', test: true });
    await page.getByRole('button', { name: 'Send a test notification' }).click();
    await expect(page.locator('.toast', { hasText: 'in about 15 seconds' })).toBeVisible();
    await kit.at(Date.now() + 16_000);
    expect(kit.pushed().at(-1)?.body).toMatch(/^A test/);
    await page.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Off\.$/ })).toBeVisible();
    expect(await kit.waiting()).toEqual([]);
  } finally {
    await kit.stop();
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/notifications.spec.js`
Expected: FAIL: no "Notifications" heading (the route opens Trips).

- [ ] **Step 3: Write the implementation**

`src/ui/screens/notifications.js`:

```js
import { h, field } from '../dom.js';
import { platform } from '../platform.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/** Where to allow notifications, for this phone (spec §17 rule 3). @param {'ios' | 'android' | 'desktop'} where */
export function deniedHelp(where) {
  if (where === 'ios') return 'Notifications are turned off for annai on this iPhone. Turn them on in Settings → Notifications → annai, then come back here.';
  if (where === 'android') return "Notifications are blocked for annai. Touch and hold annai's icon, then App info → Notifications, and allow them; then come back here.";
  return "Notifications are blocked for this site. Allow them in the browser's site settings (the icon beside the address), then come back here.";
}

/** @param {{ on: boolean, waiting: number }} st */
const statusText = (st) => (st.on ? `On · ${st.waiting === 1 ? '1 reminder' : `${st.waiting} reminders`} waiting at the relay.` : 'Off.');

/**
 * Settings → Notifications (spec §11.6, §11.7): reminders for a closed annai through the push relay,
 * with plain words on what the relay learns.
 * @param {any} ctx
 */
export async function renderNotifications(ctx) {
  const push = ctx.push;
  const st = await push.status();
  const where = platform();
  const status = h('p', { class: 'sub', role: 'status', text: statusText(st) });
  const alert = h('p', { class: 'error', role: 'alert', hidden: !st.problem, text: st.problem?.message ?? '' });
  /** @param {string} text */
  const fail = (text) => {
    alert.textContent = text;
    alert.hidden = false;
  };
  const address = h('input', { id: 'push-relay', type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', value: st.relay });
  const save = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      save.disabled = true;
      try {
        await push.setRelay(address.value);
        ctx.notices.toast('Saved');
        ctx.render();
      } catch (e) {
        fail(String(/** @type {any} */ (e)?.message ?? e));
      } finally {
        save.disabled = false;
      }
    },
  }, 'Save address');
  /** @type {any[]} */
  const acts = [];
  /** @type {any} */
  let help = null;
  if (st.supported === 'install') {
    help = h('p', { text: 'On iPhone, notifications work only in the Home Screen app. In Safari, tap Share, then Add to Home Screen, and open annai from your Home Screen.' });
  } else if (st.supported === 'no') {
    help = h('p', { text: "This browser can't show annai's notifications. On iPhone they need iOS 16.4 or later, in the Home Screen app." });
  } else if (st.on) {
    const off = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        off.disabled = true;
        try {
          await push.turnOff();
          ctx.notices.toast('Notifications are off.');
          ctx.render();
        } catch (e) {
          fail(String(/** @type {any} */ (e)?.message ?? e));
          off.disabled = false;
        }
      },
    }, 'Turn off');
    const trial = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        trial.disabled = true;
        try {
          await push.test();
          ctx.notices.toast('A test notification comes in about 15 seconds. Lock the phone to see it arrive.');
        } catch (e) {
          fail(String(/** @type {any} */ (e)?.message ?? e));
        } finally {
          trial.disabled = false;
        }
      },
    }, 'Send a test notification');
    acts.push(off, trial);
  } else {
    const on = h('button', {
      class: 'btn pri', type: 'button',
      onclick: () => {
        // First thing in the tap, before anything is awaited: iOS asks only during a user activation (6b choice 11).
        const asking = push.source.ask();
        on.disabled = true;
        alert.hidden = true;
        status.textContent = 'Asking…';
        asking.then(async (/** @type {string} */ p) => {
          if (p !== 'granted') {
            status.textContent = statusText(st);
            fail(deniedHelp(where));
            on.disabled = false;
            return;
          }
          status.textContent = 'Turning them on…';
          try {
            await push.turnOn(address.value);
            ctx.notices.toast('Notifications are on. A first one comes now.');
            ctx.render();
          } catch (e) {
            status.textContent = statusText(st);
            fail(String(/** @type {any} */ (e)?.message ?? e));
            on.disabled = false;
          }
        }, () => {
          fail(deniedHelp(where));
          on.disabled = false;
        });
      },
    }, 'Turn on notifications');
    acts.push(on);
    if (st.permission === 'denied') help = h('p', { class: 'sub', text: deniedHelp(where) });
  }
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Notifications' }),
    h('p', { class: 'sub', text: "Shiori's reminders for a time, and the plan's \"coming up\" and \"leave soon\", reach you as notifications while annai is closed. Tapping one opens annai, and Shiori catches up." }),
    status, alert, help,
    acts.length ? h('div', { class: 'acts' }, ...acts) : null,
    section('Relay', field('Relay address', address), h('div', { class: 'acts' }, save),
      h('p', { class: 'sub', text: "Reminders go through annai's relay, push.annai.guide, unless you run your own: its code is in annai's source, under relay/." })),
    section('What the relay learns', h('ul', { class: 'where' },
      h('li', { text: "annai encrypts every reminder on this phone, and makes each the same size: the relay can't read it, or tell a long one from a short one." }),
      h('li', { text: "It learns this phone's push address (at Apple, Google or Mozilla, whose service delivers it), when each reminder is due, and how many are waiting. Like any server, it sees the internet address the phone connects from." }),
      h('li', { text: 'Reminders about places (arriving, leaving, nearby) never leave the phone. A "leave soon" reminder\'s time is worked out from where you were when annai last looked, so it tells roughly how far away you were to someone who also knew your plan; the relay doesn\'t.' }),
      h('li', { text: 'Each reminder is deleted at the relay once it is sent, or when you cancel it, turn notifications off, or remove its trip.' }),
      h('li', { text: 'With annai open on screen, annai says a reminder itself, and the relay\'s copy is called off: you never get it twice.' }))),
    h('p', { class: 'sub', text: 'Every request to the relay is in Trace, under System · This device.' }));
}
```

`src/ui/shell.js`: import `renderNotifications` and add `notifications: renderNotifications` to `SCREENS`.

`src/ui/router.js`: add `"#/notifications"` to the doc comment's list.

`src/ui/screens/settings.js`, after the Voice section:

```js
    section('Notifications', h('p', { class: 'sub', text: 'Reminders while annai is closed, through the push relay, and what it learns.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/notifications' }, 'Notifications'))),
```

In `sw.js` `SHELL`, add `'/src/ui/screens/notifications.js',` after `'/src/ui/screens/now.js',`.

- [ ] **Step 4: Run it to see it pass**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/notifications.spec.js`
Expected: PASS in both browsers (the iPhone-tab test runs in WebKit only).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui/screens/notifications.js src/ui/shell.js src/ui/router.js src/ui/screens/settings.js sw.js test/e2e/push-helpers.js test/e2e/notifications.spec.js && git commit -m "Settings → Notifications: on and off, the relay's address, a test, and plain words on what the relay learns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 6: Done: a reminder reaches the push service, opens a catch-up wake, and never comes twice

**Files:**
- Test: `test/e2e/push.spec.js`
- Create: `docs/testing/device-checklist-m6.md`
- Modify: `README.md`, `docs/superpowers/specs/2026-10-15-annai-design.md` (§11.7, one line), `scripts/size.mjs`

**Interfaces:**
- Consumes: everything above; `test/e2e/helpers.js` (`openApp`, `waitForServiceWorker`, `startModelServer`, `addEndpoint`, `anthropicToolReply`, `startTrip`, `writeRecords`, `filterTrace`); `test/e2e/push-helpers.js`.
- Produces: the milestone's proof, and the user's checklist.

- [ ] **Step 1: Write the failing test**

`test/e2e/push.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, startTrip, writeRecords, filterTrace } from './helpers.js';
import { pushKit, fakeSubscription, notificationsOn, APP } from './push-helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };
/** An ISO time ms after t, in UTC, to the second. @param {number} t @param {number} ms */
const plus = (t, ms) => new Date(t + ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** Shiori's model on a stand-in, and a trip. @param {any} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  return startTrip(page, 'Big Sur');
}

/** Types to Shiori. @param {any} page @param {string} words */
async function say(page, words) {
  await page.getByRole('button', { name: 'Type' }).click();
  await page.getByLabel('Message to Shiori').fill(words);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('a reminder Shiori sets waits at the relay, encrypted, reaches the push service at its time, and opening it starts a catch-up wake (spec §11.6, §20 row 6)', async ({ page, context, browserName }) => {
  const start = Date.now();
  const due = Date.parse(plus(start, 4 * 60_000));
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: plus(start, 4 * 60_000) }, fallback: 'Call Grandma.' } }, sleep])),
      sse(anthropicToolReply([sleep])),
    ],
  });
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    if (browserName === 'chromium') await context.grantPermissions(['notifications']);
    const trip = await setUp(page, llm.origin);
    await notificationsOn(page, kit.relay.origin);
    await page.goto('/#/now');
    await say(page, 'Remind me to call Grandma.');
    await expect.poll(async () => (await kit.waiting()).length).toBe(1);
    const [w] = await kit.waiting();
    expect(w.sendAt).toBe(due + 30_000);
    await kit.at(w.sendAt);
    const reminder = kit.pushed().at(-1);
    expect(reminder).toMatchObject({ title: 'Big Sur', body: 'Call Grandma.', scope: trip });
    expect(kit.service.received.at(-1)?.bytes).toBe(3174);
    if (browserName === 'chromium') {
      // The phone's side: the push reaches the service worker, which shows it.
      const cdp = await context.newCDPSession(page);
      const reg = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
        const r = e.registrations.find((x) => x.scopeURL === `${APP}/` && !x.isDeleted);
        if (r) resolve(r.registrationId);
      }));
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: APP, registrationId: /** @type {string} */ (await reg), data: JSON.stringify(reminder) });
      await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.body))).toContain('Call Grandma.');
    }
    // Opening it (no browser lets a test tap a notification): the tap as the service worker writes it down.
    await page.evaluate(async (r) => {
      const box = await caches.open('annai-push');
      await box.put(`/push-news/${Date.now()}-tap`, new Response(JSON.stringify({ kind: 'opened', key: r.key, scope: r.scope, watch: r.watch, at: r.at, title: r.title, body: r.body, t: Date.now() })));
    }, reminder);
    await page.reload();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    const wake = JSON.stringify(llm.bodies('/b/v1/messages')[1]);
    expect(wake).toContain('Catch-up: ');
    expect(wake).toContain('The user opened the reminder \\"Call Grandma.\\" from its notification at');
    // Every relay request is in the trace, and no token or key is anywhere in annai's records.
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Web' });
    await expect(page.locator('ol.trace .d', { hasText: /^push relay · POST http:\/\/127\.0\.0\.1:\d+\/v1\/schedule · 201/ }).first()).toBeVisible();
    const leaked = await page.evaluate(async (keys) => {
      const load = (/** @type {string} */ url) => import(url);
      const { createIdbStore } = await load('/src/core/store-idb.js');
      const store = await createIdbStore();
      const tokens = Object.values((await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('push:tokens'))) ?? {});
      let all = '';
      for (const s of await store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.listScopes())) all += JSON.stringify(await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(s.id)));
      // Every stored content, every file's history included.
      await store.tx(['blobs'], 'readonly', async (/** @type {any} */ t) => {
        for (const b of await t.listBlobs()) all += new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0)));
      });
      store.close();
      return [...tokens, ...keys].filter((k) => all.includes(String(k)));
    }, [Buffer.from(kit.sub.p256dh).toString('base64url'), Buffer.from(kit.sub.auth).toString('base64url')]);
    expect(leaked).toEqual([]);
  } finally {
    await kit.stop();
    await llm.stop();
  }
});

test('with annai open, a reminder that comes due is said on the phone and called off at the relay: no second one', async ({ page }) => {
  const start = Date.now();
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: plus(start, 45_000) }, fallback: 'Stretch.' } }, sleep])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Time to stretch.' } }, sleep])),
    ],
  });
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    await setUp(page, llm.origin);
    await notificationsOn(page, kit.relay.origin);
    await page.goto('/#/now');
    await say(page, 'Remind me to stretch.');
    await expect.poll(async () => (await kit.waiting()).length).toBe(1);
    await expect.poll(() => llm.bodies('/b/v1/messages').length, { timeout: 70_000 }).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Stretch.');
    await expect.poll(async () => (await kit.waiting()).length, { timeout: 15_000 }).toBe(0);
    await kit.at(Date.parse(plus(start, 45_000)) + 60_000);
    expect(kit.pushed().filter((p) => !p.test)).toEqual([]);
  } finally {
    await kit.stop();
    await llm.stop();
  }
});

test("a plan item moved moves its reminder at the relay; removing the trip calls it off (spec §11.6, §4.9)", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': sse(anthropicToolReply([sleep])) });
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    const trip = await setUp(page, llm.origin);
    const start = Date.now();
    await writeRecords(page, trip, { write: { '/plan/tea.json': { id: 'tea', title: 'Tea at the inn', fixed: true, start: { at: plus(start, 60 * 60_000), tz: 'UTC' } } } });
    await page.reload();
    await notificationsOn(page, kit.relay.origin);
    await expect.poll(async () => (await kit.waiting()).map((x) => x.sendAt)).toEqual([Date.parse(plus(start, 45 * 60_000)) + 30_000]);
    await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
    await writeRecords(page, trip, { patch: { '/plan/tea.json': { start: { at: plus(start, 90 * 60_000), tz: 'UTC' } } } });
    await page.reload();
    await expect.poll(async () => (await kit.waiting()).map((x) => x.sendAt), { timeout: 15_000 }).toEqual([Date.parse(plus(start, 75 * 60_000)) + 30_000]);
    await page.getByRole('button', { name: 'Remove trip' }).click();
    await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
    await expect.poll(async () => (await kit.waiting()).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await kit.stop();
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run it to see it fail, then pass**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/push.spec.js`
Expected: on this branch as built through Task 5, PASS. These tests prove the pieces work together. If one fails, it is a finding in Tasks 1–5: debug it there (superpowers:systematic-debugging), with a unit test that fails first.

- [ ] **Step 3: The docs**

`docs/testing/device-checklist-m6.md`:

```markdown
# Device checklist: milestone 6 (push relay)

Milestone 6's "Done when": a reminder arrives on a locked iPhone and opens a catch-up wake. This is
that test, on an iPhone (iOS 16.4 or later) and an Android phone, with annai installed to the Home
Screen and served over HTTPS, and a model set up.

## The relay

Before the relay is deployed, use the one in Node on the machine that serves annai to the phones
(`relay/README.md`, "A device test before deploying"):

    node relay/serve.mjs --port 8796 --origin https://<machine>.<tailnet>.ts.net:8792
    tailscale serve --bg --https=8797 http://127.0.0.1:8796

Once it is deployed, use `https://push.annai.guide` (the default).

## Turning notifications on (both phones)
- [ ] iPhone, annai in a Safari tab: Settings → Notifications says notifications work only in the Home Screen app, and how to add it.
- [ ] From the Home Screen app: Settings → Notifications → Relay address (the tailnet one, or leave the default) → Save address → Turn on notifications. The phone asks once; allow.
- [ ] Within seconds, a notification: "Notifications are on. Reminders come like this while annai is closed." The screen says "On · 0 reminders waiting at the relay."
- [ ] Refuse once, on one phone (turn off, then on, and choose Don't Allow): the screen says where to allow it, and the words are right for that phone.
- [ ] Send a test notification, then lock the phone at once: it arrives on the lock screen about 15 seconds after the tap.

## A reminder while annai is closed (the "Done when")
- [ ] Ask Shiori: "Remind me in 5 minutes to check the parking meter." Settings → Notifications: "1 reminder waiting".
- [ ] Close annai fully (swipe it away), lock the phone, wait.
- [ ] The notification arrives on the locked phone, about 30 seconds after the time: the trip's name, and "check the parking meter" in Shiori's words. Note how many seconds late it was.
- [ ] Tap it. annai opens and Shiori catches up: she knows you opened the reminder, and that it was shown (Trace → Notifications: push.shown and push.opened; Trace → Conversation: the catch-up wake says "The user opened the reminder …").
- [ ] Same again, but with annai in the background (another app open) rather than closed: the same notification, the same catch-up when you tap it.
- [ ] A plan reminder: a fixed plan item an hour ahead with no place. Close annai; "In 15 min: …" arrives 15 minutes before it.

## Cancelling and changing
- [ ] Ask for a reminder in 10 minutes, then ask Shiori to cancel it. Close annai and wait 12 minutes: nothing arrives.
- [ ] Move a plan item later (Plan screen, or ask Shiori). Its "coming up" arrives at the new time, not the old.
- [ ] A trip with a reminder waiting: remove the trip. Nothing arrives for it.
- [ ] Turn notifications off: "0 reminders waiting", and no reminder arrives.

## No second reminder while annai is open
- [ ] With annai open on screen (live mode on, or Now), let a reminder come due. Shiori says it on the phone, and no notification follows in the next minute.
- [ ] Same with the screen kept on in the car (Driving): no notification after Shiori's reminder.

## Android
- [ ] Note what Android shows: the notification's title, text and icon; whether it appears on the lock screen; whether tapping it opens annai or Chrome first.
- [ ] Android with annai in the background but not closed: the notification arrives, and the catch-up follows the tap.

## iPhone specifics
- [ ] Focus mode on: the notification follows the Focus settings (held or allowed).
- [ ] After a phone restart, notifications still arrive (no need to turn them on again). If they don't, note it: annai should have shown a card saying how to turn them back on.
- [ ] After a week without using annai, a reminder still arrives.

## The relay's privacy
- [ ] Trace, System · This device: each request to the relay is a web request ("push relay", a URL and a status); no token or key appears in any of them.
```

`README.md`, after the "Backups" section:

```markdown
## Notifications

- Turn on Settings → Notifications, and Shiori's reminders for a time, and the plan's "coming up" and "leave soon", reach you as notifications while annai is closed. Tapping one opens annai, and Shiori catches up.
- They go through a small relay, `push.annai.guide` (its code is in [`relay/`](relay/README.md), to run your own). annai encrypts each reminder on the phone and pads it to one size: the relay learns only the phone's push address, when each reminder is due and how many are waiting. Reminders about places never leave the phone.
- With annai open on screen, annai says a reminder itself and the relay's copy is called off, so it never comes twice.
```

In the spec, §11.7, after "Location otherwise goes only to the user's own model provider.":

```markdown
- With notifications on, the push relay gets each time reminder encrypted, and learns only the push endpoint, the timing and how many there are (§11.6).
```

`scripts/size.mjs`: raise `BUDGET` to the figure `npm run size` reports plus a small margin, and add to its comment "…; 1150 with the review fixes; N for milestone 6 (notifications)". List the raise in the report.

- [ ] **Step 4: The whole suite, in both browsers**

Run: `npm run stamp && npm run check && docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`
Expected: every unit test passes; every end-to-end test passes in Chromium and WebKit. Delete any `core*` file WebKit left.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add test/e2e/push.spec.js docs/testing/device-checklist-m6.md README.md docs/superpowers/specs/2026-10-15-annai-design.md scripts/size.mjs && git commit -m "Milestone 6 done: a reminder waits at the relay encrypted, reaches the push service at its time, opens a catch-up wake, and never comes twice; the device checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

## Ledger

(Kept by the executor: one line per task as it completes, and a Ruling line for each call made while building.)
