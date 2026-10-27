import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';
import { liveKit, iso, LA } from './live-kit.js';

// What reaches a model stays annai's English under Japanese screens (the L5f review's probes, made tests): the next plan reminder
// in Koe's view, an opened notification in Shiori's catch-up, and why the microphone stopped while she listened.

setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));

const TEA = { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } };
const KANA = /[぀-ヿ一-鿿]/;

test("a plan reminder live mode lists: English for Koe's view (text), the screens' words for the push (shown)", async () => {
  const k = await liveKit({ plan: { tea: TEA } });
  const r = (await k.live.reminders())?.find((x) => x.watch === 'plan:tea:coming-up');
  assert.equal(r?.text, 'In 15 min: Tea at the inn at 16:00.');
  assert.equal(r?.shown, 'あと15分：Tea at the inn（16:00）。');
  k.live.dispose();
});
