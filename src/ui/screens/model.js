import { h, savedField, savedCheck, autosave, twoStep, jsonField, numberIn } from '../dom.js';
import { modelOf, modelBase, providerOf, endpointOf, saveModel, removeModel, diffLayer } from '../../core/llm/config.js';
import { testPanel } from '../model-check.js';
import { speechTestPanel } from '../speech-check.js';
import { tryPanel } from '../talk-panel.js';

/**
 * Saves one field into the user's layer of the model as it is now (spec §9.2; a function works the
 * value out from it), and ends its rest: what failed may be fixed. Gives the model.
 * @param {any} ctx @param {string} id
 */
const fieldSaver = (ctx, id) => async (/** @type {string} */ key, /** @type {any} */ value) => {
  const rec = (await ctx.llm.config()).models[id];
  if (!rec) throw new Error('This model no longer exists.');
  const { [key]: _, ...rest } = rec.user ?? {};
  const v = typeof value === 'function' ? value(modelOf(rec)) : value;
  const next = { ...rec, user: { ...rest, ...diffLayer({ [key]: v }, modelBase(rec)) } };
  await saveModel(ctx.ws, next);
  ctx.llm.bench.clear(id);
  return modelOf(next);
};

/**
 * A JSON field that saves once it parses, then shows what is in effect.
 * @param {(key: string, value: any) => Promise<import('../../core/llm/config.js').Model>} save @param {string} label @param {string} id
 * @param {string} key @param {any} value @param {(v: any) => any} [into] what is saved, from what was typed
 */
function modelJson(save, label, id, key, value, into = (v) => v) {
  const f = jsonField(label, id, value);
  return h('div', { class: 'saving' }, f.el, ...autosave(f.area, f.read, async (v) => f.show(/** @type {any} */ (await save(key, into(v)))[key])));
}

/**
 * Its name and provider id; the title follows them. A name equal to the provider id is no name of its own.
 * @param {(key: string, value: any) => Promise<import('../../core/llm/config.js').Model>} save
 * @param {import('../../core/llm/config.js').Model} m @param {string} baseName @param {HTMLElement} title
 */
function nameFields(save, m, baseName, title) {
  const name = h('input', { id: 'model-name', autocomplete: 'off', value: m.name });
  const pid = h('input', { id: 'model-provider-id', autocomplete: 'off', autocapitalize: 'off', value: m.providerId });
  const retitle = async (/** @type {string} */ key, /** @type {string} */ v) => { title.textContent = (await save(key, v)).name; };
  return [
    savedField('Name', name, () => (name.value.trim() === pid.value.trim() ? baseName : name.value.trim()), (v) => retitle('name', v)),
    savedField('Provider model id', pid, () => {
      if (!pid.value.trim()) throw new Error("Give the provider's model id.");
      return pid.value.trim();
    }, (v) => retitle('providerId', v)),
  ];
}

/**
 * One model: what it can do and what it costs (spec §9.2), each setting saved as it changes, and
 * for a chat model, "Try this model".
 * @param {any} ctx @param {string} id
 */
export async function renderModel(ctx, id) {
  await ctx.llm.ready;
  const cfg = await ctx.llm.config();
  const rec = cfg.models[id];
  if (!rec) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'This model no longer exists' }), h('p', {}, h('a', { href: '#/models' }, 'Back to Models')));
  const m = modelOf(rec);
  const base = modelBase(rec);
  const pRec = cfg.providers[rec.provider];
  const ability = providerOf(pRec).abilities[rec.ability];
  const ep = endpointOf(pRec, rec.ability, ctx.llm.types().get(ability.type)?.tunables);
  const back = `#/models/provider?id=${encodeURIComponent(rec.provider)}`;
  // Its provider and ability, as the provider's page names them.
  const of = h('p', { class: 'sub', text: `${ep.name} · ${ability.name}${ability.on ? '' : ' (switched off)'}` });
  const speech = ability.kind === 'transcription' ? 'in' : ability.kind === 'voice' ? 'out' : ability.kind === 'realtime' ? 'live' : null;
  if (speech) return renderSpeechModel(ctx, rec, speech, ep, back, of);
  const save = fieldSaver(ctx, id);
  const title = h('h1', { class: 'title', text: m.name });
  /** A switch for one kind of input. @param {string} label @param {string} kind */
  const takes = (label, kind) => savedCheck(label, m.input.includes(kind), (on) => save('input', (/** @type {any} */ now) => [...new Set([...now.input.filter((/** @type {string} */ x) => x !== kind), ...(on ? [kind] : [])])]));
  const images = takes('Takes photos', 'image');
  const pdfs = takes('Takes PDFs', 'pdf');
  const tools = savedCheck('Calls tools', m.tools !== false, (on) => save('tools', on));
  const window = h('input', { id: 'model-window', inputmode: 'numeric', value: m.contextWindow ?? '' });
  const max = h('input', { id: 'model-max', inputmode: 'numeric', value: m.maxOutput ?? '' });
  const ttls = h('input', { id: 'model-ttls', autocomplete: 'off', value: m.cacheTtls.join(', '), placeholder: '5m, 1h' });
  const readTtls = () => {
    const list = ttls.value.split(/[\s,]+/).filter(Boolean);
    if (list.some((x) => x !== '5m' && x !== '1h')) throw new Error('Cache lifetimes are 5m, 1h, or both.');
    return [...new Set(list)];
  };
  const tokens = (/** @type {HTMLInputElement} */ i, /** @type {string} */ what) => numberIn(i, 1, 1e9, `${what} is a whole number of tokens; leave it empty when you don't know it.`, { whole: true });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: back }, `← ${ep.name}`)),
    title,
    of,
    h('section', { class: 'panel', 'aria-label': 'Model' },
      h('p', { class: 'sub', text: 'Each setting is saved as you change it.' }),
      ...nameFields(save, m, base.name, title),
      h('div', { class: 'checks' }, images.el, pdfs.el, tools.el),
      h('div', { class: 'row' },
        savedField('Context window (tokens)', window, () => tokens(window, 'The context window'), (v) => save('contextWindow', v)),
        savedField('Maximum output (tokens)', max, () => tokens(max, 'The maximum output'), (v) => save('maxOutput', v))),
      modelJson(save, 'Prices, USD per million tokens (JSON)', 'model-prices', 'prices', m.prices ?? {}, (p) => (Object.keys(p).length ? p : null)),
      savedField('Cache lifetimes (5m, 1h)', ttls, readTtls, (v) => save('cacheTtls', v)),
      h('p', { class: 'sub', text: 'Empty: it is asked for five minutes.' }),
      // What it takes in photos (spec §9.2): formats, maxEdge (pixels), maxBytes, maxCount. A refusal can teach these.
      modelJson(save, 'Photo limits (JSON)', 'model-images', 'images', m.images ?? {}),
      modelJson(save, 'Reasoning levels (JSON)', 'model-reasoning', 'reasoning', m.reasoning),
      modelJson(save, 'Tunables (JSON)', 'model-tunables', 'tunables', m.tunables),
      modelJson(save, 'Extra request fields (JSON)', 'model-extra', 'extraBody', m.extraBody)),
    testPanel(ctx, id, rec.verified),
    tryPanel(ctx, m),
    h('div', { class: 'acts' }, twoStep('Remove model', 'Tap again to remove it', async () => {
      await removeModel(ctx.ws, id);
      ctx.go(back);
    })));
}

/**
 * A transcription model, a voice, or a live voice model (K4) (spec §9.2, §10): its name, id, voice, style, prices and Test,
 * each saved as it changes. They have Test, not "Try this model". A voice's voice and style go with every request (§10.1);
 * Voice suggests the voices its provider lists (the model's `voices` tunable, else its protocol's).
 * @param {any} ctx @param {import('../../core/llm/config.js').ModelRecord} rec @param {'in' | 'out' | 'live'} kind
 * @param {import('../../core/llm/config.js').Endpoint} ep @param {string} back @param {HTMLElement} of its provider and ability
 */
function renderSpeechModel(ctx, rec, kind, ep, back, of) {
  const m = modelOf(rec);
  const base = modelBase(rec);
  const save = fieldSaver(ctx, rec.id);
  const title = h('h1', { class: 'title', text: m.name });
  const { voice: voiceId, style: styleNote, voices: own, ...otherTunables } = m.tunables;
  const names = [].concat(own ?? ctx.llm.types().get(ep.type)?.voices ?? []);
  const voice = kind !== 'in' ? h('input', { id: 'model-voice', autocomplete: 'off', autocapitalize: 'off', list: 'model-voices', value: String(voiceId ?? ''), placeholder: 'voice' in m.tunables ? '' : String(ep.tunables.voice ?? '') }) : null;
  const style = kind === 'out' ? h('input', { id: 'model-style', autocomplete: 'off', value: String(styleNote ?? ''), placeholder: 'style' in m.tunables ? '' : String(ep.tunables.style ?? '') }) : null;
  /** The tunables with the voice and style typed in, which have fields of their own, and the voices kept. One emptied after it was set is '' (none sent), or the default would take its place. @param {Record<string, any>} t @param {Record<string, any>} now */
  const withFields = (t, now) => {
    const { voice: _v, style: _s, voices: _l, ...rest } = t;
    const put = (/** @type {string} */ k, /** @type {HTMLInputElement | null} */ el) => (!el ? {} : el.value.trim() ? { [k]: el.value.trim() } : k in now ? { [k]: '' } : {});
    return { ...rest, ...(now.voices ? { voices: now.voices } : {}), ...put('voice', voice), ...put('style', style) };
  };
  const tunables = jsonField('Tunables (JSON)', 'model-tunables', otherTunables);
  const showTunables = (/** @type {import('../../core/llm/config.js').Model} */ now) => {
    const { voice: _v, style: _s, voices: _l, ...rest } = now.tunables;
    tunables.show(rest);
  };
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: back }, `← ${ep.name}`)),
    title,
    of,
    h('p', { class: 'sub', text: { in: 'A transcription model: it turns what you say into text.', out: 'A voice: Shiori speaks with it.', live: 'A live voice: it hears and speaks in one stream, as Koe.' }[kind] }),
    h('section', { class: 'panel', 'aria-label': 'Model' },
      h('p', { class: 'sub', text: 'Each setting is saved as you change it.' }),
      ...nameFields(save, m, base.name, title),
      voice ? savedField('Voice', voice, () => voice.value.trim(), () => save('tunables', (/** @type {any} */ now) => withFields(now.tunables, now.tunables))) : null,
      h('datalist', { id: 'model-voices' }, names.map((v) => h('option', { value: v }))),
      voice ? h('p', { class: 'sub', text: 'Sent with every request, so every sentence has this voice. Empty, the provider chooses, and some choose another speaker each time.' }) : null,
      style ? savedField('Style', style, () => style.value.trim(), () => save('tunables', (/** @type {any} */ now) => withFields(now.tunables, now.tunables))) : null,
      style ? h('p', { class: 'sub', id: 'model-style-note', text: { ...ep.tunables, ...m.tunables }.styled === false ? "This voice can't take a style: it is kept, not sent." : 'How she should sound, in a few words, such as calm, warm and friendly. A voice with no use for it ignores it.' }) : null,
      modelJson(save, { in: 'Prices, USD (JSON: perMinute, minSeconds)', out: 'Prices, USD (JSON: perMillionChars)', live: 'Prices, USD per million tokens (JSON: input, cacheRead, audioIn, cacheReadAudio, image, cacheReadImage, output, audioOut)' }[kind], 'model-prices', 'prices', m.prices ?? {}, (p) => (Object.keys(p).length ? p : null)),
      h('div', { class: 'saving' }, tunables.el, ...autosave(tunables.area, tunables.read, async (t) => showTunables(await save('tunables', (/** @type {any} */ now) => withFields(t, now.tunables))))),
      modelJson(save, 'Extra request fields (JSON)', 'model-extra', 'extraBody', m.extraBody)),
    kind === 'live' ? testPanel(ctx, rec.id, rec.verified, 'Test', true) : speechTestPanel(ctx, m, kind, rec.verified),
    h('div', { class: 'acts' }, twoStep('Remove model', 'Tap again to remove it', async () => {
      await removeModel(ctx.ws, rec.id);
      ctx.go(back);
    })));
}
