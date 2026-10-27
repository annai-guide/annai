export { t, tc, plural, asUser } from '../core/l10n.js';
import { t, lang } from '../core/l10n.js';
import { parseNum } from '../core/intl.js';

/** A lang attribute for words in a language that may not be the screens' (a plugin's): the tag, else none. @param {string} [tag] */
export const otherLang = (tag) => (tag && tag !== lang() ? tag : undefined);

/**
 * Builds DOM without innerHTML (the CSP and spec §15 forbid it).
 * attrs: class (string | string[]), text (textContent), style (object → setProperty, never a style attribute),
 * dataset (object), on<event> (listener), value (property), true → empty attribute, false/null/undefined → skipped.
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children nodes, strings, numbers, arrays; null/false are skipped
 * @returns {any}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in el) /** @type {any} */ (el).value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/**
 * A back link ("← Settings"): its arrow a span of its own, hidden from screen readers (VoiceOver read "leftwards arrow"), and its
 * label a message, or a name (a trip's, a provider's) as text or an element. @param {string} href @param {string | Node} label
 */
export const crumb = (href, label) => h('a', { href }, h('span', { 'aria-hidden': 'true' }, '← '), label);

/**
 * Runs fn once node has left the page, such as a screen another replaced: its place is watched once it has
 * one, the frame after it is built. One never put on the page counts as gone then. @param {Node} node @param {() => void} fn
 */
export function whenGone(node, fn) {
  requestAnimationFrame(() => {
    const parent = node.parentNode;
    if (!parent) return fn();
    const seen = new MutationObserver(() => {
      if (node.isConnected) return;
      seen.disconnect();
      fn();
    });
    seen.observe(parent, { childList: true });
  });
}

/** A labelled control: <label class="field"><span>Label</span>control</label>. @param {string} label @param {HTMLElement} control */
export function field(label, control) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control);
}

/** @param {string} label @param {boolean} checked */
export function checkbox(label, checked) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  return { input, el: h('label', { class: 'check' }, input, h('span', { text: label })) };
}

/**
 * @param {string} legend
 * @param {[string, string][]} options [value, label]
 * @param {string} value
 * @param {(value: string) => void} [onChange]
 */
export function radios(legend, options, value, onChange = () => {}) {
  const name = `r-${Math.random().toString(36).slice(2)}`;
  return h('fieldset', { class: 'radios' }, h('legend', { text: legend }),
    ...options.map(([v, label]) => {
      const input = h('input', { type: 'radio', name, value: v, onchange: () => onChange(v) });
      input.checked = v === value;
      return h('label', { class: 'check' }, input, h('span', { text: label }));
    }));
}

/**
 * A destructive button that needs a second tap within eight seconds, the same everywhere; onArm: called at the first, to
 * say what goes. Both its words hold the same place, the one not shown hidden, so arming it never moves it: the second
 * tap lands where the first did (the emulator pass: a wider "Tap again to remove" wrapped onto the next line).
 * @param {string} label @param {string} confirmLabel @param {() => Promise<void> | void} action @param {() => unknown} [onArm]
 */
export function twoStep(label, confirmLabel, action, onArm) {
  let armed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const first = h('span', { text: label });
  const again = h('span', { class: 'off', text: confirmLabel });
  const arm = (/** @type {boolean} */ on) => {
    armed = on;
    first.classList.toggle('off', on);
    again.classList.toggle('off', !on);
  };
  const btn = h('button', {
    class: 'btn danger two-step', type: 'button',
    onclick: async () => {
      if (!armed) {
        arm(true);
        onArm?.();
        timer = setTimeout(() => arm(false), 8000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      try {
        await action();
      } finally {
        btn.disabled = false;
        arm(false);
      }
    },
  }, first, again);
  return btn;
}

/**
 * A labelled JSON editor for a settings object. read() parses it, or throws in plain words;
 * show() puts a value in it.
 * @param {string} label @param {string} id @param {any} value
 */
export function jsonField(label, id, value) {
  const area = h('textarea', { id, rows: 4, spellcheck: 'false', autocapitalize: 'off', class: 'mono' });
  const show = (/** @type {any} */ v) => { area.value = JSON.stringify(v ?? {}, null, 2); };
  show(value);
  return {
    el: field(label, area),
    area,
    show,
    read() {
      const text = area.value.trim();
      if (!text) return {};
      /** @type {any} */
      let v;
      try {
        v = JSON.parse(text);
      } catch {
        throw new Error(t`${label} isn't valid JSON.`);
      }
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(t`${label} has to be an object: { … }.`);
      return v;
    },
  };
}

/**
 * What went wrong, in plain words; for a ValidationError, without the path but with the key refused ("maxEdge must be at least 16");
 * for a plugin's error, without the plugin's id it starts with for the logs ("chat-completions: "). @param {any} e
 */
export function messageOf(e) {
  // The screens' words where an error carries them (shown), else its message or a schema's refusals (LESSONS 2026-10-27).
  if (typeof e?.shown === 'string') return e.shown;
  if (!Array.isArray(e?.errors)) {
    const m = String(e?.message ?? e);
    return typeof e?.pluginId === 'string' && m.startsWith(`${e.pluginId}: `) ? m.slice(e.pluginId.length + 2) : m;
  }
  return e.errors.map((/** @type {string} */ x) => {
    const m = /^\$([^:]*): (.*)$/s.exec(x);
    if (!m) return x;
    const key = m[1].split('.').pop();
    return key && /^(must|expected|does not|is required|is not allowed)/.test(m[2]) ? `${key} ${m[2]}` : m[2];
  }).join(' ');
}

/**
 * A message with its links where its words say them: each link's words are a value of the message, so every translation holds them;
 * a link the words don't hold comes after. @param {string} text @param {...HTMLElement} links @returns {(string | HTMLElement)[]}
 */
export function linkIn(text, ...links) {
  /** @type {(string | HTMLElement)[]} */
  const parts = [];
  /** @type {(string | HTMLElement)[]} */
  const rest = [];
  let from = 0;
  for (const { a, i } of links.map((a) => ({ a, i: text.indexOf(String(a.textContent)) })).sort((x, y) => x.i - y.i)) {
    if (i < from) rest.push(' ', a);
    else {
      parts.push(text.slice(from, i), a);
      from = i + String(a.textContent).length;
    }
  }
  return [...parts, text.slice(from), ...rest];
}

/**
 * The part of an error's words that is a developer's English (decision 11), "" when none: all of messageOf for a schema's refusals and
 * an error marked `en: true` (annai's own checks, EnglishError, a PluginError with no screen words); the part its `en` names, when
 * it is a string (the English inside a sentence in the screens' words). A provider's or a plugin's own words are never marked.
 * @param {any} e
 */
export function englishOf(e) {
  if (typeof e?.en === 'string') return e.en;
  return typeof e?.shown !== 'string' && (e?.en === true || Array.isArray(e?.errors)) ? messageOf(e) : '';
}

/**
 * text (made of messageOf(e) for each error) as parts, with each error's English in a span marked lang="en", where its words stand.
 * @param {string} text @param {...unknown} errors @returns {(string | HTMLElement)[]}
 */
export const englishIn = (text, ...errors) => linkIn(text, ...errors.map(englishOf).filter(Boolean).map((en) => h('span', { lang: 'en', text: en })));

/** Shows what went wrong (messageOf) in el, a developer's English marked lang="en". The next words shown there replace it. @param {HTMLElement} el @param {unknown} e */
export const showError = (el, e) => el.replaceChildren(...englishIn(messageOf(e), e));

/**
 * A field's number for autosave's read(): null when empty (unless needed), else lo to hi, whole when asked; anything else throws words.
 * @param {HTMLInputElement} input @param {number} lo @param {number} hi @param {string} words @param {{ whole?: boolean, need?: boolean }} [o]
 */
export function numberIn(input, lo, hi, words, { whole = false, need = false } = {}) {
  const text = input.value.trim();
  if (!text && !need && !input.validity?.badInput) return null;
  const n = parseNum(text);
  if (!text || !(n >= lo && n <= hi) || (whole && !Number.isInteger(n))) throw new Error(words);
  return n;
}

let saving = Promise.resolve();

/**
 * Runs a save after those waiting, so saves that read, change and write a setting lose nothing to
 * each other. Save buttons use it too; a save it runs never calls it (it would wait for itself).
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export function queueSave(fn) {
  const run = saving.then(fn, fn);
  saving = run.then(() => {}, () => {});
  return run;
}

/**
 * A Save button's work, with "Saving…" on its line from the tap until the save lands (a key can take seconds: a provider is asked to
 * delete what it keeps first, or the device is slow); the work may put its own words there (Saved), or an error elsewhere.
 * shown: what follows, out of the queue, before "Saving…" goes: the screen drawn again with the field saved, then the toast.
 * @template T @param {HTMLElement} note @param {() => Promise<T>} work @param {(result: T) => unknown} [shown] @returns {Promise<T>}
 */
export function savingNote(note, work, shown) {
  const saving = t`Saving…`;
  note.textContent = saving;
  return queueSave(work).then(async (r) => {
    await shown?.(r);
    return r;
  }).finally(() => { if (note.textContent === saving) note.textContent = ''; });
}

/** Resolves once the saves queued so far have landed: an action that reads settings (a Test) waits for what a field's change started, so it never runs on the old value. */
export const settled = () => queueSave(async () => {});

/**
 * A setting saved as it changes (spec §16.1): on `change`, so a text field saves once committed
 * or left, never per keystroke. read() throws in plain words for a value that isn't valid: nothing
 * is saved, and the words show by the field. A failed save says why and shows what is stored again.
 * Saved, a quiet "Saved" shows by it for a moment.
 * @param {HTMLElement} control an input, select, textarea or fieldset @param {() => any} read @param {(value: any) => unknown} save
 * @returns {HTMLElement[]} the note and the error, to put by the field
 */
export function autosave(control, read, save) {
  const note = h('span', { class: 'saved', role: 'status' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const say = (/** @type {unknown} */ e) => {
    showError(error, e);
    error.hidden = false;
  };
  /** @type {any[]} */
  const inputs = control.matches('input, select, textarea') ? [control] : [...control.querySelectorAll('input, select, textarea')];
  const ticks = (/** @type {any} */ x) => x.type === 'checkbox' || x.type === 'radio';
  const shown = () => inputs.map((x) => (ticks(x) ? x.checked : x.value));
  let stored = shown();
  const run = async () => {
    let value;
    try {
      value = read();
    } catch (e) {
      say(e);
      control.setAttribute('aria-invalid', 'true');
      return;
    }
    control.removeAttribute('aria-invalid');
    try {
      await save(value);
      error.hidden = true;
      stored = shown();
      note.textContent = t`Saved`;
      timer = setTimeout(() => { note.textContent = ''; }, 4000);
    } catch (e) {
      inputs.forEach((x, i) => { if (ticks(x)) x.checked = stored[i]; else x.value = stored[i]; });
      say(e);
    }
  };
  control.addEventListener('change', () => {
    clearTimeout(timer);
    note.textContent = '';
    queueSave(run);
  });
  return [note, error];
}

/** A labelled field that saves as it changes (autosave). @param {string} label @param {HTMLElement} control @param {() => any} read @param {(value: any) => unknown} save */
export function savedField(label, control, read, save) {
  return h('div', { class: 'saving' }, field(label, control), ...autosave(control, read, save));
}

/** A checkbox that saves as it changes. @param {string} label @param {boolean} checked @param {(on: boolean) => unknown} save */
export function savedCheck(label, checked, save) {
  const c = checkbox(label, checked);
  return { input: c.input, el: h('div', { class: 'saving' }, c.el, ...autosave(c.input, () => c.input.checked, save)) };
}

/** Radios that save as they change. @param {string} legend @param {[string, string][]} options @param {string} value @param {(value: string) => unknown} save */
export function savedRadios(legend, options, value, save) {
  const set = radios(legend, options, value);
  return h('div', { class: 'saving' }, set, ...autosave(set, () => /** @type {HTMLInputElement} */ (set.querySelector('input:checked')).value, save));
}
