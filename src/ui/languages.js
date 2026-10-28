import { h, field, queueSave, messageOf, t, crumb } from './dom.js';
import { readAppSettings, updateAppSettings } from '../core/settings.js';
import { chooseTag, lang as screensLang } from '../core/l10n.js';
import { SHIPPED, EXPERIMENTAL } from '../core/l10n-list.js';
import { LANGUAGES, LANGUAGE_WORDS as W, languageSettings, nativeName, tagFor, distancesOf } from '../core/languages.js';
import { languageName, setDistances } from '../core/intl.js';
import { reorderable } from './screens/models.js';

/** A language by its own name ("日本語", "简体中文"), whatever the screens are in. @param {string} tag */
export function ownName(tag) {
  try { return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/** The device's copy of the screens' language (`annai.ui`), read at the start; none: as the phone is set. @param {string | null | undefined} tag */
export function keepUiChoice(tag) {
  try {
    if (tag) localStorage.setItem('annai.ui', tag);
    else localStorage.removeItem('annai.ui');
  } catch { /* storage blocked: annai starts in English then */ }
}

/** The screens' language the app settings choose: a tag, or '' as the phone is set. @param {Record<string, any>} app */
export const chosenUi = (app) => (typeof app.languages?.ui === 'string' ? app.languages.ui : '');

/** Writes that copy from the app settings, as a restore does before its restart. @param {any} ws */
export async function keepUiFrom(ws) {
  keepUiChoice(chosenUi(await readAppSettings(ws)));
}

/** Asks the worker to keep a language's words; with no worker, checks they can be fetched. @param {string} tag @param {{ worker?: ServiceWorker | null, limitMs?: number }} [o] */
export async function keepWords(tag, { worker = navigator.serviceWorker?.controller, limitMs = 30_000 } = {}) {
  if (!worker) {
    try { /* en */ return (await fetch(`/l10n/${tag}.json`)).ok; } catch { return false; }
  }
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const done = (/** @type {boolean} */ ok) => { clearTimeout(timer); port1.close(); resolve(ok); };
    const timer = setTimeout(() => done(false), limitMs);
    port1.onmessage = (e) => done(e.data?.ok === true);
    worker.postMessage({ type: 'cache-words', tag }, [port2]);
  });
}

/** A language of ours by its id. @param {string} id */
const language = (id) => LANGUAGES.find((l) => l.id === id);
/** A language as a picker shows it: its name in the screens' language, then its own. @param {import('../core/languages.js').Language} l */
const optionText = (l) => W.option(languageName(l.id), nativeName(l));

/** Settings → Languages, a screen of its own (the user, 2026-10-28; Settings → Shiori held it before). @param {any} ctx */
export async function renderLanguages(ctx) {
  return h('div', { class: 'screen' }, h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)), h('h1', { class: 'title', text: W.heading }),
    languagesSection(ctx, await readAppSettings(ctx.ws)));
}

/**
 * Settings → Languages (phase 2): annai's screens, distances, the languages you speak, in order, and the one Shiori answers in. Each change is saved at
 * once, in the app settings (so backups carry it), and every model that hears or speaks is told at its next session or wake. Each
 * change is built from the list as it stands, and shown before its write lands, so two quick ones lose neither; the answer language
 * is one of those listed, and takes leave with its language, in the same save.
 * @param {any} ctx @param {Record<string, any>} app the app settings
 */
export function languagesSection(ctx, app) {
  const first = languageSettings(app, navigator.language);
  // A browser language annai has no codes for is no pick: the list starts empty then, and says the browser's is used.
  let ids = first.spoken.map((l) => l.id).filter((id) => language(id));
  let chosen = first.explicit;
  let answerId = first.answer?.id ?? 'follow';
  /** What the store has, to go back to when a write fails with nothing newer. */
  let stored = { ids, chosen, answerId };
  let version = 0;

  const note = h('span', { class: 'saved', role: 'status' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const screens = screensRow(ctx, app);
  const distances = distancesRow(ctx, app);
  const hint = h('p', { class: 'sub' });
  const list = h('ol', { class: 'role-list', 'aria-label': W.spokenLabel });
  const add = h('select', { id: 'language-add' });
  const addButton = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => pick() }, W.addButton);
  const answer = h('select', { id: 'language-answer' });

  /** Writes what is shown, after the writes queued before it; the last one written is the list as the user left it. @param {string[]} said what the line says while it is written, and once it has been */
  const save = (said) => {
    const mine = ++version;
    note.textContent = said[0];
    return queueSave(async () => {
      // What this write sends, taken before it waits: the screen goes on changing meanwhile, and is not what was kept. Until the user
      // has chosen a list, only the answer is saved: the browser's language shown is not their pick.
      const sent = { ids, chosen, answerId };
      try {
        await updateAppSettings(ctx.ws, { languages: sent.chosen ? { spoken: sent.ids, answer: sent.answerId } : { answer: sent.answerId } });
        stored = sent;
        error.hidden = true;
        if (mine === version) note.textContent = said[1];
      } catch (e) {
        // With a newer change after it, that one writes the whole list again; else the screen goes back to what the store has.
        if (mine === version) {
          ({ ids, chosen, answerId } = stored);
          draw();
          note.textContent = '';
        }
        error.textContent = messageOf(e);
        error.hidden = false;
      }
    });
  };

  /** Shows the new list at once, then saves it. @param {string[]} next @param {string[]} said @param {{ id: string, act: string } | 'add' | null} [focus] where focus goes (null: it stays, or a handle takes it back) @param {string} [nextAnswer] */
  const change = (next, said, focus = 'add', nextAnswer = answerId) => {
    ids = next;
    chosen = true;
    answerId = nextAnswer;
    draw(focus);
    return save(said);
  };

  /** Moves a language by one (its handle's keys or menu). @param {string} id @param {number} by */
  const move = async (id, by) => {
    const i = ids.indexOf(id);
    if (i < 0 || !ids[i + by]) return;
    await change(swap(Math.min(i, i + by)), W.moved(languageName(id), i + by + 1), null);
  };
  /** A drag's order, said as the language that moved furthest. @param {string} _ @param {(ids: string[]) => string[]} order */
  const dragged = async (_, order) => {
    const next = order(ids);
    const far = (/** @type {string} */ x) => Math.abs(next.indexOf(x) - ids.indexOf(x));
    const moved = next.reduce((a, b) => (far(b) > far(a) ? b : a), next[0]);
    await change(next, W.moved(languageName(moved), next.indexOf(moved) + 1), null);
  };

  /** @param {{ id: string, act: string } | 'add' | null} [focus] */
  const draw = (focus) => {
    // Dragged by a handle, as the model list is (the user, 2026-10-28).
    list.replaceChildren(...ids.map((id, i) => {
      const l = /** @type {import('../core/languages.js').Language} */ (language(id));
      const own = nativeName(l);
      const name = languageName(id);
      const drop = h('button', { class: 'btn', type: 'button', 'aria-label': W.removeLabel(name), dataset: { lang: id, act: 'remove' }, disabled: ids.length < 2, onclick: () => remove(id) }, W.remove);
      return reorderable('languages', id, i, ids.length, name, false, undefined, move, dragged, drop, { own: own !== name ? h('span', { class: 'sub', lang: tagFor(l), text: own }) : null });
    }));
    hint.textContent = chosen ? '' : W.emptyHint;
    hint.hidden = chosen;
    add.replaceChildren(h('option', { value: '', text: W.add }), ...LANGUAGES.filter((l) => !ids.includes(l.id)).map((l) => h('option', { value: l.id, text: optionText(l) })));
    addButton.disabled = true;
    // Shiori answers in one of those listed, or follows you.
    // (An answer language saved before the list limited it still shows, so the screen says what is so.)
    const offered = answerId !== 'follow' && !ids.includes(answerId) && language(answerId) ? [...ids, answerId] : ids;
    answer.replaceChildren(h('option', { value: 'follow', text: W.follow }), ...offered.map((id) => h('option', { value: id, text: optionText(/** @type {any} */ (language(id))) })));
    answer.value = offered.includes(answerId) ? answerId : 'follow';
    if (focus === 'add') add.focus({ preventScroll: true });
    else if (focus) {
      // The button asked for, else any other of that language's that works, else the item itself (the last language has no working button).
      const buttons = [...list.querySelectorAll(`button[data-lang="${focus.id}"]`)].filter((b) => !(/** @type {HTMLButtonElement} */ (b).disabled));
      const to = buttons.find((b) => /** @type {HTMLElement} */ (b).dataset.act === focus.act) ?? buttons[0] ?? list.querySelector(`li[data-id="${focus.id}"] .grip`);
      /** @type {HTMLElement | null} */ (to)?.focus({ preventScroll: true });
    }
  };

  /** The list with the language at i and the one after it exchanged. @param {number} i */
  const swap = (i) => ids.map((x, k) => (k === i ? ids[i + 1] : k === i + 1 ? ids[i] : x));

  /** Removes a language; if it was the one Shiori answers in, she follows you again, in the same save. Focus goes to the next one's Remove, else the one before's. @param {string} id */
  const remove = (id) => {
    const at = ids.indexOf(id);
    const next = ids.filter((x) => x !== id);
    const name = languageName(id);
    const resets = answerId === id;
    const near = next[Math.min(at, next.length - 1)];
    return change(next, resets ? W.removedAnswer(name) : W.removed(name), near ? { id: near, act: 'remove' } : 'add', resets ? 'follow' : answerId);
  };

  /** Adds the language picked, once Add is pressed: arrow keys in the list only choose. */
  const pick = () => {
    const l = language(add.value);
    if (l && !ids.includes(l.id)) change([...ids, l.id], W.added(languageName(l.id)));
  };

  add.addEventListener('change', () => { addButton.disabled = !add.value; });
  answer.addEventListener('change', () => {
    answerId = answer.value;
    save(answerId === 'follow' ? W.answeredFollow() : W.answered(languageName(answerId)));
  });
  draw();

  return h('section', { class: 'panel', 'aria-label': W.heading },
    h('p', { class: 'sub', text: W.intro }),
    screens,
    distances,
    h('div', { class: 'saving' },
      h('h3', { text: W.spokenLabel }), h('p', { class: 'sub', text: W.order }), list,
      h('div', { class: 'row' }, field(W.add, add), addButton),
      field(W.answerLabel, answer),
      note, error, hint));
}

/** "annai's screens in": the phone's, then each language by its own name; unfinished ones only while Experimental allows (a chosen one always shows). Also on the welcome's first step. @param {any} ctx @param {Record<string, any>} app */
export function screensRow(ctx, app) {
  const phone = navigator.languages ?? [];
  const chosen = chosenUi(app);
  const offered = [...SHIPPED, ...(app.experimental?.unfinishedTranslations === true ? EXPERIMENTAL : [])];
  if (chosen && !offered.includes(chosen) && EXPERIMENTAL.includes(chosen)) offered.push(chosen);
  const select = h('select', { id: 'language-ui' },
    h('option', { value: '', text: t`As this phone is set (${ownName(chooseTag(null, phone, SHIPPED).tag)})` }),
    ...offered.map((tag) => h('option', { value: tag, lang: tag, text: ownName(tag) })));
  select.value = offered.includes(chosen) ? chosen : '';
  const note = h('span', { class: 'saved', 'aria-live': 'polite' });
  const error = h('p', { class: 'error', 'aria-live': 'assertive', hidden: true });
  let shown = select.value;
  select.addEventListener('change', async () => {
    const pick = select.value;
    select.disabled = true;
    error.hidden = true;
    const next = chooseTag(pick || null, phone, offered, SHIPPED);
    const name = ownName(next.tag);
    const back = (/** @type {string} */ why) => { select.value = shown; select.disabled = false; note.textContent = ''; error.textContent = why; error.hidden = false; };
    if (next.tag !== 'en') {
      note.textContent = t`Getting ${name}…`;
      if (!(await keepWords(next.tag))) return back(t`annai couldn't get ${name}. It needs a connection once to get a language.`);
    }
    try {
      await updateAppSettings(ctx.ws, { languages: { ui: pick || null } });
    } catch (e) {
      return back(messageOf(e));
    }
    keepUiChoice(pick);
    shown = pick;
    // Already in it: nothing to restart into.
    if (document.documentElement.lang === (next.region ? `${next.tag}-${next.region}` : next.tag)) {
      select.disabled = false;
      note.textContent = t`Saved`;
      return;
    }
    note.textContent = t`Saved. Restarting…`;
    // Called off ("Don't restart"): the row works again, and the change waits for the next restart.
    if (!ctx.updates) location.reload();
    else if (!(await ctx.updates.restart())) {
      select.disabled = false;
      note.textContent = t`Saved. It applies the next time annai restarts.`;
    }
  });
  return h('div', { class: 'saving' }, field(t`annai's screens in`, select), note, error);
}

/** Distances (localization decision 4): Automatic (by region), Kilometres or Miles; used at once, told to Shiori at her next wake. @param {any} ctx @param {Record<string, any>} app */
function distancesRow(ctx, app) {
  const select = h('select', { id: 'language-distances' },
    h('option', { value: '', text: t`Automatic` }), h('option', { value: 'km', text: t`Kilometres` }), h('option', { value: 'mi', text: t`Miles` }));
  select.value = distancesOf(app) ?? '';
  // Its note is no status role: the languages' own is the section's one (as the screens' row).
  const note = h('span', { class: 'saved', 'aria-live': 'polite' });
  let kept = select.value;
  select.addEventListener('change', () => queueSave(async () => {
    const v = select.value;
    try {
      await updateAppSettings(ctx.ws, { languages: { distances: v || null } });
      setDistances(kept = v);
      note.textContent = t`Saved`;
    } catch (e) {
      select.value = kept;
      note.textContent = messageOf(e);
    }
  }));
  return h('div', { class: 'saving' }, field(t`Distances`, select), note);
}

/**
 * The start's cards: the words that failed to load, and a setting the device's copy disagrees with (the copy is then to be written, and
 * a restart offered if it would change the language shown). running: the page's tag; failed: the tag whose words couldn't load.
 * @param {{ settings: string, kept: string, running: string, failed?: string, phone?: readonly string[], offered?: readonly string[], shipped?: readonly string[], restart: () => unknown }} o
 */
export function screensCards({ settings, kept, running, failed, phone = navigator.languages ?? [], offered = [...SHIPPED, ...EXPERIMENTAL], shipped = SHIPPED, restart }) {
  /** @type {{ title: string, body: string, actions: { label: string, primary?: boolean, run: () => unknown }[] }[]} */
  const cards = [];
  if (failed) {
    const name = ownName(failed);
    cards.push({ title: t`${name} couldn't be loaded`, body: t`annai shows English until it is online.`, actions: [{ label: t`Try again`, run: restart }] });
  }
  if (settings === kept) return { copy: null, cards };
  const next = chooseTag(settings || null, phone, offered, shipped);
  if (next.tag !== running && !(failed && next.tag === failed)) {
    const name = ownName(next.tag);
    cards.push({
      title: t`Restart to show annai in ${name}`,
      body: t`Your settings say annai's screens are in ${name}, but this device is showing something else.`,
      actions: [{ label: t`Restart annai`, primary: true, run: restart }],
    });
  }
  return { copy: settings, cards };
}

/** At start: the device's copy written if the settings differ, and the cards, whether or not the settings can be read. @param {{ ws: any, notices: { card: (c: any) => unknown }, restart: () => unknown }} o */
export async function screensAtStart({ ws, notices, restart }) {
  const app = await readAppSettings(ws).catch(() => null);
  let kept = '';
  try { kept = localStorage.getItem('annai.ui') ?? ''; } catch { /* storage blocked */ }
  const got = screensCards({ settings: app ? chosenUi(app) : kept, kept, running: screensLang(), failed: document.documentElement.dataset.l10nFailed, restart });
  if (got.copy !== null) keepUiChoice(got.copy);
  for (const c of got.cards) notices.card(c);
}
