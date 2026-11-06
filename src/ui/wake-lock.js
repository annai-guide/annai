import { readAppSettings, updateAppSettings } from '../core/settings.js';

/**
 * The screen kept on while GPS is on: one setting, on unless the user turned it off, kept in the app settings. The lock is held while
 * GPS is on, annai is on screen, and the setting says so; the browser lets it go off screen, and it is asked for again on coming back.
 * @param {{ live: { on: boolean, shown: boolean, onChange: (fn: () => void) => unknown },
 *   ws: import('../core/workspace.js').Workspace, lock?: { request: (type: 'screen') => Promise<any> } | null }} c
 */
export function keepAwake({ live, ws, lock = /** @type {any} */ (globalThis.navigator)?.wakeLock ?? null }) {
  let chosen = true;
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
        console.warn(/* en */ 'a wake lock listener failed', e);
      }
    }
  };
  const want = () => Boolean(live.on && live.shown && chosen);
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
  const ready = readAppSettings(ws).then((s) => { chosen = s.live?.keepScreenOn !== false; }, () => {}).then(apply);
  live.onChange(() => { apply().catch(() => {}); });
  return {
    ready,
    available: Boolean(lock),
    get held() {
      return Boolean(held);
    },
    get chosen() {
      return chosen;
    },
    /** Keep the screen on while GPS is on, or not. @param {boolean} on */
    async choose(on) {
      chosen = on;
      await updateAppSettings(ws, { live: { keepScreenOn: on } });
      await apply();
    },
    /** @param {() => void} fn */
    onChange(fn) {
      changes.add(fn);
      return () => { changes.delete(fn); };
    },
  };
}
