import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionOrder } from '../../src/ui/screens/settings.js';

test('Settings: what a user reaches for most often first, Erase last; a waiting update before everything', () => {
  const usual = ['models', 'voice', 'notifications', 'backup', 'shiori', 'photos', 'tools', 'plugins', 'storage', 'about', 'diagnostics', 'developer', 'experimental', 'erase'];
  assert.deepEqual(sectionOrder({ updateReady: false }), usual);
  assert.deepEqual(sectionOrder({ updateReady: true }), ['update', ...usual]);
});
