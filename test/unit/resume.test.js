import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, setTripStatus, removeTrip } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { ensureDraft } from '../../src/core/chats.js';
import { shouldWelcome, markWelcomed } from '../../src/ui/welcome.js';
import { screenToResume } from '../../src/ui/resume.js';

const PLAIN = { hash: '', search: '' };
const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 14, 12); // noon, 2026-11-14, in UTC
const UTC = { now: NOW, zone: 'UTC' };

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws, c: { store, ws } };
}

/** Its record's last talked, as the log's write stamps it. @param {any} store @param {string} id @param {number | null} talked */
const talkedAt = (store, id, talked) => store.tx(['scopes'], 'readwrite', async (/** @type {any} */ t) => t.putScope({ ...(await t.getScope(id)), talked }));

test('a plain start opens the conversation last talked in under 12 hours ago, and home from 12 hours on (the user, "Last chat if recent, else timeline")', async () => {
  const { store, ws, c } = await device();
  const id = await createTrip(ws, { title: 'Testville' });
  await updateAppSettings(ws, { activeTrip: id });
  await talkedAt(store, id, NOW - 11 * HOUR - 59 * MIN);
  assert.equal(await screenToResume(c, PLAIN, UTC), `#/trip/${id}/talk`);
  assert.equal(await screenToResume(c, { hash: '#', search: '' }, UTC), `#/trip/${id}/talk`);
  await talkedAt(store, id, NOW - 12 * HOUR - MIN);
  assert.equal(await screenToResume(c, PLAIN, UTC), null, '12 h and a minute: home');
  await talkedAt(store, id, NOW - 12 * HOUR + MIN);
  assert.equal(await screenToResume(c, PLAIN, UTC), `#/trip/${id}/talk`, '12 h less a minute');
});

test('a happening trip opens however long ago it was talked in, or if nobody has; a chat nobody talked in opens home', async () => {
  const { store, ws, c } = await device();
  const trip = await createTrip(ws, { title: 'Testville', start: '2026-11-13', end: '2026-11-16' });
  await updateAppSettings(ws, { activeTrip: trip });
  assert.equal(await screenToResume(c, PLAIN, UTC), `#/trip/${trip}/talk`, 'talked null, happening');
  await talkedAt(store, trip, NOW - 30 * 24 * HOUR);
  assert.equal(await screenToResume(c, PLAIN, UTC), `#/trip/${trip}/talk`, 'an old talked, happening');
  // Over, or not begun: by the last line alone.
  assert.equal(await screenToResume(c, PLAIN, { now: Date.UTC(2026, 10, 20, 12), zone: 'UTC' }), null, 'past');
  assert.equal(await screenToResume(c, PLAIN, { now: Date.UTC(2026, 10, 1, 12), zone: 'UTC' }), null, 'future');
  const chat = await createTrip(ws, { title: 'A question' });
  await updateAppSettings(ws, { activeTrip: chat });
  assert.equal(await screenToResume(c, PLAIN, UTC), null, 'talked null, undated');
  // A record a released copy wrote has no talked key until the backfill: as nobody has.
  await store.tx(['scopes'], 'readwrite', async (t) => { const { talked: _, ...rec } = /** @type {any} */ (await t.getScope(chat)); await t.putScope(rec); });
  assert.equal(await screenToResume(c, PLAIN, UTC), null, 'no talked key');
});

test('a plain start with the open conversation removed, archived or the standing draft, or with none, opens home (Review Focus 4)', async () => {
  const { store, ws, c } = await device();
  assert.equal(await screenToResume(c, PLAIN, UTC), null, 'none was open');
  const id = await createTrip(ws, { title: 'Testville' });
  await talkedAt(store, id, NOW - HOUR);
  await updateAppSettings(ws, { activeTrip: id });
  assert.ok(await screenToResume(c, PLAIN, UTC));
  await setTripStatus(store, id, 'archived');
  assert.equal(await screenToResume(c, PLAIN, UTC), null, 'archived');
  await setTripStatus(store, id, 'active');
  assert.ok(await screenToResume(c, PLAIN, UTC));
  await removeTrip(store, id);
  assert.equal(await screenToResume(c, PLAIN, UTC), null, 'removed');
  const draft = await ensureDraft(ws);
  await talkedAt(store, draft, NOW - MIN);
  await updateAppSettings(ws, { activeTrip: draft });
  assert.equal(await screenToResume(c, PLAIN, UTC), null, 'the standing draft');
});

test('a link, a share or a sign-in coming back is never redirected, and the welcome comes first at the first plain start', async () => {
  const { store, ws, c } = await device();
  const id = await createTrip(ws, { title: 'Testville' });
  await talkedAt(store, id, NOW - HOUR);
  await updateAppSettings(ws, { activeTrip: id });
  for (const at of [{ hash: '#/import?inbox=1', search: '' }, { hash: '#/models', search: '' }, { hash: `#/trip/${id}`, search: '' }, { hash: '', search: '?code=abc' }]) {
    assert.equal(await screenToResume(c, at, UTC), null, JSON.stringify(at));
  }
  // main.js asks shouldWelcome first, and opens the welcome; only after it has been seen does the rule open the conversation.
  assert.equal(await shouldWelcome(ws, PLAIN), true);
  await markWelcomed(ws);
  assert.equal(await shouldWelcome(ws, PLAIN), false);
  assert.equal(await screenToResume(c, PLAIN, UTC), `#/trip/${id}/talk`);
});
