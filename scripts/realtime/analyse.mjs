// What a realtime check makes of what it recorded: pure functions from one scenario's record (the clips played into the
// microphone, the frames annai and Gemini exchanged, what annai played, annai's own trace) to turns, timings, checks and a
// timeline, so they are tested without a browser. Times are epoch ms; a record's startedAt is when its session opened.
//

/**
 * @typedef {{ at: number, name: string, end: number, gainDb: number }} MicPlay  a clip played into the microphone
 * @typedef {{ at: number, dir: 'out' | 'in', kind: string, bytes?: number, text?: string, name?: string, code?: number, reason?: string }} Frame
 *   out (annai to Gemini): setup, activityStart, activityEnd, audio, text, toolResponse; in: setupComplete, audio, heard, said, turnComplete,
 *   interrupted, toolCall, usage, goAway, close
 * @typedef {{ at: number, type: string, data: any, text?: string }} TraceEntry  annai's own: live.turn, live.session, out.speak, heard, error
 * @typedef {{ scenario: string, route: string, echoDb: number | null, startedAt: number, endedAt: number, keyLine: number | null, plays: MicPlay[],
 *   frames: Frame[], level: number[][], micLevel?: number[][], trace: TraceEntry[], errors: string[], notes: string[] }} Rec  level: [at, rms of what annai plays];
 *   micLevel: the same for what the microphone carried
 */

/** The loudness (rms, 0..1) from which what annai plays is sound; and the quiet that ends a run of it. */
export const SOUND = 0.01;
const SOUND_GAP_MS = 400;
/** How soon after her sound a turn the user did not make is taken for its echo. */
const ECHO_WINDOW_MS = 1000;
/** The longest a turn may end after the user stopped: the check's limit. */
export const END_LAG_MS = 2000;

/** The words of a text, lower case, no punctuation. @param {string} text */
const words = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);

/** How much of what was said was heard: the share of its words found among the heard words. @param {string} said @param {string} heard */
export function wordRecall(said, heard) {
  const want = words(said);
  if (!want.length) return 1;
  const got = new Set(words(heard));
  return want.filter((w) => got.has(w)).length / want.length;
}

/** The runs of sound in what annai played. @param {number[][]} level @returns {{ from: number, to: number }[]} */
export function soundRuns(level) {
  /** @type {{ from: number, to: number }[]} */
  const runs = [];
  for (const [at, rms] of level) {
    if (rms < SOUND) continue;
    const last = runs.at(-1);
    if (last && at - last.to <= SOUND_GAP_MS) last.to = at;
    else runs.push({ from: at, to: at });
  }
  return runs;
}

/**
 * @typedef {{ i: number, start: number, end: number | null, ms: number | null, audioBytes: number, reason: string | null, clip: string | null,
 *   spurious: boolean, echo: boolean }} Turn
 * @typedef {{ name: string, at: number, end: number, expect: 'answer' | 'nothing', turns: number, endLagMs: number | null, answered: boolean | null,
 *   firstAudioMs: number | null, firstSoundMs: number | null, heard: string, recall: number, said: string, tools: string[], overHer: boolean, sentMs: number, coverage: number }} ClipResult
 *   tools: what she called before her first sound; overHer: it began while she sounded or as she began
 * @typedef {{ at: number, cause: 'user' | 'echo' | 'noise' | 'other' }} Cut
 * @typedef {{ name: string, ok: boolean, detail: string, soft?: boolean }} Check  soft: a warning, which does not fail the scenario
 */

/**
 * @param {Rec} rec @param {Record<string, { kind: string, words: string }>} clips
 * @param {{ endLagMs?: number, expectCut?: boolean }} [o] expectCut: the scenario has the user speak over her, which should cut her
 */
export function analyse(rec, clips, { endLagMs = END_LAG_MS, expectCut = false } = {}) {
  const frames = [...rec.frames].sort((a, b) => a.at - b.at);
  const runs = soundRuns(rec.level);
  /** @type {string[]} */
  const notes = [...rec.notes];
  const speech = rec.plays.filter((p) => clips[p.name]?.kind !== 'silence').sort((a, b) => a.at - b.at);

  // The user's turns, as annai sent them: activityStart to activityEnd.
  /** @type {Turn[]} */
  const turns = [];
  /** @type {Turn | null} */
  let open = null;
  for (const fr of frames) {
    if (fr.dir !== 'out') continue;
    if (fr.kind === 'activityStart' && !open) {
      open = { i: turns.length + 1, start: fr.at, end: null, ms: null, audioBytes: 0, reason: null, clip: null, spurious: false, echo: false };
      turns.push(open);
    } else if (fr.kind === 'audio' && open) open.audioBytes += fr.bytes ?? 0;
    else if (fr.kind === 'activityEnd' && open) {
      open.end = fr.at;
      open.ms = fr.at - open.start;
      open = null;
    }
  }
  // Why each ended, from annai's own trace: the nearest live.turn entry to its end.
  const ended = rec.trace.filter((t) => t.type === 'live.turn');
  for (const t of turns) {
    if (t.end === null) continue;
    const near = ended.filter((e) => Math.abs(e.at - /** @type {number} */ (t.end)) <= 1500).sort((a, b) => Math.abs(a.at - /** @type {number} */ (t.end)) - Math.abs(b.at - /** @type {number} */ (t.end)))[0];
    t.reason = near?.data?.end ?? null;
  }
  // Which clip each turn is: the latest one begun before it started that has not ended long before.
  for (const t of turns) {
    const p = [...speech].reverse().find((x) => x.at - 200 <= t.start && t.start <= x.end + 700);
    t.clip = p ? `${p.name}@${p.at}` : null;
    t.spurious = !p;
    t.echo = t.spurious && runs.some((r) => r.from <= t.start && r.to >= t.start - ECHO_WINDOW_MS);
  }

  /** @type {ClipResult[]} */
  const results = rec.plays.slice().sort((a, b) => a.at - b.at).map((p) => {
    const kind = clips[p.name]?.kind;
    if (kind === 'silence') {
      return { name: p.name, at: p.at, end: p.end, expect: /** @type {const} */ ('nothing'), turns: 0, endLagMs: null, answered: null, firstAudioMs: null, firstSoundMs: null, heard: '', recall: 1, said: '', tools: [], overHer: false, sentMs: 0, coverage: 1 };
    }
    const mine = turns.filter((t) => t.clip === `${p.name}@${p.at}`);
    const last = mine.at(-1);
    const next = speech.find((x) => x.at > p.at);
    const until = next ? next.at : Infinity;
    const lastEnd = last?.end ?? null;
    const audio = lastEnd === null ? undefined : frames.find((fr) => fr.dir === 'in' && fr.kind === 'audio' && fr.at > /** @type {number} */ (lastEnd) && fr.at < until);
    const sound = lastEnd === null ? undefined : runs.find((r) => r.to > /** @type {number} */ (lastEnd) && r.from < until);
    const heard = frames.filter((fr) => fr.dir === 'in' && fr.kind === 'heard' && mine.length && fr.at >= mine[0].start && fr.at < until).map((fr) => fr.text ?? '').join('').replace(/\s+/g, ' ').trim();
    const said = frames.filter((fr) => fr.dir === 'in' && fr.kind === 'said' && lastEnd !== null && fr.at > lastEnd && fr.at < until).map((fr) => fr.text ?? '').join('').replace(/\s+/g, ' ').trim();
    const tools = audio ? frames.filter((fr) => fr.dir === 'in' && fr.kind === 'toolCall' && lastEnd !== null && fr.at > lastEnd && fr.at < audio.at).map((fr) => fr.name ?? '?') : [];
    const overHer = runs.some((r) => r.to >= p.at && r.from <= p.at + 600);
    return {
      name: p.name, at: p.at, end: p.end, expect: /** @type {const} */ ('answer'), turns: mine.length, tools, overHer,
      sentMs: mine.reduce((n, t) => n + (t.ms ?? 0), 0), coverage: mine.reduce((n, t) => n + (t.ms ?? 0), 0) / Math.max(1, p.end - p.at),
      endLagMs: lastEnd === null ? null : lastEnd - p.end,
      answered: Boolean(audio), firstAudioMs: audio ? audio.at - p.end : null, firstSoundMs: sound ? Math.max(sound.from, lastEnd ?? 0) - p.end : null,
      heard, recall: heard ? wordRecall(clips[p.name]?.words ?? '', heard) : 0, said,
    };
  });
  const halfDuplex = rec.route === 'speaker';
  for (const r of results) {
    if (r.expect === 'answer' && !r.turns && r.overHer) notes.push(`${r.name}: spoken over her${halfDuplex ? ', and annai on the phone speaker hears nothing while she speaks: no turn, as designed' : ' and no turn was made of it'}`);
    if (r.expect === 'answer' && r.turns > 1) notes.push(`${r.name}: split into ${r.turns} turns (a pause inside the sentence ended the first)`);
    if (r.expect === 'answer' && r.turns && r.heard && r.recall < 0.6) notes.push(`${r.name}: Gemini heard "${r.heard}" for "${clips[r.name]?.words}"`);
    if (r.expect === 'answer' && r.turns && !r.heard) notes.push(`${r.name}: no transcript of the turn came back`);
    if (r.firstAudioMs !== null && r.firstAudioMs > 3000) notes.push(`${r.name}: her first audio came ${(r.firstAudioMs / 1000).toFixed(1)} s after the user stopped`);
  }
  for (const t of turns) {
    if (t.spurious && !t.echo) notes.push(`turn ${t.i} at ${(t.start - rec.startedAt) / 1000} s was nobody speaking (noise)`);
    if (t.end === null) notes.push(`turn ${t.i} never ended`);
  }

  // Her being cut: each interrupted, by whose turn it followed.
  /** @type {Cut[]} */
  const cuts = frames.filter((fr) => fr.dir === 'in' && fr.kind === 'interrupted').map((fr) => {
    const t = [...turns].reverse().find((x) => x.start <= fr.at && fr.at - x.start <= 3000);
    return { at: fr.at, cause: /** @type {Cut['cause']} */ (!t ? 'other' : t.echo ? 'echo' : t.spurious ? 'noise' : 'user') };
  });
  const spoken = rec.trace.filter((t) => t.type === 'out.speak' && t.data?.cut).length;
  if (spoken) notes.push(`${spoken} of her lines ${spoken === 1 ? 'was' : 'were'} cut where heard (✂ in the conversation)`);
  const echoMeasuredDb = measureEcho(rec);
  if (rec.echoDb !== null && rec.micLevel) {
    if (echoMeasuredDb === null || echoMeasuredDb < rec.echoDb - 10) notes.push(`echo mode: her voice did not reach the microphone at the level asked (${rec.echoDb} dB; measured ${echoMeasuredDb === null ? 'nothing' : `${echoMeasuredDb.toFixed(1)} dB`}): the check proves nothing about echo`);
    else notes.push(`echo mode: her voice reached the microphone at ${echoMeasuredDb.toFixed(1)} dB of her own level (asked ${rec.echoDb} dB)`);
  }

  // Errors: the trace's, the sockets' closes with a code, and the page's.
  /** @type {string[]} */
  const errors = [
    ...rec.trace.filter((t) => t.type === 'error').map((t) => `${t.data?.kind ?? 'error'}: ${t.data?.message ?? ''}`.trim()),
    ...frames.filter((fr) => fr.kind === 'close' && ![1000, 1005].includes(fr.code ?? 0)).map((fr) => `socket closed ${fr.code}: ${fr.reason ?? ''}`.trim()),
    ...rec.errors,
  ];

  // On the phone speaker, speaking over her is not heard by design (half-duplex): such a question is not expected an answer.
  const asked = results.filter((r) => r.expect === 'answer' && !(halfDuplex && r.overHer && !r.turns));
  const lagged = asked.filter((r) => r.turns && (r.endLagMs === null || r.endLagMs > endLagMs));
  const echoes = turns.filter((t) => t.echo).length + cuts.filter((c) => c.cause === 'echo').length;
  const quiet = results.filter((r) => r.expect === 'nothing');
  const noisy = quiet.filter((q) => turns.some((t) => t.start >= q.at && t.start <= q.end));
  /** @type {Check[]} */
  const checks = [
    { name: 'answered', ok: asked.every((r) => r.answered), detail: `${asked.filter((r) => r.answered).length} of ${asked.length} questions got audio back${asked.some((r) => !r.answered) ? `; none for ${asked.filter((r) => !r.answered).map((r) => `${r.name} (${r.turns ? 'turn sent' : 'no turn'})`).join(', ')}` : ''}` },
    { name: 'no echo cut', ok: echoes === 0 && noisy.length === 0, detail: echoes || noisy.length ? `${echoes} turns or cuts from her own echo${noisy.length ? `, ${noisy.length} turns in silence` : ''}` : 'no turn began in her voice, none in silence, and no cut came from one' },
    { name: 'turn ends in time', ok: lagged.length === 0, detail: lagged.length ? `late: ${lagged.map((r) => `${r.name} ${r.endLagMs === null ? 'never ended' : `${(r.endLagMs / 1000).toFixed(2)} s`}`).join(', ')}` : `every turn ended within ${endLagMs / 1000} s of the user stopping` },
    { name: 'no errors', ok: errors.length === 0, detail: errors.length ? errors.join('; ') : 'none' },
  ];
  // Whether all that was said reached Gemini: a sentence cut at its pause, or a question begun over her voice, arrives in part.
  const partial = asked.filter((r) => r.turns && (r.coverage < 0.75 || (r.heard && r.recall < 0.6)));
  checks.push({
    name: 'whole sentences heard', ok: partial.length === 0, soft: true,
    detail: partial.length ? `only part of what was said was heard: ${partial.map((r) => `${r.name} (${Math.round(Math.min(1, r.coverage) * 100)}% of the sound sent, ${Math.round(r.recall * 100)}% of the words heard)`).join(', ')}` : 'every question was sent whole',
  });
  if (expectCut) checks.push({ name: 'she is cut by the user', ok: cuts.some((c) => c.cause === 'user'), detail: cuts.some((c) => c.cause === 'user') ? 'the user speaking over her cut her off' : 'the user spoke over her and she was not cut' });
  return { turns, clips: results, cuts, notes, errors, checks, echoMeasuredDb, warnings: checks.filter((c) => c.soft && !c.ok).map((c) => c.name), pass: checks.filter((c) => !c.soft).every((c) => c.ok) };
}

/**
 * How loud her voice was at the microphone, in dB of her own level, while no clip played: the median of mic over hers where she sounded.
 * @param {Rec} rec @returns {number | null}
 */
function measureEcho(rec) {
  if (!rec.micLevel?.length) return null;
  const mic = new Map(rec.micLevel.map(([at, v]) => [Math.round(at / 20), v]));
  /** @type {number[]} */
  const ratios = [];
  for (const [at, her] of rec.level) {
    if (her < SOUND || rec.plays.some((p) => at >= p.at - 200 && at <= p.end + 200)) continue;
    const m = mic.get(Math.round(at / 20));
    if (m !== undefined) ratios.push(20 * Math.log10(Math.max(m, 1e-6) / her));
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

/** @param {number} ms */
const secs = (ms) => (ms / 1000).toFixed(2);
/** How long after (or, negative, before) the user stopped. @param {number} ms @param {string} [what] */
const after = (ms, what = 'the user stopped') => (ms < 0 ? `${secs(-ms)} s BEFORE ${what}` : `${secs(ms)} s after ${what}`);

/**
 * Everything the record holds, in one list in time order from the session's open: the clips played into the microphone, the frames each
 * way (a run of audio as one line), where she sounded, and annai's own trace; the user's turns and her first audio explained.
 * @param {Rec} rec @param {ReturnType<typeof analyse>} a
 */
export function timeline(rec, a) {
  /** @type {{ at: number, src: string, text: string }[]} */
  const rows = [];
  const add = (/** @type {number} */ at, /** @type {string} */ src, /** @type {string} */ text) => rows.push({ at, src, text });
  for (const p of rec.plays) add(p.at, 'mic', `say ${p.name} (${secs(p.end - p.at)} s, ends ${secs(p.end - rec.startedAt)})${p.gainDb ? ` at ${p.gainDb} dB` : ''}`);
  const frames = [...rec.frames].sort((x, y) => x.at - y.at);
  /** @type {{ dir: string, from: number, to: number, n: number, bytes: number } | null} */
  let run = null;
  const flush = () => {
    if (run) add(run.from, run.dir === 'out' ? 'ws>>' : 'ws<<', `audio x${run.n} ${(run.bytes / 1000).toFixed(0)} kB, to ${secs(run.to - rec.startedAt)}${run.dir === 'in' ? firstAudioNote(run.from) : ''}`);
    run = null;
  };
  /** The first audio of an answer is explained: how long after the user stopped. @param {number} at */
  const firstAudioNote = (at) => {
    const c = a.clips.find((x) => x.answered && x.firstAudioMs !== null && x.end + /** @type {number} */ (x.firstAudioMs) === at);
    return c ? ` (first audio ${after(/** @type {number} */ (c.firstAudioMs))}, saying ${c.name})` : '';
  };
  for (const fr of frames) {
    if (fr.kind === 'audio') {
      if (run && (run.dir !== fr.dir || fr.at - run.to > 600)) flush();
      run ??= { dir: fr.dir, from: fr.at, to: fr.at, n: 0, bytes: 0 };
      run.to = fr.at;
      run.n++;
      run.bytes += fr.bytes ?? 0;
      continue;
    }
    flush();
    const arrow = fr.dir === 'out' ? 'ws>>' : 'ws<<';
    let text = fr.kind;
    if (fr.text) text += ` "${fr.text.replace(/\s+/g, ' ').slice(0, 100)}"`;
    if (fr.name) text += ` ${fr.name}`;
    if (fr.kind === 'close') text += ` ${fr.code ?? ''} ${fr.reason ?? ''}`.trimEnd();
    if (fr.dir === 'out' && fr.kind === 'activityEnd') {
      const t = a.turns.find((x) => x.end === fr.at);
      const clip = t && a.clips.find((c) => t.clip === `${c.name}@${c.at}`);
      if (t) text += ` (turn ${t.i}: ${secs(t.ms ?? 0)} s sent, ended "${t.reason ?? '?'}"${clip && clip.end ? `, ${after(fr.at - clip.end, 'the clip ended')}` : t.spurious ? `, NOBODY SPOKE${t.echo ? ': HER ECHO' : ''}` : ''})`;
    }
    add(fr.at, arrow, text);
  }
  flush();
  for (const r of soundRuns(rec.level)) {
    add(r.from, 'she', 'sounds');
    add(r.to, 'she', 'stops');
  }
  for (const t of rec.trace) {
    const d = t.data ?? {};
    const detail = t.type === 'live.turn' ? `${d.end} ${d.ms} ms floor ${d.floorDb} peak ${d.peakDb}` : t.type === 'live.session' ? `${d.state ?? ''}${d.why ? ` why=${d.why}` : ''}` : t.type === 'out.speak' ? `${d.cut ? 'CUT ' : ''}${d.voice ? 'voice ' : ''}${t.text ? `"${t.text.slice(0, 100)}"` : ''}` : `${d.kind ?? ''} ${d.message ?? t.text ?? ''}`.trim();
    add(t.at, 'trace', `${t.type} ${detail}`.trimEnd());
  }
  rows.sort((x, y) => x.at - y.at);
  return rows.map((r) => `${secs(r.at - rec.startedAt).padStart(8)}  ${r.src.padEnd(6)} ${r.text}`).join('\n');
}

/**
 * One scenario in a few lines: each clip with what became of it, then the checks and notes.
 * @param {Rec} rec @param {ReturnType<typeof analyse>} a @param {string} [about]
 */
export function detail(rec, a, about = '') {
  const out = [`== ${rec.scenario}: ${a.pass ? 'PASS' : 'FAIL'} (${rec.route}${rec.echoDb === null ? '' : `, her voice back into the microphone at ${rec.echoDb} dB`})${about ? ` ${about}` : ''}`];
  for (const c of a.clips) {
    if (c.expect === 'nothing') {
      out.push(`   ${c.name.padEnd(9)} ${secs(c.end - c.at)} s of quiet, ${a.turns.some((t) => t.start >= c.at && t.start <= c.end) ? 'a turn began in it' : 'no turn began'}`);
      continue;
    }
    const t = a.turns.filter((x) => x.clip === `${c.name}@${c.at}`);
    const ends = t.map((x) => `${x.reason ?? '?'}`).join('+');
    out.push(`   ${c.name.padEnd(9)} ${c.turns ? `${c.turns} turn${c.turns > 1 ? 's' : ''} (${t.map((x) => `${secs(x.ms ?? 0)} s`).join(' + ')} sent), ended by ${ends}, ${c.endLagMs === null ? 'never ended' : after(c.endLagMs)}` : 'NO TURN was made'}; ${c.answered ? `audio back ${after(/** @type {number} */ (c.firstAudioMs))}${c.tools.length ? ` (after ${c.tools.join(', ')})` : ''}, sound at the speaker ${c.firstSoundMs === null ? '?' : after(c.firstSoundMs)}` : 'NO AUDIO back'}`);
    out.push(`             heard: "${c.heard}"${c.heard ? ` (${Math.round(c.recall * 100)}% of the words)` : ''}${c.said ? `; she said: "${c.said.slice(0, 140)}"` : ''}`);
  }
  for (const k of a.cuts) out.push(`   she was cut at ${secs(k.at - rec.startedAt)} s by ${k.cause === 'user' ? 'the user speaking over her' : k.cause === 'echo' ? 'HER OWN ECHO' : k.cause === 'noise' ? 'noise' : 'something else'}`);
  for (const c of a.checks) out.push(`   ${c.ok ? 'ok  ' : c.soft ? 'WARN' : 'FAIL'} ${c.name}: ${c.detail}`);
  for (const n of a.notes) out.push(`   note: ${n}`);
  return out.join('\n');
}

/**
 * The short report: one row a scenario, its checks, and the verdict.
 * @param {{ rec: Rec, a: ReturnType<typeof analyse> }[]} runs
 * @param {{ sessions: number, lines: number[] }} used
 */
export function summary(runs, used) {
  const as = runs.map((r) => r.a);
  const names = runs.map((r) => r.rec.scenario);
  const out = [`${as.length} scenarios, ${used.sessions} realtime session${used.sessions === 1 ? '' : 's'}${used.lines.length ? ` (key lines ${used.lines.join(', ')})` : ''}`];
  runs.forEach((r, i) => {
    const a = as[i];
    const asked = a.clips.filter((c) => c.expect === 'answer');
    const med = median(asked.flatMap((c) => (c.firstAudioMs === null ? [] : [c.firstAudioMs])));
    out.push(`${names[i].padEnd(14)} ${asked.filter((c) => c.answered).length}/${asked.length} answered  ${a.checks.map((c) => `${c.ok ? 'ok' : c.soft ? 'WARN' : 'FAIL'} ${c.name}`).join(', ')}${med === null ? '' : `  first audio ${secs(med)} s`}  ${a.pass ? 'PASS' : 'FAIL'}`);
  });
  const warned = as.reduce((n, a) => n + a.warnings.length, 0);
  out.push(`overall: ${as.every((a) => a.pass) ? `PASS${warned ? ` (${warned} warning${warned === 1 ? '' : 's'})` : ''}` : 'FAIL'}`);
  return out.join('\n');
}

/** @param {number[]} xs */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
