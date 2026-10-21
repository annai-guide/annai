import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { anySignal } from '../../src/core/signals.js';

// AbortSignal.any came in Chrome 116 and Safari 17.4; annai runs on Chrome 113 and iOS 16.4 (the emulator pass).
const root = new URL('../../', import.meta.url);

/** Runs f with AbortSignal.any gone, as on those browsers. @param {() => void | Promise<void>} f */
async function withoutAny(f) {
  const had = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  // @ts-ignore: the point is that it is missing
  delete AbortSignal.any;
  try {
    assert.equal(typeof AbortSignal.any, 'undefined');
    await f();
  } finally {
    if (had) Object.defineProperty(AbortSignal, 'any', had);
  }
}

test('without AbortSignal.any, the signal aborts when any of them does, with its reason, once', () => withoutAny(() => {
  const a = new AbortController();
  const b = new AbortController();
  const s = anySignal([a.signal, b.signal]);
  let heard = 0;
  s.addEventListener('abort', () => heard++);
  assert.equal(s.aborted, false);
  const why = new DOMException('No answer in time.', 'TimeoutError');
  b.abort(why);
  assert.equal(s.aborted, true);
  assert.equal(s.reason, why);
  a.abort(new Error('later'));
  assert.equal(heard, 1);
  assert.equal(s.reason, why);
}));

test('without AbortSignal.any, one already aborted gives an aborted signal with its reason', () => withoutAny(() => {
  const a = new AbortController();
  a.abort('stopped');
  const s = anySignal([new AbortController().signal, a.signal]);
  assert.equal(s.aborted, true);
  assert.equal(s.reason, 'stopped');
}));

test('without AbortSignal.any, a timeout among them ends a fetch-like wait', () => withoutAny(async () => {
  const s = anySignal([new AbortController().signal, AbortSignal.timeout(5)]);
  await new Promise((resolve) => s.addEventListener('abort', resolve, { once: true }));
  assert.equal(s.reason.name, 'TimeoutError');
}));

test('where AbortSignal.any exists, it is used', () => {
  const a = new AbortController();
  const s = anySignal([a.signal]);
  a.abort('x');
  assert.equal(s.reason, 'x');
});

/** Every .js file under a folder. @param {URL} dir @returns {Promise<URL[]>} */
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const u = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
    if (e.isDirectory()) out.push(...await walk(u));
    else if (e.name.endsWith('.js')) out.push(u);
  }
  return out;
}

test('nothing annai ships calls AbortSignal.any itself: anySignal does, with its fallback', async () => {
  /** @type {string[]} */
  const found = [];
  for (const f of [...await walk(new URL('src/', root)), ...await walk(new URL('plugins-official/', root)), new URL('sw.js', root)]) {
    const where = f.pathname.slice(root.pathname.length);
    if (where === 'src/core/signals.js') continue;
    if ((await readFile(f, 'utf8')).includes('AbortSignal.any(')) found.push(where);
  }
  assert.deepEqual(found, []);
});
