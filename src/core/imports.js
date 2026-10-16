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

/**
 * What Shiori is told when the user adds files to a trip (spec §7.3: "Shiori is woken with 'new file'").
 * @param {{ path: string, type: string }[]} files @param {string[]} planned plan items annai made from calendar files
 */
export function newFilesText(files, planned) {
  const shown = files.slice(0, 20).map((f) => `/trip${f.path} (${f.type})`);
  const more = files.length > shown.length ? `, and ${files.length - shown.length} more` : '';
  const allPhotos = files.every((f) => f.type.startsWith('image/'));
  return [
    `The user added ${files.length === 1 ? 'a file' : `${files.length} files`} to the trip: ${shown.join(', ')}${more}.`,
    planned.length ? `annai made ${planned.length} plan ${planned.length === 1 ? 'item' : 'items'} from the calendar: ${planned.slice(0, 20).map((p) => `/trip${p}`).join(', ')}.` : '',
    "If one is a booking (a confirmation, ticket, Wallet pass or reservation), read it, write an unverified booking in /trip/bookings/ with source set to its path, add the fixed plan items it implies with booking set to the booking's path, and ask only about what you are unsure of.",
    allPhotos ? "If these are just trip photos, they need nothing from you: don't open them all." : '',
  ].filter(Boolean).join(' ');
}
