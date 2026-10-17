// Fails when the JavaScript and CSS annai ships grow past the budget (spec §18).
import { readFile, stat } from 'node:fs/promises';

const BUDGET = 960 * 1024; // bytes, uncompressed; raised from 740 KiB for milestone 3 (voice): 820, then 880 when Shiori learned to talk and listen; 960 for milestone 5 (live mode)
const root = new URL('../', import.meta.url);
const sw = await readFile(new URL('sw.js', root), 'utf8');
const shell = [...(/const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').matchAll(/'(\/[^']+\.(?:js|css))'/g)].map((m) => m[1]);
let total = 0;
for (const p of shell) total += (await stat(new URL(p.slice(1), root))).size;
total += (await stat(new URL('sw.js', root))).size;
console.log(`shipped JS + CSS: ${(total / 1024).toFixed(1)} KiB (budget ${BUDGET / 1024} KiB)`);
if (total > BUDGET) {
  console.error('Over budget: trim code or raise the budget on purpose.');
  process.exit(1);
}
