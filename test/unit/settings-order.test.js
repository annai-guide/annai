import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionOrder, waitingWords, backupLine } from '../../src/ui/screens/settings.js';

test('Settings: what a user reaches for most often first, Erase last; Updates before everything while something waits', () => {
  // Languages, the four settings of the screens and of what you speak, are their own section, after Shiori's (the user, 2026-10-28).
  const head = ['models', 'voice', 'notifications', 'backup', 'shiori', 'languages', 'photos', 'tools', 'plugins', 'storage'];
  const tail = ['about', 'diagnostics', 'developer', 'experimental', 'erase'];
  assert.deepEqual(sectionOrder({ waiting: false }), [...head, 'updates', ...tail]);
  assert.deepEqual(sectionOrder({ waiting: true }), ['updates', ...head, ...tail]);
});

test("Settings' Updates line says what waits", () => {
  assert.equal(waitingWords(false, []), null);
  assert.equal(waitingWords(true, []), 'A new version of annai is ready.');
  assert.equal(waitingWords(false, [{ id: 'Remote trace', name: 'Remote trace' }, { id: 'tide-pools', name: 'tide-pools' }]), 'Plugin updates are ready: Remote trace, tide-pools.');
  assert.equal(waitingWords(true, [{ id: 'Remote trace', name: 'Remote trace' }]), 'A new version of annai is ready. Plugin updates are ready: Remote trace.');
});

test("Settings' Backups line names each kind of place backed up to automatically once", () => {
  const place = (/** @type {string} */ name, auto = 'changes') => ({ name, auto });
  assert.equal(backupLine([place('WebDAV'), place('WebDAV'), place('GitHub'), place('S3-compatible storage', 'off')]), 'Backing up automatically to WebDAV, GitHub.');
  assert.match(backupLine([place('WebDAV', 'off')]), /^No automatic backups yet/);
});
