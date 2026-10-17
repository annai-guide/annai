import { h, field, checkbox, radios, twoStep } from '../dom.js';
import { placeStatus, placeHref, newerText, withArticle, relTime, bytes } from '../format.js';
import { offeredTypes } from '../../core/llm/official.js';
import { TIMINGS } from '../../core/backup-auto.js';
import { connectionOf } from '../platform.js';
import { restoreFrom, whereOf } from '../auto-backup.js';

/** What a place's test said, shown once on its screen as it opens again. @type {Map<string, string>} */
const notes = new Map();

/**
 * Settings → Backups (spec §12.4, §16.2 "Storage & backup"): the places this device backs up to, or one place.
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderBackups(ctx, route) {
  if (route.parts[1] === 'place') return renderPlace(ctx, route.params.id ?? '');
  const places = await ctx.backups.list();
  const offered = await offeredTypes('storage-type').catch(() => []);
  /** @type {Map<string, string>} type → name */
  const kinds = new Map(offered.map((o) => /** @type {[string, string]} */ ([o.type, o.name])));
  for (const t of ctx.backups.types()) kinds.set(t.type, t.name);
  const pick = h('select', { id: 'add-place' }, ...[...kinds].map(([type, name]) => h('option', { value: type, text: name })));
  const status = h('p', { class: 'sub', role: 'status' });
  const add = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      add.disabled = true;
      status.textContent = 'Getting it ready…';
      try {
        ctx.go(placeHref(await ctx.backups.add(pick.value)));
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
        add.disabled = false;
      }
    },
  }, 'Add');
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Backups' }),
    h('p', { class: 'sub', text: 'annai backs up everything on this device to the places you add here: after changes or once a day, on Wi-Fi, while annai is open. Your API keys stay on this device.' }),
    places.length
      ? h('ul', { class: 'cards' }, ...places.map((/** @type {any} */ t) => h('li', {}, h('a', { class: 'card', href: placeHref(t.id) },
        h('span', { class: 'name', text: `${t.name} · ${whereOf(ctx, t)}` }),
        h('span', { class: 'sub', text: placeStatus(t, ctx.backups.progress(t.id)) })))))
      : h('p', { class: 'empty', text: 'No backup places yet.' }),
    kinds.size
      ? h('section', { class: 'panel', 'aria-label': 'Add a place' }, field('Add a place to back up to', pick), h('div', { class: 'acts' }, add), status)
      : h('p', { class: 'sub', text: "annai couldn't load the kinds of backup places. Check the connection, then open this screen again." }));
}

/** One place: where it is, when annai backs up to it, and what is there. @param {any} ctx @param {string} id */
async function renderPlace(ctx, id) {
  const t = await ctx.backups.get(id);
  if (!t) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'This backup place was removed' }), h('p', {}, h('a', { href: '#/backups' }, 'Back to Backups')));
  const type = ctx.backups.typeOf(t.type);
  const noun = ctx.backups.noun;
  const status = h('p', { class: 'sub', role: 'status', text: notes.get(id) ?? '' });
  notes.delete(id);
  const say = (/** @type {string} */ s) => { status.textContent = s; };
  const live = h('p', { class: 'sub', text: placeStatus(t, ctx.backups.progress(id)) });
  const stop = h('button', { class: 'btn', type: 'button', hidden: !ctx.backups.progress(id), onclick: () => ctx.backups.stop(id) }, 'Stop');
  const off = ctx.backups.on(async () => {
    if (!live.isConnected) {
      off();
      return;
    }
    const now = await ctx.backups.get(id);
    if (now) live.textContent = placeStatus(now, ctx.backups.progress(id));
    stop.hidden = !ctx.backups.progress(id);
  });
  const top = [
    h('p', { class: 'crumbs' }, h('a', { href: '#/backups' }, '← Backups')),
    h('h1', { class: 'title', text: t.name }),
    h('p', { class: 'sub', text: whereOf(ctx, t) }),
    live,
  ];
  if (!type) {
    const on = h('button', {
      class: 'btn pri', type: 'button',
      onclick: async () => {
        say('Turning it on…');
        try {
          await ctx.backups.turnOn(id);
          ctx.render();
        } catch (e) {
          say(String(/** @type {any} */ (e)?.message ?? e));
        }
      },
    }, 'Turn it on');
    return h('div', { class: 'screen' }, ...top,
      h('section', { class: 'panel', 'aria-label': 'Plugin' }, h('p', { text: `The plugin for ${t.name} isn't running, so annai can't back up here.` }), h('div', { class: 'acts' }, on), status),
      removeSection(ctx, id));
  }
  /** A backup the user asked for; its result shows when the screen opens again. @param {{ over?: boolean }} o */
  const backUpNow = async (o) => {
    say('');
    try {
      await ctx.backups.backUp(id, o);
      notes.set(id, 'Backed up.');
    } catch (e) {
      if (/** @type {any} */ (e)?.name !== 'AbortError') notes.set(id, String(/** @type {any} */ (e)?.message ?? e));
    }
    if (live.isConnected) ctx.render();
  };
  const saved = new Set(await ctx.backups.savedSecrets(id));
  const inputs = type.fields.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-${f.key}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: t.config[f.key] ?? '', placeholder: f.placeholder ?? '' }) }));
  const secrets = type.secret.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-secret-${f.key}`, type: 'password', autocomplete: 'off', placeholder: saved.has(f.key) ? 'saved (type a new one to replace it)' : 'not set' }) }));
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      save.disabled = true;
      say('Testing…');
      try {
        await ctx.backups.update(id, {
          config: Object.fromEntries(inputs.map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
          secret: Object.fromEntries(secrets.filter((/** @type {any} */ i) => i.el.value.trim()).map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
        });
        notes.set(id, (await ctx.backups.check(id)).note);
        ctx.render();
      } catch (e) {
        say(String(/** @type {any} */ (e)?.message ?? e));
        save.disabled = false;
      }
    },
  }, 'Save and test');
  const hold = t.hold;
  const holdPanel = hold?.kind === 'newer'
    ? h('section', { class: 'panel', 'aria-label': 'A newer backup' },
      h('h2', { class: 'section', text: t.last ? 'A newer backup is here' : 'A backup is already here' }),
      h('p', { text: newerText(t, { where: whereOf(ctx, t), noun, tree: type.stores === 'tree' }) }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn pri', type: 'button', onclick: () => restoreFrom(ctx, t, hold.remote, say) }, 'Import it as a copy'),
        h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({ over: true }) }, `Back up this ${noun} over it`)))
    : hold?.kind === 'large'
      ? h('section', { class: 'panel', 'aria-label': 'A large backup' },
        h('p', { text: `This backup uploads ${bytes(hold.bytes)}. annai can't tell whether this ${noun} is on Wi-Fi, so larger backups wait for your OK.` }),
        h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => backUpNow({}) }, 'Back up now')))
      : null;
  const auto = radios('Back up automatically', [
    ['changes', type.stores === 'tree' ? 'After changes, within the hour' : 'After changes, at most every 6 hours'],
    ['daily', 'Once a day'],
    ['off', 'Off'],
  ], t.auto, async (v) => {
    await ctx.backups.update(id, { auto: /** @type {any} */ (v) });
    ctx.notices.toast('Saved');
  });
  const mobile = checkbox('Also over mobile data', t.mobileData);
  mobile.input.addEventListener('change', async () => {
    await ctx.backups.update(id, { mobileData: mobile.input.checked });
    ctx.notices.toast('Saved');
  });
  const list = h('ul', { class: 'cards' });
  const show = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      show.disabled = true;
      say('Looking…');
      try {
        const all = await ctx.backups.remote(id);
        say(all.length ? '' : 'There are no backups here yet.');
        list.replaceChildren(...all.slice(0, 10).map((/** @type {any} */ r) => h('li', { class: 'card' },
          h('span', { class: 'name', text: new Date(r.at).toLocaleString() }),
          h('span', { class: 'sub', text: [r.label ? `From ${withArticle(r.label)}` : null, relTime(r.at)].filter(Boolean).join(' · ') }),
          h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => restoreFrom(ctx, t, r, say) }, 'Open')))));
      } catch (e) {
        say(String(/** @type {any} */ (e)?.message ?? e));
      }
      show.disabled = false;
    },
  }, 'Show the backups here');
  const more = inputs.filter((/** @type {any} */ i) => i.f.advanced);
  const help = type.help
    ? h('p', { class: 'sub' }, type.help, /^https:\/\//.test(type.helpUrl ?? '') ? [' ', h('a', { href: type.helpUrl, target: '_blank', rel: 'noopener' }, type.helpLabel ?? 'How to set it up')] : null)
    : null;
  return h('div', { class: 'screen' }, ...top,
    holdPanel,
    h('section', { class: 'panel', 'aria-label': 'Where' },
      ...inputs.filter((/** @type {any} */ i) => !i.f.advanced).map((/** @type {any} */ i) => field(i.f.label, i.el)),
      ...secrets.map((/** @type {any} */ i) => field(i.f.label, i.el)),
      more.length ? h('details', {}, h('summary', { text: 'More' }), ...more.map((/** @type {any} */ i) => field(i.f.label, i.el))) : null,
      help,
      h('div', { class: 'acts' }, save),
      status),
    h('section', { class: 'panel', 'aria-label': 'When' },
      auto, mobile.el,
      connectionOf(navigator) === 'unknown'
        ? h('p', { class: 'sub', text: `This browser doesn't tell annai whether it is on Wi-Fi, so automatic backups larger than ${bytes(TIMINGS.askAbove)} wait for your OK, unless "Also over mobile data" is on.` })
        : null,
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({}) }, 'Back up now'), stop)),
    h('section', { class: 'panel', 'aria-label': 'Restore' },
      h('h2', { class: 'section', text: 'Restore' }),
      h('p', { class: 'sub', text: 'Open a backup from here on the import screen, where you choose what comes in.' }),
      h('div', { class: 'acts' }, show),
      list),
    removeSection(ctx, id));
}

/** @param {any} ctx @param {string} id */
function removeSection(ctx, id) {
  return h('section', { class: 'panel', 'aria-label': 'Remove' },
    h('p', { class: 'sub', text: 'annai stops backing up here. The backups already there stay.' }),
    h('div', { class: 'acts' }, twoStep('Remove this place', 'Tap again to remove it', async () => {
      await ctx.backups.remove(id);
      ctx.go('#/backups');
    })));
}
