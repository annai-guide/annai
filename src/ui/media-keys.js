/** The media keys a car or headset sends. */
const KEYS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'];

/**
 * Steering-wheel and headset buttons as a talk button (spec §18: an experiment): while voice is
 * on, the media keys act like a tap on Shiori (tapShiori: stop her, listen, or stop listening). Browsers send
 * them only to a page that played sound lately. A key this browser doesn't know is left alone.
 * @param {{ session: any, tap: () => unknown, voice: { on: boolean, onChange(fn: (m: { on: boolean }) => void): () => void } }} c
 * @returns {() => void} stops following the voice mode
 */
export function mediaKeys({ session, tap, voice }) {
  if (!session?.setActionHandler) return () => {};
  /** @param {boolean} on */
  const set = (on) => {
    for (const key of KEYS) {
      try {
        session.setActionHandler(key, on ? () => { tap(); } : null);
      } catch {
        // not a key this browser has
      }
    }
  };
  set(voice.on);
  return voice.onChange((m) => set(m.on));
}
