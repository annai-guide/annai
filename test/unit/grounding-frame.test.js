import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// The frame Google's search suggestions are drawn in (G4): it takes HTML only when sandboxed (its own origin opaque) and only
// from annai, its parent, so a page elsewhere that frames it can't make it draw anything, whatever the host serves.

const source = await readFile(new URL('../../src/ui/grounding.js', import.meta.url), 'utf8');
const ANNAI = 'https://annai.guide';

/** The script run as a frame would run it. @param {string} origin its own origin, as self.origin says it */
function frame(origin) {
  /** @type {((e: any) => void)[]} */
  const listeners = [];
  /** @type {any[]} */
  const posted = [];
  const parent = { postMessage: (/** @type {any} */ m) => posted.push(m) };
  const body = { innerHTML: '' };
  vm.runInNewContext(source, { self: { origin }, location: { origin: ANNAI }, parent, document: { body, documentElement: { scrollHeight: 48 } }, addEventListener: (/** @type {string} */ _t, /** @type {any} */ fn) => listeners.push(fn) });
  /** @param {any} data @param {any} [from] @param {string} [at] */
  const send = (data, from = parent, at = ANNAI) => { for (const fn of listeners) fn({ source: from, origin: at, data }); };
  return { body, posted, send };
}

test('sandboxed, it draws the HTML annai sends, and says how tall it is', () => {
  const f = frame('null');
  f.send({ html: '<a class="chip">kyoto</a>' });
  assert.equal(f.body.innerHTML, '<a class="chip">kyoto</a>');
  assert.deepEqual(JSON.parse(JSON.stringify(f.posted)), [{ height: 48 }], "objects from the frame's own realm");
});

test('framed without a sandbox (its own origin real), it draws nothing, even for annai', () => {
  for (const origin of [ANNAI, 'https://evil.example']) {
    const f = frame(origin);
    f.send({ html: '<img src=x onerror=alert(1)>' });
    assert.equal(f.body.innerHTML, '', origin);
    assert.deepEqual(f.posted, []);
  }
});

test('sandboxed in a page elsewhere, or sent HTML by anything but its parent, it draws nothing', () => {
  const f = frame('null');
  f.send({ html: '<img src=x onerror=alert(1)>' }, undefined, 'https://evil.example');
  f.send({ html: '<img src=x onerror=alert(1)>' }, { postMessage: () => {} });
  f.send({ html: 42 });
  assert.equal(f.body.innerHTML, '');
  assert.deepEqual(f.posted, []);
});
