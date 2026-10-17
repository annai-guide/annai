import { h } from './dom.js';
import { relTime } from './format.js';
import { ProviderError, explain } from '../core/llm/contract.js';
import { saveModel } from '../core/llm/config.js';
import { micProblem } from './mic-help.js';

/** What a voice says when it is tested. */
export const SAMPLE = 'Hello! This is how I sound when I talk to you.';

/** A speech call that failed, in plain words with what to do next. @param {unknown} e */
export function speechProblem(e) {
  if (e instanceof ProviderError) return explain(e);
  const p = micProblem(e);
  return /** @type {any} */ (e)?.name && /** @type {any} */ (e).name !== 'Error' ? `${p.title}. ${p.body}` : String(/** @type {any} */ (e)?.message ?? e);
}

/**
 * A speech model's Test (spec §9.8): a voice plays a sample; a transcription model hears you say
 * something and writes it down. Whether it worked is kept on the model.
 * @param {any} ctx @param {import('../core/llm/config.js').Model} model @param {'in' | 'out'} kind
 * @param {Record<string, any> | undefined} verified @param {string} [title]
 */
export function speechTestPanel(ctx, model, kind, verified, title = 'Test') {
  const status = h('p', { class: 'sub', role: 'status', text: verified?.at ? `Last tested ${relTime(verified.at)}: ${verified.speech ? 'it worked' : "it didn't work"}.` : 'Not tested yet.' });
  const meter = h('meter', { min: '0', max: '1', value: '0', 'aria-label': 'How loud the microphone hears you', hidden: kind === 'out' });
  const mark = async (/** @type {boolean} */ ok) => {
    const rec = (await ctx.llm.config()).models[model.id];
    if (rec) await saveModel(ctx.ws, { ...rec, verified: { ...(rec.verified ?? {}), speech: ok, at: Date.now() } });
  };
  const run = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      run.disabled = true;
      try {
        if (kind === 'out') {
          status.textContent = 'Playing a sample…';
          const r = await ctx.voice.sample(model.id, SAMPLE);
          status.textContent = r.ended ? 'It works: that was this voice.' : 'The sample stopped early.';
          await mark(true);
          return;
        }
        status.textContent = 'Say something, such as "Where should we stop for lunch?"';
        const off = ctx.voice.onLevel((/** @type {number} */ x, /** @type {string} */ who) => { if (who === 'you') meter.value = x; });
        try {
          const seg = await ctx.voice.listenOnce({ seconds: 12, onSpeech: () => { status.textContent = 'Hearing you…'; } });
          if (!seg) {
            status.textContent = 'Nothing was heard in 12 seconds. Check that the microphone is on, then try again.';
            return;
          }
          status.textContent = 'Writing it down…';
          const text = await ctx.voice.transcribe(seg, model.id);
          status.textContent = text ? `It heard: "${text}"` : 'It heard speech but wrote nothing down. Try again, a little closer to the phone.';
          await mark(Boolean(text));
        } finally {
          off();
          meter.value = 0;
        }
      } catch (e) {
        status.textContent = speechProblem(e);
        if (e instanceof ProviderError) await mark(false);
      } finally {
        run.disabled = false;
      }
    },
  }, kind === 'out' ? 'Play a sample' : 'Say something');
  return h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), h('div', { class: 'acts' }, run), meter, status);
}
