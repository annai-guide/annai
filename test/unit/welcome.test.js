import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';
import { plainStart, shouldWelcome, markWelcomed } from '../../src/ui/welcome.js';

async function setup() {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  return ws;
}

test('the plain start is annai with no screen in its address; any link to a screen is not', () => {
  for (const hash of ['', '#', '#/']) assert.equal(plainStart({ hash, search: '' }), true, hash || '(none)');
  // A shared trip, a share, the sign-in coming back, and every other screen wait for the next plain start.
  for (const hash of ['#import=https%3A%2F%2Fexample.com%2Ft.annai.zip', '#/import?inbox=1', '#/models', '#/trips', '#/welcome'])
    assert.equal(plainStart({ hash, search: '' }), false, hash);
  assert.equal(plainStart({ hash: '', search: '?code=abc&state=x' }), false, 'OpenRouter coming back');
});

test('a fresh device is welcomed at its plain start, once the welcome is drawn never again', async () => {
  const ws = await setup();
  assert.equal(await shouldWelcome(ws, { hash: '', search: '' }), true);
  assert.equal(await shouldWelcome(ws, { hash: '#import=x', search: '' }), false, 'a shared trip opens as it is');
  assert.equal(await shouldWelcome(ws, { hash: '#/import?inbox=1', search: '' }), false, 'a share opens as it is');
  await markWelcomed(ws, 1234);
  assert.equal((await readAppSettings(ws)).welcomedAt, 1234, "kept in the app's settings");
  assert.equal(await shouldWelcome(ws, { hash: '', search: '' }), false);
  await markWelcomed(ws, 9999);
  assert.equal((await readAppSettings(ws)).welcomedAt, 1234, 'the first time stays');
});

test('settings that exist already keep their values when the welcome is noted', async () => {
  const ws = await setup();
  await updateAppSettings(ws, { lastExportAt: 5 });
  await markWelcomed(ws, 7);
  assert.deepEqual(await readAppSettings(ws), { lastExportAt: 5, welcomedAt: 7 });
});
