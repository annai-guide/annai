import { CORE_SCHEMAS } from './schemas.js';
import { VERSION } from '../../app/version.js';
import { t } from '../../core/l10n.js';

export const manifest = {
  id: 'core-schemas',
  name: t`Trip record checks`,
  version: VERSION,
  api: 1,
  description: t`Checks trip.json, plan items, bookings and watches when they are saved.`,
};

/** @param {{ schemas: { register: (entry: any) => () => void } }} annai */
export function activate(annai) {
  const off = CORE_SCHEMAS.map((entry) => annai.schemas.register(entry));
  return () => off.forEach((fn) => fn());
}
