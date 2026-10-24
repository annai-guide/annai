import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_NOTE, WELCOME_SEARCH, stateOf } from '../../src/ui/search-panel.js';
import { cooldowns, READY_MS } from '../../src/core/web-search.js';
import { FREE_PROVIDERS, KNOWLEDGE } from '../../src/plugins/web/free.js';

test('S5: the notes name where searches go, the last resort that is always on, the training, and what is not sent', () => {
  for (const t of [SEARCH_NOTE, WELCOME_SEARCH]) {
    assert.match(t, /Exa/);
    assert.match(t, /Wikimedia/);
    assert.match(t, /OpenStreetMap/);
    assert.match(t, /Search via: Off/);
    assert.match(t, /train their models/);
    assert.match(t, /names and addresses/);
    assert.match(t, /not your files or your location/);
    assert.match(t, /free tiers that can change or stop/);
    assert.doesNotMatch(t, /nothing of your trips|Jina/);
  }
  assert.match(WELCOME_SEARCH, /Exa also gets the addresses of pages it reads for her/);
  assert.match(SEARCH_NOTE, /Exa also reads a page that no other reader can, which sends it that page's address/);
  assert.equal(KNOWLEDGE.name, 'Wikivoyage, Wikipedia and Nominatim');
});

test('a provider\'s state: a ready() that never answers is "couldn\'t check", a resting floor says it rests, an always-on floor says so', async () => {
  cooldowns.clear('wiki');
  cooldowns.clear('stuck');
  const was = READY_MS.ms;
  READY_MS.ms = 30;
  try {
    assert.equal(await stateOf({ id: 'stuck', ready: () => new Promise(() => {}) }), "couldn't check");
    assert.equal(await stateOf({ id: 'k', ready: async () => ({ ok: false, why: 'needs a key' }) }), 'needs a key');
    assert.equal(await stateOf({ id: 'k2', ready: async () => ({ ok: true }) }), 'ready');
    assert.equal(await stateOf(FREE_PROVIDERS[0]), 'free, no key');
    assert.match(await stateOf(KNOWLEDGE), /Wikimedia and OpenStreetMap; always on, the last resort/);
    cooldowns.rest('wiki');
    assert.match(await stateOf(KNOWLEDGE), /^resting after a failure, tries again in 1 minute$/);
  } finally {
    READY_MS.ms = was;
    cooldowns.clear('wiki');
  }
});
