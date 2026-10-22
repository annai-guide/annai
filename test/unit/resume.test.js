import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, setTripStatus, removeTrip } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { noteScreen, screenToResume } from '../../src/ui/resume.js';

/** @returns {import('../../src/ui/resume.js').KeyValue} */
const kv = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const PLAIN = { hash: '', search: '' };

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws, c: { store, ws } };
}

test('a plain start reopens the trip screen that was open; Trips shows only when that trip is gone, archived or removed (the user, 2026-10-21)', async () => {
  const { store, ws, c } = await device();
  const id = await createTrip(ws, { title: 'Big Sur' });
  const kept = kv();
  assert.equal(await screenToResume(c, PLAIN, kept), null, 'nothing noted yet: Trips');
  noteScreen(`#/trip/${id}/plan`, kept);
  assert.equal(await screenToResume(c, PLAIN, kept), `#/trip/${id}/plan`);
  assert.equal(await screenToResume(c, { hash: '#', search: '' }, kept), `#/trip/${id}/plan`);
  // A link, a share or a sign-in coming back points somewhere of its own.
  for (const at of [{ hash: '#/import?inbox=1', search: '' }, { hash: '#/models', search: '' }, { hash: '', search: '?code=abc' }]) assert.equal(await screenToResume(c, at, kept), null, JSON.stringify(at));
  // Other screens (Settings) leave the trip noted; Trips clears it.
  noteScreen('#/settings', kept);
  assert.equal(await screenToResume(c, PLAIN, kept), `#/trip/${id}/plan`);
  // The open trip's own tabs resume while that trip is the active one.
  noteScreen('#/now', kept);
  assert.equal(await screenToResume(c, PLAIN, kept), null, 'no trip is open');
  await updateAppSettings(ws, { activeTrip: id });
  assert.equal(await screenToResume(c, PLAIN, kept), '#/now');
  noteScreen('#/trips', kept);
  assert.equal(await screenToResume(c, PLAIN, kept), null);
  // Gone: archived, then removed.
  noteScreen(`#/trip/${id}/file?path=%2Fa.md`, kept);
  assert.ok(await screenToResume(c, PLAIN, kept));
  await setTripStatus(store, id, 'archived');
  assert.equal(await screenToResume(c, PLAIN, kept), null, 'archived');
  await setTripStatus(store, id, 'active');
  assert.ok(await screenToResume(c, PLAIN, kept));
  await removeTrip(store, id);
  assert.equal(await screenToResume(c, PLAIN, kept), null, 'removed');
});
