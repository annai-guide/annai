import { parseIcs, planItems, MAX_ICS_BYTES } from './ics.js';

/**
 * Importing a calendar file creates plan items (spec §8): one per event, written as the user's,
 * each naming the file it came from.
 * @param {import('./workspace.js').Workspace} ws @param {string} scope @param {string} path @param {{ defaultTz: string }} o
 * @returns {Promise<string[]>} the plan items' paths
 */
export async function importCalendar(ws, scope, path, { defaultTz }) {
  const got = await ws.read(scope, path);
  if (!got) throw new Error(`No file at ${path}.`);
  if (got.bytes.byteLength > MAX_ICS_BYTES) throw new Error(`${path} is larger than a trip's calendar ever is (over ${MAX_ICS_BYTES / 1048576} MB). Export only the trip's dates from your calendar, and add that file.`);
  const items = planItems(parseIcs(new TextDecoder().decode(got.bytes), { defaultTz }));
  for (const { path: p, item } of items) await ws.write(scope, p, item, { author: 'user', source: path });
  return items.map((x) => x.path);
}
