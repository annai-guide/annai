import { h, field } from './dom.js';
import { AllFailedError } from '../core/llm/fallback.js';
import { ProviderError, explain } from '../core/llm/contract.js';
import { formatCost, outcomeText } from './format.js';

const SYSTEM = 'You are a helpful travel assistant inside the annai app. This conversation only checks that the models work, so keep your replies short.';

/** The line under a reply: who answered, the tokens, the cost, and which models failed first. @param {any} result */
function metaLine(result) {
  const u = result.usage;
  const tokens = u.input + u.cacheRead + u.cacheWrite + u.cacheWrite1h + u.output;
  const failed = result.attempts.filter((/** @type {any} */ a) => a.outcome !== 'ok');
  let line = `${result.answeredBy} · ${tokens} tokens · ${formatCost(result.cost)}`;
  if (failed.length) line += `, after ${failed.length} failed attempt${failed.length === 1 ? '' : 's'} (${failed.map((/** @type {any} */ a) => `${a.name}: ${outcomeText(a.outcome)}`).join('; ')})`;
  return line;
}

/** @param {unknown} err */
function failure(err) {
  if (err instanceof AllFailedError) {
    if (!err.attempts.length) return 'No model is set for the main role. Add one under Roles.';
    return `No model answered: ${err.attempts.map((a) => `${a.name}: ${outcomeText(a.outcome)}`).join('; ')}.`;
  }
  if (err instanceof ProviderError) return explain(err);
  return String(/** @type {any} */ (err)?.message ?? err);
}

/**
 * "Talk to your models": a plain text conversation through the main role, with fallback, to try
 * the models. Nothing is kept but the trace; Shiori's real conversation comes in milestone 2's
 * second part. Replies only ever go into textContent (spec §15).
 * @param {any} ctx
 */
export function talkPanel(ctx) {
  /** @type {import('../core/llm/contract.js').Message[]} */
  const messages = [];
  const log = h('ol', { class: 'talk', 'aria-live': 'polite' });
  const input = h('textarea', { id: 'talk-input', rows: 2 });
  /** @type {AbortController | null} */
  let running = null;
  const send = h('button', { class: 'btn pri', type: 'submit' }, 'Send');
  const stop = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => running?.abort() }, 'Stop');
  const form = h('form', {
    class: 'talk-form',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || running) return;
      input.value = '';
      messages.push({ role: 'user', parts: [{ type: 'text', text }] });
      log.append(h('li', { class: 'talk-you', text }));
      const reply = h('div', { class: 'talk-text' });
      const meta = h('div', { class: 'sub' });
      log.append(h('li', { class: 'talk-model' }, reply, meta));
      running = new AbortController();
      send.disabled = true;
      stop.hidden = false;
      try {
        const result = await ctx.llm.call({
          role: 'main', request: { system: SYSTEM, messages, maxOutput: 1024 }, signal: running.signal,
          onEvent: (/** @type {any} */ ev) => { if (ev.type === 'text') reply.textContent += ev.text; },
        });
        reply.textContent = result.reply.text;
        messages.push({ role: 'assistant', parts: result.reply.parts });
        meta.textContent = metaLine(result);
      } catch (err) {
        messages.pop();
        meta.textContent = failure(err);
        if (err instanceof AllFailedError) ctx.notices.card({ tone: 'warn', title: "Shiori can't reach her model", body: failure(err) });
      } finally {
        running = null;
        send.disabled = false;
        stop.hidden = true;
      }
    },
  }, field('Message', input), h('div', { class: 'acts' }, send, stop));
  return h('section', { class: 'panel', 'aria-label': 'Talk to your models' },
    h('h2', { class: 'section', text: 'Talk to your models' }),
    h('p', { class: 'sub', text: 'A plain conversation through the main role, to try your models. Each request shows in Trace.' }),
    log,
    form);
}
