import { readJourney } from './journey.js';
import { STAY_MIN } from './route.js';
import { tsv } from '../tsv.js';
import { dayIn, timeIn } from '../time.js';
import { record } from '../agent/log.js';
import { modelOf } from '../llm/config.js';
import { stricter } from '../agent/refusals.js';
import { PhotoCopies, requestLimits } from '../request-photos.js';
import { photoSettings } from '../photos.js';
import { readAppSettings } from '../settings.js';
import { toBase64, fromBase64 } from '../bytes.js';
import { ME } from '../scopes.js';
import { AllFailedError } from '../llm/fallback.js';
import { ProviderError, explain } from '../llm/contract.js';

/**
 * The recap (spec §13): the utility model writes /trip/recap.md from the trip as it went (the
 * journey), its notes and memory, and a few photos. The road goes as stays and moves in words and
 * TSV (§4.7), never as its location points (choice 4). Shiori can tell it by voice (TELL_RECAP).
 * @typedef {import('./journey.js').Journey} Journey
 * @typedef {import('./journey.js').Entry} Entry
 */

export const RECAP_FILE = '/recap.md';
/** Photos sent with it at most (choice 4)… */
export const RECAP_PHOTOS = 6;
/** …taking at most this part of the maximum request size (spec §6.5). */
export const PHOTO_SHARE = 0.5;
/** The text sent, at most (about 17,000 tokens). */
export const RECAP_CHARS = 60_000;
/** Each card and message, at most. */
export const LINE_CHARS = 300;
/** Each note and the trip's memory, at most. */
export const NOTE_CHARS = 4000;

export const RECAP_SYSTEM = 'You write the recap of a trip for the traveler who took it, from what the annai app recorded on the way: '
  + 'where they stayed and for how long, how they moved between, the stamps they earned at places they visited, what they said and what Shiori, their guide, showed them, '
  + 'their notes, and some of their photos. Write Markdown: a first line "# " with a title for the trip; then one "## " section for each day, in order, '
  + 'telling the day in a few short paragraphs: the places, what happened there, and the photos by their paths where they belong; '
  + 'then "## Highlights" with three to five short bullet points. Be warm, concrete and brief, about 150 words a day. '
  + 'Use only what the record says, and leave out what you don\'t know rather than guess. Shiori may read the recap aloud, so write sentences that are easy to say. '
  + 'Write in the traveler\'s language (their profile says which). Reply with the recap only.';

/**
 * What goes to the model, as the Recap screen says it (spec §11.7: it must be true). Photos go as Shiori's
 * own photos do: a copy made smaller has no metadata, but a photo kept as taken that fits goes as it is (review 6).
 */
export const RECAP_SENDS = Object.freeze([
  'Where you stayed and for how long, by name; a place without one as its position, rounded to about 100 m. Never the GPS track itself.',
  'How far you drove or walked between, the stamps, and the plan.',
  "Shiori's cards and your words, typed or spoken, each shortened.",
  "The trip's notes and memory, and your profile.",
  `Up to ${RECAP_PHOTOS} photos, if the model takes photos. A photo kept as taken (Settings → Photos → Keep originals) can still hold where it was taken.`,
]);

/** What Shiori is woken with when the user asks to hear the recap (choice 6). */
export const TELL_RECAP = "The user asked to hear the trip's recap. Read /trip/recap.md and tell it to them with speak, a few sentences at a time, in your own words.";

/** @param {string} s @param {number} n */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The models of the utility role, or of the main role when it has none (spec §9.6). @param {any} cfg */
export function recapModels(cfg) {
  const ids = cfg?.roles?.utility?.models?.length ? cfg.roles.utility.models : cfg?.roles?.main?.models ?? [];
  return ids.map((/** @type {string} */ id) => (cfg.models?.[id] ? modelOf(cfg.models[id]) : null)).filter(Boolean);
}

/** The photos sent with the recap: up to RECAP_PHOTOS, spread evenly over the trip. @param {Journey} j */
export function recapPhotos(j, max = RECAP_PHOTOS) {
  const all = j.entries.filter((e) => e.kind === 'photo');
  if (all.length <= max) return all;
  return [...new Set(Array.from({ length: max }, (_, i) => Math.round((i * (all.length - 1)) / (max - 1))))].map((i) => all[i]);
}

/**
 * The recap's input in words (choice 4): the trip, its days, the way (stays and moves), stamps, the
 * plan, what was said and shown, photos, notes and memory. At most RECAP_CHARS: the words are thinned
 * evenly until it fits, then it is cut.
 * @param {Journey} j @param {{ profile?: string, memory?: string, notes?: { path: string, text: string }[] }} [more]
 */
export function recapText(j, { profile = '', memory = '', notes = [] } = {}) {
  const day = (/** @type {number} */ t) => String(dayIn(t, j.tz));
  const time = (/** @type {number} */ t) => String(timeIn(t, j.tz));
  const info = j.info ?? {};
  const party = Array.isArray(info.party) ? info.party.filter((/** @type {any} */ p) => p && typeof p.name === 'string') : [];
  const head = [
    `# ${j.title}`,
    [info.start ? `Dates: ${info.start}${info.end ? ` to ${info.end}` : ''}.` : '', `Times are local, in ${j.tz}.`].filter(Boolean).join(' '),
    party.length ? `Travel party: ${party.map((/** @type {any} */ p) => [p.name, typeof p.age === 'number' ? `age ${p.age}` : '', p.driver ? 'driver' : '', p.interests?.length ? `likes ${p.interests.join(', ')}` : ''].filter(Boolean).join(', ')).join('; ')}.` : '',
    profile.trim() ? `\n## The traveler's profile\n${cut(profile.trim(), 2000)}` : '',
  ].filter(Boolean).join('\n');
  const stays = j.entries.filter((e) => e.kind === 'stay');
  const moves = j.entries.filter((e) => e.kind === 'move');
  const photos = j.entries.filter((e) => e.kind === 'photo');
  const words = j.entries.filter((e) => e.kind === 'said' || e.kind === 'card');
  const days = tsv(['day', 'km', 'stays', 'stamps', 'photos', 'words'], j.days.map((d) => [
    d, Math.round(moves.filter((m) => day(m.at) === d).reduce((s, m) => s + /** @type {any} */ (m).km, 0) * 10) / 10,
    stays.filter((s) => day(s.at) === d).length, j.stamps.filter((s) => day(s.at) === d).length,
    photos.filter((p) => day(p.at) === d).length, words.filter((w) => day(w.at) === d).length,
  ]));
  const way = tsv(['day', 'from', 'to', 'what', 'place', 'km', 'stamp'], j.entries.flatMap((e) => {
    if (e.kind === 'stay') return [[day(e.at), time(e.at), time(e.to), e.to > e.at ? 'stayed' : 'arrived', e.name ?? `unnamed, near ${e.lat.toFixed(3)}, ${e.lng.toFixed(3)}`, '', e.stamp ? 'yes' : '']];
    if (e.kind === 'move') return [[day(e.at), time(e.at), time(e.to), `${e.mode === 'walk' ? 'walked' : 'drove'}${e.gap ? ' (partly unseen: the phone was locked or annai closed)' : ''}`, '', e.km, '']];
    return [];
  }));
  const stamps = tsv(['day', 'time', 'place', 'kind'], j.stamps.map((s) => [day(s.at), time(s.at), s.name, s.plan ? 'on the plan' : 'off the plan']));
  const plan = tsv(['day', 'time', 'item', 'place', 'kind', 'visited'], j.plan.map((p) => [p.at === null ? '' : day(p.at), p.at === null ? '' : time(p.at), p.title, p.place?.name ?? '', p.fixed ? 'fixed' : 'flexible', p.visited ? 'yes' : 'no']));
  /** Where a moment was: the stay it fell in. @param {number} t */
  const where = (t) => /** @type {any} */ (stays.find((s) => t >= s.at && t <= /** @type {any} */ (s).to))?.name ?? '';
  const photoList = tsv(['time', 'path', 'where', 'size'], photos.map((p) => {
    const ph = /** @type {Extract<Entry, { kind: 'photo' }>} */ (p);
    return [`${day(ph.at)} ${time(ph.at)}`, `/trip${ph.path}`, where(ph.at) || (ph.place ? `near ${ph.place.lat.toFixed(3)}, ${ph.place.lng.toFixed(3)}` : ''), ph.width && ph.height ? `${ph.width}×${ph.height}` : ''];
  }));
  const rows = words.map((w) => {
    if (w.kind === 'card') {
      const c = w.card ?? {};
      return [`${day(w.at)} ${time(w.at)}`, 'Shiori (card)', cut([c.title, c.text, c.place?.name].filter((x) => typeof x === 'string' && x.trim()).join(': ').replace(/\s+/g, ' '), LINE_CHARS)];
    }
    const s = /** @type {Extract<Entry, { kind: 'said' }>} */ (w);
    return [`${day(s.at)} ${time(s.at)}`, s.spoken ? 'traveler (spoke)' : 'traveler', cut(s.text.replace(/\s+/g, ' '), LINE_CHARS)];
  });
  const tail = [
    ...notes.filter((n) => n.text.trim()).map((n) => `### ${n.path}\n${cut(n.text.trim(), NOTE_CHARS)}`),
  ];
  const build = (/** @type {unknown[][]} */ said, /** @type {number} */ left) => [
    head,
    `## Days\n${days}`,
    `## The way\nStays of ${STAY_MIN} minutes or more and the moves between, worked out from ${j.points.length} location points (the points themselves aren't sent).\n${way}`,
    j.stamps.length ? `## Stamps (places visited)\n${stamps}` : '',
    j.plan.length ? `## The plan\n${plan}` : '',
    rows.length ? `## What was said and shown\n${tsv(['time', 'who', 'text'], said)}${left ? `\n[${left} lines left out to fit]` : ''}` : '',
    photos.length ? `## Photos\n${photoList}` : '',
    tail.length ? `## Notes\n${tail.join('\n\n')}` : '',
    memory.trim() ? `## Trip memory\n${cut(memory.trim(), NOTE_CHARS)}` : '',
  ].filter(Boolean).join('\n\n');
  let text = build(rows, 0);
  if (text.length > RECAP_CHARS) {
    // Evenly thinned: the fewest left out that fits.
    let lo = 0;
    let hi = rows.length;
    // The first and the last stay, and the rest evenly between.
    const pick = (/** @type {number} */ n) => (n >= rows.length ? rows : n < 2 ? rows.slice(0, n) : Array.from({ length: n }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (n - 1))]));
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (build(pick(mid), rows.length - mid).length <= RECAP_CHARS) lo = mid;
      else hi = mid - 1;
    }
    text = build(pick(lo), rows.length - lo);
  }
  return text.length > RECAP_CHARS ? `${text.slice(0, RECAP_CHARS - 1)}…` : text;
}

/** Why the recap wasn't written, in plain words with what to do next. @param {unknown} e */
export function recapError(e) {
  if (e instanceof AllFailedError) {
    return e.attempts.length
      ? `No model could write it: ${e.attempts.map((a) => `${a.name}: ${a.error ?? a.outcome}`).join('; ')}. Check Settings → Models, then try again.`
      : 'No model is set for the utility or main role. Add one in Settings → Models.';
  }
  if (e instanceof ProviderError) return `${explain(e).replace(/[.!?]?$/, '.')} Try again in a while.`;
  return String(/** @type {any} */ (e)?.message ?? e);
}

/** @param {import('../types.js').Store} store @param {string} hash */
async function bytesOf(store, hash) {
  const b = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
  return b ? new Uint8Array(b.data) : null;
}

/**
 * Writes /trip/recap.md with the utility model (spec §13, choice 5), and logs a recap entry that names
 * the photo copies it sent (§4.9). Errors are plain: what happened and what to do next.
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, llm: any, trip: string,
 *   codec?: import('../photos.js').Codec | null, namer?: (p: { lat: number, lng: number }) => { name: string, m: number } | null, signal?: AbortSignal }} c
 * @returns {Promise<{ text: string, photos: number, chars: number }>}
 */
export async function writeRecap({ store, ws, llm, trip, codec = null, namer, signal }) {
  const cfg = await llm.config();
  const models = recapModels(cfg);
  if (!models.length) throw new Error('No model is set up to write the recap. Add one in Settings → Models.');
  const j = await readJourney({ store, ws, trip, namer });
  const profile = (await ws.readText(ME, '/profile.md').catch(() => '')) ?? '';
  const memory = (await ws.readText(trip, '/memory.md').catch(() => '')) ?? '';
  /** @type {{ path: string, text: string }[]} */
  const notes = [];
  for (const f of await ws.list(trip, '/notes/')) {
    if (/\.(md|txt)$/i.test(f.path)) notes.push({ path: `/trip${f.path}`, text: (await ws.readText(trip, f.path).catch(() => '')) ?? '' });
  }
  const text = recapText(j, { profile, memory, notes });
  /** @type {import('../llm/contract.js').Part[]} */
  const parts = [{ type: 'text', text }];
  /** @type {{ hash?: string, bytes?: Uint8Array, type: string }[]} */
  const blobs = [];
  if (models.every((/** @type {any} */ m) => m.input?.includes('image'))) {
    /** @type {import('../agent/refusals.js').Learned} */
    let images = {};
    for (const m of models) images = stricter(images, /** @type {any} */ (m).images ?? {});
    const app = await readAppSettings(ws);
    const limits = requestLimits(photoSettings(app).request, images);
    const room = (app.shiori?.compaction?.maxRequestMiB ?? 8) * 2 ** 20 * PHOTO_SHARE;
    const copies = codec ? new PhotoCopies({ codec: /** @type {any} */ (codec), read: (h) => bytesOf(store, h) }) : null;
    let used = 0;
    for (const p of recapPhotos(j, Math.min(RECAP_PHOTOS, limits.maxCount ?? RECAP_PHOTOS))) {
      const ph = /** @type {Extract<Entry, { kind: 'photo' }>} */ (p);
      try {
        const c = copies
          ? await copies.copy({ hash: ph.hash, type: ph.type, width: ph.width, height: ph.height, size: ph.size }, limits)
          : { hash: ph.hash, mediaType: ph.type, data: undefined };
        const data = c.data ?? toBase64(/** @type {Uint8Array} */ ((await bytesOf(store, c.hash)) ?? new Uint8Array()));
        if (!data || used + data.length > room) continue;
        used += data.length;
        parts.push({ type: 'text', text: `Photo /trip${ph.path}, ${dayIn(ph.at, j.tz)} ${timeIn(ph.at, j.tz)}:` }, { type: 'image', mediaType: c.mediaType, data, hash: c.hash, path: `/trip${ph.path}` });
        blobs.push(c.data ? { bytes: fromBase64(c.data), type: c.mediaType } : { hash: c.hash, type: c.mediaType });
      } catch {
        // A photo that can't be read or made small enough stays out; the list still names it.
      }
    }
  }
  const r = await llm.call({ role: 'utility', request: { system: RECAP_SYSTEM, messages: [{ role: 'user', parts }] }, scope: trip, record: { tag: 'recap' }, signal });
  const out = String(r?.reply?.text ?? '').trim();
  if (!out) throw new Error('The model sent back an empty recap. Try again, or put another model first in the utility role (Settings → Models).');
  await ws.write(trip, RECAP_FILE, `${out}\n`, { author: 'shiori' });
  await record(store, trip, { type: 'recap', actor: 'system', data: { path: RECAP_FILE, chars: text.length, photos: blobs.length, points: j.points.length }, blobs });
  return { text: out, photos: blobs.length, chars: text.length };
}
