import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeContract } from '../contract/store-contract.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { storeError, StorageFullError } from '../../src/core/errors.js';

storeContract(test, assert, async () => createMemoryStore());

test('memory store: a failed transaction does not block the next one', async () => {
  const s = createMemoryStore();
  await assert.rejects(s.tx(['files'], 'readwrite', async () => { throw new Error('x'); }));
  assert.equal(await s.tx(['files'], 'readonly', async () => 'ok'), 'ok');
});

test("storeError: a full device is told by the error's name and the side that ended the operation, never by its words", () => {
  const e = (/** @type {string} */ name, message = '') => new DOMException(message, name);
  const full = (/** @type {unknown} */ x, /** @type {any} */ o) => storeError(x, o) instanceof StorageFullError;
  // The quota's name counts anywhere.
  assert.equal(full(e('QuotaExceededError')), true);
  assert.equal(full(e('QuotaExceededError'), { write: true }), true);
  // WebKit's refusals are UnknownError, a write's only: a read that fails so is a lost connection.
  assert.equal(full(e('UnknownError')), false);
  assert.equal(full(e('UnknownError'), { write: true }), true);
  // An abort after every request succeeded (the store marks it) is a refused commit, a write's only.
  assert.equal(full(e('AbortError'), { write: true }), false);
  assert.equal(full(e('AbortError'), { write: true, refused: true }), true);
  assert.equal(full(e('AbortError'), { refused: true }), false);
  assert.equal(full(e('DataError', 'Failed to write blobs (IOError)'), { write: true }), false, 'a DataError counts when the store marks it refused, not by name');
  // A connection that could not be opened: Chromium at its last bytes says UnknownError, or AbortError while its backing store is still closing.
  assert.equal(full(e('AbortError'), { write: true, open: true }), true);
  assert.equal(full(e('UnknownError'), { write: true, open: true }), true);
  assert.equal(full(e('SecurityError'), { write: true, open: true }), false, 'a browser blocking storage is no full device');
  assert.equal(full(e('InvalidStateError'), { write: true, open: true }), false);
  // Never by words: an error of annai's own that mentions them is rejected as it is.
  for (const own of [new Error('The disk is full: QuotaExceededError, UnknownError'), Object.assign(new Error('storage is full'), { name: 'ValidationError' }), e('ConstraintError', 'quota')]) {
    assert.equal(storeError(own, { write: true, open: true }), own);
  }
});
