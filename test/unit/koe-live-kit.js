// Helpers for Koe live's tests (K5): Shiori as two halves with a realtime model, at the stand-in Gemini Live server.
import { agentKit } from './agent-kit.js';
import { clip, quiet, cat } from './voice-kit.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

export const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** Voice-like 24 kHz 16-bit PCM, seconds long. @param {number} [seconds] */
export const tone = (seconds = 0.6) => new Uint8Array(Int16Array.from({ length: Math.round(24_000 * seconds) }, (_, i) => Math.round(6000 * Math.sin(i / 9))).buffer);

/**
 * Shiori as two halves with a realtime model (m-live) first in Koe's list, at a stand-in Gemini Live server
 * that answers with turns; a voice (on unless voice says otherwise), and Kokoro's scripts.
 * @param {any[]} turns @param {{ pace?: number, kokoro?: any[], koe?: any, voice?: any, live?: any, agent?: any }} [o]
 */
export async function liveKit(turns, o = {}) {
  const server = await startRealtimeServer({ flavour: o.live?.type === 'openai-realtime' ? 'openai' : 'gemini', turns, pace: o.pace ?? 0.05 });
  const k = await agentKit(o.kokoro ?? [{ rules: [{ match: '.', reply: sleep }] }], {
    live: { origin: server.origin, ...o.live }, koe: o.koe, agent: o.agent, voice: { speechIn: ['m-hear'], ...o.voice },
  });
  await k.agent.idle();
  return { ...k, server, done: async () => { k.agent.hush('away'); await server.stop(); } };
}
/** @param {any} k @param {string} [state] the live.session entries, or those in one state */
export const lives = async (k, state) => (await k.events(['live.session'])).filter((/** @type {any} */ e) => !state || e.data.state === state);
/** The instruction blocks Kokoro got. @param {any} k */
export const blocks = async (k) => (await k.events(['halves'])).map((/** @type {any} */ e) => e.data.state);
/** What the stand-in got, of one kind. @param {any} k @param {string} key */
export const got = (k, key) => k.server.received().filter((/** @type {any} */ m) => m[key]);
/** The text turns it got. @param {any} k */
export const texts = (k) => got(k, 'clientContent').flatMap((/** @type {any} */ m) => m.clientContent.turns.flatMap((/** @type {any} */ t) => t.parts.filter((/** @type {any} */ p) => p.text).map((/** @type {any} */ p) => p.text)));
/** Waits for an async condition. @param {() => Promise<boolean>} fn */
export async function soon(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** The user says one of the speech clips into the microphone. @param {any} k @param {string} name */
export const say = async (k, name) => k.platform.mic.feed(cat(quiet(0.3), await clip(name), quiet(1)), 16_000);

