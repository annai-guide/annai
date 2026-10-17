import { insidePlugin } from './packages.js';

/**
 * What plugins may add to annai's screens (spec §16.4), checked before it is registered. Pure: the
 * core never touches the DOM; src/ui/slots.js draws what is registered.
 */

export const SLOTS = Object.freeze(['status-chip', 'now-section', 'dock-action', 'trip-tab', 'settings-page']);
export const COMPONENTS = Object.freeze(['avatar', 'now-card', 'dock', 'plan-row']);
export const ACTIVITIES = Object.freeze(['still', 'walking', 'moving-fast']);
export const UI_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** @param {unknown} s @param {number} min @param {number} max */
const words = (s, min, max) => typeof s === 'string' && s.trim().length >= min && [...s].length <= max;
const fn = (/** @type {unknown} */ f) => typeof f === 'function';
/** The name a slot's item goes by in messages. */
const SLOT_NAMES = /** @type {Record<string, string>} */ ({ 'status-chip': 'status chip', 'now-section': 'Now section', 'dock-action': 'dock action', 'trip-tab': 'trip tab', 'settings-page': 'settings page' });

/** What is wrong with a slot's item, or null. @param {string} slot @param {any} item @returns {string | null} */
export function checkSlot(slot, item) {
  if (!SLOTS.includes(slot)) return `"${slot}" isn't a slot; the slots are ${SLOTS.join(', ')}`;
  if (typeof item?.id !== 'string' || !UI_ID.test(item.id)) return `a ${slot} needs an id of lowercase letters, digits and dashes`;
  const what = `the ${SLOT_NAMES[slot]} ${item.id}`;
  if (slot === 'dock-action') {
    if (!words(item.label, 1, 40)) return `${what} needs a label of 1 to 40 characters`;
    if (typeof item.icon !== 'string' || [...item.icon].length < 1 || [...item.icon].length > 2) return `${what} needs an icon of 1 or 2 characters`;
    if (!fn(item.run)) return `${what} needs run`;
    return null;
  }
  if (slot !== 'status-chip' && !words(item.title, 1, 40)) return `${what} needs a title of 1 to 40 characters`;
  if (!fn(item.render)) return `${what} needs render`;
  return null;
}

/** @param {any} item @returns {string | null} */
export function checkCardType(item) {
  if (typeof item?.type !== 'string' || !UI_ID.test(item.type)) return 'a card type needs a type of lowercase letters, digits and dashes';
  const what = `the card type ${item.type}`;
  if (!words(item.name, 1, 40)) return `${what} needs a name of 1 to 40 characters`;
  if (!words(item.description, 1, 300)) return `${what} needs a description of 1 to 300 characters`;
  if (!fn(item.render)) return `${what} needs render`;
  if (item.schema !== undefined && (!item.schema || typeof item.schema !== 'object' || Array.isArray(item.schema))) return `${what}'s schema must be a JSON Schema object`;
  return null;
}

/** @param {string} name @param {any} impl @returns {string | null} */
export function checkComponent(name, impl) {
  if (!COMPONENTS.includes(name)) return `"${name}" isn't a component annai lets plugins replace; those are ${COMPONENTS.join(', ')}`;
  const needs = name === 'avatar' || name === 'dock' ? 'create' : 'render';
  if (!impl || !fn(impl[needs])) return `the ${name} component needs ${needs}`;
  return null;
}

/** @param {any} item @returns {string | null} */
export function checkScreen(item) {
  if (typeof item?.id !== 'string' || !UI_ID.test(item.id)) return 'a screen needs an id of lowercase letters, digits and dashes';
  const what = `the screen ${item.id}`;
  if (!words(item.title, 1, 40)) return `${what} needs a title of 1 to 40 characters`;
  if (!fn(item.render)) return `${what} needs render`;
  if (item.tab !== undefined && typeof item.tab !== 'boolean') return `${what}'s tab is true or false`;
  if (item.homeFor !== undefined && !ACTIVITIES.includes(item.homeFor)) return `${what}'s homeFor is one of ${ACTIVITIES.join(', ')}`;
  return null;
}

/** @param {unknown} file @returns {string | null} */
export function checkTheme(file) {
  if (typeof file !== 'string' || !file.endsWith('.css') || !insidePlugin(file)) return 'a theme is a .css file in the package, such as theme.css';
  return null;
}

/** The parts of a card Shiori can show (spec §7.1 show). */
const CARD_PROPERTIES = {
  title: { type: 'string' },
  text: { type: 'string', description: 'Markdown: **bold**, *italic*, lists and [links](https://…).' },
  place: { type: 'object', properties: { name: { type: 'string' }, address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } }, required: ['name'] },
  links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label', 'url'] } },
  booking: { type: 'string', description: 'A booking’s path, such as /trip/bookings/hotel.json.' },
  image: { type: 'string', description: 'A photo’s path, such as /trip/files/2026-11-26-1604.webp.' },
  choice: { type: 'array', items: { type: 'string' }, description: 'Buttons. A tap comes back to you as a message.' },
};

/**
 * The show tool's card: the built-in parts, and, once plugins add card types, type and data.
 * @param {{ type: string, name: string, description: string }[]} types
 */
export function cardSchema(types) {
  if (!types.length) return { type: 'object', properties: CARD_PROPERTIES };
  return {
    type: 'object',
    properties: {
      ...CARD_PROPERTIES,
      type: { type: 'string', enum: types.map((t) => t.type), description: `A kind of card a plugin draws, with its data: ${types.map((t) => `${t.type}: ${t.description}`).join(' ')}` },
      data: { type: 'object', description: 'What a typed card shows, as its type asks.' },
    },
  };
}
