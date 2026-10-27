import { VERSION } from '../../app/version.js';
import { t } from '../../core/l10n.js';

export const manifest = {
  id: 'sensors',
  name: t`Sensors`,
  version: VERSION,
  api: 1,
  description: t`Where the phone is (GPS, only while GPS is on in annai and annai is on screen), whether annai is on screen, and whether there is a connection.`,
};

/** A number the phone gave, or null. @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The phone's sensors for live mode (spec §11.2), as registry items the live engine starts and
 * stops: location (watchPosition), visibility and connectivity. They only report: nothing here
 * sends a position anywhere (§11.7).
 * @param {{ geolocation?: Geolocation, document?: Document, window?: Window, navigator?: Navigator }} env
 */
export function sensors({ geolocation, document: doc, window: win, navigator: nav }) {
  return [
    {
      kind: /** @type {const} */ ('location'),
      /** @param {(x: any) => void} emit */
      start(emit) {
        if (!geolocation?.watchPosition) {
          // Kept with the state, never shown: a developer's words.
          emit({ error: 'unavailable', message: /* en */ "This browser can't tell where it is." });
          return () => {};
        }
        const id = geolocation.watchPosition(
          (p) => emit({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: num(p.coords.accuracy) ?? 50, speed: num(p.coords.speed), heading: num(p.coords.heading) }),
          // A refusal is the user's; anything else (no signal, a timeout) passes, and the watch goes on.
          (e) => emit({ error: e.code === 1 ? 'denied' : 'unavailable', message: String(e.message ?? '') }),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 },
        );
        return () => geolocation.clearWatch(id);
      },
    },
    {
      kind: /** @type {const} */ ('visibility'),
      /** @param {(x: boolean) => void} emit */
      start(emit) {
        const now = () => emit(doc?.visibilityState !== 'hidden');
        const gone = () => emit(false);
        doc?.addEventListener('visibilitychange', now);
        // The back-forward cache freezes a page without a visibilitychange on some browsers.
        win?.addEventListener('pagehide', gone);
        win?.addEventListener('pageshow', now);
        now();
        return () => {
          doc?.removeEventListener('visibilitychange', now);
          win?.removeEventListener('pagehide', gone);
          win?.removeEventListener('pageshow', now);
        };
      },
    },
    {
      kind: /** @type {const} */ ('connectivity'),
      /** @param {(x: boolean) => void} emit */
      start(emit) {
        const now = () => emit(nav?.onLine !== false);
        win?.addEventListener('online', now);
        win?.addEventListener('offline', now);
        now();
        return () => {
          win?.removeEventListener('online', now);
          win?.removeEventListener('offline', now);
        };
      },
    },
  ];
}

/** @param {any} annai */
export function activate(annai) {
  const offs = sensors({ geolocation: navigator.geolocation, document, window, navigator }).map((s) => annai.register('sensor', s));
  return () => offs.forEach((off) => off());
}
