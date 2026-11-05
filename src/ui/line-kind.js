import { t } from '../core/l10n.js';
import { PHOTO_ONLY } from '../core/agent/loop.js';
import { FILES_ONLY } from '../core/handover.js';

/**
 * @typedef {{ name?: string, first?: string | null, tried?: boolean } | null | undefined} By
 * @typedef {{ kind: string, tint: '' | 'blue' | 'teal' | 'violet' | 'amber', icon: '' | keyof typeof ICONS, label: string }} Line
 *   kind: which row of the table in the second-drive design; tint: its colour, which only assists: label always says it in words
 */

/** The model that wrote a line, in words: "" for a line stored with none (`by: null`). @param {By} b */
export function modelWords(b) {
  if (!b?.name) return '';
  if (!b.first || b.first === b.name) return b.name;
  return b.tried ? t`${b.name} · ${b.first} didn't answer` : t`${b.name} · instead of ${b.first}`;
}

/** A reminder annai showed that is really Kokoro's words: answer, or the title an older entry stored. @param {any} d the event's data */
export const kokorosWords = (d) => d.answer === true || d.title === /* en */ "Shiori's answer";

/**
 * What a line of the Conversation is, and what it says of itself (the second-drive design, section 1): the one place that decides, from
 * fields the events already carry, so an old conversation draws correctly too. Null: not one of these lines.
 * @param {{ type: string, data?: any }} e the event, with its stored words in its data
 * @returns {Line | null}
 */
export function lineKind(e) {
  const d = e.data ?? {};
  /** @type {(kind: string, tint: Line['tint'], icon: Line['icon'], label: string) => Line} */
  const line = (kind, tint, icon, label) => ({ kind, tint, icon, label });
  if (e.type === 'msg.user') {
    if (d.claim) return line('spoken', 'blue', 'mic', t`spoken`);
    if (d.chose) return line('tapped', '', '', t`tapped`);
    // Only a photo, or only files handed over: nothing was typed, so nothing says it was.
    return d.text === PHOTO_ONLY || d.text === FILES_ONLY ? line('sent', '', '', '') : line('typed', '', 'keyboard', t`typed`);
  }
  if (e.type === 'heard') {
    // Dismissed first: it is a quiet line with or without words. In a live session it means only that the model said nothing: no one judged the words.
    if (d.dismissed) return d.source === 'live' ? line('unanswered', '', 'ear', t`heard · she didn't answer`) : line('judged', '', 'ear', t`heard · judged not for her`);
    // The words may come later, or never (a clip kept, not yet written down): the label is true in both.
    if (typeof d.text !== 'string') return line('hearing', '', 'mic', t`spoken · no words yet`);
    const words = d.source === 'dictation' ? t`spoken · phone dictation` : d.source === 'live' ? t`spoken · live voice` : t`spoken`;
    return line('spoken', 'blue', 'mic', words);
  }
  if (e.type === 'out.speak' || e.type === 'out.show' || e.type === 'out.ask') {
    const model = modelWords(d.by);
    if (d.live) return line('koe-live', 'teal', 'wave', model ? t`Koe · live · ${model}` : t`Koe · live`);
    if (d.half === 'koe' && d.voice) return line('koe-aloud', 'blue', 'wave', model ? t`Koe · said aloud · ${model}` : t`Koe · said aloud`);
    if (d.half === 'koe') return line('koe-text', '', 'text', model ? t`Koe · text · ${model}` : t`Koe · text`);
    if (d.half === 'kokoro') return line('kokoro', 'violet', d.voice ? 'wave' : 'text', model ? t`Kokoro directly · ${model}` : t`Kokoro directly`);
    // One half: its model, as now; a line it said aloud keeps saying so, as Settings → Voice promises.
    if (d.voice) return line('one', '', '', model ? t`said aloud · ${model}` : t`said aloud`);
    return line('one', '', '', model);
  }
  if (e.type === 'reminder') {
    if (kokorosWords(d)) return line('kokoros-words', 'violet', '', d.aloud ? t`Kokoro's words · said aloud` : t`Kokoro's words · shown`);
    return line('reminder', 'amber', '', d.aloud ? t`annai · said aloud` : t`annai · shown`);
  }
  return null;
}

/** The chosen icons' shapes, on a 16 px grid, drawn in the text colour. */
const ICONS = {
  keyboard: /* en */ 'M3 4h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 12H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 4zM4 7h.01M7 7h.01M10 7h.01M12.5 7h.01M5 9.8h6',
  mic: /* en */ 'M5.8 3.7a2.2 2.2 0 0 1 4.4 0v3.6a2.2 2.2 0 0 1-4.4 0zM3.3 7.5a4.7 4.7 0 0 0 9.4 0M8 12.2v2.3',
  wave: /* en */ 'M2 6.5v3M5 4v8M8 2.2v11.6M11 4.5v7M14 6.5v3',
  text: /* en */ 'M3 4h10M3 8h10M3 12h6',
  ear: /* en */ 'M4 6.5a4 4 0 1 1 7.2 2.4c-.8 1-1.7 1.5-1.9 2.6-.2 1.3-1.1 2.3-2.4 2.3M6.5 6.5a1.5 1.5 0 1 1 3 0',
};

const SVG = 'http://www.w3.org/2000/svg';

/** A line's class: what it is, and its tint. @param {Line} line @param {string} own the classes it has anyway */
export const lineClass = (line, own) => [own, `line-${line.kind}`, line.tint ? `tint-${line.tint}` : ''].filter(Boolean).join(' ');

/** The label under a line's words: its icon and its words; null with nothing to say. @param {Line} line @returns {HTMLElement | null} */
export function lineLabel(line) {
  if (!line.label) return null;
  const el = document.createElement('span');
  el.className = 'line-label';
  if (line.icon) {
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', ICONS[line.icon]);
    svg.append(path);
    el.append(svg);
  }
  const words = document.createElement('span');
  words.textContent = line.label;
  el.append(words);
  return el;
}
