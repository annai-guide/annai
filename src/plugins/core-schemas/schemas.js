import { WATCH_SCHEMA } from '../../core/live/watches.js';
import { NAMES_FILE, NAMES_SCHEMA } from '../../core/names.js';

const TIME = {
  type: 'object', required: ['at', 'tz'],
  properties: { at: { type: 'string', format: 'date-time' }, tz: { type: 'string', minLength: 1 } },
};
const PLACE = {
  type: 'object', required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    address: { type: 'string' },
  },
};

export const TRIP_SCHEMA = {
  type: 'object', required: ['id', 'title'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    start: { type: 'string', format: 'date' },
    end: { type: 'string', format: 'date' },
    // A trip a simulation made (spec §13): outside its run, live mode leaves it as it is.
    simulation: { type: 'boolean' },
    places: { type: 'array', items: { type: 'string' } },
    timezones: { type: 'array', items: { type: 'string' } },
    party: {
      type: 'array',
      items: {
        type: 'object', required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          age: { type: 'integer', minimum: 0, maximum: 130 },
          interests: { type: 'array', items: { type: 'string' } },
          driver: { type: 'boolean' },
        },
      },
    },
  },
};

export const PLAN_ITEM_SCHEMA = {
  type: 'object', required: ['id', 'title', 'fixed'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    kind: { type: 'string' },
    fixed: { type: 'boolean' },
    priority: { type: 'integer', minimum: 0, maximum: 3 },
    start: TIME,
    end: TIME,
    place: PLACE,
    booking: { type: 'string' },
    notes: { type: 'string' },
  },
};

export const BOOKING_SCHEMA = {
  type: 'object', required: ['id', 'kind', 'status', 'source'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { enum: ['flight', 'lodging', 'car', 'rail', 'event', 'restaurant', 'other'] },
    status: { enum: ['unverified', 'confirmed'] },
    source: { type: 'string', pattern: '^/' },
    title: { type: 'string' },
    start: TIME,
    end: TIME,
    place: PLACE,
    confirmation: { type: 'string' },
    cost: {
      type: 'object', required: ['amount', 'currency'],
      properties: { amount: { type: 'number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } },
    },
    fields: { type: 'object' },
  },
};

/** Registrations for the workspace's schema lookup (spec §4.4). */
export const CORE_SCHEMAS = [
  { scope: 'trip', pattern: '/trip.json', schema: TRIP_SCHEMA },
  { scope: 'trip', pattern: '/plan/*.json', schema: PLAN_ITEM_SCHEMA },
  { scope: 'trip', pattern: '/bookings/*.json', schema: BOOKING_SCHEMA },
  { scope: 'trip', pattern: '/watches/*.json', schema: WATCH_SCHEMA },
  { scope: 'me', pattern: '/watches/*.json', schema: WATCH_SCHEMA },
  // Shiori's short names for files, beside them in a trip and in the waiting space (sys:waiting).
  { scope: 'trip', pattern: NAMES_FILE, schema: NAMES_SCHEMA },
  { scope: 'sys', pattern: NAMES_FILE, schema: NAMES_SCHEMA },
];
