import { at, off, MONTEREY, BIXBY, RIVER_INN, NEPENTHE, HEARST } from './live-kit.js';

/** Points from a to b between t0 and t1 (t1 left out), one every sec seconds, as the log keeps them while moving. */
export function road(/** @type {{ lat: number, lng: number }} */ a, /** @type {{ lat: number, lng: number }} */ b, /** @type {number} */ t0, /** @type {number} */ t1, sec = 5) {
  const out = [];
  for (let t = t0; t < t1; t += sec * 1000) {
    const f = (t - t0) / (t1 - t0);
    out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, at: t });
  }
  return out;
}
const LEAVING_BIXBY = off(BIXBY, 40, 0);
/** A morning on Highway 1: a stop at Bixby Bridge, five minutes at the River Inn, the phone locked at Nepenthe until Hearst Castle. */
export const MORNING = [
  ...road(MONTEREY, BIXBY, at('09:00'), at('09:30')),
  { ...BIXBY, at: at('09:30') }, { ...LEAVING_BIXBY, at: at('09:50') }, // stopped 20 min: the log kept the arrival, then the leaving
  ...road(LEAVING_BIXBY, RIVER_INN, at('09:50:05'), at('10:08')),
  { ...RIVER_INN, at: at('10:08') }, { ...off(RIVER_INN, 0, 30), at: at('10:13') }, // 5 min: not a stay
  ...road(off(RIVER_INN, 0, 30), NEPENTHE, at('10:13:05'), at('10:30')),
  { ...NEPENTHE, at: at('10:30') }, // the phone locked here…
  { ...HEARST, at: at('16:40') }, { ...off(HEARST, 20, 20), at: at('18:15') }, // …and unlocked at Hearst Castle
];
