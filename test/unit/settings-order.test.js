import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionOrder, waitingWords } from '../../src/ui/screens/settings.js';

test('Settings: what a user reaches for most often first, Erase last; Updates before everything while something waits', () => {
  const head = ['models', 'voice', 'notifications', 'backup', 'shiori', 'photos', 'tools', 'plugins', 'storage'];
  const tail = ['about', 'diagnostics', 'developer', 'experimental', 'erase'];
  assert.deepEqual(sectionOrder({ waiting: false }), [...head, 'updates', ...tail]);
  assert.deepEqual(sectionOrder({ waiting: true }), ['updates', ...head, ...tail]);
});

test("Settings' Updates line says what waits", () => {
  assert.equal(waitingWords(false, []), null);
  assert.equal(waitingWords(true, []), 'A new version of annai is ready.');
  assert.equal(waitingWords(false, [{ name: 'Remote trace' }, { name: 'tide-pools' }]), 'Plugin updates are ready: Remote trace, tide-pools.');
  assert.equal(waitingWords(true, [{ name: 'Remote trace' }]), 'A new version of annai is ready. Plugin updates are ready: Remote trace.');
});
