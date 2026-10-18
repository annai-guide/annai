// Shiori's rig on a virtual clock (the post-release review's scenarios): races between blinks, head turns and state
// changes; loops that stop when she is off the page or off screen; reduced motion; how often she draws.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { advance, make, place, av, frontEyes, frontLight, markerBand, setReduced, pending, counts, motionListenerCount, art } from './avatar-sim.js';

/** @type {any[]} */
let made = [];
/** @param {boolean} [onPage] */
const avatar = (onPage) => {
  const a = make(onPage);
  made.push(a);
  advance(20); // the observer reports
  return a;
};
afterEach(() => {
  for (const a of made) place(a, false);
  made = [];
  advance(100);
  setReduced(false);
  art.loaded = true;
});

test('S1: a blink is closing when Thinking comes: her head still turns', () => {
  const a = avatar();
  a.setState('listening');
  advance(500);
  a.blink();
  advance(80);
  a.setState('thinking');
  advance(1000);
  assert.equal(av(a).dataset.face, 'turned');
});

test('S2: Thinking comes, then a blink lands while her eyes close for the turn: her head still turns', () => {
  const a = avatar();
  a.setState('listening');
  advance(500);
  a.setState('thinking');
  advance(30);
  a.blink();
  advance(1000);
  assert.equal(av(a).dataset.face, 'turned');
});

test('S3: turned away, Talking comes, then a blink lands: she faces you again', () => {
  const a = avatar();
  a.setState('thinking');
  advance(1000);
  a.setState('speaking');
  advance(30);
  a.blink();
  advance(1000);
  assert.equal(av(a).dataset.face, undefined);
  assert.equal(frontLight(a), '14.5');
});

test('S4: a blink is open-and-shut when Hearing you comes: her eyes reopen wide', () => {
  const a = avatar();
  a.setState('listening');
  advance(500);
  a.blink();
  advance(90);
  a.setState('hearing');
  advance(1000);
  assert.equal(frontLight(a), '17.4');
});

test('rapid changes (thinking, listening, thinking, talking) settle on the last: facing you, eyes open', () => {
  const a = avatar();
  a.setState('listening');
  advance(500);
  for (const s of ['thinking', 'listening', 'thinking', 'speaking']) {
    a.setState(s);
    advance(50);
  }
  advance(2000);
  assert.equal(av(a).dataset.face, undefined);
  assert.equal(frontLight(a), '14.5');
});

test('thinking straight to asleep: her asleep head, with no moment of no head or two heads', () => {
  const a = avatar();
  a.setState('thinking');
  advance(1000);
  assert.equal(av(a).dataset.face, 'turned');
  a.setState('sleeping');
  /** @type {(string | undefined)[]} */
  const faces = [];
  for (let i = 0; i < 60; i++) {
    advance(10);
    faces.push(av(a).dataset.face);
  }
  assert.deepEqual([...new Set(faces)], ['turned', 'asleep']);
  assert.equal(frontLight(a), '0');
});

test('waking: one head at a time, the asleep one until halfway through her lifting it, then the front one', () => {
  const a = avatar();
  advance(1000);
  assert.equal(av(a).dataset.face, 'asleep');
  a.setState('listening');
  advance(100);
  assert.equal(av(a).dataset.face, 'asleep');
  advance(200);
  assert.equal(av(a).dataset.face, undefined);
  a.setState('sleeping');
  advance(100);
  assert.equal(av(a).dataset.face, undefined);
  advance(200);
  assert.equal(av(a).dataset.face, 'asleep');
});

test('asleep straight to thinking: her head turns', () => {
  const a = avatar();
  advance(100);
  a.setState('thinking');
  advance(1000);
  assert.equal(av(a).dataset.face, 'turned');
});

test('a second glance is not cut short by the first one ending', () => {
  const a = avatar();
  a.setState('listening');
  advance(500);
  a.glance(1, 0);
  advance(500);
  a.glance(-1, 0);
  advance(700);
  assert.equal(frontEyes(a).style.transform, 'translate(-14px, 0px)');
  advance(500);
  assert.equal(frontEyes(a).style.transform, '');
});

test('working: the streamer steps through one wave at about 15 frames a second, not once a frame', () => {
  const a = avatar();
  const band = markerBand(a);
  a.setState('away');
  advance(200);
  const before = band.writes.d ?? 0;
  /** @type {Set<string | null>} */
  const shapes = new Set();
  for (let i = 0; i < 100; i++) {
    advance(100);
    shapes.add(band.getAttribute('d'));
  }
  const steps = (band.writes.d ?? 0) - before;
  assert.ok(steps >= 130 && steps <= 170, `${steps} steps in 10 s`);
  assert.ok(shapes.size <= 32, `${shapes.size} shapes: one wave, precomputed`);
});

test('talking: the streamer is redrawn only when it moves enough to see', () => {
  const a = avatar();
  const band = /** @type {any} */ (a.el.find('pin')).find('band');
  a.setState('speaking');
  a.setLevel(0);
  advance(300);
  let before = band.writes.d ?? 0;
  advance(2000);
  const quiet = (band.writes.d ?? 0) - before;
  a.setLevel(1);
  advance(300);
  before = band.writes.d ?? 0;
  advance(2000);
  const loud = (band.writes.d ?? 0) - before;
  assert.ok(quiet < 10, `${quiet} redraws in 2 s when she's quiet`);
  assert.ok(loud > quiet && loud < 120, `${loud} redraws in 2 s at full voice`);
});

test('an avatar never put on the page runs nothing: no frames, no blinks, no timers', () => {
  const a = avatar(false);
  const band = markerBand(a);
  a.setState('away');
  advance(5000);
  a.setState('speaking');
  a.setLevel(1);
  advance(5000);
  a.setState('listening');
  advance(60000);
  assert.equal(band.writes.d ?? 0, 1, 'drawn once, at rest');
  assert.equal(pending(), 0);
});

test('taken off the page or scrolled off screen, she stops; back on screen, she goes on', () => {
  const a = avatar();
  const band = markerBand(a);
  a.setState('away');
  advance(1000);
  place(a, false);
  let before = band.writes.d;
  advance(2000);
  assert.ok(band.writes.d - before <= 1, 'stops once off the page');
  assert.equal(av(a).dataset.hidden, '');
  place(a, true, false);
  before = band.writes.d;
  advance(2000);
  assert.ok(band.writes.d - before <= 1, 'stays stopped off screen');
  place(a, true, true);
  before = band.writes.d;
  advance(2000);
  assert.ok(band.writes.d - before > 20, 'goes on back on screen');
  assert.equal(av(a).dataset.hidden, undefined);
});

test('reduced motion: on at the start, no blinks; turned off, blinks and the wave begin; turned on again, they stop', () => {
  setReduced(true);
  const a = avatar();
  const iris = /** @type {any} */ (frontEyes(a).find('iris'));
  const band = markerBand(a);
  a.setState('listening');
  let before = iris.writes.d;
  advance(20000);
  assert.equal(iris.writes.d - before, 0, 'no blinks');
  setReduced(false);
  before = iris.writes.d;
  advance(20000);
  assert.ok(iris.writes.d - before > 0, 'blinks once it is off');
  a.setState('away');
  advance(500);
  setReduced(true);
  before = band.writes.d;
  advance(2000);
  assert.ok(band.writes.d - before <= 1, 'the wave stops when it is on');
  setReduced(false);
  before = band.writes.d;
  advance(2000);
  assert.ok(band.writes.d - before > 20, 'and goes on when it is off');
});

test('one reduced-motion query for every avatar, read once, and its listener goes when she leaves the page', () => {
  const before = counts.matchMedia;
  const a = avatar();
  a.setState('away');
  advance(5000);
  assert.equal(counts.matchMedia - before, 0);
  assert.ok(motionListenerCount() >= 1);
  place(a, false);
  advance(100);
  assert.equal(motionListenerCount(), 0);
});

test('setLevel writes the level once, on the seat, and only when it changes', () => {
  const a = avatar();
  a.setState('speaking');
  const glow = a.el.writes['data-glow'] ?? 0; // set once as she is made
  for (let i = 0; i < 10; i++) a.setLevel(0.5);
  a.setLevel(0.5, 'her');
  assert.equal(a.el.writes['--amp'], 1);
  assert.equal(av(a).writes['--amp'] ?? 0, 0, '.av inherits it');
  assert.equal((a.el.writes['data-glow'] ?? 0) - glow, 0, 'glow already "her"');
  a.setLevel(0.5, 'you');
  assert.equal(a.el.writes['data-glow'] - glow, 1);
});

test("her art shows only once it has arrived; if it never does, the seat shows alone and she stops asking", () => {
  art.loaded = false;
  const a = avatar();
  advance(500);
  assert.equal(av(a).dataset.art, 'wait');
  art.loaded = true;
  advance(500);
  assert.equal(av(a).dataset.art, undefined);
  art.loaded = false;
  const b = avatar();
  advance(60000);
  assert.equal(av(b).dataset.art, 'wait');
  place(a, false);
  advance(100);
  assert.equal(pending(), 0, 'no polling left');
});
