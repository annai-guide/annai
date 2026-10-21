import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speaker, speechOutEntries, wordStart } from '../../src/core/voice/speaker.js';
import { fakePlatform, fakeVoices } from './voice-fakes.js';

/** @param {ReturnType<typeof fakeVoices>} v @param {ReturnType<typeof fakePlatform>} p */
const speaker = (v, p) => new Speaker({ entries: v.entries, synthesize: v.synthesize, bench: v.bench, platform: () => /** @type {any} */ (p), locale: 'en' });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const plays = (/** @type {string[]} */ log) => log.filter((l) => l.startsWith('play ') || l.startsWith('browser ')).map((l) => l.replace(/^\S+ /, ''));

test('sentences play as they stream in, and the next is fetched while one plays (spec §10.1)', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1']);
  const u = speaker(v, p).begin();
  u.feed('Bixby Bridge is two miles ahead. When it op');
  await tick(5);
  assert.deepEqual(v.log, ['fetch v1 Bixby Bridge is two miles ahead.'], 'the first sentence goes before the rest has arrived');
  u.feed('Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop');
  u.end('Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop?');
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['v1:Bixby Bridge is two miles ahead.', 'v1:When it opened in 1932, it was tall!', 'v1:Want a stop?']);
  assert.equal(done.said, 3);
  assert.equal(done.cut, null);
  assert.equal(done.failed, null);
  assert.equal(done.heard, 'Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop?');
  assert.deepEqual(p.sessions, ['playback'], 'playback while she speaks: heard with the silent switch on (spec §10.1)');
});

test('the next clip is fetched while one plays: no gap waiting for it', async () => {
  const p = fakePlatform({ playMs: 30 });
  const v = fakeVoices(['v1'], { fetchMs: 5 });
  const u = speaker(v, p).begin();
  u.end('One. Two. Three.');
  await tick(20); // the first clip is playing
  assert.deepEqual(v.log, ['fetch v1 One.', 'fetch v1 Two.']);
  await u.done;
});

test('a voice that fails partway is benched; the same sentence plays on the next voice, and so does the rest (spec §10.1)', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1', 'v2'], { failing: { v1: 'Second' } });
  const u = speaker(v, p).begin();
  u.end('First thing. Second thing. Third thing.');
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['v1:First thing.', 'v2:Second thing.', 'v2:Third thing.']);
  assert.deepEqual(v.benched, ['v1']);
  assert.equal(done.said, 3);
  assert.deepEqual(done.voices, ['v1', 'v2']);
});

test('done names the voices that failed and why, for the Voice test to say before who spoke (the second emulator re-check, N39)', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1', 'v2'], { failing: { v1: true } });
  const u = speaker(v, p).begin();
  u.end('One thing.');
  const done = await u.done;
  assert.deepEqual(done.voices, ['v2']);
  assert.deepEqual(done.failedVoices, [{ name: 'v1', why: 'v1 failed' }]);
  const ok = fakeVoices(['v1']);
  const u2 = speaker(ok, fakePlatform()).begin();
  u2.end('Fine.');
  assert.deepEqual((await u2.done).failedVoices, []);
});

test('the browser voice speaks when it comes first, or when every API voice failed; a cut is kept by word', async () => {
  const p = fakePlatform({ playMs: 40 });
  const v = fakeVoices(['v1'], { failing: { v1: true }, browser: true });
  const s = speaker(v, p);
  const u = s.begin();
  u.end('Bixby Bridge is two miles ahead. Want a stop?');
  await tick(20);
  assert.equal(s.speaking, true);
  assert.equal(s.stop(), true);
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['Bixby Bridge is two miles ahead.']);
  assert.deepEqual(done.cut, { index: 0, at: 6 });
  assert.equal(done.heard, 'Bixby…');
  assert.equal(done.said, 0);
  assert.equal(s.speaking, false);
});

test('cut off while a clip is still downloading: done settles at once, nothing plays, the download stops', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1'], { fetchMs: 200 });
  const u = speaker(v, p).begin();
  u.end('One more thing. And another.');
  await tick(10);
  const t0 = Date.now();
  u.stop();
  const done = await u.done;
  assert.ok(Date.now() - t0 < 50);
  assert.deepEqual(plays(p.log), []);
  assert.ok(v.log.includes('aborted v1 One more thing.'));
  assert.deepEqual(done.cut, { index: 0, at: 0 });
  assert.equal(done.heard, '');
});

test('cut off between sentences, while the rest is still being written: what was said is kept', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1']);
  const u = speaker(v, p).begin();
  u.feed('One. Two is on its w');
  await tick(60);
  u.stop();
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['v1:One.']);
  assert.equal(done.said, 1);
  assert.deepEqual(done.cut, { index: 1, at: 0 });
  assert.equal(done.heard, 'One.');
});

test('a cut in a clip is kept by the fraction played, back to a word', async () => {
  const p = fakePlatform({ playMs: 100 });
  const v = fakeVoices(['v1']);
  const u = speaker(v, p).begin();
  u.end('Bixby Bridge is two miles ahead.');
  await tick(30);
  u.stop();
  const done = await u.done;
  assert.deepEqual(done.cut, { index: 0, at: wordStart('Bixby Bridge is two miles ahead.', 0.5) });
  assert.equal(done.heard, 'Bixby Bridge is…');
  assert.equal(wordStart('Bixby Bridge is two miles ahead.', 0.5), 15);
  assert.equal(wordStart('Bixby', 0.5), 0);
  assert.equal(wordStart('Bixby', 1), 5);
});

test('utterances play one after another; a stop cuts them all', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1']);
  const s = speaker(v, p);
  const a = s.begin();
  const b = s.begin();
  b.end('Second.');
  a.end('First.');
  await Promise.all([a.done, b.done]);
  assert.deepEqual(plays(p.log), ['v1:First.', 'v1:Second.']);
  const c = s.begin();
  const d = s.begin();
  c.end('A one. A two.');
  d.end('Never said.');
  await tick(10);
  s.stop();
  const [dc, dd] = await Promise.all([c.done, d.done]);
  assert.ok(dc.cut);
  assert.equal(dd.said, 0);
  assert.ok(!plays(p.log).includes('v1:Never said.'));
});

test('no voice works, or the page may not play sound yet: done says so, and a blocked page benches no voice', async () => {
  const blank = speaker(fakeVoices([]), fakePlatform()).begin();
  blank.end('   ');
  assert.equal((await blank.done).failed, null, 'nothing to say is no failure');
  const u = speaker(fakeVoices([]), fakePlatform()).begin();
  u.end('Hello.');
  assert.equal((await u.done).failed, 'no-voice');
  const v = fakeVoices(['v1']);
  const w = speaker(v, fakePlatform({ blocked: true })).begin();
  w.end('Hello.');
  const blocked = await w.done;
  assert.equal(blocked.failed, 'blocked');
  assert.deepEqual(v.benched, []);
  const x = new Speaker({ ...fakeVoices(['v1']), platform: () => null }).begin();
  x.end('Hello.');
  assert.equal((await x.done).failed, 'no-voice');
});

test('the speech-out entries that can speak now, in their order (spec §9.6)', () => {
  /** @type {any} */
  const cfg = {
    providers: {
      'pv-o': { id: 'pv-o', plugin: 'p', template: null, user: { abilities: { voice: { kind: 'voice', type: 'say' } } } },
      'pv-i': { id: 'pv-i', plugin: 'p', template: null, user: { abilities: { transcription: { kind: 'transcription', type: 'hear' } } } },
    },
    models: { 'm-o': { id: 'm-o', provider: 'pv-o', ability: 'voice', template: null, user: { providerId: 'tts', name: 'Marin' } }, 'm-i': { id: 'm-i', provider: 'pv-i', ability: 'transcription', template: null, user: { providerId: 'asr' } } },
    roles: { 'speech-out': { models: ['m-o', 'browser-voice', 'm-i', 'm-gone'], level: 'off' } },
  };
  const types = new Map([['say', { speech: 'out' }], ['hear', { speech: 'in' }]]);
  const ids = (/** @type {any} */ c) => speechOutEntries(cfg, { types, until: () => 0, now: 1, browser: true, ...c }).map((e) => `${e.kind}:${e.name}`);
  assert.deepEqual(ids({}), ['api:Marin', 'browser:Browser voice']);
  assert.deepEqual(ids({ until: (/** @type {string} */ id) => (id === 'm-o' ? 5 : 0) }), ['browser:Browser voice']);
  assert.deepEqual(ids({ browser: false }), ['api:Marin']);
  assert.deepEqual(speechOutEntries({ ...cfg, roles: {} }, { types, until: () => 0, now: 1, browser: true }).map((e) => e.id), ['browser-voice']);
});
