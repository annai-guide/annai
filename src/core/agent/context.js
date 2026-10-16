import { CORE, DEFAULT_PERSONALITY } from './instructions.js';
import { ME } from '../scopes.js';
import { tsv } from '../tsv.js';
import { sha256Hex } from '../hash.js';
import { utf8 } from '../bytes.js';

/**
 * The context, in the order that keeps provider caches warm (spec §6.3):
 * 1. core instructions, the personality, the tools;
 * 2. a snapshot of the profile, memory, skill index and trip;
 * 3. the transcript, which only grows at the end;
 * 4. the now block, last, after the cache marker.
 * @typedef {{ trip: string | null, personalityName: string, personality: string, profile: string, memory: string,
 *   tripInfo: string, tripMemory: string, skills: { name: string, description: string }[] }} Snapshot
 * @typedef {import('../llm/contract.js').Request} Request
 */

/**
 * @param {{ ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry, trip: string | null, personalityName: string }} c
 * @returns {Promise<Snapshot>}
 */
export async function takeSnapshot({ ws, registry, trip, personalityName }) {
  const read = async (/** @type {string} */ scope, /** @type {string} */ path) => (await ws.readText(scope, path).catch(() => undefined)) ?? '';
  const tripJson = trip ? await ws.readJSON(trip, '/trip.json').catch(() => null) : null;
  return {
    trip,
    personalityName,
    personality: (await read(ME, `/personalities/${personalityName}.md`)) || DEFAULT_PERSONALITY,
    profile: await read(ME, '/profile.md'),
    memory: await read(ME, '/memory.md'),
    tripInfo: tripJson ? JSON.stringify(tripJson, null, 2) : '',
    tripMemory: trip ? await read(trip, '/memory.md') : '',
    skills: registry.list('skill').filter((s) => s?.name).map((s) => ({ name: String(s.name), description: String(s.description ?? '') })),
  };
}

/**
 * The snapshot for this wake. Rewriting the prefix costs a cold cache, so it happens only when the
 * cache is cold or about to expire (spec §6.4), or for another trip. An approved personality
 * change comes at the next wake whatever the cache (§14.1).
 * @param {Snapshot | null} prev @param {Snapshot} fresh @param {{ cold: boolean }} c @returns {Snapshot}
 */
export function nextSnapshot(prev, fresh, { cold }) {
  if (!prev || cold || prev.trip !== fresh.trip) return fresh;
  if (prev.personality === fresh.personality && prev.personalityName === fresh.personalityName) return prev;
  return { ...prev, personality: fresh.personality, personalityName: fresh.personalityName };
}

/** The system text: core, personality, then the snapshot. @param {Snapshot} s */
export function systemText(s) {
  const parts = [CORE, s.personality.trim()];
  if (s.profile.trim()) parts.push(`# About the user (/me/profile.md)\n${s.profile.trim()}`);
  if (s.memory.trim()) parts.push(`# What you remember (/me/memory.md)\n${s.memory.trim()}`);
  if (s.skills.length) parts.push(`# Skills (load one with the skill tool)\n${s.skills.map((k) => `${k.name}: ${k.description}`).join('\n')}`);
  if (s.trip) parts.push(`# This trip (/trip/trip.json)\n${s.tripInfo}`, s.tripMemory.trim() ? `${s.tripMemory.trim()}` : '# Trip memory\n(empty)');
  else parts.push('# No trip is open\n/trip/ is empty. The user can open a trip from Trips.');
  return parts.join('\n\n');
}

/** The next plan items, as TSV rows: start, title, fixed, place. @param {import('../workspace.js').Workspace} ws @param {string | null} trip @param {number} now */
export async function nextPlanItems(ws, trip, now, limit = 5) {
  if (!trip) return [];
  const items = [];
  for (const f of await ws.list(trip, '/plan/')) {
    if (!f.path.endsWith('.json')) continue;
    const it = await ws.readJSON(trip, f.path).catch(() => null);
    const at = Date.parse(it?.start?.at ?? '');
    if (Number.isFinite(at) && at >= now) items.push({ at, it });
  }
  items.sort((a, b) => a.at - b.at);
  return items.slice(0, limit).map(({ it }) => [it.start.at, it.title, it.fixed ? 'yes' : 'no', it.place?.name ?? '']);
}

/** @param {number} now @param {string} timeZone */
function localTime(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}, ${timeZone} (${parts.timeZoneName})`;
}

const VOICE = /** @type {Record<string, string>} */ ({ off: 'off (speak shows a bubble; wait waits for typing)', on: 'on', auto: 'auto' });

/**
 * The now block (spec §6.3, item 4): sent last, never cached.
 * @param {{ now: number, timeZone: string, voice: string, online: boolean, reasons: string[], plan: string[][], place?: string, activity?: string }} c
 */
export function nowBlock({ now, timeZone, voice, online, reasons, plan, place = 'unknown', activity = 'unknown' }) {
  const lines = [
    `time: ${localTime(now, timeZone)}`,
    `place: ${place}`,
    `activity: ${activity}`,
    `voice: ${VOICE[voice] ?? voice}`,
    `connection: ${online ? 'online' : 'offline'}`,
    `woke for: ${reasons.length ? reasons.join('; ') : 'a reason annai did not record'}`,
    plan.length ? `next in the plan:\n${tsv(['start', 'title', 'fixed', 'place'], plan)}` : 'next in the plan: nothing',
  ];
  return `<now>\n${lines.join('\n')}\n</now>`;
}

/**
 * @param {{ snapshot: Snapshot, tools: import('../llm/contract.js').ToolDef[], transcript: { messages: import('../llm/contract.js').Message[] },
 *   tail: string, cacheTtl: '5m' | '1h', maxOutput?: number }} c
 * @returns {Request}
 */
export function buildRequest({ snapshot, tools, transcript, tail, cacheTtl, maxOutput }) {
  return { system: systemText(snapshot), tools, messages: transcript.messages, tail, cacheTtl, ...(maxOutput ? { maxOutput } : {}) };
}

/**
 * Names the cached prefix: the system text and tools, and the compaction the transcript starts
 * from (after it, the transcript only grows at the end). @param {Request} request @param {number} compaction
 */
export function prefixFingerprint(request, compaction) {
  return sha256Hex(utf8(JSON.stringify([request.system ?? '', request.tools ?? [], compaction])));
}
