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
