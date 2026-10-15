import { CORE_SCHEMAS } from './schemas.js';
import { VERSION } from '../../app/version.js';

export const manifest = {
  id: 'core-schemas',
  name: 'Trip record checks',
  version: VERSION,
  api: 1,
  description: 'Checks trip.json, plan items and bookings when they are saved.',
};

/** @param {{ schemas: { register: (entry: any) => () => void } }} annai */
export function activate(annai) {
  const off = CORE_SCHEMAS.map((entry) => annai.schemas.register(entry));
  return () => off.forEach((fn) => fn());
}
