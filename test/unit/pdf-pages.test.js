import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../../src/core/registry.js';
import { runningPdfPages, MAX_PAGES, PAGE_EDGE } from '../../src/core/pdf-pages.js';

const drawn = { count: 1, pages: [{ type: 'image/jpeg', bytes: new Uint8Array([1]), width: 10, height: 12 }] };

test('no plugin, no pages: null until one registers, and null again once it is removed', async () => {
  const r = new Registry();
  assert.equal(runningPdfPages(r), null);
  assert.equal(runningPdfPages(null), null);
  const off = r.add('pdf-pages', 'pdf-pages', { id: 'pdfjs', pages: async () => drawn });
  assert.equal(runningPdfPages(r)?.pluginId, 'pdf-pages');
  assert.deepEqual(await runningPdfPages(r)?.pages(new Uint8Array(4), { max: 1, edge: 100 }), drawn);
  off();
  assert.equal(runningPdfPages(r), null);
});

test('a registration without a pages function is passed over for the next', () => {
  const r = new Registry();
  r.add('broken', 'pdf-pages', { id: 'x' });
  r.add('good', 'pdf-pages', { id: 'y', pages: async () => drawn });
  assert.equal(runningPdfPages(r)?.pluginId, 'good');
});

test("an answer in words never counts against it: a locked PDF's Error, three times, leaves the plugin on", async () => {
  const r = new Registry({ maxFailures: 3 });
  r.add('p', 'pdf-pages', { id: 'x', pages: async () => { throw new Error('This PDF is locked with a password, so its pages can\'t be drawn.'); } });
  for (let i = 0; i < 3; i++) await assert.rejects(/** @type {any} */ (runningPdfPages(r)).pages(new Uint8Array(4), { max: 1, edge: 100 }), /locked with a password/);
  assert.equal(r.isDisabled('p'), false);
});

test('three crashes switch it off, as a tool\'s do: runningPdfPages is null then', async () => {
  const r = new Registry({ maxFailures: 3 });
  r.add('p', 'pdf-pages', { id: 'x', pages: async () => { throw new TypeError('boom'); } });
  for (let i = 0; i < 3; i++) await assert.rejects(/** @type {any} */ (runningPdfPages(r)).pages(new Uint8Array(4), { max: 1, edge: 100 }), /boom/);
  assert.equal(r.isDisabled('p'), true);
  assert.equal(runningPdfPages(r), null);
});

test('the limits: at most 10 pages, 1600 px on the longest side', () => {
  assert.equal(MAX_PAGES, 10);
  assert.equal(PAGE_EDGE, 1600);
});
