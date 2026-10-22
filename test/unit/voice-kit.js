import { readFile } from 'node:fs/promises';
import { decodeWav } from '../../src/core/voice/pcm.js';
import { Detector } from '../../src/core/voice/detector.js';

/**
 * Sound for the voice tests: the speech fixtures (16 kHz), pauses with a faint hiss, and brown
 * noise like a car's, all from a seeded generator so every run hears the same thing.
 */
export const RATE = 16_000;

/** @param {string} name a clip in test/fixtures/voice/ */
export async function clip(name) {
  return decodeWav(new Uint8Array(await readFile(new URL(`../fixtures/voice/${name}.wav`, import.meta.url)))).pcm;
}

/** @param {number} seed */
function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
}

/** A pause: a faint hiss, as a real microphone never gives true silence. @param {number} seconds @param {number} [amp] */
export function quiet(seconds, amp = 0.0005) {
  const r = random(11);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => r() * amp);
}

/** A short loud noise: a click, a door. @param {number} seconds @param {number} amp */
export function burst(seconds, amp) {
  const r = random(5);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => r() * amp);
}

/** Brown noise, the rumble of a car. @param {number} seconds @param {number} amp @param {number} [seed] */
export function brown(seconds, amp, seed = 7) {
  const r = random(seed);
  let last = 0;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    last = (last + 0.02 * r()) / 1.02;
    return last * amp * 3.5;
  });
}

/**
 * A room whose noise wanders by about 2 dB from 20 ms to 20 ms (people, a TV, the road), with speech said at 3 s; zeroAt(t): the
 * microphone gives digital silence then, as an iPhone's echo canceller and a just-opened microphone do (the voice investigation, 2026-10-22).
 * @param {number} seconds @param {Float32Array} speech @param {(t: number) => boolean} [zeroAt] @param {number} [amp]
 */
export function room(seconds, speech, zeroAt = () => false, amp = 0.003) {
  const r = random(9);
  const g = random(10);
  const out = new Float32Array(Math.round(seconds * RATE));
  let w = 0;
  for (let i = 0; i < out.length; i++) {
    if (i % 320 === 0) w = 0.8 * w + 1.2 * g();
    out[i] = r() * amp * 10 ** (w / 20);
  }
  out.set(speech.map((x, j) => x + out[3 * RATE + j]), 3 * RATE);
  for (let i = 0; i < out.length; i++) if (zeroAt(i / RATE)) out[i] = 0;
  return out;
}

/** @param {...Float32Array} parts */
export function cat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** a with b added, sample by sample. @param {Float32Array} a @param {Float32Array} b */
export const mix = (a, b) => a.map((x, i) => x + (b[i] ?? 0));

/** Runs the detector over pcm in chunks, as a microphone would give it, then ends. @param {Float32Array} pcm @param {Record<string, number>} [opts] */
export function detect(pcm, opts = {}) {
  const d = new Detector({ sampleRate: RATE, ...opts });
  const events = [];
  for (let i = 0; i < pcm.length; i += 2048) events.push(...d.push(pcm.subarray(i, i + 2048)));
  return events;
}

/** The length of each segment, in ms. @param {import('../../src/core/voice/detector.js').DetectorEvent[]} events */
export const segments = (events) => events.flatMap((e) => (e.type === 'segment' ? [e.ms] : []));
