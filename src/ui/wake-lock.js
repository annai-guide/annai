import { readAppSettings, updateAppSettings } from '../core/settings.js';

/** The situations the screen choice is kept for (spec §11.1: "per situation"). @param {string} activity */
export const situation = (activity) => (activity === 'moving-fast' || activity === 'walking' || activity === 'still' ? activity : 'unknown');

/**
 * The screen kept on in live mode (spec §11.1: "the user's choice per situation (on the car charger,
 * yes; walking, probably not)"): one choice for each activity, kept in the app settings. The lock is
 * held while live mode is on, annai is on screen, and the choice for the activity now says so; the
 * browser lets it go off screen, and it is asked for again on coming back.
 * @param {{ live: { on: boolean, shown: boolean, activity: string, onChange: (fn: () => void) => unknown },
 *   ws: import('../core/workspace.js').Workspace, lock?: { request: (type: 'screen') => Promise<any> } | null }} c
 */
export function keepAwake({ live, ws, lock = /** @type {any} */ (globalThis.navigator)?.wakeLock ?? null }) {
  /** @type {Record<string, boolean>} */
  let choices = {};
  /** @type {any} */
  let held = null;
  let asking = false;
  /** @type {Set<() => void>} */
  const changes = new Set();
  const tell = () => {
    for (const fn of changes) {
      try {
        fn();
      } catch (e) {
        console.warn('a wake lock listener failed', e);
      }
    }
  };
  const want = () => Boolean(live.on && live.shown && choices[situation(live.activity)]);
  const apply = async () => {
    if (want() && !held && lock && !asking) {
      asking = true;
      try {
        const sentinel = await lock.request('screen');
        held = sentinel;
        sentinel?.addEventListener?.('release', () => {
          if (held !== sentinel) return;
          held = null;
          tell();
        });
      } catch {
        held = null; // refused (low battery, say): the screen goes off as usual
      } finally {
        asking = false;
      }
      if (held && !want()) await apply();
    } else if (!want() && held) {
      const sentinel = held;
      held = null;
      await Promise.resolve(sentinel.release?.()).catch(() => {});
    }
    tell();
  };
  const ready = readAppSettings(ws).then((s) => { choices = { ...(s.live?.awake ?? {}) }; }, () => {}).then(apply);
  live.onChange(() => { apply().catch(() => {}); });
  return {
    ready,
    available: Boolean(lock),
    get held() {
      return Boolean(held);
    },
    get chosen() {
      return Boolean(choices[situation(live.activity)]);
    },
    /** Keep the screen on (or not) in the situation now. @param {boolean} on */
    async choose(on) {
      const key = situation(live.activity);
      choices = { ...choices, [key]: on };
      await updateAppSettings(ws, { live: { awake: { [key]: on } } });
      await apply();
    },
    /** @param {() => void} fn */
    onChange(fn) {
      changes.add(fn);
      return () => { changes.delete(fn); };
    },
  };
}
