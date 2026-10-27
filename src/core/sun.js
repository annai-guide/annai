import { timeIn } from './time.js';
import { t } from './l10n.js';

/**
 * The sun, worked out on the phone (spec §11.5: "Sunrise, sunset and golden hour are computed on
 * the phone"), with the equations of NOAA's solar calculator (after Jean Meeus, "Astronomical
 * Algorithms"), good to about a minute away from the poles.
 * @typedef {{ noon: number, sunrise: number | null, sunset: number | null, dawn: number | null, dusk: number | null,
 *   goldenMorningEnd: number | null, goldenEveningStart: number | null, polar: 'day' | 'night' | null }} SunTimes
 *   ms, or null when that moment doesn't come that day; dawn and dusk: civil twilight, the sun 6° below the horizon;
 *   golden hour: the sun lower than 6° above it; polar: the sun doesn't set (day) or rise (night) that day
 */

const RAD = Math.PI / 180;
const DAY = 86_400_000;
const MIN = 60_000;

/** The sun's declination (radians) and the equation of time (minutes) at an instant. @param {number} ms */
function sunAt(ms) {
  const jc = (ms / DAY + 2440587.5 - 2451545) / 36525; // Julian centuries since J2000
  const l0 = (((280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360) + 360) % 360; // mean longitude
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc); // mean anomaly
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc); // the orbit's eccentricity
  const c = Math.sin(RAD * m) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(RAD * 2 * m) * (0.019993 - 0.000101 * jc) + Math.sin(RAD * 3 * m) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const apparent = l0 + c - 0.00569 - 0.00478 * Math.sin(RAD * omega);
  const tilt = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(RAD * omega);
  const dec = Math.asin(Math.sin(RAD * tilt) * Math.sin(RAD * apparent));
  const y = Math.tan((RAD * tilt) / 2) ** 2;
  const eot = (4 / RAD) * (y * Math.sin(2 * RAD * l0) - 2 * e * Math.sin(RAD * m) + 4 * e * y * Math.sin(RAD * m) * Math.cos(2 * RAD * l0)
    - 0.5 * y * y * Math.sin(4 * RAD * l0) - 1.25 * e * e * Math.sin(2 * RAD * m));
  return { dec, eot };
}

/**
 * The sun's times at a place, for the day whose solar noon is nearest ms.
 * @param {number} ms @param {number} lat @param {number} lng @returns {SunTimes}
 */
export function sunTimes(ms, lat, lng) {
  const day = Math.floor((ms + lng * 4 * MIN) / DAY) * DAY; // the place's solar date, at 00:00 UTC
  const phi = RAD * lat;
  /** 12:00 less 4 min a degree east, less the equation of time at t; ± the hour angle. @param {number} t @param {number} [ha] degrees */
  const clock = (t, ha = 0) => day + (720 - 4 * lng + 4 * ha - sunAt(t).eot) * MIN;
  const noon = clock(clock(day + 720 * MIN));
  /** The hour angle's cosine when the sun is at deg, at t. @param {number} deg @param {number} t */
  const cosH = (deg, t) => {
    const { dec } = sunAt(t);
    return (Math.sin(RAD * deg) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  };
  /** When the sun is at deg, rising (-1) or setting (+1); null when it never is. @param {number} deg @param {-1 | 1} side */
  const when = (deg, side) => {
    let t = noon;
    for (let k = 0; k < 3; k++) {
      const c = cosH(deg, t);
      if (c < -1 || c > 1) return null;
      t = clock(t, side * Math.acos(c) / RAD);
    }
    return t;
  };
  const c = cosH(-0.833, noon);
  return {
    noon,
    sunrise: when(-0.833, -1), sunset: when(-0.833, 1),
    dawn: when(-6, -1), dusk: when(-6, 1),
    goldenMorningEnd: when(6, -1), goldenEveningStart: when(6, 1),
    polar: c < -1 ? 'day' : c > 1 ? 'night' : null,
  };
}

/**
 * What the sun is doing, as chips for the Now screen (spec §16.2): the next sunrise, golden hour,
 * sunset or dusk, in the place's own time zone.
 * @param {number} now @param {number} lat @param {number} lng @param {string} tz @returns {string[]}
 */
export function sunChips(now, lat, lng, tz) {
  const sun = sunTimes(now, lat, lng);
  const hm = (/** @type {number} */ x) => timeIn(x, tz);
  if (sun.polar === 'day') return [t`Midnight sun`];
  if (sun.polar === 'night') return [t`Polar night`];
  const sunrise = /** @type {number} */ (sun.sunrise);
  const sunset = /** @type {number} */ (sun.sunset);
  if (now < sunrise) return [t`Sunrise ${hm(sunrise)}`];
  const { goldenMorningEnd: goldenEnd, goldenEveningStart: golden } = sun;
  // The sun never climbs past golden hour's 6° (high latitudes in winter): golden light until sunset, then dusk as any day.
  if (golden === null || goldenEnd === null) {
    if (now < sunset) return [t`Golden light all day`, t`Sunset ${hm(sunset)}`];
  } else if (now < goldenEnd) {
    return [t`Golden hour until ${hm(goldenEnd)}`];
  } else if (now < golden) {
    return [t`Golden hour ${hm(golden)}`, t`Sunset ${hm(sunset)}`];
  }
  if (now < sunset) return [t`Golden hour now`, t`Sunset ${hm(sunset)}`];
  if (sun.dusk !== null && now < sun.dusk) return [t`Dusk ${hm(sun.dusk)}`];
  const tomorrow = sunTimes(now + DAY / 2, lat, lng);
  return tomorrow.sunrise !== null ? [t`Sunrise ${hm(tomorrow.sunrise)}`] : [];
}
