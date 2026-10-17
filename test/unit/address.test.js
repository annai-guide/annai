import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressParts, fullAddress, refuseUserinfo } from '../../src/core/address.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';

// An address's keys, for MCP servers and packages alike (milestone 8c's third finding; fix passes 8c-2 and 8a-1).

test('8c-2: words in an address stay; a key is 12 or more digits, 24 or more lowercase letters alone, or a part that is not words and is 16 or more characters or 8 or more mixing letters and digits', () => {
  const words40 = 'trail-maps-and-parking-for-the-big-sur-co';
  assert.equal(words40.length, 41);
  for (const a of [
    'https://mcp.example.com/model-context-protocol/mcp',
    'https://mcp.example.com/my-company-name-here/mcp',
    'https://mcp.example.com/internationalization/organizations/mcp?topic=organizations&v=2',
    `https://mcp.example.com/${words40.slice(0, 40)}/mcp`,
  ]) {
    assert.deepEqual(addressParts(a), { shown: a, keys: [] }, a);
  }
  const { shown, keys } = addressParts('https://mcp.example.com/s/AbCdEfGhIjKlMnOpQr/123456789012345/Ab_Cd-EfGh_IjKl-MnOp/a1b2c3d4/mcp?q=AbCdEfGhIjKlMnOpQr&n=abcdefgh&token=x');
  assert.equal(shown, 'https://mcp.example.com/s/«key»/«key»/«key»/«key»/mcp?q=«key»&n=abcdefgh&token=«key»');
  assert.deepEqual(keys, ['AbCdEfGhIjKlMnOpQr', '123456789012345', 'Ab_Cd-EfGh_IjKl-MnOp', 'a1b2c3d4', 'AbCdEfGhIjKlMnOpQr', 'x']);
  assert.equal(addressParts('https://mcp.example.com/123e4567-e89b-12d3-a456-426614174000/mcp').keys.length, 1, 'a UUID');
  // The backstop: lowercase letters alone, 24 or more of them, are a key; joined words of any length are not.
  const lower = 'qwhzkxvbnmplokijuhygtfrdeswa';
  assert.equal(lower.length, 28);
  assert.deepEqual(addressParts(`https://mcp.example.com/${lower}/mcp?k2=${lower}`), { shown: 'https://mcp.example.com/«key»/mcp?k2=«key»', keys: [lower, lower] });
  for (const a of ['https://mcp.example.com/internationalization/mcp', 'https://mcp.example.com/model-context-protocol-server-for-weather/mcp']) {
    assert.deepEqual(addressParts(a), { shown: a, keys: [] }, a);
  }
});

test('an address and its keys: shown with each part that may be a key blanked, and put back whole (the third finding)', () => {
  const a = 'https://mcp.example.com/api/mcp/s/zap1a2b3c4d5e6f7g8h9/mcp?v=2&key=q9w8e7r6t5y4&k=abc&api_key=short';
  const { shown, keys } = addressParts(a);
  assert.equal(shown, 'https://mcp.example.com/api/mcp/s/«key»/mcp?v=2&key=«key»&k=abc&api_key=«key»');
  assert.deepEqual(keys, ['zap1a2b3c4d5e6f7g8h9', 'q9w8e7r6t5y4', 'short']);
  assert.equal(fullAddress(shown, keys), a);
  assert.deepEqual(addressParts('http://127.0.0.1:8080/mcp'), { shown: 'http://127.0.0.1:8080/mcp', keys: [] });
});

test("a short value under a credential name annai's trace blanks (appid, app_id) is blanked in the shown address too, and goes to secrets", () => {
  const { shown, keys } = addressParts('https://mcp.example.com/mcp?appid=abc123&app_id=x9&v=2');
  assert.equal(shown, 'https://mcp.example.com/mcp?appid=«key»&app_id=«key»&v=2');
  assert.deepEqual(keys, ['abc123', 'x9']);
});

test('8a-1: an address with a name or password before an @ is refused, in words that say what to do', () => {
  assert.throws(() => refuseUserinfo(new URL('https://me:pw@trails.example/kit.zip')), /This address holds a name or password before an @\. Leave it out\.$/);
  assert.throws(() => refuseUserinfo(new URL('https://me@mcp.example.com/mcp'), ', and put the key in the Token or Headers field'), /Leave it out, and put the key in the Token or Headers field\.$/);
  refuseUserinfo(new URL('https://trails.example/kit.zip'));
});

test("8a-1: the keys of an address that aren't secrets yet are blanked in the trace too", async () => {
  const store = createMemoryStore();
  const key = 'zap1a2b3c4d5e6f7g8h9';
  const get = tracedFetch(store, SYS, { tool: 'plugins', blank: [key] }, async () => new Response('ok'));
  await get(`https://trails.example/s/${key}/kit.zip`);
  const [e] = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
  assert.doesNotMatch(JSON.stringify(e.data), new RegExp(key));
  assert.match(e.data.url, /^https:\/\/trails\.example\/s\/.+\/kit\.zip$/);
});
