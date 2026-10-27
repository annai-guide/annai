import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unbumped } from '../../scripts/catalog-versions.mjs';

const catalog = (/** @type {any[]} */ ...plugins) => ({ plugins });

test('a released version whose files changed is listed; a new version, the same files or a new plugin is not', () => {
  const live = catalog(
    { id: 'a', version: '1.0.0', files: { 'index.js': 'h1', 'annai-plugin.json': 'm1' } },
    { id: 'b', version: '0.2.0', files: { 'index.js': 'h2' } },
    { id: 'c', version: '2.0.0', files: { 'index.js': 'h3' } },
  );
  const next = catalog(
    { id: 'a', version: '1.0.0', files: { 'annai-plugin.json': 'm1-changed', 'index.js': 'h1' } },
    { id: 'b', version: '0.2.1', files: { 'index.js': 'h2-changed' } },
    { id: 'c', version: '2.0.0', files: { 'index.js': 'h3' } },
    { id: 'd', version: '0.1.0', files: { 'index.js': 'h4' } },
  );
  assert.deepEqual(unbumped(live, next), [{ id: 'a', version: '1.0.0' }]);
});

test('the same files in another order are the same; a file added or removed is a change', () => {
  const live = catalog({ id: 'a', version: '1.0.0', files: { x: '1', y: '2' } });
  assert.deepEqual(unbumped(live, catalog({ id: 'a', version: '1.0.0', files: { y: '2', x: '1' } })), []);
  assert.deepEqual(unbumped(live, catalog({ id: 'a', version: '1.0.0', files: { x: '1', y: '2', z: '3' } })), [{ id: 'a', version: '1.0.0' }]);
  assert.deepEqual(unbumped(live, catalog({ id: 'a', version: '1.0.0', files: { x: '1' } })), [{ id: 'a', version: '1.0.0' }]);
});

test('a missing or empty catalog lists nothing', () => {
  assert.deepEqual(unbumped(null, catalog({ id: 'a', version: '1.0.0', files: {} })), []);
  assert.deepEqual(unbumped(catalog(), {}), []);
});
