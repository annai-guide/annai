import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openArchive, NeedsPassphraseError } from '../../src/core/archive.js';
import { SYS } from '../../src/core/scopes.js';
import { backupFileName, parseBackupFileName, TargetError } from '../../src/core/storage-types.js';
import { memoryFilePlace, device, everything } from './backup-kit.js';

/** Backups made a moment apart get names that sort apart. */
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

/** @param {Awaited<ReturnType<typeof device>>} d @param {Record<string, any>} [o] */
async function filePlaceOn(d, o = {}) {
  const id = await d.backups.add('memory-file');
  if (Object.keys(o).length) await d.backups.update(id, o);
  await d.backups.check(id);
  return id;
}

test('a whole-file backup is named for when, and which device, made it (spec §12.2 file names)', () => {
  const at = Date.UTC(2026, 9, 16, 18, 4, 5, 123);
  const name = backupFileName({ at, label: 'Android phone', device: 'k3j2h4l1abcd', encrypted: false });
  assert.equal(name, 'annai-backup-20261016T180405123Z-android-phone-k3j2h4l1abcd.annai.zip');
  assert.deepEqual(parseBackupFileName(name), { id: name, at, device: 'k3j2h4l1abcd', label: 'Android phone', encrypted: false });
  const sealed = backupFileName({ at, label: 'iPhone', device: 'k3j2h4l1abcd', encrypted: true });
  assert.equal(sealed, 'annai-backup-20261016T180405123Z-iphone-k3j2h4l1abcd.annai');
  assert.deepEqual([parseBackupFileName(sealed)?.label, parseBackupFileName(sealed)?.encrypted], ['iPhone', true]);
  for (const other of ['annai-backup-2026-10-16.annai.zip', 'notes.txt', 'annai-backup-20261016T180405123Z-iphone-short.annai.zip', '']) {
    assert.equal(parseBackupFileName(other), null, other);
  }
});

test('a whole-file backup is the archive file, named for this device, and comes back as it went', async () => {
  const place = memoryFilePlace();
  const d = await device(place);
  const id = await filePlaceOn(d);
  const result = await d.backups.backUp(id);
  const [name] = [...place.files.keys()];
  assert.equal(result.id, name);
  assert.deepEqual([parseBackupFileName(name)?.label, parseBackupFileName(name)?.encrypted], ['iPhone', false]);
  assert.equal((await d.backups.get(id))?.last?.id, name);
  const opened = await openArchive(await d.backups.download(id, name));
  assert.ok(opened.manifest.scopes.some((s) => s.record.id === d.trip));
});

test('encrypted with the passphrase annai keeps for the place; API keys only when ticked (spec §12.2)', async () => {
  const place = memoryFilePlace();
  const d = await device(place);
  await d.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('endpoint:x', 'sk-model-key-0001'));
  const id = await filePlaceOn(d);
  await assert.rejects(d.backups.update(id, { encrypt: true }), (e) => e instanceof TargetError && e.kind === 'setup' && /passphrase/.test(e.message));
  await assert.rejects(d.backups.update(id, { keys: true }), (e) => e instanceof TargetError && /only in encrypted backups/.test(e.message));
  await d.backups.update(id, { encrypt: true, passphrase: 'pine needle' });
  assert.notEqual((await d.backups.get(id))?.checked, null, 'a passphrase is no new sign-in');
  assert.deepEqual(await d.backups.savedSecrets(id), ['passphrase']);
  const first = await d.backups.backUp(id);
  assert.match(first.id, /\.annai$/);
  assert.deepEqual((await d.backups.remote(id)).map((b) => b.encrypted), [true], 'the listing says which backups are encrypted');
  const blob = await d.backups.download(id, first.id);
  await assert.rejects(openArchive(blob), NeedsPassphraseError);
  assert.equal((await openArchive(blob, 'pine needle')).manifest.secrets, undefined);
  await d.backups.update(id, { keys: true });
  await later();
  const second = await d.backups.backUp(id);
  const withKeys = await openArchive(await d.backups.download(id, second.id), 'pine needle');
  assert.equal(typeof withKeys.manifest.secrets, 'string');
  // The model's key travels; the backup place's own sign-in never does (its screen says so).
  const ids = JSON.parse(new TextDecoder().decode(await withKeys.zip.read(/** @type {string} */ (withKeys.manifest.secrets)))).map((/** @type {any} */ x) => x.id);
  assert.deepEqual(ids, ['endpoint:x']);
  // A new passphrase: the old backup opens with the old one, the next with the new one.
  await d.backups.update(id, { passphrase: 'cedar bark' });
  await later();
  const third = await d.backups.backUp(id);
  await openArchive(await d.backups.download(id, first.id), 'pine needle');
  await openArchive(await d.backups.download(id, third.id), 'cedar bark');
  // Unticking encryption unticks the keys too.
  await d.backups.update(id, { encrypt: false });
  assert.deepEqual([(await d.backups.get(id))?.encrypt, (await d.backups.get(id))?.keys], [false, false]);
  const text = await everything(d.store);
  assert.equal(text.includes('pine needle') || text.includes('cedar bark'), false);
});

test('single writer, for whole files: a newer backup from another device pauses this one (spec §12.4)', async () => {
  const place = memoryFilePlace();
  const phone = await device(place, 'iPhone');
  const android = await device(place, 'Android phone');
  const a = await filePlaceOn(phone);
  await phone.backups.backUp(a);
  const b = await filePlaceOn(android);
  assert.equal((await android.backups.get(b))?.hold?.kind, 'newer');
  await later();
  await android.backups.backUp(b, { over: true });
  await assert.rejects(phone.backups.backUp(a), (e) => e instanceof TargetError && e.kind === 'newer' && e.remote?.label === 'Android phone');
  assert.equal(place.files.size, 2);
});

test("keeps the last few of this device's backups; another device's are never deleted; a failed deletion is no failed backup", async () => {
  const place = memoryFilePlace();
  const phone = await device(place);
  const android = await device(place, 'Android phone');
  await android.backups.backUp(await filePlaceOn(android));
  const a = await filePlaceOn(phone, { keep: 2 });
  for (let i = 0; i < 4; i++) {
    await later();
    await phone.backups.backUp(a, { over: true });
  }
  const mine = () => [...place.files.keys()].filter((n) => n.includes('-iphone-')).sort();
  assert.equal(mine().length, 2);
  assert.equal([...place.files.keys()].filter((n) => n.includes('-android-phone-')).length, 1);
  assert.equal((await phone.backups.get(a))?.last?.id, mine().at(-1));
  place.failDeleteNext(new TargetError('other', 'The server said no.'));
  await later();
  await phone.backups.backUp(a);
  assert.equal(mine().length, 3);
  const errors = await phone.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.error'] }));
  assert.deepEqual([errors.at(-1)?.data.kind, errors.at(-1)?.data.message], ['prune', 'The server said no.']);
  assert.ok((await phone.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.prune'] }))).length >= 2);
  assert.equal((await phone.backups.get(a))?.hold, null);
});

test('a whole file over the limit waits for the user, before anything is sent', async () => {
  const place = memoryFilePlace();
  const d = await device(place);
  const id = await filePlaceOn(d);
  await assert.rejects(d.backups.backUp(id, { maxUpload: 10, reason: 'auto' }), (e) => e instanceof TargetError && e.kind === 'large' && (e.bytes ?? 0) > 10);
  assert.equal(place.files.size, 0);
});

test("minors 23: single writer, for whole files, with a clock that is behind: another device's backup made after this one's base is newer, whatever its time says", async () => {
  const place = memoryFilePlace();
  const phone = await device(place, 'iPhone');
  /** The Android phone's backups, by its clock, an hour behind. */
  const android = () => {
    const name = backupFileName({ at: Date.now() - 3_600_000, label: 'Android phone', device: 'k3j2h4l1abcd', encrypted: false });
    place.files.set(name, new Blob(['a backup']));
    return name;
  };
  android();
  const a = await filePlaceOn(phone);
  await phone.backups.backUp(a, { over: true });
  await later();
  await phone.backups.backUp(a);
  assert.equal((await phone.backups.get(a))?.hold, null);
  // The Android phone backs up after the iPhone did; its file says an hour earlier.
  await later();
  const skewed = android();
  await assert.rejects(phone.backups.backUp(a), (e) => e instanceof TargetError && e.kind === 'newer' && e.remote?.id === skewed);
  assert.equal((await phone.backups.check(a)).newer?.id, skewed, 'its screen says so too');
  // Backed up over it, it is known: the next backup goes ahead.
  await later();
  await phone.backups.backUp(a, { over: true });
  await later();
  await phone.backups.backUp(a);
  assert.equal((await phone.backups.get(a))?.hold, null);
  // A device it never saw, whose clock is a day behind: newer too.
  const stranger = backupFileName({ at: Date.now() - 86_400_000, label: 'iPad', device: 'q8w7e6r5t4y3', encrypted: false });
  place.files.set(stranger, new Blob(['a backup']));
  await later();
  await assert.rejects(phone.backups.backUp(a), (e) => e instanceof TargetError && e.kind === 'newer' && e.remote?.id === stranger);
});

test('minors 25: a change that fails its checks keeps nothing of itself: no new sign-in, no new passphrase', async () => {
  const place = memoryFilePlace();
  const d = await device(place);
  const id = await filePlaceOn(d);
  await d.backups.update(id, { secret: { token: 'old-token-0001' }, encrypt: true, passphrase: 'pine needle' });
  const secret = () => d.store.tx(['secrets'], 'readonly', (t) => t.getSecret(`backup:${id}`));
  const before = await secret();
  await assert.rejects(d.backups.update(id, { secret: { token: 'new-token-0002' }, passphrase: '' }), /Type a passphrase/);
  assert.deepEqual(await secret(), before);
  const fresh = await filePlaceOn(d);
  await assert.rejects(d.backups.update(fresh, { secret: { token: 'new-token-0002' }, passphrase: 'cedar bark', keys: true }), /only in encrypted backups/);
  assert.equal(await d.store.tx(['secrets'], 'readonly', (t) => t.getSecret(`backup:${fresh}`)), undefined);
});

test('fix pass R1: "Back up over it" covers the place as the user saw it, every device listed then; a backup made after still gets its own decision', async () => {
  const place = memoryFilePlace();
  const phone = await device(place, 'iPhone');
  /** Another device's backup, made now. @param {string} label @param {string} id */
  const other = (label, id) => {
    const name = backupFileName({ at: Date.now(), label, device: id, encrypted: false });
    place.files.set(name, new Blob(['a backup']));
    return name;
  };
  const a = await filePlaceOn(phone);
  await phone.backups.backUp(a);
  await later();
  other('Android phone', 'k3j2h4l1abcd');
  await later();
  const ipad = other('iPad', 'q8w7e6r5t4y3');
  await later();
  await assert.rejects(phone.backups.backUp(a), (e) => e instanceof TargetError && e.kind === 'newer' && e.remote?.id === ipad);
  // One tap goes over both: the Android's backup was there when the user saw the iPad's.
  await later();
  await phone.backups.backUp(a, { over: true });
  assert.equal((await phone.backups.get(a))?.hold, null);
  // Held again, found on the place's screen; the Android backs up before the user taps.
  await later();
  other('iPad', 'q8w7e6r5t4y3');
  assert.ok((await phone.backups.check(a)).newer);
  await later();
  const after = other('Android phone', 'k3j2h4l1abcd');
  await later();
  await assert.rejects(phone.backups.backUp(a, { over: true }), (e) => e instanceof TargetError && e.kind === 'newer' && e.remote?.id === after);
  await later();
  await phone.backups.backUp(a, { over: true });
  assert.equal((await phone.backups.get(a))?.hold, null);
});
