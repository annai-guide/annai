import { h } from './dom.js';
import { relTime, outcomeText } from './format.js';

/**
 * The Test button (spec §9.8) and "Test reasoning levels" (§9.3) for one model, with what the
 * last test found.
 * @param {any} ctx @param {string} modelId @param {Record<string, any> | undefined} verified @param {string} [title]
 */
export function testPanel(ctx, modelId, verified, title = 'Test') {
  const out = h('ul', { class: 'checks-result' });
  const last = verified?.at
    ? `Last tested ${relTime(verified.at)}: ${['key', 'tools', 'images'].filter((k) => k in verified).map((k) => `${k} ${verified[k] ? '✓' : '✗'}`).join(', ')}.`
    : 'Not tested yet.';
  const status = h('p', { class: 'sub', role: 'status', text: last });
  /** @param {{ ok: boolean, text: string }[]} lines */
  const show = (lines) => out.replaceChildren(...lines.map((l) => h('li', { class: l.ok ? 'ok' : 'bad', text: `${l.ok ? '✓' : '✗'} ${l.text}` })));
  const run = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      run.disabled = true;
      status.textContent = 'Testing: a tiny request, then one with a tool and a small picture…';
      try {
        const r = await ctx.llm.test(modelId);
        status.textContent = r.ok ? 'Everything works.' : 'Something needs attention:';
        show(r.steps.map((/** @type {any} */ s) => ({ ok: s.ok, text: s.detail })));
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
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
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
      } finally {
        levels.disabled = false;
      }
    },
  }, 'Test reasoning levels');
  return h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), h('div', { class: 'acts' }, run, levels), status, out);
}
