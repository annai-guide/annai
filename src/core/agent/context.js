import { CORE, DEFAULT_PERSONALITY } from './instructions.js';
import { editedInstructions } from './her-instructions.js';
import { ME, DRAFT_TITLE, listTrips } from '../scopes.js';
import { phaseOf, talkedAt } from '../timeline.js';
import { deviceZone } from '../time.js';
import { quote } from './blocks.js';
import { tsv } from '../tsv.js';
import { sha256Hex } from '../hash.js';
import { utf8 } from '../bytes.js';
import { readAppSettings } from '../settings.js';
import { languageSettings, languagesText, screensText, distancesText } from '../languages.js';
import { lang, glossary } from '../l10n.js';
import { blobJSON } from '../reach.js';

/**
 * The context, in the order that keeps provider caches warm (spec §6.3):
 * 1. core instructions, the personality, the tools;
 * 2. a snapshot of the profile, memory, skill index and trip;
 * 3. the transcript, which only grows at the end;
 * 4. the now block, last, after the cache marker.
 * @typedef {{ trip: string | null, personalityName: string, personality: string, profile: string, memory: string,
 *   tripInfo: string, guessed?: boolean, tripMemory: string, skills: { name: string, description: string }[], languages?: string, edited?: Partial<Record<import('./her-instructions.js').InstructionId, string>>,
 *   elsewhere?: string }} Snapshot
 *   languages: the languages section's words, from the languages setting; edited: the instructions the user changed (her-instructions.js);
 *   elsewhere: for an undated one, what read_trip may mean (the happening trips, the latest others);
 *   guessed: the trip's name is annai's own first guess (a first line's words or a file's name, the system's write of trip.json, or the draft's
 *   placeholder), or, while it has no dates, her own: not one the user gave
 * @typedef {import('../llm/contract.js').Request} Request
 */

/**
 * @param {{ ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry, trip: string | null, personalityName: string, locale?: string }} c
 *   locale: the browser's language, which the languages are until the user chooses
 * @returns {Promise<Snapshot>}
 */
export async function takeSnapshot({ ws, registry, trip, personalityName, locale }) {
  const read = async (/** @type {string} */ scope, /** @type {string} */ path) => (await ws.readText(scope, path).catch(() => undefined)) ?? '';
  const tripJson = trip ? await ws.readJSON(trip, '/trip.json').catch(() => null) : null;
  // Whose name it is: annai's naming (Chats) writes trip.json as the system; a rename in Details and Start a trip are the user's. After a write
  // of hers to an undated one, the name's is whoever wrote the version that first held it: her own name for a chat stays hers to change (F7).
  const author = trip && tripJson ? (await ws.read(trip, '/trip.json').catch(() => undefined))?.entry.author : undefined;
  const guessed = Boolean(tripJson) && (tripJson.title === DRAFT_TITLE || author === 'system'
    || (author === 'shiori' && !tripJson.start && (await namedBy(ws, /** @type {string} */ (trip), tripJson.title)) !== 'user'));
  const app = await readAppSettings(ws);
  /* en */ return {
    trip,
    personalityName,
    personality: (await read(ME, `/personalities/${personalityName}.md`)) || DEFAULT_PERSONALITY,
    profile: await read(ME, '/profile.md'),
    memory: await read(ME, '/memory.md'),
    tripInfo: tripJson ? JSON.stringify(tripJson, null, 2) : '',
    guessed,
    tripMemory: trip ? await read(trip, '/memory.md') : '',
    skills: skillIndex(registry),
    // Then the screens' names and a Distances choice.
    languages: [languagesText(languageSettings(app, locale)), screensText(lang(), glossary()), distancesText(app)].filter(Boolean).join(' '),
    edited: await editedInstructions(ws),
    elsewhere: trip && !tripJson?.start ? await elsewhere(ws, trip) : '', // as systemText tells an undated one
  };
}

/** Who wrote the version of trip.json that first held this title, going back while each version holds it. @param {import('../workspace.js').Workspace} ws @param {string} trip @param {unknown} title */
async function namedBy(ws, trip, title) {
  let by = '';
  for (const v of (await ws.history(trip, '/trip.json')).reverse()) {
    if (v.type !== 'file.write' || (await blobJSON(ws.store, trip, v.new, { quiet: true }))?.title !== title) break;
    by = v.actor;
  }
  return by;
}

/** The longest name annai takes (start_trip, Start a trip, Details); a file's record can hold more. */
const TITLE_MAX = 200;

/** @param {import('../workspace.js').Workspace} ws @param {string} trip */
async function elsewhere(ws, trip) {
  const others = (await listTrips(ws.store)).active.filter((s) => s.id !== trip);
  const happening = others.filter((s) => phaseOf(s, Date.now(), deviceZone()) === 'happening'); // as home's now line has them
  // The spec's "last few": five (the plan's call), placed as home places a chat.
  const latest = others.filter((s) => !happening.includes(s)).sort((a, b) => talkedAt(b) - talkedAt(a)).slice(0, 5);
  const named = (/** @type {import('../types.js').ScopeRecord} */ s) => `${quote([...s.title].slice(0, TITLE_MAX).join(''))} (${s.id})`;
  /* en */
  // One trip happening is what "tomorrow" means here: Haiku asked "which place?" with it listed (stage 5's real-model pass).
  const meant = happening.length === 1 ? ' Here "today", "tomorrow" and "the plan" mean that trip: read it rather than ask which place.' : '';
  return [happening.length ? `Happening now: ${happening.map(named).join('; ')}.${meant}` : '', latest.length ? `Their latest other conversations: ${latest.map(named).join('; ')}` : ''].filter(Boolean).join('\n');
}

/**
 * The snapshot for this wake. Rewriting the prefix costs a cold cache, so it happens only when the
 * cache is cold or about to expire (spec §6.4), or for another trip. An approved personality
 * change comes at the next wake whatever the cache (§14.1).
 * @param {Snapshot | null} prev @param {Snapshot} fresh @param {{ cold: boolean }} c @returns {Snapshot}
 */
export function nextSnapshot(prev, fresh, { cold }) {
  if (!prev || cold || prev.trip !== fresh.trip) return fresh;
  const samePersonality = prev.personality === fresh.personality && prev.personalityName === fresh.personalityName;
  // A skill installed or removed shows at once, as a new tool does.
  const sameSkills = JSON.stringify(prev.skills) === JSON.stringify(fresh.skills);
  // So does a change of the languages setting, or of her instructions: the user chose it just now.
  const sameEdits = JSON.stringify(prev.edited ?? {}) === JSON.stringify(fresh.edited ?? {});
  // So does a name that stopped being annai's guess (the user renamed it in Details); a trip.json that couldn't be read says nothing of it.
  const renamed = Boolean(prev.guessed && !fresh.guessed && fresh.tripInfo);
  if (samePersonality && sameSkills && sameEdits && !renamed && prev.languages === fresh.languages) return prev;
  return { ...prev, personality: fresh.personality, personalityName: fresh.personalityName, skills: fresh.skills, languages: fresh.languages, edited: fresh.edited, ...(renamed ? { tripInfo: fresh.tripInfo, guessed: false } : {}) };
}

/** The skill index (spec §6.3): each skill's name and description, once per name (its owner's). @param {import('../registry.js').Registry} registry */
function skillIndex(registry) {
  return registry.list('skill').filter((s) => s?.name).map((s) => ({ name: String(s.name), description: String(s.description ?? '') }));
}

/** The system text: core, personality, a half's own part (Kokoro's, while Shiori is two halves), the languages, then the snapshot. @param {Snapshot} s @param {string} [part] */
export function systemText(s, part = '') {
  const parts = [s.edited?.shiori ?? CORE, s.personality.trim(), ...(part ? [part] : [])];
  if (s.languages) /* en */ parts.push(`# Languages\n${s.languages}`);
  if (s.profile.trim()) /* en */ parts.push(`# About the user (/me/profile.md)\n${s.profile.trim()}`);
  if (s.memory.trim()) /* en */ parts.push(`# What you remember (/me/memory.md)\n${s.memory.trim()}`);
  if (s.skills.length) /* en */ parts.push(`# Skills (load one with the skill tool)\n${s.skills.map((k) => `${k.name}: ${k.description}`).join('\n')}`);
  if (s.trip) {
    /* en */ parts.push(`# This trip (/trip/trip.json)\n${s.tripInfo}`, s.tripMemory.trim() ? `${s.tripMemory.trim()}` : '# Trip memory\n(empty)');
    // From the snapshot, so it stays the same from turn to turn and the cached prefix holds.
    // Her name for it is only for a name annai or she guessed: one the user gave stays, said so (real models renamed the user's).
    if (!datedInfo(s.tripInfo)) /* en */ parts.push(`# This conversation has no dates\n${s.guessed ? 'Its name is a first guess: patch /trip/trip.json when you know a better one. If it becomes a trip, patch its title and dates there.' : 'Keep its name unless they ask to change it. If it becomes a trip, patch /trip/trip.json with its dates.'}\nIf this is about one of their trips, read it with read_trip first and answer here; take them there with open_trip only if they want to carry on there.${s.elsewhere ? `\n${s.elsewhere}` : ''}`);
    // A dated trip's text names no other trip (so nothing done elsewhere moves it), but says they exist: asked about another trip's
    // hotel in a trip's own conversation, every model searched this one and said there was none (stage 5's real-model pass).
    else /* en */ parts.push("# Their other trips\nA trip or place they name that isn't this one may be another of theirs: look in list_trips before you say it isn't there.");
  } else /* en */ parts.push('# No trip is open\n/trip/ is empty. The user can open a trip from Trips.');
  return parts.join('\n\n');
}

/** Whether a snapshot's trip.json has a start. @param {string} info */
function datedInfo(info) {
  try {
    return Boolean(JSON.parse(info)?.start);
  } catch {
    return false;
  }
}

/** A trip's plan items that have a start, soonest first. @param {import('../workspace.js').Workspace} ws @param {string} trip @returns {Promise<{ at: number, it: any }[]>} */
export async function planItems(ws, trip) {
  const items = [];
  for (const f of await ws.list(trip, '/plan/')) {
    if (!f.path.endsWith('.json')) continue;
    const it = await ws.readJSON(trip, f.path).catch(() => null);
    const at = Date.parse(it?.start?.at ?? '');
    if (Number.isFinite(at)) items.push({ at, it });
  }
  return items.sort((a, b) => a.at - b.at);
}

/** The next plan items, as TSV rows: start, title, fixed, place. @param {import('../workspace.js').Workspace} ws @param {string | null} trip @param {number} now */
export async function nextPlanItems(ws, trip, now, limit = 5) {
  if (!trip) return [];
  return (await planItems(ws, trip)).filter((x) => x.at >= now).slice(0, limit).map(({ it }) => [it.start.at, it.title, it.fixed ? 'yes' : 'no', it.place?.name ?? '']);
}

/** @param {number} now @param {string} timeZone */
function localTime(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}, ${timeZone} (${parts.timeZoneName})`;
}

/* en */ const VOICE = /** @type {Record<string, string>} */ ({ off: 'off (speak shows a bubble; wait waits for typing)', on: 'on (speak plays aloud, then listens; wait listens; ask is spoken too)' });
/** Koe's state, as Kokoro's now block says it (the Koe and Kokoro design). */
/* en */ const KOE = /** @type {Record<string, string>} */ ({ text: 'talking with the user (use tell_koe)', live: 'talking with the user live (use tell_koe)', down: "can't speak now: talk to the user directly" });

/**
 * The now block (spec §6.3, item 4): sent last, never cached.
 * @param {{ now: number, timeZone: string, voice: string, online: boolean, reasons: string[], plan: string[][] | null, place?: string, activity?: string, voiceWhy?: string, koe?: string }} c
 *   voiceWhy: why voice is on with its setting off (spec §10.5); plan null: no plan line (Koe's view has the plan); koe: Koe's state, for Kokoro;
 *   reasons: what woke her, or joined her turn, since her last request: none, no line (each is said once)
 */
export function nowBlock({ now, timeZone, voice, online, reasons, plan, place = 'unknown', activity = 'unknown', voiceWhy = '', koe }) {
  /* en */ const lines = [
    `time: ${localTime(now, timeZone)}`,
    `place: ${place}`,
    `activity: ${activity}`,
    `voice: ${VOICE[voice] ?? voice}${voiceWhy ? ` (${voiceWhy})` : ''}`,
    ...(koe ? [`koe: ${KOE[koe] ?? koe}`] : []),
    `connection: ${online ? 'online' : 'offline'}`,
    ...(reasons.length ? [`woke for: ${reasons.join('; ')}`] : []),
    ...(plan === null ? [] : [plan.length ? `next in the plan:\n${tsv(['start', 'title', 'fixed', 'place'], plan)}` : 'next in the plan: nothing']),
  ];
  /* en */ return `<now>\n${lines.join('\n')}\n</now>`;
}

/**
 * @param {{ snapshot: Snapshot, system?: string, tools: import('../llm/contract.js').ToolDef[], transcript: { messages: import('../llm/contract.js').Message[] },
 *   tail: string, cacheTtl: '5m' | '1h', maxOutput?: number }} c
 *   system: a half's own system text, in place of Shiori's
 * @returns {Request}
 */
export function buildRequest({ snapshot, system, tools, transcript, tail, cacheTtl, maxOutput }) {
  return { system: system ?? systemText(snapshot), tools, messages: transcript.messages, tail, cacheTtl, ...(maxOutput ? { maxOutput } : {}) };
}

/**
 * Names the cached prefix: the system text and tools, and the compaction the transcript starts
 * from (after it, the transcript only grows at the end). @param {Request} request @param {number} compaction
 */
export function prefixFingerprint(request, compaction) {
  return sha256Hex(utf8(JSON.stringify([request.system ?? '', request.tools ?? [], compaction])));
}
