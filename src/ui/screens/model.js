import { h, crumb, savedField, savedCheck, autosave, twoStep, jsonField, numberIn, t } from '../dom.js';
import { modelOf, modelBase, providerOf, endpointOf, updateModel, removeModel, diffLayer } from '../../core/llm/config.js';
import { testPanel } from '../model-check.js';
import { speechTestPanel } from '../speech-check.js';
import { tryPanel } from '../talk-panel.js';
import { pricesProblem } from '../../core/llm/cost.js';
import { numField } from '../format.js';
import { NotFoundError } from '../../core/workspace.js';

/** The reasoning levels (reasoning.js's LEVELS) in the screens' words. @type {Record<string, string>} */
export const LEVEL_WORDS = { off: t`off`, low: t`low`, medium: t`medium`, high: t`high`, max: t`max` };

/**
 * Saves one field into the user's layer of the model as it is now (spec §9.2; a function works the
 * value out from it), and ends its rest: what failed may be fixed. Gives the model.
 * @param {any} ctx @param {string} id
 */
export const fieldSaver = (ctx, id) => async (/** @type {string} */ key, /** @type {any} */ value) => {
  // Read and written in the model file's lock: a Test's result recorded meanwhile is not written back as it was.
  const next = await updateModel(ctx.ws, id, (rec) => {
    const { [key]: _, ...rest } = /** @type {Record<string, any>} */ (rec.user ?? {});
    let v = typeof value === 'function' ? value(modelOf(rec)) : value;
    // The Prices box shows the prices in effect, a description's schedule with the fields the user set left out of it. Sent back
    // unchanged, that schedule is the description's still, not a copy of it for the user (which would put the description's
    // value over a price the user typed later).
    const was = modelOf(rec).prices;
    if (key === 'prices' && v && !('schedule' in (rec.user?.prices ?? {})) && modelBase(rec).prices?.schedule && JSON.stringify(v.schedule) === JSON.stringify(was?.schedule)) {
      v = { ...v, schedule: modelBase(rec).prices?.schedule };
    } else if (key === 'prices' && v && Array.isArray(v.schedule)) {
      // A schedule of the user's own, and a price changed in this edit: the price wins from every date (typed, it is theirs), in each
      // entry that still has what it had; an entry the same edit changed that field in is the user's word for that date.
      const changed = Object.keys({ ...v, ...was }).filter((k) => k !== 'schedule' && JSON.stringify(v[k]) !== JSON.stringify(was?.[k]));
      if (changed.length) {
        const earlier = (/** @type {any} */ e) => (Array.isArray(was?.schedule) ? was.schedule.find((/** @type {any} */ x) => x?.from === e.from) : undefined);
        v = { ...v, schedule: v.schedule.map((/** @type {any} */ e) => (e && typeof e === 'object' ? Object.fromEntries(Object.entries(e).filter(([k, x]) => k === 'from' || !changed.includes(k) || JSON.stringify(x) !== JSON.stringify(earlier(e)?.[k]))) : e)).filter((/** @type {any} */ e) => !e || typeof e !== 'object' || Object.keys(e).length > 1) };
      }
    }
    const layer = diffLayer({ [key]: v }, modelBase(rec));
    // The description's schedule deleted is stored as an empty list: an older build reads that, and drops a model whose schedule is null.
    if (key === 'prices' && layer.prices?.schedule === null) layer.prices.schedule = [];
    return { ...rec, user: { ...rest, ...layer } };
  }).catch((/** @type {unknown} */ e) => {
    throw e instanceof NotFoundError ? new Error(t`This model no longer exists.`) : e;
  });
  ctx.llm.bench.clear(id);
  return modelOf(next);
};

/** The Prices box's value to save: none when it is empty, and refused when something in it isn't a price. @param {any} p */
export function pricesInto(p) {
  const wrong = pricesProblem(p);
  if (wrong) throw new Error(wrong);
  return Object.keys(p).length ? p : null;
}

/**
 * A JSON field that saves once it parses, then shows what is in effect.
 * @param {(key: string, value: any) => Promise<import('../../core/llm/config.js').Model>} save @param {string} label @param {string} id
 * @param {string} key @param {any} value @param {(v: any) => any} [into] what is saved, from what was typed
 */
function modelJson(save, label, id, key, value, into = (v) => v) {
  const f = jsonField(label, id, value);
  // `into` may refuse (a price that isn't one): that is said by the field, with the text left as typed.
  return h('div', { class: 'saving' }, f.el, ...autosave(f.area, () => into(f.read()), async (v) => f.show(/** @type {any} */ (await save(key, v))[key])));
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
    savedField(t`Name`, name, () => (name.value.trim() === pid.value.trim() ? baseName : name.value.trim()), (v) => retitle('name', v)),
    savedField(t`Provider model id`, pid, () => {
      if (!pid.value.trim()) throw new Error(t`Give the provider's model id.`);
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
  if (!rec) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`This model no longer exists` }), h('p', {}, h('a', { href: '#/models' }, t`Back to Models`)));
  const m = modelOf(rec);
  const base = modelBase(rec);
  const pRec = cfg.providers[rec.provider];
  const ability = providerOf(pRec).abilities[rec.ability];
  const ep = endpointOf(pRec, rec.ability, ctx.llm.types().get(ability.type)?.tunables);
  const back = `#/models/provider?id=${encodeURIComponent(rec.provider)}`;
  // Its provider and ability, as the provider's page names them.
  const of = h('p', { class: 'sub', text: ability.on ? `${ep.name} · ${ability.name}` : t`${ep.name} · ${ability.name} (switched off)` });
  const speech = ability.kind === 'transcription' ? 'in' : ability.kind === 'voice' ? 'out' : ability.kind === 'realtime' ? 'live' : null;
  if (speech) return renderSpeechModel(ctx, rec, speech, ep, back, of);
  const save = fieldSaver(ctx, id);
  const title = h('h1', { class: 'title', text: m.name });
  /** A switch for one kind of input. @param {string} label @param {string} kind */
  const takes = (label, kind) => savedCheck(label, m.input.includes(kind), (on) => save('input', (/** @type {any} */ now) => [...new Set([...now.input.filter((/** @type {string} */ x) => x !== kind), ...(on ? [kind] : [])])]));
  const images = takes(t`Takes photos`, 'image');
  const pdfs = takes(t`Takes PDFs`, 'pdf');
  const tools = savedCheck(t`Calls tools`, m.tools !== false, (on) => save('tools', on));
  const window = h('input', { id: 'model-window', inputmode: 'numeric', value: numField(m.contextWindow) });
  const max = h('input', { id: 'model-max', inputmode: 'numeric', value: numField(m.maxOutput) });
  const ttls = h('input', { id: 'model-ttls', autocomplete: 'off', value: m.cacheTtls.join(', '), placeholder: /* en */ '5m, 1h' });
  const readTtls = () => {
    const list = ttls.value.split(/[\s,]+/).filter(Boolean);
    if (list.some((x) => x !== '5m' && x !== '1h')) throw new Error(t`Cache lifetimes are 5m, 1h, or both.`);
    return [...new Set(list)];
  };
  const tokens = (/** @type {HTMLInputElement} */ i, /** @type {string} */ words) => numberIn(i, 1, 1e9, words, { whole: true });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb(back, ep.name)),
    title,
    of,
    h('section', { class: 'panel', 'aria-label': t`Model` },
      h('p', { class: 'sub', text: t`Each setting is saved as you change it.` }),
      ...nameFields(save, m, base.name, title),
      h('div', { class: 'checks' }, images.el, pdfs.el, tools.el),
      h('div', { class: 'row' },
        savedField(t`Context window (tokens)`, window, () => tokens(window, t`The context window is a whole number of tokens; leave it empty when you don't know it.`), (v) => save('contextWindow', v)),
        savedField(t`Maximum output (tokens)`, max, () => tokens(max, t`The maximum output is a whole number of tokens; leave it empty when you don't know it.`), (v) => save('maxOutput', v))),
      modelJson(save, t`Prices, USD per million tokens (JSON)`, 'model-prices', 'prices', m.prices ?? {}, pricesInto),
      savedField(t`Cache lifetimes (5m, 1h)`, ttls, readTtls, (v) => save('cacheTtls', v)),
      h('p', { class: 'sub', text: t`Empty: it is asked for five minutes.` }),
      // What it takes in photos (spec §9.2): formats, maxEdge (pixels), maxBytes, maxCount. A refusal can teach these.
      modelJson(save, t`Photo limits (JSON)`, 'model-images', 'images', m.images ?? {}),
      modelJson(save, t`Reasoning levels (JSON)`, 'model-reasoning', 'reasoning', m.reasoning),
      modelJson(save, t`Tunables (JSON)`, 'model-tunables', 'tunables', m.tunables),
      modelJson(save, t`Extra request fields (JSON)`, 'model-extra', 'extraBody', m.extraBody)),
    testPanel(ctx, id, rec.verified),
    tryPanel(ctx, m),
    h('div', { class: 'acts' }, twoStep(t`Remove model`, t`Tap again to remove it`, async () => {
      await removeModel(ctx.ws, id);
      ctx.go(back);
    })));
}

/**
 * A transcription model, a voice, or a live voice model (K4) (spec §9.2, §10): its name, id, voice, style, prices and Test,
 * each saved as it changes. They have Test, not "Try this model". A voice's voice and style go with every request (§10.1);
 * a field shows what is sent and, emptied, falls back to the model's default (its placeholder). Voice suggests `voices`.
 * @param {any} ctx @param {import('../../core/llm/config.js').ModelRecord} rec @param {'in' | 'out' | 'live'} kind
 * @param {import('../../core/llm/config.js').Endpoint} ep @param {string} back @param {HTMLElement} of its provider and ability
 */
function renderSpeechModel(ctx, rec, kind, ep, back, of) {
  const m = modelOf(rec);
  const base = modelBase(rec);
  const save = fieldSaver(ctx, rec.id);
  const title = h('h1', { class: 'title', text: m.name });
  const sent = { ...ep.tunables, ...m.tunables };
  const dflt = { ...ep.tunables, ...base.tunables };
  const voices = (/** @type {Record<string, any>} */ t) => [].concat(t.voices ?? ctx.llm.types().get(ep.type)?.voices ?? []);
  const list = h('datalist', { id: 'model-voices' }, voices(sent).map((v) => h('option', { value: v })));
  const voice = kind !== 'in' ? h('input', { id: 'model-voice', autocomplete: 'off', autocapitalize: 'off', list: 'model-voices', value: String(sent.voice ?? ''), placeholder: String(dflt.voice ?? '') }) : null;
  // instructions: the style's older name, a user's own: shown as the style, replaced by it when saved.
  const style = kind === 'out' ? h('input', { id: 'model-style', autocomplete: 'off', maxlength: 200, value: String(sent.instructions || sent.style || ''), placeholder: String(dflt.style ?? '') }) : null;
  const note = h('p', { class: 'sub', id: 'model-style-note' });
  const noteFor = (/** @type {Record<string, any>} */ now) => { note.textContent = { ...ep.tunables, ...now }.styled === false ? t`This voice can't take a style: it is kept, not sent.` : t`How she should sound, in a few words, such as calm, warm and friendly.`; };
  noteFor(m.tunables);
  const own = [voice && 'voice', style && 'style', style && 'instructions'];
  /** The tunables without what a field holds; a key with no field here stays. @param {Record<string, any>} t */
  const without = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !own.includes(k)));
  /** A field's value to save; the default is no override. @param {HTMLInputElement | null} el @param {string} k @param {string} was the default */
  const put = (el, k, was) => (!el ? {} : (el.value.trim() || (k === 'voice' ? was : '')) === was ? (base.tunables[k] === undefined ? {} : { [k]: base.tunables[k] }) : { [k]: el.value.trim() });
  /** The tunables with the voice and style typed in; the provider's older instructions, emptied, can't win. @param {Record<string, any>} t */
  const withFields = (t) => ({ ...without(t), ...put(voice, 'voice', String(dflt.voice ?? '')), ...put(style, 'style', String(dflt.style ?? '')), ...(style && ep.tunables.instructions ? { instructions: '' } : {}) });
  const tunables = jsonField(t`Tunables (JSON)`, 'model-tunables', without(m.tunables));
  const showTunables = (/** @type {import('../../core/llm/config.js').Model} */ now) => {
    tunables.show(without(now.tunables));
    list.replaceChildren(...voices({ ...ep.tunables, ...now.tunables }).map((v) => h('option', { value: v })));
    noteFor(now.tunables);
  };
  const saveFields = () => save('tunables', (/** @type {any} */ now) => withFields(now.tunables));
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb(back, ep.name)),
    title,
    of,
    h('p', { class: 'sub', text: { in: t`A transcription model: it turns what you say into text.`, out: t`A voice: Shiori speaks with it.`, live: t`A live voice: it hears and speaks in one stream, as Koe.` }[kind] }),
    h('section', { class: 'panel', 'aria-label': t`Model` },
      h('p', { class: 'sub', text: t`Each setting is saved as you change it.` }),
      ...nameFields(save, m, base.name, title),
      voice ? savedField(t`Voice`, voice, () => voice.value.trim(), saveFields) : null,
      list,
      voice ? h('p', { class: 'sub', text: t`Sent with every request. Emptied, the model's default (grey) is used; to send none, put "voice": null in Extra request fields.` }) : null,
      style ? savedField(t`Style`, style, () => style.value.trim(), saveFields) : null,
      style ? note : null,
      modelJson(save, { in: t`Prices, USD (JSON: perMinute, minSeconds)`, out: t`Prices, USD (JSON: perMillionChars)`, live: t`Prices, USD per million tokens (JSON: input, cacheRead, audioIn, cacheReadAudio, image, cacheReadImage, output, audioOut)` }[kind], 'model-prices', 'prices', m.prices ?? {}, pricesInto),
      h('div', { class: 'saving' }, tunables.el, ...autosave(tunables.area, tunables.read, async (t) => showTunables(await save('tunables', withFields(t))))),
      modelJson(save, t`Extra request fields (JSON)`, 'model-extra', 'extraBody', m.extraBody)),
    kind === 'live' ? testPanel(ctx, rec.id, rec.verified, t`Test`, true) : speechTestPanel(ctx, m, kind, rec.verified),
    h('div', { class: 'acts' }, twoStep(t`Remove model`, t`Tap again to remove it`, async () => {
      await removeModel(ctx.ws, rec.id);
      ctx.go(back);
    })));
}
