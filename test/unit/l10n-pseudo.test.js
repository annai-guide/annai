import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accented, mirrored, pseudoFor } from '../../src/core/l10n-pseudo.js';
import { setWords, t, plural, dir } from '../../src/core/l10n.js';

test('en-XA accents the letters, pads by 40% and brackets, and keeps the values', () => {
  assert.equal(accented('Open'), '⟦Óṕéñ ··⟧');
  assert.equal(accented('Last backup {0}, to {1}.'), `⟦Ļáśţ ƀáçķúṕ {0}, ţó {1}. ${'·'.repeat(Math.ceil(0.4 * 18))}⟧`);
  assert.equal(accented('# stamps'), '⟦# śţáɱṕś ···⟧');
});

test('ar-XB reverses the letters of every word and keeps the values', () => {
  assert.equal(mirrored('Open the {0} door.'), 'nepO eht {0} rood.');
  assert.equal(pseudoFor('ar-XB'), mirrored);
  assert.equal(pseudoFor('en-XA'), accented);
});

test('as words, the pseudo-locale shows every message in pseudo text', () => {
  setWords('en-XA', null, pseudoFor('en-XA'));
  assert.equal(t`Open ${'x'}`, '⟦Óṕéñ x ··⟧');
  assert.ok(plural(2, '# stamp', '# stamps').startsWith('⟦2 śţáɱṕś'));
  setWords('ar-XB', null, pseudoFor('ar-XB'));
  assert.equal(dir(), 'rtl');
  setWords('en', null);
});
