/**
 * Everything a store holds, as plain data to compare before and after: the scopes, each scope's files and log entries, and every
 * blob with its bytes. Used by the tests that must show an operation changed nothing (forget's dry run), on the memory store and
 * on IndexedDB alike.
 * @param {import('../../src/core/types.js').Store} store
 */
export async function snapshot(store) {
  return store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (t) => {
    const scopes = (await t.listScopes()).sort((a, b) => (a.id < b.id ? -1 : 1));
    const ids = [...new Set([...scopes.map((s) => s.id), ...(await t.scopesWithData())])].sort();
    const blobs = [];
    for (const { hash } of (await t.listBlobs()).sort((a, b) => (a.hash < b.hash ? -1 : 1))) {
      const b = await t.getBlob(hash);
      blobs.push({ hash, type: b?.type, size: b?.size, data: b ? [...new Uint8Array(b.data)] : null });
    }
    return JSON.parse(JSON.stringify({
      scopes,
      files: await Promise.all(ids.map(async (id) => [id, await t.listFiles(id)])),
      events: await Promise.all(ids.map(async (id) => [id, await t.listEvents(id)])),
      blobs,
    }));
  });
}
