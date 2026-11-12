// What a realtime check makes of stage 5's card (read_trip: annai's own question, answered by a tap or a spoken yes): pure functions from one
// scenario's record to the lines Koe heard (when annai wrote each down, each revision of it, the socket's own chunks), what became of the card (granted by
// voice or tap, ended unanswered, or never answered), the times in seconds from the end of the user's word, and checks against what the scenario expects.
// They are tested without a browser (test/unit/realtime-card.test.js), and the lateness numbers of a whole run come from lateness.mjs.
import { spokenYes } from '../../src/core/agent/spoken-yes.js';

/** A transcript as annai keeps it, for comparing: no markup, one space between words. @param {string} text */
export const tidy = (text) => String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)|<[^>]*(?:>|$)|\{[^}]*(?:\}|$)/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The user's lines in what the stand-in Kokoro was given in its last request: "[heard]" (the words on the line after, or on the same one), and "The user said:"
 * (the result of a card that a line ended, in classic voice, carries it so), in the order they stand. @param {string} text @returns {string[]}
 */
export const heardIn = (text) => [...String(text).matchAll(/^\[heard[^\]]*\][ \t]*\n?(.+)$|The user said:[ \t]*\n?(.+)$/gm)].map((m) => tidy(m[1] ?? m[2]).replace(/ \(heard; may be misheard as [^)]*\)$/, ''));

/**
 * What Gemini wrote for each of the user's turns as it came over the socket (the transcription chunks from the turn's start to the next one's, put together), with
 * the clip that was played into it. A turn nothing was written for has an empty text.
 * @param {import('./analyse.mjs').Rec} rec @param {{ turns: import('./analyse.mjs').Turn[] }} base @returns {{ clip: string | null, text: string, chunks: number }[]}
 */
export function turnTexts(rec, base) {
  const chunks = rec.frames.filter((f) => f.dir === 'in' && f.kind === 'heard').sort((a, b) => a.at - b.at);
  const turns = [...base.turns].sort((a, b) => a.start - b.start);
  return turns.map((t, i) => {
    const cs = chunks.filter((c) => c.at >= t.start && c.at < (turns[i + 1]?.start ?? Infinity));
    return { clip: t.clip ? t.clip.split('@')[0] : null, text: tidy(cs.map((c) => c.text).join('')), chunks: cs.length };
  });
}

/**
 * Every line Koe heard in a record: annai's own `heard` entry (when it wrote it down, what it said then, whether Koe set it aside), each `heard.text`
 * revision after it, and the socket's own transcription chunks for the turn it came from (when the first and the last arrived), with the clip that was
 * played into it and when that clip ended.
 * @param {import('./analyse.mjs').Rec} rec @param {{ turns: import('./analyse.mjs').Turn[] }} base
 */
export function heardLines(rec, base) {
  const entries = rec.trace.filter((t) => t.type === 'heard').sort((a, b) => a.at - b.at);
  const revs = rec.trace.filter((t) => t.type === 'heard.text').sort((a, b) => a.at - b.at);
  const chunks = rec.frames.filter((f) => f.dir === 'in' && f.kind === 'heard').sort((a, b) => a.at - b.at);
  const turns = [...base.turns].sort((a, b) => a.start - b.start);
  /** The chunks of each turn: from its start to the next one's. */
  const byTurn = turns.map((t, i) => chunks.filter((c) => c.at >= t.start && c.at < (turns[i + 1]?.start ?? Infinity)));
  const taken = new Set();
  /** @type {Set<any>} */
  const usedPlays = new Set();
  return entries.map((e) => {
    const id = e.data?.id;
    const mine = revs.filter((r) => r.data?.of === id);
    const final = tidy(mine.at(-1)?.data?.text ?? e.data?.text);
    // Its turn: the first not taken whose chunks, put together, are its final words; else one whose chunks begin them or are begun by them.
    const said = byTurn.map((cs) => tidy(cs.map((c) => c.text).join('')));
    let k = said.findIndex((x, i) => !taken.has(i) && x !== '' && x === final);
    if (k < 0) k = said.findIndex((x, i) => !taken.has(i) && x !== '' && (final.startsWith(x) || x.startsWith(final)));
    if (k >= 0) taken.add(k);
    const cs = k >= 0 ? byTurn[k] : [];
    const turn = k >= 0 ? turns[k] : null;
    // No turn (classic voice has no live socket): the first clip not yet taken that began before the entry was written, in order.
    let play = turn?.clip ? rec.plays.find((p) => `${p.name}@${p.at}` === turn.clip) : null;
    if (!turn) {
      play = rec.plays.filter((p) => p.name !== 'silence' && p.at < e.at && !usedPlays.has(p)).sort((a, b) => a.at - b.at)[0] ?? null;
      if (play) usedPlays.add(play);
    }
    const text0 = tidy(e.data?.text);
    return {
      id, at: e.at, dismissed: e.data?.dismissed === true, gate: e.data?.gate ?? null, text0, final,
      revisions: mine.map((r) => ({ at: r.at, text: tidy(r.data?.text) })),
      chunks: cs.map((c) => ({ at: c.at, text: c.text ?? '' })),
      turn: turn ? { start: turn.start, end: turn.end } : null,
      clip: play ? { name: play.name, at: play.at, end: play.end } : null,
      yes0: spokenYes(text0), yesFinal: spokenYes(final),
      /** the longest wait between annai's entry and its revisions, one to the next (the settle restarts at each) */
      maxGapMs: [e.at, ...mine.map((r) => r.at)].reduce((m, t, i, all) => (i ? Math.max(m, t - all[i - 1]) : m), 0),
    };
  });
}

/**
 * Classic voice: what the speech-to-text server wrote for each clip, in order (the stand-in passes each request on and logs the words that came back, and
 * when it asked and was answered). One request to each clip that made a segment, so the n-th request is the n-th clip's.
 * @param {import('./analyse.mjs').Rec} rec
 */
export function asrLines(rec) {
  const plays = rec.plays.filter((p) => p.name !== 'silence').sort((a, b) => a.at - b.at);
  return (rec.kokoro ?? []).filter((k) => k.kind === 'asr').sort((a, b) => a.at - b.at).map((k, i) => ({
    clip: plays[i] ?? null, text: String(k.text ?? ''), asked: k.at, answered: k.at + (k.ms ?? 0), ms: k.ms ?? 0, status: k.status ?? null, bytes: k.bytes ?? 0,
    /** written down: after the clip's end (ms) */
    afterClip: plays[i] ? k.at + (k.ms ?? 0) - plays[i].end : null,
  }));
}

/**
 * What became of annai's card in a record, and the times that matter.
 * @param {import('./analyse.mjs').Rec} rec @param {{ turns: import('./analyse.mjs').Turn[] }} base
 */
export function cardOutcome(rec, base) {
  const ask = rec.trace.find((t) => t.type === 'out.ask' && t.data?.own === true);
  const media = rec.media ?? [];
  const card = ask ? { at: ask.at, question: String(ask.data?.question ?? ''), options: /** @type {string[]} */ (ask.data?.options ?? []) } : null;
  const qStart = card ? media.find((m) => m.kind === 'playing' && m.at >= card.at - 50)?.at ?? null : null;
  const qEnd = card ? media.find((m) => m.kind === 'ended' && m.at >= card.at - 50)?.at ?? null : null;
  const lines = card ? heardLines(rec, base).filter((l) => (l.clip?.at ?? l.at) >= card.at - 100) : [];
  const answers = card ? rec.plays.filter((p) => p.at >= card.at - 100 && p.name !== 'silence').sort((a, b) => a.at - b.at) : [];
  const grant = rec.trace.find((t) => t.type === 'trip.grant');
  const read = rec.trace.find((t) => t.type === 'trip.read');
  const result = rec.trace.find((t) => t.type === 'tool.result' && t.data?.name === 'read_trip' && (!card || t.at >= card.at));
  const text = String(result?.data?.content ?? result?.text ?? '');
  /** @type {'granted-voice' | 'granted-tap' | 'declined-voice' | 'unanswered' | 'not-now' | 'stopped' | 'none'} */
  const kind = grant ? (grant.data?.how === 'tap' ? 'granted-tap' : 'granted-voice')
    : !result ? 'none' : /tapped Not now/.test(text) ? 'not-now' : /^The user said no:/.test(text) ? 'declined-voice' : /^Not read:/.test(text) ? 'unanswered' : result.data?.ok === false ? 'stopped' : 'unanswered';
  const lastEnd = answers.at(-1)?.end ?? null;
  const firstAt = answers[0]?.at ?? null;
  const after = (/** @type {number | undefined | null} */ t) => (t == null || lastEnd === null ? null : t - lastEnd);
  // What Koe said from the first answer to the card's end (her words and the speech-to-speech model's own markup, tidied), and the stand-in voice's say.
  const end = result?.at ?? rec.endedAt;
  const said = firstAt === null ? [] : rec.frames.filter((f) => f.dir === 'in' && f.kind === 'said' && f.at >= firstAt && f.at <= end + 3000).map((f) => ({ at: f.at, text: f.text ?? '' }));
  const spoke = firstAt === null ? [] : rec.trace.filter((t) => t.type === 'out.speak' && t.at >= firstAt && t.at <= end + 3000).map((t) => ({ at: t.at, text: String(t.data?.text ?? t.text ?? '') })); // a short text is kept in the entry's data
  const kokoroLines = heardIn((rec.kokoro ?? []).filter((k) => k.kind === 'request').at(-1)?.text ?? '');
  return {
    card, qStart, qEnd, answers, lines, kind, text, grant: grant ? { at: grant.at, how: grant.data?.how ?? null } : null, resultAt: result?.at ?? null,
    readAt: read?.at ?? null, lastEnd, said, spoke, kokoroLines,
    /** seconds after the user's last word ended (ms) */
    asr: asrLines(rec),
    ms: { writeDown: after(asrLines(rec).findLast((a) => a.clip && lastEnd !== null && a.clip.end === lastEnd)?.answered), heardEntry: after(lines.at(-1)?.at), firstChunk: after(lines.at(-1)?.chunks[0]?.at), lastChunk: after(lines.at(-1)?.chunks.at(-1)?.at), lastRevision: after(lines.at(-1)?.revisions.at(-1)?.at), grant: after(grant?.at), read: after(read?.at), result: after(result?.at) },
    cardToQuestionEnd: card && qEnd ? qEnd - card.at : null,
  };
}

/** Per million tokens (the Anthropic provider's own price list, plugins-official/provider-anthropic): input, output, cache read, cache write (5 minutes and 1 hour). Haiku above 100K of prompt costs 5x. */
const PRICES = /** @type {Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number }>} */ ({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
});

/**
 * What a record's model turns used, by the model that answered (annai's own count of each reply's usage), and an estimated cost in dollars from the list prices.
 * @param {import('./analyse.mjs').Rec} rec
 */
export function usageOf(rec) {
  /** @type {Record<string, { calls: number, input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, usd: number | null }>} */
  const by = {};
  for (const t of rec.trace.filter((x) => x.type === 'model.turn' && x.data?.usage)) {
    const model = String(t.data.answeredBy ?? t.data.first ?? '?');
    const u = t.data.usage;
    const m = (by[model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, usd: 0 });
    m.calls++;
    for (const k of /** @type {const} */ (['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'])) m[k] += Number(u[k] ?? 0);
  }
  for (const [model, m] of Object.entries(by)) {
    const p = PRICES[model] ?? (/opus/i.test(model) ? PRICES['claude-opus-5-5'] : /sonnet/i.test(model) ? PRICES['claude-sonnet-5-5'] : /haiku/i.test(model) ? PRICES['claude-haiku-5-5'] : undefined);
    m.usd = p ? (m.input * p.input + m.output * p.output + m.cacheRead * p.cacheRead + m.cacheWrite * p.cacheWrite + m.cacheWrite1h * p.cacheWrite1h) / 1e6 : null;
  }
  return by;
}

/** @param {number | null | undefined} ms */
const sec = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)} s`);

/**
 * The card's checks and a readable summary. sc.expect.grant: 'voice' | 'tap' | false (no grant); 'any' leaves it open (the report says what happened);
 * declined: a spoken no ended it, as Not now (the voice-yes rule).
 * @param {import('./analyse.mjs').Rec} rec @param {ReturnType<import('./analyse.mjs').analyse>} base @param {{ expect?: { grant: 'voice' | 'tap' | false | 'any', words?: boolean, open?: boolean, next?: boolean, declined?: boolean } }} [sc]
 * @returns {{ checks: import('./analyse.mjs').Check[], text: string[], card: ReturnType<typeof cardOutcome> }}
 */
export function analyseCard(rec, base, sc = {}) {
  const c = cardOutcome(rec, base);
  const expect = sc.expect?.grant ?? 'any';
  /** @type {import('./analyse.mjs').Check[]} */
  const checks = [];
  checks.push({ name: 'card shown', ok: Boolean(c.card && /^Read Testville/.test(c.card.question) && c.card.options.includes('Allow')), detail: c.card ? `"${c.card.question}" ${c.card.options.join(' / ')}` : 'annai showed no card of its own' });
  checks.push({ name: 'question said', ok: c.qEnd !== null, detail: c.qEnd !== null ? `the stand-in voice's clip played ${sec(c.cardToQuestionEnd)} after the card, to ${((c.qEnd - rec.startedAt) / 1000).toFixed(2)} s` : 'the page never heard its own player end after the card' });
  checks.push({ name: 'card resolved', ok: c.kind !== 'none' || sc.expect?.open === true, detail: c.kind === 'none' ? 'read_trip never got its result: the card was still waiting at the end' : `${c.kind}${c.resultAt ? `, ${((c.resultAt - rec.startedAt) / 1000).toFixed(2)} s in` : ''}` });
  const got = c.kind === 'granted-voice' ? 'voice' : c.kind === 'granted-tap' ? 'tap' : false;
  if (expect !== 'any') checks.push({ name: expect === false ? 'no grant' : `granted by ${expect}`, ok: got === expect, detail: `what the rule says: ${expect === false ? 'no grant' : `a grant by ${expect}`}; what happened: ${got === false ? c.kind : `a grant by ${got}`}` });
  if (sc.expect?.declined === true) checks.push({ name: 'declined by voice', ok: c.kind === 'declined-voice', detail: `what happened: ${c.kind}` });
  if (sc.expect?.words === true) {
    // A line kept as the user's that is no yes goes on to Shiori as hers, once: the last request's [heard] lines hold each of its words once.
    const kept = c.lines.filter((l) => !l.dismissed && !l.yesFinal);
    const counts = kept.map((l) => ({ text: l.final, n: c.kokoroLines.filter((x) => tidy(x) === l.final).length }));
    checks.push({ name: 'words reach Shiori once', ok: counts.length > 0 && counts.every((x) => x.n === 1), detail: counts.length ? counts.map((x) => `"${x.text}" ${x.n}x`).join('; ') : 'no kept line to follow' });
  }
  if (sc.expect?.next === true) {
    // Kokoro is free after the card: the next question that needs her is answered, with no card of annai's and no tap (in classic voice, but the tap on Shiori that a window needs).
    const play = rec.plays.find((p) => p.name === 'bixby');
    const cards = rec.trace.filter((t) => t.type === 'out.ask' && t.data?.own === true).length;
    const next = base.clips.find((x) => x.name === 'bixby');
    const said = rec.mode === 'classic' ? (play && (rec.kokoro ?? []).some((k) => k.kind === 'speech' && /twenty minutes/.test(k.text ?? '') && k.at > play.at)) : Boolean(next?.answered);
    checks.push({ name: 'Kokoro is free after it', ok: Boolean(said) && cards === 1 && (rec.taps ?? []).length === 0, detail: `${play ? (said ? 'the next question was answered' : 'the next question got no answer') : 'no next question was asked'}; ${cards} card${cards === 1 ? '' : 's'} of annai's, ${(rec.taps ?? []).length} taps` });
  }
  /** @type {string[]} */
  const text = [];
  if (c.card) text.push(`   card at ${((c.card.at - rec.startedAt) / 1000).toFixed(2)} s: "${c.card.question}"; question ${c.qStart ? `playing from ${((c.qStart - rec.startedAt) / 1000).toFixed(2)} s` : 'not heard begin'}, ${c.qEnd ? `said to ${((c.qEnd - rec.startedAt) / 1000).toFixed(2)} s` : 'not heard end'}`);
  for (const a of c.answers) text.push(`   clip ${a.name}: ${((a.at - rec.startedAt) / 1000).toFixed(2)} to ${((a.end - rec.startedAt) / 1000).toFixed(2)} s${c.qEnd ? ` (${((a.at - c.qEnd) / 1000).toFixed(1)} s after the question was said)` : ''}`);
  for (const a of c.asr) text.push(`   speech to text for ${a.clip ? a.clip.name : '?'}: ${JSON.stringify(a.text)} (${a.ms} ms, ${a.status ?? 'failed'}; written down ${sec(a.afterClip)} after the clip ended)`);
  for (const l of rec.mode === 'classic' ? [] : c.lines) {
    text.push(`   heard "${l.final}"${l.text0 !== l.final ? ` (first written "${l.text0}")` : ''} entry ${l.dismissed ? 'DISMISSED (set aside)' : 'kept'}${l.gate ? ` gate=${l.gate}` : ''} at ${l.clip ? sec(l.at - l.clip.end) : '?'} after its clip; revisions ${l.revisions.length ? l.revisions.map((r) => `${sec(r.at - l.at)} after the entry`).join(', ') : 'none'}; socket chunks ${l.chunks.length ? `${l.chunks.length}, ${l.clip ? `${sec(l.chunks[0].at - l.clip.end)} to ${sec((l.chunks.at(-1)?.at ?? l.chunks[0].at) - l.clip.end)} after the clip` : ''}` : 'none'}; first words yes? ${l.yes0}, whole line yes? ${l.yesFinal}`);
  }
  text.push(`   outcome: ${c.kind}${c.grant ? ` (grant how=${c.grant.how}, ${sec(c.ms.grant)} after the last clip ended${c.ms.writeDown !== null && c.ms.grant !== null ? `, ${sec(c.ms.grant - c.ms.writeDown)} after it was written down` : ''}; read ${sec(c.ms.read)})` : c.resultAt ? ` (result ${sec(c.ms.result)} after the last clip ended)` : ''}`);
  for (const k of rec.taps ?? []) text.push(`   tap on "${k.label}" at ${((k.at - rec.startedAt) / 1000).toFixed(2)} s${k.ok ? '' : ' (no such button)'}${c.lastEnd ? `, ${sec(k.at - c.lastEnd)} after the last clip ended` : ''}`);
  if (c.said.length || c.spoke.length) text.push(`   Koe meanwhile: ${[...c.said].map((s) => JSON.stringify(s.text)).join(' ')}${c.spoke.length ? ` (kept as: ${c.spoke.map((s) => JSON.stringify(s.text)).join(' | ')})` : ''}`);
  if (rec.model) {
    const u = usageOf(rec);
    const dollars = (/** @type {number | null} */ x) => (x === null ? '' : `, about $${x.toFixed(4)}`);
    text.push(`   model requests: ${rec.model.requests} to the real provider${rec.model.capped ? ' (CAPPED: the 31st was refused)' : ''}; ${Object.entries(u).map(([m, x]) => `${m} ${x.calls} turn${x.calls === 1 ? '' : 's'}, ${x.input} in / ${x.cacheRead} cache read / ${x.cacheWrite + x.cacheWrite1h} cache write / ${x.output} out${dollars(x.usd)}`).join('; ') || 'no usage in the trace'}`);
    checks.push({ name: 'within 30 model requests', ok: !rec.model.capped, detail: `${rec.model.requests} requests` });
  }
  if (c.text) text.push(`   read_trip's result: ${JSON.stringify(c.text.replace(/\s+/g, ' ').slice(0, 220))}`);
  if (c.kokoroLines.length) text.push(`   Shiori was given: ${c.kokoroLines.map((x) => `[heard] ${x}`).join(' | ')}`);
  return { checks, text, card: c };
}
