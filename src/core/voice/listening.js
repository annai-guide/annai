import { record } from './recorder.js';
import { newId } from '../scopes.js';

/**
 * A listening session (spec §10.2): start, stop, and a stream of segments. Recording opens the
 * microphone and the end-of-sentence detector cuts what it hears into segments; phone dictation
 * gives the words itself. They can't run together. When dictation fails, the session records from
 * the next segment on (§10.3). A session never decides to stop listening: its owner does.
 * @typedef {import('./resolve.js').Heard} Heard
 * @param {{ platform: import('./platform.js').VoicePlatform, kind: 'record' | 'dictation', pauseMs: number, lang?: string, now?: () => number, local?: boolean, recording?: { type: string, format: string },
 *   onSegment: (h: Heard) => void, onSpeech?: () => void, onQuiet?: () => void, onLevel?: (x: number) => void,
 *   onError: (e: Error) => void, onSwitch?: (e: Error) => void }} c
 *   onQuiet: what began like speech wasn't (a click); onSwitch: dictation failed and recording took over; local: dictation stays on the phone
 * @returns {Promise<{ readonly kind: 'record' | 'dictation', stop(): void }>}
 */
export async function listen(c) {
  const now = c.now ?? Date.now;
  /** @type {{ close(): void } | null} */
  let running = null;
  /** @type {'record' | 'dictation'} */
  let kind = c.kind;
  let stopped = false;
  const recording = async () => {
    kind = 'record';
    const r = await record({
      mic: c.platform.mic, pauseMs: c.pauseMs, now, recording: c.recording, onSpeech: c.onSpeech, onDiscard: c.onQuiet, onLevel: c.onLevel, onError: c.onError,
      onSegment: (s) => c.onSegment({ id: s.id, source: 'mic', audio: s.audio, ms: s.ms, at: s.at, ...(s.encoded ? { encoded: s.encoded } : {}) }),
    });
    if (stopped) r.close();
    else running = r;
  };
  if (kind === 'dictation') {
    running = c.platform.dictation.open({
      lang: c.lang,
      local: Boolean(c.local),
      onSpeech: c.onSpeech,
      onQuiet: c.onQuiet,
      onSegment: (text) => c.onSegment({ id: newId('s'), source: 'dictation', text, ms: 0, at: now() }),
      onError: (e) => {
        if (stopped) return;
        running?.close();
        running = null;
        c.onSwitch?.(e);
        recording().catch((err) => c.onError(err));
      },
    });
  } else {
    await recording();
  }
  return {
    get kind() {
      return kind;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      running?.close();
      running = null;
    },
  };
}
