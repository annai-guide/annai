/** Places on the Big Sur drive, and a point some meters away from one. Tests of live mode share these. */
export const MONTEREY = { lat: 36.6036, lng: -121.8916 };
export const BIXBY = { lat: 36.3715, lng: -121.9017 };
export const RIVER_INN = { lat: 36.27, lng: -121.807 };
export const NEPENTHE = { lat: 36.2213, lng: -121.7567 };
export const MCWAY = { lat: 36.158, lng: -121.672 };
export const HEARST = { lat: 35.6852, lng: -121.166 };
export const CAMBRIA = { lat: 35.5641, lng: -121.0807 };
/** Meters in a degree of latitude, as meters() counts them. */
const DEG = (6_371_000 * Math.PI) / 180;
/** A point dx meters east and dy meters north of p. @param {{ lat: number, lng: number }} p @param {number} dx @param {number} dy */
export const off = (p, dx, dy) => ({ lat: p.lat + dy / DEG, lng: p.lng + dx / (DEG * Math.cos((p.lat * Math.PI) / 180)) });
export const LA = 'America/Los_Angeles';
/** A moment on the day of the drive, Pacific time. @param {string} hhmm "09:30" or "09:30:15" */
export const at = (hhmm, day = '2026-11-27') => Date.parse(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}-08:00`);
