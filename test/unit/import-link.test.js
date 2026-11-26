import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { exportArchive, PRESETS } from '../../src/core/archive.js';

// An "#import=<url>" link (spec §12.3) names its file by the address's last part, decoded as far as it decodes: a "%" that starts no escape
// ("50%off") stays as written, and the escapes beside it are read (the Deferred entry "An import link whose file name holds a stray `%`
// fails after it downloads"). A run of escapes that is not text (`%E9%20`: a lone byte E9, then a space) stays whole, as the trace reads
// one. A link may be relative (a file beside annai's own copy): its name is read against the page's address.

// The least DOM the import screen's first draw touches (h, crumb, the passphrase form).
class Node {}
class El extends Node {
  /** @param {string} tag */
  constructor(tag) {
    super();
    this.tag = tag;
    /** @type {any[]} */ this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
  }
  setAttribute() {}
  addEventListener() {}
  /** @param {...any} cs */
  append(...cs) { this.children.push(...cs); }
  /** @param {...any} cs */
  replaceChildren(...cs) { this.children = cs.filter((c) => c !== null && c !== undefined); }
  set textContent(v) { this.children = [{ text: String(v) }]; }
  /** @returns {string} */
  get textContent() { return this.children.map((c) => c.text ?? c.textContent).join(''); }
}
const env = /** @type {any} */ (globalThis);
const real = env.fetch;
const realLocation = env.location;
Object.assign(env, { Node, location: { href: 'https://annai.example.test/#/import' }, document: { createElement: (/** @type {string} */ t) => new El(t), createTextNode: (/** @type {string} */ text) => ({ text }) } });
after(() => {
  env.fetch = real;
  delete env.document;
  delete env.Node;
  if (realLocation === undefined) delete env.location;
  else env.location = realLocation;
});
const { renderImport } = await import('../../src/ui/screens/import.js');

/** An encrypted trip archive, as a site would host one: its screen names the file and asks for the passphrase. */
async function archive() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const id = await createTrip(ws, { title: 'Shared Big Sur' });
  return (await exportArchive(store, { kind: 'trip', scopes: [id], include: PRESETS.share, passphrase: 'p', iterations: 100_000, app: '0.1.0' })).blob;
}

/**
 * The import screen for a link to url, once it has downloaded the file and read its start: its words, and the address it asked for.
 * @param {string} url @param {Blob} blob
 */
async function opened(url, blob) {
  /** @type {string[]} */
  const asked = [];
  env.fetch = async (/** @type {string} */ u) => {
    asked.push(u);
    return new Response(blob, { headers: { 'Content-Type': 'application/zip' } });
  };
  const screen = /** @type {any} */ (await renderImport({ store: createMemoryStore() }, { params: { url } }));
  const body = screen.children.at(-1);
  // The read of the file's start ends in the passphrase form.
  for (let i = 0; i < 200 && !/encrypted/.test(body.textContent); i++) await new Promise((done) => setTimeout(done, 10));
  return { words: body.textContent, asked };
}

test('an import link whose file name holds a stray "%" opens the file, named as written, and the escapes beside it are read', async () => {
  const blob = await archive();
  for (const [url, name] of [
    ['https://files.example.test/50%off.annai.zip', '50%off.annai.zip'],
    ['https://files.example.test/50%off%20sale.annai.zip', '50%off sale.annai.zip'],
    ['https://files.example.test/100%25%20done.annai.zip', '100% done.annai.zip'],
    ['https://files.example.test/%E6%97%85.annai.zip', '旅.annai.zip'],
    ['https://files.example.test/bad%ff.annai.zip', 'bad%ff.annai.zip'],
    ['https://files.example.test/caf%E9%20menu.annai.zip', 'caf%E9%20menu.annai.zip'],
  ]) {
    const { words, asked } = await opened(url, blob);
    assert.deepEqual(asked, [url], 'the address is downloaded as the link gave it');
    assert.ok(words.startsWith(`${name} is encrypted.`), `${url}: ${words}`);
  }
});

test('a relative import link downloads, and is named by its last part, read against the page', async () => {
  const blob = await archive();
  for (const [url, name] of [
    ['/zz-shared/trip%20one.annai.zip', 'trip one.annai.zip'],
    ['/zz-shared/50%off.annai.zip', '50%off.annai.zip'],
    ['trip.annai.zip', 'trip.annai.zip'],
  ]) {
    const { words, asked } = await opened(url, blob);
    assert.deepEqual(asked, [url], 'the address is downloaded as the link gave it (the browser resolves it)');
    assert.ok(words.startsWith(`${name} is encrypted.`), `${url}: ${words}`);
  }
});
