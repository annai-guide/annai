import { h, settled, t, asUser, messageOf } from './dom.js';
import { relTime, speaksScreens } from './format.js';
import { readAppSettings } from '../core/settings.js';
import { ProviderError, explain, providerReason } from '../core/llm/contract.js';
import { markVerified } from '../core/llm/config.js';
import { micProblem } from './mic-help.js';
import { shownWithoutSecrets, withoutSecrets } from '../core/agent/net.js';

/** What a voice says when it is tested, as the user's own words (asUser): a voice speaks a sentence in its own language. @param {boolean} speaks */
export const sample = (speaks) => asUser(speaks)`Hello! This is how I sound when I talk to you.`;

/**
 * A speech call that failed, in plain words with what to do next, with every key annai keeps blanked (spec §9.9). A 400 says the
 * provider's reason where its answer gave one ("Voice not found") and the keys can be read; a voice's 404 says what to check (a router
 * passes on Grok's and Voxtral's bare "Provider returned 404"); else the kind's words; none of these when the keys can't be read: the note that they
 * couldn't be checked. Kind and status decide, never the text; annai's own not-found (no status) keeps its words when the keys can be read. @param {import('../core/types.js').Store} store @param {unknown} e @param {boolean} [speaking] a voice, not a transcription model
 */
export async function speechProblem(store, e, speaking = false) {
  if (!(e instanceof ProviderError)) {
    const p = micProblem(e);
    return shownWithoutSecrets(store, /** @type {any} */ (e)?.name && /** @type {any} */ (e).name !== 'Error' ? t`${p.title}. ${p.body}` : messageOf(e));
  }
  // Blanked before it is cut (a key across the cut would show its first characters); no reason if the keys can't be read.
  const reason = e.kind === 'bad-request' ? await withoutSecrets(store, e.message, '', { strict: true }).then((m) => providerReason(e, m), () => '') : '';
  const words = reason ? t`The provider didn't accept the request: "${reason}".`
    : speaking && e.kind === 'not-found' && e.status !== undefined ? t`The provider doesn't know this model, address or voice. Check the model id, the base URL and the Voice.`
      : explain(e);
  return shownWithoutSecrets(store, words);
}

/**
 * A speech model's Test (spec §9.8): a voice plays a sample; a transcription model hears you say
 * something and writes it down. Whether it worked is kept on the model.
 * @param {any} ctx @param {import('../core/llm/config.js').Model} model @param {'in' | 'out'} kind
 * @param {Record<string, any> | undefined} verified @param {string} [title]
 */
export function speechTestPanel(ctx, model, kind, verified, title = t`Test`) {
  const status = h('p', { class: 'sub', role: 'status', text: !verified?.at ? t`Not tested yet.` : verified.speech ? t`Last tested ${relTime(verified.at)}: it worked.` : t`Last tested ${relTime(verified.at)}: it didn't work.` });
  const meter = h('meter', { min: '0', max: '1', value: '0', 'aria-label': t`How loud the microphone hears you`, hidden: kind === 'out' });
  const mark = (/** @type {boolean} */ ok) => markVerified(ctx.ws, model.id, { speech: ok, at: Date.now() });
  const run = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      run.disabled = true;
      await settled();
      try {
        if (kind === 'out') {
          status.textContent = t`Playing a sample…`;
          const r = await ctx.voice.sample(model.id, sample(speaksScreens(await readAppSettings(ctx.ws))));
          status.textContent = r.ended ? t`It works: that was this voice.` : t`The sample stopped early.`;
          await mark(true);
          return;
        }
        status.textContent = t`Say something, such as "Where should we stop for lunch?"`;
        const off = ctx.voice.onLevel((/** @type {number} */ x, /** @type {string} */ who) => { if (who === 'you') meter.value = x; });
        try {
          const seg = await ctx.voice.listenOnce({ seconds: 12, onSpeech: () => { status.textContent = t`Hearing you…`; } });
          if (!seg) {
            status.textContent = t`Nothing was heard in 12 seconds. Check that the microphone is on, then try again.`;
            return;
          }
          status.textContent = t`Writing it down…`;
          const text = await ctx.voice.transcribe(seg, model.id);
          status.textContent = text ? t`It heard: "${text}"` : t`It heard speech but wrote nothing down. Try again, a little closer to the phone.`;
          await mark(Boolean(text));
        } finally {
          off();
          meter.value = 0;
        }
      } catch (e) {
        status.textContent = await speechProblem(ctx.store, e, kind === 'out');
        if (e instanceof ProviderError) await mark(false);
      } finally {
        run.disabled = false;
      }
    },
  }, kind === 'out' ? t`Play a sample` : t`Say something`);
  return h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), h('div', { class: 'acts' }, run), meter, status);
}
