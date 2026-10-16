import { h, field, checkbox, twoStep, jsonField } from '../dom.js';
import { modelOf, modelBase, endpointOf, saveModel, removeModel, diffLayer } from '../../core/llm/config.js';
import { messageOf } from './endpoint.js';
import { testPanel } from '../model-check.js';

/** A positive whole number from an input, or null when it's empty. @param {string} v */
function num(v) {
  const n = Math.round(Number(v));
  return v.trim() && Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * One model: what it can do and what it costs (spec §9.2).
 * @param {any} ctx @param {string} id
 */
export async function renderModel(ctx, id) {
  await ctx.llm.ready;
  const cfg = await ctx.llm.config();
  const rec = cfg.models[id];
  if (!rec) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'This model no longer exists' }), h('p', {}, h('a', { href: '#/models' }, 'Back to Models')));
  const m = modelOf(rec);
  const base = modelBase(rec);
  const epRec = cfg.endpoints[rec.endpoint];
  const ep = endpointOf(epRec, ctx.llm.types().get(epRec.type)?.tunables);
  const back = `#/models/endpoint?id=${encodeURIComponent(rec.endpoint)}`;
  const status = h('p', { class: 'sub', role: 'status' });
  const name = h('input', { id: 'model-name', autocomplete: 'off', value: m.name });
  const providerId = h('input', { id: 'model-provider-id', autocomplete: 'off', autocapitalize: 'off', value: m.providerId });
  const images = checkbox('Takes photos', m.input.includes('image'));
  const tools = checkbox('Calls tools', m.tools !== false);
  const window = h('input', { id: 'model-window', inputmode: 'numeric', value: m.contextWindow ?? '' });
  const max = h('input', { id: 'model-max', inputmode: 'numeric', value: m.maxOutput ?? '' });
  const prices = jsonField('Prices, USD per million tokens (JSON)', 'model-prices', m.prices ?? {});
  const ttls = h('input', { id: 'model-ttls', autocomplete: 'off', value: m.cacheTtls.join(', '), placeholder: '5m, 1h' });
  const reasoning = jsonField('Reasoning levels (JSON)', 'model-reasoning', m.reasoning);
  const tunables = jsonField('Tunables (JSON)', 'model-tunables', m.tunables);
  const extra = jsonField('Extra request fields (JSON)', 'model-extra', m.extraBody);
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      try {
        const p = prices.read();
        const pid = providerId.value.trim();
        const edited = {
          name: name.value.trim() === pid ? base.name : name.value.trim(),
          providerId: pid,
          input: [...new Set([...m.input.filter((x) => x !== 'image'), ...(images.input.checked ? ['image'] : [])])],
          tools: tools.input.checked,
          contextWindow: num(window.value),
          maxOutput: num(max.value),
          prices: Object.keys(p).length ? p : null,
          cacheTtls: ttls.value.split(/[\s,]+/).filter((x) => x === '5m' || x === '1h'),
          reasoning: reasoning.read(),
          tunables: tunables.read(),
          extraBody: extra.read(),
        };
        await saveModel(ctx.ws, { ...rec, user: diffLayer(edited, base) });
        ctx.llm.bench.clear(rec.id);
        ctx.notices.toast('Saved');
        ctx.render();
      } catch (err) {
        status.textContent = messageOf(err);
      }
    },
  }, 'Save');
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: back }, `← ${ep.name}`)),
    h('h1', { class: 'title', text: m.name }),
    h('section', { class: 'panel', 'aria-label': 'Model' },
      field('Name', name), field('Provider model id', providerId),
      h('div', { class: 'checks' }, images.el, tools.el),
      h('div', { class: 'row' }, field('Context window (tokens)', window), field('Maximum output (tokens)', max)),
      prices.el, field('Cache lifetimes (5m, 1h)', ttls), reasoning.el, tunables.el, extra.el,
      h('div', { class: 'acts' }, save), status),
    testPanel(ctx, id, rec.verified),
    h('div', { class: 'acts' }, twoStep('Remove model', 'Tap again to remove it', async () => {
      await removeModel(ctx.ws, id);
      ctx.go(back);
    })));
}
