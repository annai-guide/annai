import { Detector } from './detector.js';
import { encodeWav, resample, SEND_RATE } from './pcm.js';
import { newId } from '../scopes.js';

/**
 * The recording side of a listening session (spec §10.2): the microphone is open only while this
 * runs, and the end-of-sentence detector cuts what it hears into segments, each a 16 kHz WAV.
 * @typedef {{ id: string, audio: { data: Uint8Array, mediaType: 'audio/wav', seconds: number }, ms: number, at: number }} Segment
 * @param {{ mic: import('./platform.js').Mic, pauseMs?: number, now?: () => number, onSpeech?: () => void, onLevel?: (x: number) => void,
 *   onSegment: (s: Segment) => void, onDiscard?: () => void, onError?: (e: Error) => void }} c
 * @returns {Promise<{ close(): void }>} close: the mic closes; speech still going on becomes a segment first
 */
export async function record({ mic, pauseMs = 700, now = Date.now, onSpeech, onLevel, onSegment, onDiscard, onError }) {
  /** @type {Detector | null} */
  let detector = null;
  let closed = false;
  /** @param {import('./detector.js').DetectorEvent[]} events */
  const handle = (events) => {
    for (const e of events) {
      if (e.type === 'speech') onSpeech?.();
      else if (e.type === 'discard') onDiscard?.();
      else onSegment({ id: newId('s'), audio: { data: encodeWav(resample(e.pcm, e.sampleRate, SEND_RATE), SEND_RATE), mediaType: 'audio/wav', seconds: e.ms / 1000 }, ms: e.ms, at: now() });
    }
  };
  const open = await mic.open({
    onFrames: (pcm, rate) => {
      if (closed) return;
      if (detector?.sampleRate !== rate) detector = new Detector({ sampleRate: rate, pauseMs });
      handle(detector.push(pcm));
      onLevel?.(detector.level);
    },
    onError: (e) => { if (!closed) onError?.(e); },
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      open.close();
      if (detector) handle(detector.end());
      onLevel?.(0);
    },
  };
}
