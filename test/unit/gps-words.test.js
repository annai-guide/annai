import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { liveText } from '../../src/ui/live-chip.js';

// "sorry let's use GPS on and off. simple and easy for everyone to understand." (the user, 2026-10-23)
const ROOT = new URL('../../', import.meta.url);

/** Every file under a folder, as paths from the repo root. @param {string} dir @returns {Promise<string[]>} */
async function files(dir) {
  const out = [];
  for (const e of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await files(`${dir}${e.name}/`)));
    else out.push(`${dir}${e.name}`);
  }
  return out;
}

test('the GPS switch is GPS on and GPS off in every word the user sees or Shiori is told', async () => {
  const live = { on: false, gps: 'off', activity: 'unknown', fix: null };
  assert.equal(liveText(live), 'GPS off');
  assert.equal(liveText({ ...live, on: true, gps: 'waiting' }), 'GPS on · finding you');
  // The old names are gone from the app's own files: the screens, the engine, her skill and the plugins' words.
  const found = [];
  for (const dir of ['src/', 'skills/', 'plugins-official/']) {
    for (const f of await files(dir)) {
      if (!/\.(js|md|json|html)$/.test(f)) continue;
      const text = await readFile(new URL(f, ROOT), 'utf8');
      if (/On the road|Off the road|[Ss]tart on the road|[Ss]top on the road|off the road/.test(text)) found.push(f);
    }
  }
  assert.deepEqual(found, []);
});
