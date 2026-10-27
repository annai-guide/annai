import { h, crumb, t } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { writeRecap, recapModels, recapError, RECAP_FILE, TELL_RECAP, RECAP_SENDS } from '../../core/after/recap.js';
import { loadPack } from '../../core/pack/read.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { withoutSecrets } from '../../core/agent/net.js';
import { text } from '../../core/bytes.js';
import { codec } from '../photo-codec.js';
import { fileHref, relTime, wording, sentenceGap } from '../format.js';
import { tripStamps, stampMarks } from '../stamps.js';

/** Recaps being written, by trip: the screen drawn again finds its own, and leaving the screen stops it. @type {Map<string, AbortController>} */
const writing = new Map();

/**
 * Recap (spec §13, §16.2): the trip's recap as the utility model wrote it, rendered by annai's own
 * Markdown renderer (§15); a tap writes it, or writes it again (the old one stays in the file's
 * history); Shiori can tell it aloud. What goes to the model is said here (§11.7, choice 4).
 * @param {any} ctx @param {{ parts: string[] }} route
 */
export async function renderRecap(ctx, route) {
  const id = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`This trip isn't on this device` }), h('p', {}, h('a', { href: '#/trips' }, t`Back to Trips`)));
  }
  const got = await ctx.ws.read(id, RECAP_FILE).catch(() => undefined);
  const recap = got ? text(got.bytes) : '';
  const stamps = await tripStamps(ctx, id);
  const model = ctx.llm ? recapModels(await ctx.llm.config().catch(() => null))[0] ?? null : null;
  const trip = `#/trip/${encodeURIComponent(id)}`;
  const busy = (/** @type {{ name: string }} */ m) => t`Writing it: ${m.name} is reading the trip. This can take a minute.`;
  const status = h('p', { class: 'sub', role: 'status', text: model && writing.has(id) ? busy(model) : '' });
  const write = h('button', { class: recap ? 'btn' : 'btn pri', type: 'button', disabled: !model || writing.has(id) }, recap ? t`Write it again` : t`Write the recap`);
  const here = () => location.hash.startsWith(`${trip}/recap`);
  write.addEventListener('click', async () => {
    if (!model || writing.has(id)) return;
    write.disabled = true;
    status.textContent = busy(model);
    const abort = new AbortController();
    writing.set(id, abort);
    const leave = () => { if (!here()) abort.abort(); };
    addEventListener('hashchange', leave);
    try {
      const pack = await loadPack(ctx.ws, id).catch(() => null);
      await writeRecap({ store: ctx.store, ws: ctx.ws, llm: ctx.llm, trip: id, codec, namer: (p) => pack?.name(p) ?? null, signal: abort.signal });
      ctx.notices.toast(t`The recap is written.`);
    } catch (e) {
      if (!abort.signal.aborted) ctx.notices.card({ tone: 'warn', title: t`The recap wasn't written`, body: await withoutSecrets(ctx.store, recapError(e)) });
    } finally {
      writing.delete(id);
      removeEventListener('hashchange', leave);
      if (here()) ctx.render(); // the screen, as drawn now, shows how it went
    }
  });
  const tell = recap && ctx.agent ? h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      // Shiori talks about the trip that is open: this one, as opening its page makes it (choice 3).
      if (ctx.agent.target !== id) {
        await updateAppSettings(ctx.ws, { activeTrip: id });
        await ctx.agent.open(id);
      }
      ctx.agent.wake({ kind: 'recap', aloud: true, text: TELL_RECAP });
      ctx.notices.toast(t`Shiori is getting ready to tell it.`);
    },
  }, t`Hear Shiori tell it`) : null;
  return h('div', { class: 'screen recap' },
    h('p', { class: 'crumbs' }, crumb(trip, h('span', { dir: 'auto', text: scope.title }))),
    h('h1', { class: 'title', text: t`Recap` }),
    stampMarks(stamps, { max: 24, big: true }),
    recap
      ? h('article', { class: 'recap-text' }, renderMarkdown(recap, wording(await readAppSettings(ctx.ws))(recap)))
      : h('p', { class: 'empty', text: t`No recap yet. annai's utility model writes it from the trip: where you stayed and went, the stamps, what you and Shiori said, your notes and some photos.` }),
    got ? h('p', { class: 'sub', text: got.entry.author === 'user' ? t`Written ${relTime(got.entry.modified)}, then edited by you.` : t`Written ${relTime(got.entry.modified)}.` }) : null,
    h('div', { class: 'acts' }, tell, write,
      recap ? h('a', { class: 'btn', href: fileHref(id, RECAP_FILE) }, t`Edit`) : null,
      h('a', { class: 'btn', href: `${trip}/replay` }, t`Replay`)),
    status,
    model
      ? h('details', { class: 'sent' },
        h('summary', { text: t`What goes to ${model.name}` }),
        h('ul', {}, ...RECAP_SENDS.map((line) => h('li', { text: line }))))
      : h('p', { class: 'sub' }, t`No model is set up to write it yet.`, sentenceGap(), h('a', { href: '#/models' }, t`Add one in Settings → Models.`)));
}
