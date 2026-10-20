import { h, field } from './dom.js';
import { AllFailedError } from '../core/llm/fallback.js';
import { ProviderError, explain } from '../core/llm/contract.js';
import { withoutSecrets } from '../core/agent/net.js';
import { formatCost, outcomeText } from './format.js';

const SYSTEM = 'You are a helpful travel assistant inside the annai app. This conversation only checks that the model works, so keep your replies short.';

/** The line under a reply: its tokens, audio and images too, and its cost. @param {any} result */
export function metaLine(result) {
  const u = result.usage;
  const n = ['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output', 'audioIn', 'audioOut', 'image', 'cacheReadAudio', 'cacheReadImage'].reduce((sum, k) => sum + (u[k] ?? 0), 0);
  return `${n} tokens · ${formatCost(result.cost)}`;
}

/** Why the model didn't answer, in plain words, with any key blanked (spec §9.9). @param {any} ctx @param {unknown} err @param {string} name */
function failure(ctx, err, name) {
  const a = err instanceof AllFailedError ? err.attempts[0] : null;
  const why = a ? `${outcomeText(a.outcome)}${a.error ? ` (${a.error})` : ''}` : err instanceof ProviderError ? explain(err) : String(/** @type {any} */ (err)?.message ?? err);
  return withoutSecrets(ctx.store, `${name} didn't answer: ${why}. No other model was asked.`);
}

/**
 * "Try this model" on a chat model's page (the user, 2026-10-18): a plain text conversation with
 * that model alone, with no fallback, each reply with its tokens and cost. Nothing is kept but the
 * trace. Replies only ever go into textContent (spec §15).
 * @param {any} ctx @param {import('../core/llm/config.js').Model} model
 */
export function tryPanel(ctx, model) {
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
        // Room for a model that thinks before it answers, as the Test button gives it.
        const result = await ctx.llm.callModel({
          modelId: model.id, request: { system: SYSTEM, messages, maxOutput: Math.min(4096, model.maxOutput ?? 4096) }, signal: running.signal,
          onEvent: (/** @type {any} */ ev) => { if (ev.type === 'text') reply.textContent += ev.text; },
        });
        reply.textContent = result.reply.text;
        messages.push({ role: 'assistant', parts: result.reply.parts });
        meta.textContent = metaLine(result);
      } catch (err) {
        messages.pop();
        meta.textContent = await failure(ctx, err, model.name);
      } finally {
        running = null;
        send.disabled = false;
        stop.hidden = true;
      }
    },
  }, field('Message', input), h('div', { class: 'acts' }, send, stop));
  return h('section', { class: 'panel', 'aria-label': 'Try this model' },
    h('h2', { class: 'section', text: 'Try this model' }),
    h('p', { class: 'sub', text: 'A short conversation with this model alone: if it fails, no other model answers. Each reply shows its tokens and cost. Nothing is kept but the Trace.' }),
    log,
    form);
}
