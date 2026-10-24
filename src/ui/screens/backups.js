import { h, field, checkbox, twoStep, savedField, savedCheck, savedRadios, messageOf } from '../dom.js';
import { placeStatus, placeHref, newerText, withArticle, relTime, when, size, numField, parseNum, limitFromField, limitField, limitText } from '../format.js';
import { offeredTypes } from '../../core/llm/official.js';
import { connectionOf } from '../platform.js';
import { restoreFrom, whereOf } from '../auto-backup.js';
import { leaveSignal } from '../import-state.js';

/** What a place's test said, shown once on its screen as it opens again. @type {Map<string, string>} */
const notes = new Map();

/**
 * Settings → Backups (spec §12.4, §16.2 "Storage & backup"): the places this device backs up to, or one place.
 * ?add=<type> (the Add screen's Set up) chooses that kind of place to add.
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
  // From the Add screen's Set up: that kind of place, chosen.
  if (kinds.has(route.params.add)) pick.value = route.params.add;
  const status = h('p', { class: 'sub', role: 'status' });
  const add = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      add.disabled = true;
      status.textContent = 'Getting it ready…';
      try {
        ctx.go(placeHref(await ctx.backups.add(pick.value)));
      } catch (e) {
        status.textContent = messageOf(e);
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
  // A backup opened from here stops if the user leaves this screen before it has opened (the import screen takes over from there).
  const leaving = leaveSignal();
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
          say(messageOf(e));
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
      if (/** @type {any} */ (e)?.name !== 'AbortError') notes.set(id, messageOf(e));
    }
    if (live.isConnected) ctx.render();
  };
  const saved = new Set(await ctx.backups.savedSecrets(id));
  const inputs = type.fields.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-${f.key}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: t.config[f.key] ?? '', placeholder: f.placeholder ?? '' }) }));
  const secrets = type.secret.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-secret-${f.key}`, type: 'password', autocomplete: 'off', placeholder: saved.has(f.key) ? 'saved (type a new one to replace it)' : 'not set' }) }));
  // A place that keeps whole files may encrypt them (spec §12.2), and keeps this device's last few.
  const file = type.stores === 'file';
  const encrypt = checkbox('Encrypt backups with a passphrase', Boolean(t.encrypt));
  const pass1 = h('input', { id: 'place-passphrase', type: 'password', autocomplete: 'new-password', placeholder: saved.has('passphrase') ? 'saved (type a new one to replace it)' : 'not set' });
  const pass2 = h('input', { id: 'place-passphrase2', type: 'password', autocomplete: 'new-password' });
  const keys = checkbox('Include API keys (only in encrypted backups)', Boolean(t.keys));
  const keep = h('input', { id: 'place-keep', inputmode: 'numeric', value: numField(t.keep ?? 3) });
  /** What the place offers for fields left empty (several repositories): a tap fills them in and tests again. */
  const picks = h('div', { class: 'acts', hidden: true });
  /** @param {any} e */
  const offer = (e) => {
    const choices = Array.isArray(e?.choices) ? e.choices : [];
    picks.replaceChildren(...choices.map((/** @type {any} */ c) => h('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        for (const i of inputs) if (typeof c.config?.[i.f.key] === 'string') i.el.value = c.config[i.f.key];
        save.click();
      },
    }, String(c.label))));
    picks.hidden = !choices.length;
  };
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      save.disabled = true;
      offer(null);
      say('Testing…');
      if (file && pass1.value !== pass2.value) {
        say("The passphrases don't match.");
        save.disabled = false;
        return;
      }
      try {
        await ctx.backups.update(id, {
          config: Object.fromEntries(inputs.map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
          secret: Object.fromEntries(secrets.filter((/** @type {any} */ i) => i.el.value.trim()).map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
          ...(file ? { encrypt: encrypt.input.checked, keys: encrypt.input.checked && keys.input.checked, keep: parseNum(keep.value) || 3, ...(pass1.value ? { passphrase: pass1.value } : {}) } : {}),
        });
        notes.set(id, (await ctx.backups.check(id)).note);
        ctx.render();
      } catch (e) {
        say(messageOf(e));
        offer(e);
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
        h('button', { class: 'btn pri', type: 'button', onclick: () => restoreFrom(ctx, t, hold.remote, say, { signal: leaving.signal }) }, 'Import it as a copy'),
        h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({ over: true }) }, `Back up this ${noun} over it`)))
    : hold?.kind === 'large'
      ? h('section', { class: 'panel', 'aria-label': 'A large backup' },
        h('p', { text: `This backup uploads ${size(hold.bytes)}. annai can't tell whether this ${noun} is on Wi-Fi, so larger backups wait for your OK.` }),
        h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => backUpNow({}) }, 'Back up now')))
      : null;
  const auto = savedRadios('Back up automatically', [
    ['changes', type.stores === 'tree' ? 'After changes, within the hour' : 'After changes, at most every 6 hours'],
    ['daily', 'Once a day'],
    ['off', 'Off'],
  ], t.auto, (v) => ctx.backups.update(id, { auto: /** @type {any} */ (v) }));
  const mobile = savedCheck('Also over mobile data', t.mobileData, (on) => ctx.backups.update(id, { mobileData: on }));
  // Where the browser can't say whether it is on Wi-Fi (Safari on iPhone), how much goes without asking: the user's choice.
  const limit = h('input', { id: 'place-ask-above', inputmode: 'decimal', placeholder: 'No limit', value: limitField(t.askAbove) });
  const limitNote = h('p', { class: 'sub', text: limitNoteText(t.askAbove, connectionOf(navigator)) });
  const readLimit = () => {
    const value = limit.validity?.badInput ? undefined : limitFromField(limit.value);
    if (value === undefined) throw new Error('Type a number of megabytes, or leave it empty for no limit.');
    return value;
  };
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
          h('span', { class: 'name', text: when(r.at) }),
          h('span', { class: 'sub', text: [r.label ? `From ${withArticle(r.label)}` : null, r.encrypted ? 'encrypted' : null, relTime(r.at)].filter(Boolean).join(' · ') }),
          h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => restoreFrom(ctx, t, r, say, { signal: leaving.signal }) }, 'Open')))));
      } catch (e) {
        say(messageOf(e));
      }
      show.disabled = false;
    },
  }, 'Show the backups here');
  const more = inputs.filter((/** @type {any} */ i) => i.f.advanced);
  const help = type.help
    ? h('p', { class: 'sub' }, type.help, /^https:\/\//.test(type.helpUrl ?? '') ? [' ', h('a', { href: type.helpUrl, target: '_blank', rel: 'noopener noreferrer' }, type.helpLabel ?? 'How to set it up')] : null)
    : null;
  return h('div', { class: 'screen' }, ...top,
    holdPanel,
    h('section', { class: 'panel', 'aria-label': 'Where' },
      ...inputs.filter((/** @type {any} */ i) => !i.f.advanced).map((/** @type {any} */ i) => field(i.f.label, i.el)),
      ...secrets.map((/** @type {any} */ i) => field(i.f.label, i.el)),
      more.length ? h('details', {}, h('summary', { text: 'More' }), ...more.map((/** @type {any} */ i) => field(i.f.label, i.el))) : null,
      help,
      ...(file ? [
        h('div', { class: 'checks' }, encrypt.el),
        h('div', { class: 'row' }, field('Passphrase', pass1), field('Repeat passphrase', pass2)),
        h('p', { class: 'sub', text: "Keep the passphrase somewhere safe: without it, these backups can't be opened. annai keeps it on this device, so it can back up by itself." }),
        h('div', { class: 'checks' }, keys.el),
        field("Keep this many of this device's backups here", keep),
        h('p', { class: 'sub', text: "After each backup, older ones this device made here are deleted. Other devices' backups are never deleted." }),
      ] : []),
      h('div', { class: 'acts' }, save),
      status, picks),
    accessPanel(ctx, type),
    h('section', { class: 'panel', 'aria-label': 'When' },
      auto, mobile.el,
      savedField('Upload without asking up to, MB', limit, readLimit, async (value) => {
        await ctx.backups.update(id, { askAbove: value });
        limitNote.textContent = limitNoteText(value, connectionOf(navigator));
      }),
      limitNote,
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({}) }, 'Back up now'), stop)),
    h('section', { class: 'panel', 'aria-label': 'Restore' },
      h('h2', { class: 'section', text: 'Restore' }),
      h('p', { class: 'sub', text: 'Open a backup from here on the import screen, where you choose what comes in.' }),
      h('div', { class: 'acts' }, show),
      list),
    removeSection(ctx, id));
}

/**
 * What the place needs to answer browsers, from its kind (spec §12.4: for S3, "we show the exact JSON to paste").
 * @param {any} ctx @param {any} type
 */
function accessPanel(ctx, type) {
  if (typeof type.browserAccess !== 'function') return null;
  /** @type {{ text: string, code: string } | null} */
  let a = null;
  try {
    a = type.browserAccess(location.origin);
  } catch {
    return null;
  }
  if (!a?.code) return null;
  const code = String(a.code);
  const pre = h('pre', { class: 'mono code', text: code });
  return h('section', { class: 'panel', 'aria-label': 'Browser access' },
    h('h2', { class: 'section', text: 'Browser access' }),
    h('p', { class: 'sub', text: String(a.text ?? '') }),
    pre,
    h('div', { class: 'acts' }, h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(code);
          ctx.notices.toast('Copied');
        } catch {
          getSelection()?.selectAllChildren(pre);
          ctx.notices.toast('Copying didn\'t work here: it is selected, so copy it yourself.');
        }
      },
    }, 'Copy')));
}

/**
 * What the limit for unnamed connections does, in words. @param {number | null | undefined} limit
 * @param {import('../../core/backup-auto.js').Connection} connection
 */
function limitNoteText(limit, connection) {
  const where = connection === 'unknown' ? "This browser doesn't tell annai whether it is on Wi-Fi" : "Where a browser doesn't tell annai whether it is on Wi-Fi (Safari on iPhone)";
  return limit === null
    ? `${where}: automatic backups go without asking, whatever their size. Type a number to set a limit.`
    : `${where}: automatic backups larger than ${limitText(limit)} wait for your OK, unless "Also over mobile data" is on. Leave it empty for no limit.`;
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
