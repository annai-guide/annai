import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { squash, matchAt, rankEntry, searchCatalog } from '../../src/core/search.js';
import { catalogFacts } from '../../src/core/catalog-facts.js';

// annai's own catalog as it ships, so a description that starts naming another plugin shows up here.
const catalog = JSON.parse(await readFile(new URL('../../catalog/plugins.json', import.meta.url), 'utf8')).plugins;
/** A plugin's facts as the catalog gives them. @param {any} m */
const facts = (m) => catalogFacts({ version: '1.0.0', ...m });
const ENTRIES = [
  ...catalog.map((/** @type {any} */ p) => ({ ...p, official: true })),
  { ...facts({ id: 'trail-kit', name: 'Trail kit', description: 'Trail checks and a free trail voice.', entry: 'index.js' }), official: false },
  { ...facts({ id: 'kotoba', name: 'ことば Voice', description: '日本語の声', provider: { abilities: { v: { kind: 'voice' } } } }), official: false },
  { ...facts({ id: 'golos', name: 'Голос', description: 'A voice in Russian.', provider: { abilities: { v: { kind: 'voice' } } } }), official: false },
];
/** @param {{ entry: { id: string } }[]} r */
const ids = (r) => r.map((x) => x.entry.id);

test('"lm studio", "lmstudio" and "LMStudio" are one query; matching starts at a word: "studio" matches LM Studio, "tudio" does not', () => {
  assert.equal(squash('lm studio').text, 'lmstudio');
  assert.equal(squash('LMStudio').text, 'lmstudio');
  assert.equal(squash('LM-Studio!').text, 'lmstudio');
  assert.deepEqual([...squash('LM Studio').starts], [0, 2]);
  for (const q of ['lm studio', 'lmstudio', 'LMStudio', 'LM  STUDIO']) assert.equal(matchAt(q, 'LM Studio'), true, q);
  assert.equal(matchAt('studio', 'LM Studio'), true);
  assert.equal(matchAt('tudio', 'LM Studio'), false);
  // A capital after a small letter starts a word too: "router" finds OpenRouter, "seek" DeepSeek.
  assert.equal(matchAt('router', 'OpenRouter'), true);
  assert.equal(matchAt('seek', 'DeepSeek'), true);
  assert.equal(matchAt('', 'LM Studio'), false);
  assert.equal(matchAt('?!', 'LM Studio'), false);
});

test('a name match comes before a keyword match: "lm studio" lists LM Studio first, then llama.cpp, saying "Also for: LM Studio"', () => {
  const r = searchCatalog(ENTRIES, 'lm studio', {});
  assert.deepEqual(ids(r).slice(0, 2), ['provider-lmstudio', 'provider-llamacpp']);
  assert.deepEqual([r[0].score, r[0].why], [3, undefined]);
  assert.deepEqual([r[1].score, r[1].why], [2, 'LM Studio']);
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'lmstudio', {})).slice(0, 2), ['provider-lmstudio', 'provider-llamacpp']);
});

test('"unsloth" finds llama.cpp by its keyword, saying why; "ollama" lists Ollama alone', () => {
  const r = searchCatalog(ENTRIES, 'unsloth', {});
  assert.deepEqual(ids(r), ['provider-llamacpp']);
  assert.equal(r[0].why, 'Unsloth');
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'ollama', {})), ['provider-ollama']);
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'Ollama ', {})), ['provider-ollama']);
});

test('"free voice" needs both words: OpenRouter yes (a free voice), OpenAI no; "llamacpp" and "llama cpp" both find llama.cpp', () => {
  const r = ids(searchCatalog(ENTRIES, 'free voice', {}));
  assert.ok(r.includes('provider-openrouter'), r.join());
  assert.ok(!r.includes('provider-openai'), r.join());
  assert.ok(r.includes('trail-kit'), 'its description has both words');
  // Each word scores alone, and the entry ranks by its weakest: free (1) and voice (1).
  assert.deepEqual(rankEntry(ENTRIES.find((e) => e.id === 'provider-openrouter'), 'free voice'), { score: 1 });
  assert.deepEqual(rankEntry(ENTRIES.find((e) => e.id === 'provider-openai'), 'free voice'), { score: 0 });
  // A keyword that matched among the words still says why.
  assert.deepEqual(rankEntry(ENTRIES.find((e) => e.id === 'provider-llamacpp'), 'unsloth chat'), { score: 1, why: 'Unsloth' });
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'llamacpp', {})), ['provider-llamacpp']);
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'llama cpp', {})), ['provider-llamacpp']);
  // An ability matches by its name, one or many: "voices" finds what has a voice.
  assert.ok(ids(searchCatalog(ENTRIES, 'voices', {})).includes('provider-openai'));
  assert.ok(ids(searchCatalog(ENTRIES, 'transcription', {})).includes('provider-groq'));
});

test('filters: kind, ability, free, local, official or third-party; an empty query lists all the filters keep', () => {
  assert.equal(searchCatalog(ENTRIES, '', {}).length, ENTRIES.length);
  assert.equal(searchCatalog(ENTRIES, '   ', {}).length, ENTRIES.length);
  const providers = ids(searchCatalog(ENTRIES, '', { kind: 'providers' }));
  assert.ok(providers.includes('provider-openai') && providers.includes('provider-another-address'));
  assert.ok(!providers.includes('provider-local-speech') && !providers.includes('chat-completions') && !providers.includes('storage-s3'));
  const hears = ids(searchCatalog(ENTRIES, '', { ability: 'transcription' }));
  assert.ok(hears.includes('provider-local-speech') && hears.includes('provider-openai') && hears.includes('provider-groq'));
  assert.ok(!hears.includes('provider-anthropic'));
  assert.ok(ids(searchCatalog(ENTRIES, '', { free: true })).every((id) => ENTRIES.find((e) => e.id === id)?.free));
  assert.ok(ids(searchCatalog(ENTRIES, '', { local: true })).includes('provider-ollama'));
  assert.ok(!ids(searchCatalog(ENTRIES, '', { local: true })).includes('provider-openai'));
  assert.deepEqual(ids(searchCatalog(ENTRIES, '', { source: 'third-party' })).sort(), ['golos', 'kotoba', 'trail-kit']);
  assert.ok(!ids(searchCatalog(ENTRIES, '', { source: 'official' })).includes('trail-kit'));
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'voice', { ability: 'voice', local: true })), ['provider-local-speech']);
});

test('the order: score, then featured, then official, then name', () => {
  const e = (/** @type {string} */ id, /** @type {any} */ o = {}) => ({ ...facts({ id, name: id, description: 'Maps' }), ...o });
  const list = [e('b-third', { official: false }), e('d-plain', { official: true }), e('c-featured', { official: true, featured: 'Start here.' }), e('a-plain', { official: true }), e('maps', { official: false })];
  assert.deepEqual(ids(searchCatalog(list, '', {})), ['c-featured', 'a-plain', 'd-plain', 'b-third', 'maps']);
  assert.deepEqual(ids(searchCatalog(list, 'maps', {})), ['maps', 'c-featured', 'a-plain', 'd-plain', 'b-third']);
});

test('letters of any script match: a Japanese name is found by its start', () => {
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'ことば', {})), ['kotoba']);
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'とば', {})), []);
  assert.deepEqual(ids(searchCatalog(ENTRIES, '日本語', {})), ['kotoba']);
  assert.deepEqual(ids(searchCatalog(ENTRIES, 'ГОЛОС', {})), ['golos']);
  // Full-width letters typed on a Japanese keyboard are the same letters.
  assert.equal(matchAt('ＬＭ　Ｓｔｕｄｉｏ', 'LM Studio'), true);
});
