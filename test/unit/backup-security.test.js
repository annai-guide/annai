import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { logEvent } from '../../src/core/events.js';
import { withoutSecrets, withoutSecretsIn, secretFreeLog } from '../../src/core/agent/net.js';
import { TargetError } from '../../src/core/storage-types.js';
import { TOKEN, memoryPlace, device, placeOn, everything } from './backup-kit.js';

// What a backup place's errors, notes and listings carry never takes a secret anywhere annai keeps
// or shows it (spec §9.9, §15).

test("a storage plugin's bug that echoes its token is counted against it without the token", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  place.failNext(new TypeError(`x is not a function (token ${TOKEN})`));
  await assert.rejects(d.backups.backUp(id), (e) => e instanceof TargetError && !e.message.includes(TOKEN));
  assert.equal(d.logged.length, 1);
  assert.equal(d.logged[0].type, 'plugin.error');
  assert.equal(JSON.stringify(d.logged).includes(TOKEN), false);
});

test("a stop is a stop, in annai's own words, whatever the plugin's error said", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  place.failNext(Object.assign(new Error(`stopped while sending ${TOKEN}`), { name: 'AbortError' }));
  await assert.rejects(d.backups.backUp(id), (/** @type {any} */ e) => e?.name === 'AbortError' && !String(e.message).includes(TOKEN));
});

test("a place's note and the backups it lists carry no secret into its record, the log or the screen", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const leaky = {
    ...place.type, type: 'leaky', name: 'Leaky',
    check: async () => ({ note: `Works with ${TOKEN}.` }),
    list: async () => [{ id: `b-${TOKEN}`, at: 5, device: 'someone-else', label: `Phone ${TOKEN}`, extra: TOKEN }],
  };
  d.registry.add('memory-place', 'storage-type', leaky);
  const id = await d.backups.add('leaky');
  await d.backups.update(id, { secret: { token: TOKEN } });
  const { note, newer } = await d.backups.check(id);
  assert.equal(note.includes(TOKEN), false);
  assert.equal(JSON.stringify(newer).includes(TOKEN), false);
  assert.equal(JSON.stringify((await d.backups.get(id))?.hold).includes(TOKEN), false);
  assert.equal(JSON.stringify(await d.backups.remote(id)).includes(TOKEN), false);
  assert.equal((await everything(d.store)).includes(TOKEN), false);
});

test('an address with a user name and password in it is refused before it is kept', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  await assert.rejects(d.backups.update(id, { config: { where: 'https://me:hunter22hunter@dav.example.com/annai/' } }),
    (e) => e instanceof TargetError && e.kind === 'setup' && /own fields/.test(e.message));
  assert.equal((await d.backups.get(id))?.config.where, 'here');
  assert.equal((await everything(d.store)).includes('hunter22hunter'), false);
});

test("credentials are blanked by their shape too, even ones annai doesn't keep", async () => {
  const d = await device(memoryPlace());
  const signature = 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41';
  const said = [
    'Authorization: Bearer ghp_abcdefghijklmnop1234 was refused;',
    'then Basic dXNlcjpwYXNzd29yZA== too;',
    `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261016/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature};`,
    'https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261016&X-Amz-Signature=abc123def456&X-Amz-Security-Token=FQoGZXIvYXdzEJr',
    'Basic authentication is fine to mention.',
  ].join(' ');
  const out = await withoutSecrets(d.store, said);
  for (const secret of ['ghp_abcdefghijklmnop1234', 'dXNlcjpwYXNzd29yZA==', signature, 'abc123def456', 'FQoGZXIvYXdzEJr', 'AKIAIOSFODNN7EXAMPLE']) {
    assert.equal(out.includes(secret), false, secret);
  }
  assert.match(out, /Basic authentication is fine to mention\./);
});

/** The store refuses the read the blanking needs, listing the keys (Chromium's at no byte free); reading one still works. @param {any} store */
function keysUnread(store) {
  const tx = store.tx;
  store.tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => tx.call(store, stores, mode, (/** @type {any} */ t) => fn(stores.includes('secrets') ? { ...t, listSecretIds: () => Promise.reject(new Error('The database connection is closing.')) } : t));
  return () => { store.tx = tx; };
}

const UNCHECKED = "annai couldn't check this message for keys, so it is not shown.";

test("when annai can't read the keys it keeps, a value it keeps has no text it couldn't check, and the registry's log only notes (spec §9.9)", async () => {
  const d = await device(memoryPlace());
  await d.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('endpoint:x', 'sk-model-key-0001'));
  const back = keysUnread(d.store);
  assert.deepEqual(await withoutSecretsIn(d.store, { text: 'cannot read sk-model-key-0001', deep: [{ error: 'Bearer abcdefghijklmnop' }, '', 3, true, null] }),
    { text: UNCHECKED, deep: [{ error: UNCHECKED }, '', 3, true, null] });
  assert.equal(await withoutSecrets(d.store, 'cannot read sk-model-key-0001'), UNCHECKED);
  await assert.rejects(withoutSecretsIn(d.store, { text: 'x' }, { strict: true }), /couldn't read the keys it keeps/);
  const registry = new Registry({ log: secretFreeLog(d.store, SYS), maxFailures: 1 });
  const broken = registry.guard('some-plugin', 'tool search', () => { throw new TypeError('cannot read sk-model-key-0001 of undefined'); });
  await assert.rejects(broken());
  await new Promise((resolve) => setTimeout(resolve, 20));
  back();
  const logged = await d.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['plugin.error'] }));
  assert.deepEqual(logged.map((e) => e.data), [{ name: UNCHECKED, message: UNCHECKED, count: 1 }]);
});

test("when annai can't read the keys it keeps, what a place lists is never taken in with a note for its id or device: its check says to try again, and it mends once they can be read", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  await d.backups.backUp(id);
  const first = (await d.backups.get(id))?.last?.id;
  const back = keysUnread(d.store);
  // The place lists this device's own backup: with a note for its device, it would be another device's, newer.
  await assert.rejects(d.backups.check(id), /couldn't read the keys it keeps/);
  assert.equal((await d.backups.get(id))?.hold, null);
  // A backup that goes up now is counted as failed, its id not taken in.
  await assert.rejects(d.backups.backUp(id), (/** @type {any} */ e) => e instanceof TargetError);
  assert.equal((await d.backups.get(id))?.last?.id, first);
  back();
  assert.equal((await d.backups.check(id)).newer, null);
  assert.equal((await d.backups.get(id))?.last?.id, place.kept.at(-1)?.id, 'the backup that went up is the one to build on');
});

test("when annai can't read the keys it keeps, a place's choices for a field left empty are not offered; its error still is", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const choices = [{ label: 'me/annai-backup', config: { where: 'me/annai-backup' } }];
  d.registry.add('memory-place', 'storage-type', { ...place.type, type: 'several', name: 'Several', check: async () => { throw new TargetError('setup', 'Pick one.', { choices }); } });
  const id = await d.backups.add('several');
  await d.backups.update(id, { secret: { token: TOKEN } });
  const back = keysUnread(d.store);
  await assert.rejects(d.backups.check(id), (/** @type {any} */ e) => e instanceof TargetError && e.kind === 'setup' && e.choices === undefined && e.message === UNCHECKED);
  back();
  await assert.rejects(d.backups.check(id), (/** @type {any} */ e) => e instanceof TargetError && e.message === 'Pick one.' && JSON.stringify(e.choices) === JSON.stringify(choices));
});

test("the registry's log keeps no secret, whoever failed (spec §5.5, §9.9)", async () => {
  const d = await device(memoryPlace());
  await d.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('endpoint:x', 'sk-model-key-0001'));
  const registry = new Registry({ log: secretFreeLog(d.store, SYS), maxFailures: 1 });
  const broken = registry.guard('some-plugin', 'tool search', () => { throw new TypeError('cannot read sk-model-key-0001 of undefined'); });
  await assert.rejects(broken());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const logged = await d.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['plugin.error', 'plugin.disabled'] }));
  assert.deepEqual(logged.map((e) => e.type), ['plugin.error', 'plugin.disabled']);
  assert.equal(JSON.stringify(logged).includes('sk-model-key-0001'), false);
  await logEvent(d.store, SYS, { type: 'probe', data: {} }); // the log still works
});
