import { h, field, queueSave, messageOf } from './dom.js';
import { updateAppSettings } from '../core/settings.js';
import { LANGUAGES, LANGUAGE_WORDS as W, languageSettings, nativeName } from '../core/languages.js';

/** A language of ours by its id. @param {string} id */
const language = (id) => LANGUAGES.find((l) => l.id === id);
/** A language as a picker shows it: its name, then its own. @param {import('../core/languages.js').Language} l */
const optionText = (l) => W.option(l.name, nativeName(l));

/**
 * Settings → Shiori → Languages (phase 2): the languages you speak, in order, and the one Shiori answers in. Each change is saved at
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
  const hint = h('p', { class: 'sub' });
  const list = h('ol', { class: 'langs', 'aria-label': W.spokenLabel });
  const add = h('select', { id: 'language-add' });
  const addButton = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => pick() }, W.addButton);
  const answer = h('select', { id: 'language-answer' });

  /** Writes what is shown, after the writes queued before it; the last one written is the list as the user left it. @param {string} said */
  const save = (said) => {
    const mine = ++version;
    note.textContent = said;
    return queueSave(async () => {
      // What this write sends, taken before it waits: the screen goes on changing meanwhile, and is not what was kept. Until the user
      // has chosen a list, only the answer is saved: the browser's language shown is not their pick.
      const sent = { ids, chosen, answerId };
      try {
        await updateAppSettings(ctx.ws, { languages: sent.chosen ? { spoken: sent.ids, answer: sent.answerId } : { answer: sent.answerId } });
        stored = sent;
        error.hidden = true;
        if (mine === version) note.textContent = `${said}. ${W.saved}`;
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

  /** Shows the new list at once, then saves it. @param {string[]} next @param {string} said @param {{ id: string, act: string } | 'add'} [focus] where focus goes @param {string} [nextAnswer] */
  const change = (next, said, focus = 'add', nextAnswer = answerId) => {
    ids = next;
    chosen = true;
    answerId = nextAnswer;
    draw(focus);
    return save(said);
  };

  /** @param {{ id: string, act: string } | 'add'} [focus] */
  const draw = (focus) => {
    list.replaceChildren(...ids.map((id, i) => {
      const l = /** @type {import('../core/languages.js').Language} */ (language(id));
      const own = nativeName(l);
      const button = (/** @type {string} */ act, /** @type {string} */ label, /** @type {string} */ text, /** @type {() => unknown} */ run, disabled = false) =>
        h('button', { class: 'btn', type: 'button', 'aria-label': label, dataset: { lang: id, act }, disabled, onclick: run }, text);
      return h('li', { tabindex: '-1', dataset: { lang: id } },
        h('span', { class: 'lang-name' }, l.name, own !== l.name ? [' ', h('span', { class: 'sub', text: own })] : null, ' '),
        i ? button('up', W.moveUpLabel(l.name), W.moveUpText, () => change(swap(i - 1), W.moved(l.name, i), { id, act: i > 1 ? 'up' : 'down' })) : null,
        i < ids.length - 1 ? button('down', W.moveDownLabel(l.name), W.moveDownText, () => change(swap(i), W.moved(l.name, i + 2), { id, act: i + 1 < ids.length - 1 ? 'down' : 'up' })) : null,
        button('remove', W.removeLabel(l.name), W.remove, () => remove(id), ids.length < 2));
    }));
    hint.textContent = chosen ? W.spokenHint : `${W.empty} ${W.spokenHint}`;
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
      const to = buttons.find((b) => /** @type {HTMLElement} */ (b).dataset.act === focus.act) ?? buttons[0] ?? list.querySelector(`li[data-lang="${focus.id}"]`);
      /** @type {HTMLElement | null} */ (to)?.focus({ preventScroll: true });
    }
  };

  /** The list with the language at i and the one after it exchanged. @param {number} i */
  const swap = (i) => ids.map((x, k) => (k === i ? ids[i + 1] : k === i + 1 ? ids[i] : x));

  /** Removes a language; if it was the one Shiori answers in, she follows you again, in the same save. Focus goes to the next one's Remove, else the one before's. @param {string} id */
  const remove = (id) => {
    const at = ids.indexOf(id);
    const next = ids.filter((x) => x !== id);
    const name = /** @type {any} */ (language(id)).name;
    const resets = answerId === id;
    const near = next[Math.min(at, next.length - 1)];
    return change(next, resets ? W.removedAnswer(name) : W.removed(name), near ? { id: near, act: 'remove' } : 'add', resets ? 'follow' : answerId);
  };

  /** Adds the language picked, once Add is pressed: arrow keys in the list only choose. */
  const pick = () => {
    const l = language(add.value);
    if (l && !ids.includes(l.id)) change([...ids, l.id], W.added(l.name));
  };

  add.addEventListener('change', () => { addButton.disabled = !add.value; });
  answer.addEventListener('change', () => {
    answerId = answer.value;
    save(answerId === 'follow' ? W.answered(W.follow.toLowerCase()) : W.answered(/** @type {any} */ (language(answerId)).name));
  });
  draw();

  return h('section', { class: 'panel', 'aria-label': W.heading },
    h('h2', { class: 'section', text: W.heading }),
    h('p', { class: 'sub', text: W.intro }),
    h('div', { class: 'saving' },
      h('h3', { text: W.spokenLabel }), list,
      h('div', { class: 'row' }, field(W.add, add), addButton),
      field(W.answerLabel, answer),
      note, error, hint));
}
