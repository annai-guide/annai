import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveBigSur, EXPECTED, NARRATE, label } from './big-sur-kit.js';

test('a simulated Big Sur drive produces the expected wakes, and Shiori does what her skills say (spec §20, milestone 5)', async () => {
  const { k } = await driveBigSur();

  const wakes = (await k.events(['wake'])).filter((e) => !e.data.meanwhile);
  assert.deepEqual(wakes.map((e) => label(e.data.reasons)), EXPECTED);
  // Unlocked after the phone was locked: what came due and how far they went, in one wake (spec §11.4).
  const catchUp = String(wakes.find((e) => e.data.reasons[0].kind === 'catch-up')?.data.reasons[0].text);
  assert.match(catchUp, /^Catch-up: annai was off screen for 47 min \(since 15:18\), and the user moved \d+\.\d km\. /);
  assert.match(catchUp, /Plan: time to leave soon for "Hearst Castle tour" \(fixed, 16:30\): .*\(late by 1\d min: annai was off screen\)\./);
  assert.match(catchUp, /fired: you have travelled \d+\.\d km since your last wake/);
  // With no connection near Lucia, annai said the narration watch's reminder itself, aloud (spec §11.3, §17).
  assert.deepEqual((await k.events(['reminder'])).map((e) => [e.data.text, e.data.aloud]), [[NARRATE, true], [NARRATE, true]]);
  assert.equal(k.said.filter((/** @type {string} */ s) => s === NARRATE).length, 2);
  // What Shiori did, as the skills say.
  const calls = (await k.events(['tool.call'])).map((e) => e.data.name);
  assert.equal(calls.filter((n) => n === 'watch_set').length, 2);
  assert.equal(calls.filter((n) => n === 'nearby').length, 3);
  assert.equal(calls.filter((n) => n === 'patch').length, 1);
  assert.equal((await k.ws.readJSON(k.trip, '/plan/mcway.json')).start.at, '2026-11-27T14:00:00-08:00'); // the replan: a patch, so it can be undone (§11.5)
  // Voice Auto came on with the driving and went off at the stops (spec §10.5).
  const voice = (await k.events(['state'])).filter((e) => e.data.voice).map((e) => `${e.data.voice} ${e.data.why}`);
  assert.ok(voice.includes('on moving'), voice.join(', '));
  assert.ok(voice.includes('off not sure'), voice.join(', '));
  // Nothing went wrong on the way: the only cards were the reminders.
  assert.deepEqual([...new Set(k.notices.map((/** @type {any} */ n) => n.title))], ['Reminder']);
  // The road is in the log, for replay (spec §4.5, §13).
  assert.ok((await k.events(['location'])).length > 1000);
});
