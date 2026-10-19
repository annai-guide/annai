import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// The core names no provider (spec §9.8, milestone 4): what a provider needs is in its plugin, and the
// one-tap start is the catalog's featured provider.
const root = new URL('../../', import.meta.url);

/** Every file under a folder, as URLs. @param {URL} dir @returns {Promise<URL[]>} */
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const u = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
    out.push(...(e.isDirectory() ? await walk(u) : [u]));
  }
  return out;
}

test('the core names no provider: src/ holds no "OpenRouter" and no provider plugin id', async () => {
  const ids = (await readdir(new URL('plugins-official/', root))).filter((n) => n.startsWith('provider-'));
  assert.ok(ids.includes('provider-openrouter') && ids.includes('provider-another-address'));
  /** @type {string[]} */
  const found = [];
  for (const f of await walk(new URL('src/', root))) {
    const text = await readFile(f, 'utf8');
    const where = f.pathname.slice(root.pathname.length);
    if (/openrouter/i.test(text)) found.push(`${where}: OpenRouter`);
    for (const id of ids) if (text.includes(id)) found.push(`${where}: ${id}`);
  }
  assert.deepEqual(found, []);
});
