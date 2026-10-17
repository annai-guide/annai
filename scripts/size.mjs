// Fails when the JavaScript and CSS annai ships grow past the budget (spec §18).
import { readFile, stat } from 'node:fs/promises';

const BUDGET = 1466 * 1024; // bytes, uncompressed; raised from 740 KiB for milestone 3 (voice): 820, then 880 when Shiori learned to talk and listen; 960 when milestone 9 (backups) joined it, and for milestone 5 (live mode); 1080 with both; 1135 for the offline pack; 1150 with the review fixes; 1250 for milestone 7 (after the trip); 1320 with milestone 6 (notifications); 1380 for milestone 8a (skills and packages); 1420 for milestone 8b (plugins in the UI); 1460 for milestone 8c (MCP); 1465 for the milestone 8 fix pass; 1466 for the minors batch (voice, live mode, push, after the trip)
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
