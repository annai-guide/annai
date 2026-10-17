import { readFile } from 'node:fs/promises';
import { MORNING } from '../unit/after-kit.js';
import { BIXBY } from '../unit/live-kit.js';

const PHOTO = [...await readFile(new URL('../fixtures/photos/plain.jpg', import.meta.url))];
/** A moment of the drive's day, Pacific time. @param {string} hhmm */
export const at = (hhmm) => Date.parse(`2026-11-27T${hhmm}:00-08:00`);

/**
 * A trip's morning on Highway 1, written through annai's own modules in the page: its road (thinned
 * as the log keeps it), the arrival at Bixby Creek Bridge, Shiori's card, the user's words, a photo,
 * and the castle tour on the plan (which names the stay there).
 * @param {import('@playwright/test').Page} page @param {string} trip
 */
export async function seedMorning(page, trip) {
  const events = [
    ...MORNING.map((p) => ({ ts: p.at, type: 'location', data: { lat: p.lat, lng: p.lng, accuracy: 8 } })),
    { ts: at('09:32'), type: 'trigger.fired', data: { watch: 'plan:bixby:arrived', type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } },
    { ts: at('09:35'), type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in **1932**, 85 m above the creek.' } } },
    { ts: at('09:36'), type: 'msg.user', data: { text: 'Sam wants to see the sea lions.' } },
  ].sort((a, b) => a.ts - b.ts);
  await page.evaluate(async ({ trip, events, photo }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    await store.tx(['events'], 'readwrite', async (/** @type {any} */ t) => {
      for (const e of events) await t.appendEvent(trip, { ts: e.ts, type: e.type, actor: 'system', data: e.data });
    });
    const ws = new Workspace(store);
    await ws.patch(trip, '/trip.json', { timezones: ['America/Los_Angeles'] }, { author: 'user' });
    await ws.write(trip, '/plan/hearst.json', { id: 'hearst', title: 'Hearst Castle tour', fixed: true, start: { at: '2026-11-27T16:30:00-08:00', tz: 'America/Los_Angeles' }, place: { name: 'Hearst Castle', lat: 35.6852, lng: -121.166 } }, { author: 'user' });
    await ws.write(trip, '/files/2026-11-27-0945.jpg', Uint8Array.from(photo), { author: 'user', type: 'image/jpeg', meta: { taken: '2026-11-27T09:45:00', width: 64, height: 48 } });
    store.close();
  }, { trip, events, photo: PHOTO });
}
