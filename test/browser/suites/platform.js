import { sha256Hex } from '../../../src/core/hash.js';
import { ZipWriter, readZip } from '../../../src/core/zip.js';
import { encrypt, decrypt } from '../../../src/core/archive-crypto.js';
import { utf8, text } from '../../../src/core/bytes.js';
import { createIdbStore, eraseDatabase } from '../../../src/core/store-idb.js';
import { Workspace } from '../../../src/core/workspace.js';
import { makeSchemaFor } from '../../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS } from '../../../src/core/archive.js';

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('SHA-256 works here', async () => {
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('zip with deflate-raw round-trips here', async () => {
    const z = new ZipWriter();
    await z.add('notes/案内.md', utf8('案内 '.repeat(500)));
    const out = await readZip(new Uint8Array(await z.finish().arrayBuffer()));
    assert.equal(text(/** @type {Uint8Array} */ (out.get('notes/案内.md'))), '案内 '.repeat(500));
  });

  test('archive encryption round-trips here', async () => {
    const enc = await encrypt(utf8('trip'), 'pass', 100_000);
    assert.equal(text(await decrypt(enc, 'pass')), 'trip');
  });

  test('a trip exported from one IndexedDB imports into another', async () => {
    const names = [`annai-test-a-${Date.now()}`, `annai-test-b-${Date.now()}`];
    for (const n of names) await eraseDatabase(n);
    const [sa, sb] = await Promise.all(names.map((n) => createIdbStore(n)));
    const lookup = makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf);
    const a = new Workspace(sa, { schemaFor: lookup });
    const b = new Workspace(sb, { schemaFor: lookup });
    await ensureBaseScopes(a);
    await ensureBaseScopes(b);
    const trip = await createTrip(a, { title: 'Big Sur' });
    await a.write(trip, '/notes/day1.md', 'one', { author: 'user' });
    await a.write(trip, '/notes/day1.md', 'two', { author: 'user' });
    await a.write(trip, '/files/photo.jpg', crypto.getRandomValues(new Uint8Array(30000)), { author: 'user' });
    const { blob } = await exportArchive(sa, { kind: 'trip', scopes: [trip], include: PRESETS.backup, passphrase: 'p', iterations: 100_000, app: '0.1.0' });
    const r = await importArchive(sb, await openArchive(new Uint8Array(await blob.arrayBuffer()), 'p'));
    const copy = r.trips[0];
    assert.equal(await b.readText(copy, '/notes/day1.md'), 'two');
    assert.equal((await b.history(copy, '/notes/day1.md')).length, 2);
    assert.deepEqual((await b.read(copy, '/files/photo.jpg'))?.bytes, (await a.read(trip, '/files/photo.jpg'))?.bytes);
    sa.close();
    sb.close();
    for (const n of names) await eraseDatabase(n);
  });
}
