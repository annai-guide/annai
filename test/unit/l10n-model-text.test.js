import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setWords, key } from '../../src/core/l10n.js';

// Words a model or the log is told stay English whatever the screens' language (localization design, section 7): the reason plugins
// can't load reaches a role's attempts (fallback.js) and stored model.turn events. Words are set before the module loads, as boot.js does.
const ENGLISH = "annai needs a reload: it opened without its offline service, so its plugins can't start.";
setWords('ja', { [key(ENGLISH)]: 'annai の再読み込みが必要です。' });
const { NEEDS_RELOAD, pluginsHeld } = await import('../../src/ui/plugin-cards.js');

test('with Japanese screens, the reload card speaks Japanese, and why plugins are held stays English for models and the log', () => {
  assert.equal(NEEDS_RELOAD, 'annai の再読み込みが必要です。');
  assert.equal(pluginsHeld(true, false), ENGLISH);
  assert.equal(pluginsHeld(true, true), undefined);
  assert.equal(pluginsHeld(false, false), undefined);
});
