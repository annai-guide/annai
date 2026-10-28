import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setWords, key } from '../../src/core/l10n.js';
import { SYS_PLUGINS } from '../../src/core/scopes.js';
import { utf8 } from '../../src/core/bytes.js';
import { checkPlugins } from '../../src/ui/plugin-updates.js';
import { hostKit } from './package-kit.js';
import { site } from './provider-kit.js';

// A file of its own: the catalog's words are kept for the run once had, and this is the run's first check (the plugin-l10n-fetch review).
after(() => setWords('en', null));

test("the first check of a run asks for the language's catalog once, though it serves Add's words and the plugins' hashes both", async () => {
  setWords('ja', {});
  const k = await hostKit();
  const ID = 'tide-tables';
  const files = { 'annai-plugin.json': JSON.stringify({ id: ID, name: 'Tide tables', version: '1.0.0', api: 2, description: 'Tide tables.' }) };
  const JA = { manifest: { description: '潮汐表。' }, messages: { [key('Low tide.')]: '干潮。' } };
  const s = await site({ [ID]: files }, { ja: { [ID]: JA } });
  // Installed in an earlier run, its words with it.
  await k.ws.writeMany(SYS_PLUGINS, [{ path: `/${ID}/annai-plugin.json`, content: utf8(files['annai-plugin.json']) }, { path: `/${ID}/l10n/ja.json`, content: utf8(JSON.stringify(JA)) },
    { path: '/installed.json', content: { [ID]: { version: '1.0.0', name: 'Tide tables', enabled: true, installed: 1, source: 'official' } } }], { author: 'system' });
  await checkPlugins(k.host, { fetch: s.fetch, next: () => 'ja' }, { address: false });
  assert.deepEqual(s.asked.filter((p) => p.startsWith('/catalog/l10n/')), ['/catalog/l10n/ja.json']);
});
