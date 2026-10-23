import { h, field, savedField, queueSave, messageOf } from './dom.js';
import { updateAppSettings } from '../core/settings.js';
import { LANGUAGES, LANGUAGE_WORDS as W, languageSettings, nativeName } from '../core/languages.js';

/**
 * Settings → Shiori → Languages (phase 2): the languages you speak, in order, and the one Shiori answers in. Each change is saved at
 * once, in the app settings (so backups carry it), and every model that hears or speaks is told at its next session or wake.
 * @param {any} ctx @param {Record<string, any>} app the app settings
 */
export function languagesSection(ctx, app) {
  const first = languageSettings(app, navigator.language);
  let ids = first.spoken.map((l) => l.id);
  const name = (/** @type {string} */ id) => LANGUAGES.find((l) => l.id === id)?.name ?? id;
  const own = (/** @type {string} */ id) => { const l = LANGUAGES.find((x) => x.id === id); return l && nativeName(l) !== l.name ? nativeName(l) : ''; };
  const note = h('span', { class: 'saved', role: 'status' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const list = h('ol', { class: 'langs', 'aria-label': W.spokenLabel });
  const add = h('select', { id: 'language-add' });
  /** Saves the list as shown (the first change turns the browser's default into a list of the user's own). @param {string[]} next */
  const save = (next) => queueSave(async () => {
    try {
      await updateAppSettings(ctx.ws, { languages: { spoken: next } });
      ids = next;
      error.hidden = true;
      note.textContent = 'Saved';
      draw();
    } catch (e) {
      error.textContent = messageOf(e);
      error.hidden = false;
    }
  });
  const draw = () => {
    list.replaceChildren(...ids.map((id, i) => h('li', {},
      h('span', { class: 'lang-name' }, `${i + 1}. ${name(id)} `, h('span', { class: 'sub', text: own(id) })),
      i ? h('button', { class: 'btn', type: 'button', 'aria-label': W.up(name(id)), onclick: () => save(ids.map((x, k) => (k === i - 1 ? id : k === i ? ids[i - 1] : x))) }, '↑') : null,
      h('button', { class: 'btn', type: 'button', 'aria-label': W.remove(name(id)), disabled: ids.length < 2, onclick: () => save(ids.filter((x) => x !== id)) }, 'Remove'))));
    add.replaceChildren(h('option', { value: '', text: W.add }), ...LANGUAGES.filter((l) => !ids.includes(l.id)).map((l) => h('option', { value: l.id, text: `${l.name} · ${nativeName(l)}` })));
  };
  draw();
  add.addEventListener('change', () => {
    if (add.value) save([...ids, add.value]);
  });
  const answer = h('select', { id: 'language-answer' }, h('option', { value: 'follow', text: W.follow }), ...LANGUAGES.map((l) => h('option', { value: l.id, text: l.name })));
  answer.value = first.answer?.id ?? 'follow';
  return h('section', { class: 'panel', 'aria-label': W.heading },
    h('h2', { class: 'section', text: W.heading }),
    h('p', { class: 'sub', text: W.intro }),
    h('div', { class: 'saving' }, h('h3', { text: W.spokenLabel }), list, field(W.add, add), note, error,
      h('p', { class: 'sub', text: first.explicit ? W.spokenHint : `${W.empty} ${W.spokenHint}` })),
    savedField(W.answerLabel, answer, () => answer.value, (v) => updateAppSettings(ctx.ws, { languages: { answer: v } })));
}
