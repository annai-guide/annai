import { h, settled, t } from './dom.js';
import { relTime, outcomeText, list } from './format.js';
import { withoutSecrets } from '../core/agent/net.js';

/** What a test checks, by its result's key, in the screens' words. @type {Record<string, string>} */
const CHECKS = { key: t`key`, tools: t`tools`, images: t`images`, upload: t`upload`, live: t`live` };
/** The reasoning levels, as Settings → Models names them (model.js's LEVEL_WORDS). @type {Record<string, string>} */
const LEVELS = { off: t`off`, low: t`low`, medium: t`medium`, high: t`high`, max: t`max` };

/**
 * The Test button (spec §9.8) and "Test reasoning levels" (§9.3) for one model, with what the
 * last test found. A live voice model's (K4) opens a session that answers aloud, its voice played as it comes.
 * @param {any} ctx @param {string} modelId @param {Record<string, any> | undefined} verified @param {string} [title] @param {boolean} [live]
 */
export function testPanel(ctx, modelId, verified, title = t`Test`, live = false) {
  const out = h('ul', { class: 'checks-result' });
  const last = verified?.at
    ? t`Last tested ${relTime(verified.at)}: ${list(Object.keys(CHECKS).filter((k) => k in verified).map((k) => `${CHECKS[k]} ${verified[k] ? '✓' : '✗'}`), 'plain')}.`
    : t`Not tested yet.`;
  const status = h('p', { class: 'sub', role: 'status', text: last });
  /** @param {{ ok: boolean, text: string }[]} lines */
  const show = (lines) => out.replaceChildren(...lines.map((l) => h('li', { class: l.ok ? 'ok' : 'bad', text: `${l.ok ? '✓' : '✗'} ${l.text}` })));
  const run = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      run.disabled = true;
      await settled();
      status.textContent = live ? t`Opening a live session…` : t`Testing: a tiny request, then one with a tool and a small picture…`;
      const platform = live ? ctx.voice?.platform : null;
      /** @type {import('../core/voice/platform.js').PlayerStream | undefined} */
      let voice;
      try {
        platform?.session('playback');
        const r = await ctx.llm.test(modelId, {
          onAudio: (/** @type {Uint8Array} */ d, /** @type {{ rate: number }} */ f) => (voice ??= platform?.player.stream?.({ rate: f.rate }))?.push(new Int16Array(d.slice().buffer)),
        });
        voice?.end();
        status.textContent = !r.ok ? t`Something needs attention:` : r.steps.every((/** @type {any} */ s) => s.ok) ? t`Everything works.` : t`It works, with one note:`;
        show(r.steps.map((/** @type {any} */ s) => ({ ok: s.ok, text: s.detail })));
        await voice?.done;
      } catch (e) {
        voice?.stop();
        status.textContent = await withoutSecrets(ctx.store, String(/** @type {any} */ (e)?.message ?? e));
      } finally {
        run.disabled = false;
      }
    },
  }, t`Test`);
  const levels = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      levels.disabled = true;
      status.textContent = t`Trying each reasoning level…`;
      try {
        const r = Object.entries(await ctx.llm.testLevels(modelId));
        status.textContent = r.length ? t`Reasoning levels:` : t`This model has no reasoning levels to try.`;
        show(r.map(([level, outcome]) => ({ ok: outcome === 'ok', text: outcome === 'ok' ? t`${LEVELS[level] ?? level}: works` : t`${LEVELS[level] ?? level}: ${outcomeText(outcome)}` })));
      } catch (e) {
        status.textContent = await withoutSecrets(ctx.store, String(/** @type {any} */ (e)?.message ?? e));
      } finally {
        levels.disabled = false;
      }
    },
  }, t`Test reasoning levels`);
  return h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), h('div', { class: 'acts' }, run, live ? null : levels), status, out);
}
