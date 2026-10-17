import { h } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { writeRecap, recapModels, recapError, RECAP_FILE, TELL_RECAP, RECAP_PHOTOS } from '../../core/after/recap.js';
import { loadPack } from '../../core/pack/read.js';
import { updateAppSettings } from '../../core/settings.js';
import { withoutSecrets } from '../../core/agent/net.js';
import { text } from '../../core/bytes.js';
import { codec } from '../photo-codec.js';
import { fileHref, relTime } from '../format.js';
import { tripStamps, stampMarks } from '../stamps.js';

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
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  const got = await ctx.ws.read(id, RECAP_FILE).catch(() => undefined);
  const recap = got ? text(got.bytes) : '';
  const stamps = await tripStamps(ctx, id);
  const model = ctx.llm ? recapModels(await ctx.llm.config().catch(() => null))[0] ?? null : null;
  const trip = `#/trip/${encodeURIComponent(id)}`;
  const status = h('p', { class: 'sub', role: 'status' });
  const write = h('button', { class: recap ? 'btn' : 'btn pri', type: 'button', disabled: !model }, recap ? 'Write it again' : 'Write the recap');
  write.addEventListener('click', async () => {
    if (!model) return;
    write.disabled = true;
    status.textContent = `Writing it: ${model.name} is reading the trip. This can take a minute.`;
    try {
      const pack = await loadPack(ctx.ws, id).catch(() => null);
      await writeRecap({ store: ctx.store, ws: ctx.ws, llm: ctx.llm, trip: id, codec, namer: (p) => pack?.name(p) ?? null });
      ctx.notices.toast('The recap is written.');
      if (status.isConnected) ctx.render();
    } catch (e) {
      status.textContent = '';
      write.disabled = false;
      ctx.notices.card({ tone: 'warn', title: "The recap wasn't written", body: await withoutSecrets(ctx.store, recapError(e)) });
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
      ctx.notices.toast('Shiori is getting ready to tell it.');
    },
  }, 'Hear Shiori tell it') : null;
  return h('div', { class: 'screen recap' },
    h('p', { class: 'crumbs' }, h('a', { href: trip }, `← ${scope.title}`)),
    h('h1', { class: 'title', text: 'Recap' }),
    stampMarks(stamps, { max: 24, big: true }),
    recap
      ? h('article', { class: 'recap-text' }, renderMarkdown(recap))
      : h('p', { class: 'empty', text: "No recap yet. annai's utility model writes it from the trip: where you stayed and went, the stamps, what you and Shiori said, your notes and some photos." }),
    got ? h('p', { class: 'sub', text: `Written ${relTime(got.entry.modified)}${got.entry.author === 'user' ? ', then edited by you' : ''}.` }) : null,
    h('div', { class: 'acts' }, tell, write,
      recap ? h('a', { class: 'btn', href: fileHref(id, RECAP_FILE) }, 'Edit') : null,
      h('a', { class: 'btn', href: `${trip}/replay` }, 'Replay')),
    status,
    model
      ? h('details', { class: 'sent' },
        h('summary', { text: `What goes to ${model.name}` }),
        h('ul', {},
          h('li', { text: 'Where you stayed and for how long, by name; a place without one as its position, rounded to about 100 m. Never the GPS track itself.' }),
          h('li', { text: 'How far you drove or walked between, the stamps, and the plan.' }),
          h('li', { text: "Shiori's cards and your words, typed or spoken, each shortened." }),
          h('li', { text: 'The trip\'s notes and memory, and your profile.' }),
          h('li', { text: `Up to ${RECAP_PHOTOS} photos, if the model takes photos.` })))
      : h('p', { class: 'sub' }, 'No model is set up to write it yet. ', h('a', { href: '#/models' }, 'Add one in Settings → Models.')));
}
