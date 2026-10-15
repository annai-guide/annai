import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeContract } from '../contract/store-contract.js';
import { createMemoryStore } from '../../src/core/store-memory.js';

storeContract(test, assert, async () => createMemoryStore());

test('memory store: a failed transaction does not block the next one', async () => {
  const s = createMemoryStore();
  await assert.rejects(s.tx(['files'], 'readwrite', async () => { throw new Error('x'); }));
  assert.equal(await s.tx(['files'], 'readonly', async () => 'ok'), 'ok');
});
