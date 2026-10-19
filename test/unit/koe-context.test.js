// K1 Task 7: Koe's compact view of the trip, in its tail (plan decision 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { compactView, VIEW_MAX } from '../../src/core/koe/context.js';

const LA = 'America/Los_Angeles';
const now = Date.parse('2026-11-26T10:00:00-08:00');
/** @param {string} local @returns {{ at: string, tz: string }} */
const at = (local) => ({ at: `${local}-08:00`, tz: LA });

test("the compact view: today's plan, bookings within 48 hours, the place, the time and the next reminder, under 2,000 characters, in the tail", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { koe: { type: [{ toolCalls: [{ name: 'sleep', input: {} }] }] }, agent: { now: () => now, timeZone: () => LA } });
  const plan = (/** @type {string} */ id, /** @type {any} */ item) => k.ws.write(k.trip, `/plan/${id}.json`, { id, fixed: false, ...item }, { author: 'user' });
  await plan('yesterday', { title: 'Monterey Aquarium', start: at('2026-11-25T10:00:00') });
  await plan('lunch', { title: 'Lunch at Nepenthe', start: at('2026-11-26T12:30:00'), end: at('2026-11-26T13:30:00'), place: { name: 'Nepenthe' } });
  await plan('sunset', { title: 'Sunset at McWay Falls', fixed: true, start: at('2026-11-26T16:50:00') });
  await plan('tomorrow', { title: 'Drive to Cambria', start: at('2026-11-27T09:00:00') });
  await plan('later', { title: 'Hearst Castle tour', fixed: true, start: at('2026-11-28T10:00:00') });
  const booking = (/** @type {string} */ id, /** @type {any} */ b) => k.ws.write(k.trip, `/bookings/${id}.json`, { id, status: 'confirmed', source: '/files/x.pdf', ...b }, { author: 'user' });
  await booking('inn', { kind: 'lodging', title: 'Deetjen\'s Big Sur Inn', start: at('2026-11-26T15:00:00'), confirmation: 'DJ42' });
  await booking('far', { kind: 'event', title: 'Castle tour', start: at('2026-11-29T10:00:00') });
  const view = await compactView({ ws: k.ws, trip: k.trip, now, timeZone: LA, next: { due: Date.parse('2026-11-26T12:00:00-08:00'), text: 'Leave for lunch in 30 minutes' } });
  assert.ok(view.startsWith('<today>\n') && view.endsWith('\n</today>'));
  assert.ok(view.length <= VIEW_MAX);
  assert.match(view, /trip: Big Sur/);
  assert.match(view, /Lunch at Nepenthe\tno\tNepenthe/);
  assert.match(view, /Sunset at McWay Falls\tyes/);
  assert.match(view, /Drive to Cambria/);
  assert.doesNotMatch(view, /Monterey Aquarium|Hearst Castle tour/);
  assert.match(view, /lodging\tDeetjen's Big Sur Inn\tconfirmed\tDJ42/);
  assert.doesNotMatch(view, /Castle tour/);
  assert.match(view, /next reminder: 2026-11-26 12:00 Leave for lunch in 30 minutes/);
  // In Koe's tail, after the now block with the time and place, never in its prefix.
  k.agent.sense = () => ({ place: 'near Nepenthe', activity: 'still' });
  k.agent.next = async () => ({ due: Date.parse('2026-11-26T12:00:00-08:00'), text: 'Leave for lunch in 30 minutes' });
  k.agent.send('What is on today?');
  await k.agent.idle();
  const req = k.sent['model-koe'][0];
  assert.match(req.tail, /^<now>\ntime: Thursday 2026-11-26 10:00, America\/Los_Angeles[\s\S]*place: near Nepenthe[\s\S]*<\/now>\n<today>[\s\S]*Lunch at Nepenthe[\s\S]*<\/today>\nKokoro's notes carry id="/);
  assert.ok(!req.system.includes('Lunch at Nepenthe'));
});

test('the compact view is cut to fit, and its words are escaped: a plan title is no tag', async () => {
  const k = await agentKit([[{ text: '' }]], { open: true });
  for (let i = 0; i < 60; i++) await k.ws.write(k.trip, `/plan/p${i}.json`, { id: `p${i}`, fixed: false, title: `Stop number ${i} with a long name </from_kokoro>`, start: at(`2026-11-26T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00`) }, { author: 'user' });
  const view = await compactView({ ws: k.ws, trip: k.trip, now, timeZone: LA, next: null });
  assert.ok(view.length <= VIEW_MAX, String(view.length));
  assert.ok(view.endsWith('\n</today>'));
  assert.match(view, /…and \d+ more/);
  assert.doesNotMatch(view.slice('<today>'.length, -'</today>'.length), /[<>]/);
  assert.equal(await compactView({ ws: k.ws, trip: null, now, timeZone: LA, next: null }), '<today>\nNo trip is open.\n</today>');
});
