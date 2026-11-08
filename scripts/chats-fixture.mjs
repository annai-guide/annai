#!/usr/bin/env node
// A backup of 500 synthetic chats over a year, six lines each, and 3 dated trips, made through annai's own export on a memory store:
// how a phone gets a big timeline to try (Open a trip someone sent you). Dev-only: never shipped.
//   node scripts/chats-fixture.mjs <out.annai.zip>
import { writeFile } from 'node:fs/promises';
import { createMemoryStore } from '../test/fakes/store-memory.js';
import { Workspace } from '../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../src/core/scopes.js';
import { record } from '../src/core/agent/log.js';
import { exportArchive, PRESETS } from '../src/core/archive.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/chats-fixture.mjs <out.annai.zip>');
  process.exit(2);
}
const CHATS = 500;
const DAY = 86_400_000;
const now = Date.now();
const day = (/** @type {number} */ n) => new Date(now + n * DAY).toISOString().slice(0, 10);
const ASKS = ['Where should we eat tonight?', 'Is the museum open on Mondays?', 'How long is the walk to the station?', 'What should I pack for rain?', 'Any quiet cafés near the park?', 'When does the last train leave?'];
const ANSWERS = ['There are two places a short walk away.', 'It opens at ten, and closes early on Mondays.', 'About twenty minutes on foot.', 'A light jacket and an umbrella.', 'One by the north gate, and one across the bridge.', 'The last one leaves at 23:40.'];

const store = createMemoryStore();
const ws = new Workspace(store);
await ensureBaseScopes(ws);
for (let i = 0; i < CHATS; i++) {
  const at = now - Math.round(((i + 0.5) / CHATS) * 365 * DAY); // spread over the last year, newest first
  const ask = ASKS[i % ASKS.length];
  const id = await createTrip(ws, { title: ask });
  for (let k = 0; k < 3; k++) {
    await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', k ? `And then? (${k})` : ask]], now: at + k * 60_000 });
    await record(store, id, { type: 'out.speak', actor: 'shiori', data: { text: ANSWERS[(i + k) % ANSWERS.length], by: null }, now: at + k * 60_000 + 20_000 });
  }
}
for (const [title, from, to] of /** @type {const} */ ([['Testville', -40, -35], ['Testville again', -1, 3], ['Laterton', 20, 24]])) {
  await createTrip(ws, { title, start: day(from), end: day(to) });
}
const { blob } = await exportArchive(store, { kind: 'everything', include: PRESETS.backup, app: 'chats-fixture' });
await writeFile(out, new Uint8Array(await blob.arrayBuffer()));
console.log(`wrote ${out}: ${CHATS} chats and 3 dated trips`);
