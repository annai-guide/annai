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
 * @param {(value: string) => void} onChange
 */
export function radios(legend, options, value, onChange) {
  const name = `r-${Math.random().toString(36).slice(2)}`;
  return h('fieldset', { class: 'radios' }, h('legend', { text: legend }),
    ...options.map(([v, label]) => {
      const input = h('input', { type: 'radio', name, value: v, onchange: () => onChange(v) });
      input.checked = v === value;
      return h('label', { class: 'check' }, input, h('span', { text: label }));
    }));
}

/**
 * A destructive button that needs a second tap within four seconds.
 * @param {string} label @param {string} confirmLabel @param {() => Promise<void> | void} action
 */
export function twoStep(label, confirmLabel, action) {
  let armed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const btn = h('button', {
    class: 'btn danger', type: 'button',
    onclick: async () => {
      if (!armed) {
        armed = true;
        btn.textContent = confirmLabel;
        timer = setTimeout(() => { armed = false; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      try {
        await action();
      } finally {
        btn.disabled = false;
        armed = false;
        btn.textContent = label;
      }
    },
  }, label);
  return btn;
}

/**
 * A labelled JSON editor for a settings object. read() parses it, or throws in plain words.
 * @param {string} label @param {string} id @param {any} value
 */
export function jsonField(label, id, value) {
  const area = h('textarea', { id, rows: 4, spellcheck: 'false', autocapitalize: 'off', class: 'mono' });
  area.value = JSON.stringify(value ?? {}, null, 2);
  return {
    el: field(label, area),
    read() {
      const text = area.value.trim();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${label} isn't valid JSON.`);
      }
    },
  };
}
