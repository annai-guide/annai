// Helpers for the tests of one input at a time (live-flight-*): Kokoro's notes, the continuation after a call she speaks after, and the tap,
// at the stand-in Gemini Live server, in real seconds. Lines and places are synthetic.
import { until } from './agent-kit.js';
import { liveKit, texts, soon, tone, say } from './koe-live-kit.js';
import { quiet } from './voice-kit.js';

export const RATE = 16_000;
export const FOR_USER = 'The fuel station ahead is open until ten tonight.';
export const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
export const SAID = 'The fuel station ahead is open until ten tonight.';
export const PASS = 'The pass closes at nine.';
export const FERRY = 'The ferry leaves at four.';
/** Kokoro's tell_koe with for_user, as its tool sends it. @param {any} k */
export const tell = (k) => k.agent.channel.send('kokoro', NOTE, 'append', 'tool', undefined, undefined, false, FOR_USER);
/** @param {any} k */
export const tell2 = (k) => k.agent.channel.send('kokoro', 'Tell the user the pass closes at nine.', 'append', 'tool', undefined, undefined, false, PASS);
/** @param {any} k */
export const tell3 = (k) => k.agent.channel.send('kokoro', 'Tell the user the ferry leaves at four.', 'append', 'tool', undefined, undefined, false, FERRY);
/** What annai showed for Shiori in the conversation open, and whether its own voice said it. @param {any} k */
export const shown = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.aloud)]);
/** Her lines, as written: words, cut, voiced, and when. @param {any} k @returns {Promise<{ text: string, cut: boolean, voice: boolean, ts: number }[]>} */
export const lines = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => ({ text: e.data.text, cut: Boolean(e.data.cut), voice: Boolean(e.data.voice), ts: e.ts }));
/** Her lines' words, in order. @param {any} k */
export const words = async (k) => (await lines(k)).map((l) => l.text);
/** The text turns the stand-in got, of either flavour, in order. @param {any} k @returns {string[]} */
export const textsIn = (k) => k.server.received().flatMap((/** @type {any} */ m) => (m.clientContent ? texts({ server: { received: () => [m] } })
  : m.type === 'conversation.item.create' ? (m.item?.content ?? []).filter((/** @type {any} */ p) => p.text).map((/** @type {any} */ p) => p.text) : []));
/** Kokoro's notes that went in. @param {any} k */
export const notesIn = (k) => textsIn(k).filter((t) => t.includes('<from_kokoro'));
/** annai's own lines that went in (the ask once more, a reminder, the ask again). @param {any} k */
export const asks = (k) => textsIn(k).filter((t) => /^\[annai\] /.test(t));
/** The live-silent lines, their words. @param {any} k @returns {Promise<string[]>} */
export const silences = async (k) => (await k.events(['error'])).filter((/** @type {any} */ e) => e.data.kind === 'live-silent').map((/** @type {any} */ e) => String(e.data.message));
/** annai's ask once more for a note. @param {any} k */
export const cues = (k) => asks(k).filter((t) => t.includes('Kokoro'));
export const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** Bytes of 24 kHz 16-bit silence, seconds long. @param {number} seconds */
export const zeros = (seconds) => new Uint8Array(Math.round(24_000 * seconds) * 2);
/** @param {Uint8Array} a @param {Uint8Array} b */
export const join = (a, b) => { const x = new Uint8Array(a.length + b.length); x.set(a); x.set(b, a.length); return x; };
/** Her reply to the note: "Checking your notes." and a lookup she speaks after (its turnComplete 1.2 s after its burst); the next turn follows at once. */
export const LOOKS = { said: 'Checking your notes.', audio: tone(0.8), tool: { name: 'watch_list', args: {} }, endAt: 1200, andThen: true };
/** Her continuation after the lookup's answer, 3 s later, saying the note. */
export const CONT = { said: 'Nothing there, but the station is open until ten.', audio: tone(0.8), delayMs: 3000 };

/**
 * When each text went in, and the dock's state, in ms from t0, watched every 10 ms. @param {any} k @param {number} t0
 * @returns {{ log: [number, string, string][], at: (pattern: RegExp, nth?: number) => number, stop: () => void }}
 */
export function watch(k, t0) {
  /** @type {[number, string, string][]} */
  const log = [];
  let last = '';
  let n = 0;
  const look = () => {
    const v = k.agent.live.view.name;
    if (v !== last) log.push([Date.now() - t0, 'dock', (last = v)]);
    const all = textsIn(k);
    for (; n < all.length; n++) log.push([Date.now() - t0, 'in', all[n]]);
  };
  const timer = setInterval(look, 10);
  return {
    log,
    /** When the nth text matching went in (ms from t0), Infinity if never. */
    at: (pattern, nth = 0) => {
      look();
      return log.filter(([, kind, s]) => kind === 'in' && pattern.test(s))[nth]?.[0] ?? Infinity;
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * A live session in the car (sound may cut her), the user in it, a real second; her answer to their question said. With note, Kokoro's
 * note, and resolves as she begins her reply to it (turns: hers from then on); else as she begins her reply to their question.
 * pace: the stand-in's (OpenAI's: how long generating takes, as a share of the sound's length).
 * @param {{ turns: any[], live?: any, server?: any, note?: boolean, pace?: number }} o @returns {Promise<{ k: any, t0: number, w: ReturnType<typeof watch> }>}
 */
export async function start({ turns, live, server, note = true, pace = 1 }) {
  const first = note ? [{ said: 'Hello there.', audio: tone(0.1) }] : [];
  const k = await liveKit([...first, ...turns], { pace, agent: { secondMs: 1000 }, ...(live ? { live } : {}), ...(server ? { server } : {}) });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  if (note) {
    await soon(async () => (await k.events(['out.speak'])).length === 1, 6000);
    await k.agent.live.idle();
    k.platform.mic.feed(quiet(0.5), RATE);
    await tell(k);
  }
  await soon(async () => k.agent.live.view.name === 'speaking', 6000);
  const t0 = Date.now();
  return { k, t0, w: watch(k, t0) };
}

/** A live session in the car, the user in it, her answer to their question said, and nothing going on: resolves with the clock started. @param {any[]} turns @param {{ live?: any, server?: any }} [o] */
export async function quietSession(turns, o = {}) {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, ...turns], { pace: 1, agent: { secondMs: 1000 }, ...o });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => (await k.events(['out.speak'])).length === 1, 6000);
  await k.agent.live.idle();
  k.platform.mic.feed(quiet(0.5), RATE);
  const t0 = Date.now();
  return { k, t0, w: watch(k, t0) };
}

/** When her line with these words was written (ms from t0), Infinity if never. @param {any} k @param {number} t0 @param {string} text */
export const lineAt = async (k, t0, text) => ((await lines(k)).find((l) => l.text === text)?.ts ?? Infinity) - t0;
