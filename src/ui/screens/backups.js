import { h, crumb, t, field, checkbox, twoStep, savedField, savedCheck, savedRadios, messageOf, numberIn } from '../dom.js';
import { placeStatus, holdNote, placeHref, newerText, relTime, when, size, numField, limitFromField, limitField, limitText, sentences } from '../format.js';
import { offeredTypes } from '../../core/llm/official.js';
import { connectionOf } from '../platform.js';
import { restoreFrom, whereOf, thisDevice } from '../auto-backup.js';
import { leaveSignal } from '../import-state.js';
import { heldOnScreen } from '../plugin-cards.js';

/** What a place's test said, shown once on its screen as it opens again. @type {Map<string, string>} */
const notes = new Map();
/** What went wrong, as this screen shows it: a place's plugin that can't load on this page says so in the screens' language. @param {unknown} e */
const failed = (e) => heldOnScreen(messageOf(e));

/** Which device a backup came from, by the label it was made with (platform.js's deviceName); another device for any other. */
const FROM_DEVICE = /** @type {Record<string, string>} */ ({ iPhone: t`From an iPhone`, iPad: t`From an iPad`, 'Android phone': t`From an Android phone`, computer: t`From a computer` });
/** @param {string} label */
const fromDevice = (label) => (Object.hasOwn(FROM_DEVICE, label) ? FROM_DEVICE[label] : t`From another device`);

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
  for (const k of ctx.backups.types()) kinds.set(k.type, k.name);
  const pick = h('select', { id: 'add-place' }, ...[...kinds].map(([type, name]) => h('option', { value: type, text: name })));
  // From the Add screen's Set up: that kind of place, chosen.
  if (kinds.has(route.params.add)) pick.value = route.params.add;
  const status = h('p', { class: 'sub', role: 'status' });
  const add = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      add.disabled = true;
      status.textContent = t`Getting it ready…`;
      try {
        ctx.go(placeHref(await ctx.backups.add(pick.value)));
      } catch (e) {
        status.textContent = failed(e);
        add.disabled = false;
      }
    },
  }, t`Add`);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: t`Backups` }),
    h('p', { class: 'sub', text: t`annai backs up everything on this device to the places you add here: after changes or once a day, on Wi-Fi, while annai is open. Your API keys stay on this device.` }),
    places.length
      ? h('ul', { class: 'cards' }, ...places.map((/** @type {any} */ p) => h('li', {}, h('a', { class: 'card', href: placeHref(p.id) },
        h('span', { class: 'name', text: `${p.name} · ${whereOf(ctx, p)}` }),
        h('span', { class: 'sub', text: placeStatus(p, ctx.backups.progress(p.id)) }),
        holdNote(p) ? h('span', { class: 'sub', lang: 'en', text: holdNote(p) }) : null))))
      : h('p', { class: 'empty', text: t`No backup places yet.` }),
    kinds.size
      ? h('section', { class: 'panel', 'aria-label': t`Add a place` }, field(t`Add a place to back up to`, pick), h('div', { class: 'acts' }, add), status)
      : h('p', { class: 'sub', text: t`annai couldn't load the kinds of backup places. Check the connection, then open this screen again.` }));
}

/** One place: where it is, when annai backs up to it, and what is there. @param {any} ctx @param {string} id */
async function renderPlace(ctx, id) {
  const target = await ctx.backups.get(id);
  if (!target) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`This backup place was removed` }), h('p', {}, h('a', { href: '#/backups' }, t`Back to Backups`)));
  const type = ctx.backups.typeOf(target.type);
  const noun = ctx.backups.noun;
  const me = thisDevice(noun);
  const status = h('p', { class: 'sub', role: 'status', text: notes.get(id) ?? '' });
  notes.delete(id);
  const say = (/** @type {string} */ s) => { status.textContent = s; };
  // A backup opened from here stops if the user leaves this screen before it has opened (the import screen takes over from there).
  const leaving = leaveSignal();
  const live = h('p', { class: 'sub', text: placeStatus(target, ctx.backups.progress(id)) });
  // An older hold's English, under it.
  const note = h('p', { class: 'sub', lang: 'en', text: holdNote(target), hidden: !holdNote(target) });
  const stop = h('button', { class: 'btn', type: 'button', hidden: !ctx.backups.progress(id), onclick: () => ctx.backups.stop(id) }, t`Stop`);
  const off = ctx.backups.on(async () => {
    if (!live.isConnected) {
      off();
      return;
    }
    const now = await ctx.backups.get(id);
    if (now) {
      live.textContent = placeStatus(now, ctx.backups.progress(id));
      note.textContent = holdNote(now);
      note.hidden = !note.textContent;
    }
    stop.hidden = !ctx.backups.progress(id);
  });
  const top = [
    h('p', { class: 'crumbs' }, crumb('#/backups', t`Backups`)),
    h('h1', { class: 'title', text: target.name }),
    h('p', { class: 'sub', text: whereOf(ctx, target) }),
    live,
    note,
  ];
  if (!type) {
    const on = h('button', {
      class: 'btn pri', type: 'button',
      onclick: async () => {
        say(t`Turning it on…`);
        try {
          await ctx.backups.turnOn(id);
          ctx.render();
        } catch (e) {
          say(failed(e));
        }
      },
    }, t`Turn it on`);
    return h('div', { class: 'screen' }, ...top,
      h('section', { class: 'panel', 'aria-label': t`Plugin` }, h('p', { text: t`The plugin for ${target.name} isn't running, so annai can't back up here.` }), h('div', { class: 'acts' }, on), status),
      removeSection(ctx, id));
  }
  /** A backup the user asked for; its result shows when the screen opens again. @param {{ over?: boolean }} o */
  const backUpNow = async (o) => {
    say('');
    try {
      await ctx.backups.backUp(id, o);
      notes.set(id, t`Backed up.`);
    } catch (e) {
      if (/** @type {any} */ (e)?.name !== 'AbortError') notes.set(id, failed(e));
    }
    if (live.isConnected) ctx.render();
  };
  const saved = new Set(await ctx.backups.savedSecrets(id));
  const inputs = type.fields.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-${f.key}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: target.config[f.key] ?? '', placeholder: f.placeholder ?? '' }) }));
  const secrets = type.secret.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-secret-${f.key}`, type: 'password', autocomplete: 'off', placeholder: saved.has(f.key) ? t`saved (type a new one to replace it)` : t`not set` }) }));
  // A place that keeps whole files may encrypt them (spec §12.2), and keeps this device's last few.
  const file = type.stores === 'file';
  const encrypt = checkbox(t`Encrypt backups with a passphrase`, Boolean(target.encrypt));
  const pass1 = h('input', { id: 'place-passphrase', type: 'password', autocomplete: 'new-password', placeholder: saved.has('passphrase') ? t`saved (type a new one to replace it)` : t`not set` });
  const pass2 = h('input', { id: 'place-passphrase2', type: 'password', autocomplete: 'new-password' });
  const keys = checkbox(t`Include API keys (only in encrypted backups)`, Boolean(target.keys));
  const keep = h('input', { id: 'place-keep', inputmode: 'numeric', value: numField(target.keep ?? 3) });
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
      say(t`Testing…`);
      if (file && pass1.value !== pass2.value) {
        say(t`The passphrases don't match.`);
        save.disabled = false;
        return;
      }
      try {
        await ctx.backups.update(id, {
          config: Object.fromEntries(inputs.map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
          secret: Object.fromEntries(secrets.filter((/** @type {any} */ i) => i.el.value.trim()).map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
          ...(file ? { encrypt: encrypt.input.checked, keys: encrypt.input.checked && keys.input.checked, keep: keep.value.trim() ? numberIn(keep, 1, 30, t`Keep 1 to 30 backups.`, { whole: true }) : 3, ...(pass1.value ? { passphrase: pass1.value } : {}) } : {}),
        });
        notes.set(id, (await ctx.backups.check(id)).note);
        ctx.render();
      } catch (e) {
        say(failed(e));
        offer(e);
        save.disabled = false;
      }
    },
  }, t`Save and test`);
  const hold = target.hold;
  const holdPanel = hold?.kind === 'newer'
    ? h('section', { class: 'panel', 'aria-label': t`A newer backup` },
      h('h2', { class: 'section', text: target.last ? t`A newer backup is here` : t`A backup is already here` }),
      h('p', { text: newerText(target, { where: whereOf(ctx, target), noun, tree: type.stores === 'tree' }) }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn pri', type: 'button', onclick: () => restoreFrom(ctx, target, hold.remote, say, { signal: leaving.signal }) }, t`Import it as a copy`),
        h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({ over: true }) }, me.over)))
    : hold?.kind === 'large'
      ? h('section', { class: 'panel', 'aria-label': t`A large backup` },
        h('p', { text: sentences(t`This backup uploads ${size(hold.bytes)}.`, me.wifi) }),
        h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => backUpNow({}) }, t`Back up now`)))
      : null;
  const auto = savedRadios(t`Back up automatically`, [
    ['changes', type.stores === 'tree' ? t`After changes, within the hour` : t`After changes, at most every 6 hours`],
    ['daily', t`Once a day`],
    ['off', t`Off`],
  ], target.auto, (v) => ctx.backups.update(id, { auto: /** @type {any} */ (v) }));
  const mobile = savedCheck(t`Also over mobile data`, target.mobileData, (on) => ctx.backups.update(id, { mobileData: on }));
  // Where the browser can't say whether it is on Wi-Fi (Safari on iPhone), how much goes without asking: the user's choice.
  const limit = h('input', { id: 'place-ask-above', inputmode: 'decimal', placeholder: t`No limit`, value: limitField(target.askAbove) });
  const limitNote = h('p', { class: 'sub', text: limitNoteText(target.askAbove, connectionOf(navigator)) });
  const readLimit = () => {
    const value = limit.validity?.badInput ? undefined : limitFromField(limit.value);
    if (value === undefined) throw new Error(t`Type a number of megabytes, or leave it empty for no limit.`);
    return value;
  };
  const list = h('ul', { class: 'cards' });
  const show = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      show.disabled = true;
      say(t`Looking…`);
      try {
        const all = await ctx.backups.remote(id);
        say(all.length ? '' : t`There are no backups here yet.`);
        list.replaceChildren(...all.slice(0, 10).map((/** @type {any} */ r) => h('li', { class: 'card' },
          h('span', { class: 'name', text: when(r.at) }),
          h('span', { class: 'sub', text: [r.label ? fromDevice(r.label) : null, r.encrypted ? t`encrypted` : null, relTime(r.at)].filter(Boolean).join(' · ') }),
          h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => restoreFrom(ctx, target, r, say, { signal: leaving.signal }) }, t`Open`)))));
      } catch (e) {
        say(failed(e));
      }
      show.disabled = false;
    },
  }, t`Show the backups here`);
  const more = inputs.filter((/** @type {any} */ i) => i.f.advanced);
  const help = type.help
    ? h('p', { class: 'sub' }, type.help, /^https:\/\//.test(type.helpUrl ?? '') ? [' ', h('a', { href: type.helpUrl, target: '_blank', rel: 'noopener noreferrer' }, type.helpLabel ?? t`How to set it up`)] : null)
    : null;
  return h('div', { class: 'screen' }, ...top,
    holdPanel,
    h('section', { class: 'panel', 'aria-label': t`Where` },
      ...inputs.filter((/** @type {any} */ i) => !i.f.advanced).map((/** @type {any} */ i) => field(i.f.label, i.el)),
      ...secrets.map((/** @type {any} */ i) => field(i.f.label, i.el)),
      more.length ? h('details', {}, h('summary', { text: t`More` }), ...more.map((/** @type {any} */ i) => field(i.f.label, i.el))) : null,
      help,
      ...(file ? [
        h('div', { class: 'checks' }, encrypt.el),
        h('div', { class: 'row' }, field(t`Passphrase`, pass1), field(t`Repeat passphrase`, pass2)),
        h('p', { class: 'sub', text: t`Keep the passphrase somewhere safe: without it, these backups can't be opened. annai keeps it on this device, so it can back up by itself.` }),
        h('div', { class: 'checks' }, keys.el),
        field(t`Keep this many of this device's backups here`, keep),
        h('p', { class: 'sub', text: t`After each backup, older ones this device made here are deleted. Other devices' backups are never deleted.` }),
      ] : []),
      h('div', { class: 'acts' }, save),
      status, picks),
    accessPanel(ctx, type),
    h('section', { class: 'panel', 'aria-label': t`When` },
      auto, mobile.el,
      savedField(t`Upload without asking up to, MB`, limit, readLimit, async (value) => {
        await ctx.backups.update(id, { askAbove: value });
        limitNote.textContent = limitNoteText(value, connectionOf(navigator));
      }),
      limitNote,
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({}) }, t`Back up now`), stop)),
    h('section', { class: 'panel', 'aria-label': t`Restore` },
      h('h2', { class: 'section', text: t`Restore` }),
      h('p', { class: 'sub', text: t`Open a backup from here on the import screen, where you choose what comes in.` }),
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
  return h('section', { class: 'panel', 'aria-label': t`Browser access` },
    h('h2', { class: 'section', text: t`Browser access` }),
    h('p', { class: 'sub', text: String(a.text ?? '') }),
    pre,
    h('div', { class: 'acts' }, h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(code);
          ctx.notices.toast(t`Copied`);
        } catch {
          getSelection()?.selectAllChildren(pre);
          ctx.notices.toast(t`Copying didn't work here: it is selected, so copy it yourself.`);
        }
      },
    }, t`Copy`)));
}

/**
 * What the limit for unnamed connections does, in words. @param {number | null | undefined} limit
 * @param {import('../../core/backup-auto.js').Connection} connection
 */
function limitNoteText(limit, connection) {
  const here = connection === 'unknown';
  if (limit === null) {
    return here ? t`This browser doesn't tell annai whether it is on Wi-Fi: automatic backups go without asking, whatever their size. Type a number to set a limit.`
      : t`Where a browser doesn't tell annai whether it is on Wi-Fi (Safari on iPhone): automatic backups go without asking, whatever their size. Type a number to set a limit.`;
  }
  const most = limitText(limit);
  return here ? t`This browser doesn't tell annai whether it is on Wi-Fi: automatic backups larger than ${most} wait for your OK, unless "Also over mobile data" is on. Leave it empty for no limit.`
    : t`Where a browser doesn't tell annai whether it is on Wi-Fi (Safari on iPhone): automatic backups larger than ${most} wait for your OK, unless "Also over mobile data" is on. Leave it empty for no limit.`;
}

/** @param {any} ctx @param {string} id */
function removeSection(ctx, id) {
  return h('section', { class: 'panel', 'aria-label': t`Remove` },
    h('p', { class: 'sub', text: t`annai stops backing up here. The backups already there stay.` }),
    h('div', { class: 'acts' }, twoStep(t`Remove this place`, t`Tap again to remove it`, async () => {
      await ctx.backups.remove(id);
      ctx.go('#/backups');
    })));
}
