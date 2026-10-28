import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noReader, readerRoles } from '../../src/core/agent/reading.js';

test('with nothing here that reads a PDF, the note names the setting, and the plugin only when asked to', () => {
  assert.equal(noReader('pdf', { plugin: false }), "No model here can read PDFs, so what it says can't be told. Tell the user what fixes it: a model that reads PDFs (Takes PDFs on its page in Settings → Models).");
  assert.match(noReader('pdf', { plugin: true }), /Takes PDFs on its page in Settings → Models\), or the PDF pages plugin \(Settings → Plugins → Add\), which shows a PDF's pages to a model that sees photos\.$/);
  assert.match(noReader('image', { plugin: true }), /^No model here can see photos, .*Takes photos on its page in Settings → Models\)\.$/);
  assert.doesNotMatch(noReader('image', { plugin: true }), /PDF pages/);
});

test("the roles that read for a half: Koe's first for Kokoro; for Koe, Utility's, then Main's; an empty Utility is Main's, and a role with no chat model on is left out", () => {
  const chat = { kind: 'chat', type: 'scripted', on: true };
  /** @type {any} */
  const cfg = {
    providers: { p: { id: 'p', user: { name: 'P', abilities: { chat, realtime: { kind: 'realtime', type: 'gemini-live', on: true } } } } },
    models: { a: { id: 'a', provider: 'p', ability: 'chat', user: { providerId: 'a' } }, k: { id: 'k', provider: 'p', ability: 'chat', user: { providerId: 'k' } }, u: { id: 'u', provider: 'p', ability: 'chat', user: { providerId: 'u' } }, live: { id: 'live', provider: 'p', ability: 'realtime', user: { providerId: 'live' } } },
    roles: { main: { models: ['a'] }, utility: { models: [] }, 'koe-classic': { models: ['k'] }, 'koe-realtime': { models: ['live'] } },
  };
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'main']);
  assert.deepEqual(readerRoles(cfg, 'one'), ['koe-classic', 'main']);
  assert.deepEqual(readerRoles(cfg, 'koe'), ['main', 'koe-classic']);
  cfg.roles.utility.models = ['u'];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'utility', 'main']);
  assert.deepEqual(readerRoles(cfg, 'koe'), ['utility', 'main', 'koe-classic'], "for Koe, Utility's first, then Main's (the coordinator's call, 2026-10-28)");
  cfg.roles.utility.models = ['a'];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'utility'], "a list that is an earlier one's is left out");
  cfg.roles.utility.models = ['u'];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'utility', 'main']);
  cfg.roles['koe-classic'].models = [];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['utility', 'main'], 'a realtime model is no reader');
});
