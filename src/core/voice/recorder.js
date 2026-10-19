import { Detector } from './detector.js';
import { encodeWav, resample, SEND_RATE } from './pcm.js';
import { newId } from '../scopes.js';

/** While nobody speaks, a recording alongside starts again this often, so its file begins at most this long before the speech. */
export const RESTART_MS = 2000;

/**
 * The recording side of a listening session (spec §10.2): the microphone is open only while this
 * runs, and the end-of-sentence detector cuts what it hears into segments, each a 16 kHz WAV whose
 * samples other formats are made from when a receiver needs them (Koe and Kokoro design, "Audio
 * formats"). With recording, a MediaRecorder runs alongside (decision 24): it is cut with each
 * segment, whose file of that format it gives, and starts again every RESTART_MS while nobody speaks.
 * @typedef {{ id: string, audio: { data: Uint8Array, mediaType: 'audio/wav', seconds: number }, ms: number, at: number, encoded?: Map<string, Promise<Uint8Array | null>> }} Segment
 * @param {{ mic: import('./platform.js').Mic, pauseMs?: number, now?: () => number, recording?: { type: string, format: string }, onSpeech?: () => void, onLevel?: (x: number) => void,
 *   onSegment: (s: Segment) => void, onDiscard?: () => void, onError?: (e: Error) => void }} c
 * @returns {Promise<{ close(): void }>} close: the mic closes; speech still going on becomes a segment first
 */
export async function record({ mic, pauseMs = 700, now = Date.now, recording, onSpeech, onLevel, onSegment, onDiscard, onError }) {
  /** @type {Detector | null} */
  let detector = null;
  let closed = false;
  /** @type {import('./platform.js').OpenMic | null} */
  let open = null;
  let since = now();
  /** @param {import('./detector.js').DetectorEvent[]} events */
  const handle = (events) => {
    for (const e of events) {
      if (e.type === 'speech') onSpeech?.();
      else if (e.type === 'discard') {
        onDiscard?.();
        open?.again?.();
        since = now();
      } else {
        const file = recording && open?.take?.();
        since = now();
        onSegment({
          id: newId('s'), audio: { data: encodeWav(resample(e.pcm, e.sampleRate, SEND_RATE), SEND_RATE), mediaType: 'audio/wav', seconds: e.ms / 1000 }, ms: e.ms, at: now(),
          ...(recording && file ? { encoded: new Map([[recording.format, file]]) } : {}),
        });
      }
    }
  };
  open = await mic.open({
    onFrames: (pcm, rate) => {
      if (closed) return;
      if (detector?.sampleRate !== rate) detector = new Detector({ sampleRate: rate, pauseMs });
      handle(detector.push(pcm));
      onLevel?.(detector.level);
      if (open?.again && !detector.speaking && now() - since >= RESTART_MS) {
        open.again();
        since = now();
      }
    },
    onError: (e) => { if (!closed) onError?.(e); },
    ...(recording ? { record: recording.type } : {}),
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      if (detector) handle(detector.end());
      open?.close();
      onLevel?.(0);
    },
  };
}
