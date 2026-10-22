import { h, settled } from './dom.js';
import { relTime, outcomeText } from './format.js';
import { withoutSecrets } from '../core/agent/net.js';

/**
 * The Test button (spec §9.8) and "Test reasoning levels" (§9.3) for one model, with what the
 * last test found. A live voice model's (K4) opens a session that answers aloud, its voice played as it comes.
 * @param {any} ctx @param {string} modelId @param {Record<string, any> | undefined} verified @param {string} [title] @param {boolean} [live]
 */
export function testPanel(ctx, modelId, verified, title = 'Test', live = false) {
  const out = h('ul', { class: 'checks-result' });
  const last = verified?.at
    ? `Last tested ${relTime(verified.at)}: ${['key', 'tools', 'images', 'upload', 'live'].filter((k) => k in verified).map((k) => `${k} ${verified[k] ? '✓' : '✗'}`).join(', ')}.`
    : 'Not tested yet.';
  const status = h('p', { class: 'sub', role: 'status', text: last });
  /** @param {{ ok: boolean, text: string }[]} lines */
  const show = (lines) => out.replaceChildren(...lines.map((l) => h('li', { class: l.ok ? 'ok' : 'bad', text: `${l.ok ? '✓' : '✗'} ${l.text}` })));
  const run = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      run.disabled = true;
      await settled();
      status.textContent = live ? 'Opening a live session…' : 'Testing: a tiny request, then one with a tool and a small picture…';
      const platform = live ? ctx.voice?.platform : null;
      /** @type {import('../core/voice/platform.js').PlayerStream | undefined} */
      let voice;
      try {
        platform?.session('playback');
        const r = await ctx.llm.test(modelId, {
          onAudio: (/** @type {Uint8Array} */ d, /** @type {{ rate: number }} */ f) => (voice ??= platform?.player.stream?.({ rate: f.rate }))?.push(new Int16Array(d.slice().buffer)),
        });
        voice?.end();
        status.textContent = !r.ok ? 'Something needs attention:' : r.steps.every((/** @type {any} */ s) => s.ok) ? 'Everything works.' : 'It works, with one note:';
        show(r.steps.map((/** @type {any} */ s) => ({ ok: s.ok, text: s.detail })));
        await voice?.done;
      } catch (e) {
        voice?.stop();
        status.textContent = await withoutSecrets(ctx.store, String(/** @type {any} */ (e)?.message ?? e));
      } finally {
        run.disabled = false;
      }
    },
  }, 'Test');
  const levels = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      levels.disabled = true;
      status.textContent = 'Trying each reasoning level…';
      try {
        const r = Object.entries(await ctx.llm.testLevels(modelId));
        status.textContent = r.length ? 'Reasoning levels:' : 'This model has no reasoning levels to try.';
        show(r.map(([level, outcome]) => ({ ok: outcome === 'ok', text: `${level}: ${outcome === 'ok' ? 'works' : outcomeText(outcome)}` })));
      } catch (e) {
        status.textContent = await withoutSecrets(ctx.store, String(/** @type {any} */ (e)?.message ?? e));
      } finally {
        levels.disabled = false;
      }
    },
  }, 'Test reasoning levels');
  return h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), h('div', { class: 'acts' }, run, live ? null : levels), status, out);
}
