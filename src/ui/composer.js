import { h, t, tc, messageOf } from './dom.js';
import { keepFiles } from './bring-in.js';
import { SYS_WAITING, newId } from '../core/scopes.js';
import { updateAppSettings } from '../core/settings.js';

/**
 * The type box's attachments (the bookings-and-trips design, goal 1): a + picks photos or files, and a pasted confirmation email
 * becomes a file, each a chip above the box; sending hands them to Shiori with the words, if any (a hand-over, handover.js). Ask
 * Shiori about this puts a file kept already in the box the same way.
 * @typedef {{ file: Blob & { name?: string } } | { scope: string, path: string }} Attachment  a file handed now, or one kept already
 * @typedef {import('../core/handover.js').HandedFile} HandedFile
 */

/** What the + picks: photos, PDFs, Wallet passes, texts, emails and calendar files. */
const ACCEPT = 'image/*,application/pdf,.pdf,.pkpass,application/vnd.apple.pkpass,text/plain,.txt,.eml,.ics,text/calendar';
/** A paste longer than this is a confirmation to hand over, not a sentence to type. */
const PASTE_MAX = 280;

/** Whether pasted text is a confirmation to hand over (a line break, or past 280 characters), not words to type (My call 6). @param {string} text */
export const pasteBecomesFile = (text) => /[\r\n]/.test(text.trim()) || [...text].length > PASTE_MAX;

/** A pasted text's file name: when it was pasted, in the phone's time (pasted-2026-10-28-0310.txt). @param {number} ms */
export function pastedName(ms) {
  const d = new Date(ms);
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `pasted-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.txt`;
}

/** A path in a scope as Shiori sees it: the waiting space's under /waiting/, a trip's under /trip/. @param {string} scope @param {string} path */
export const shownPath = (scope, path) => `${scope === SYS_WAITING ? '/waiting' : '/trip'}${path}`;

/** A file kept already, as Shiori is told of it (a reference). @param {{ scope: string, path: string }} ref @param {{ type: string, name: string }} o @returns {HandedFile} */
export const handedOf = (ref, o) => ({ path: shownPath(ref.scope, ref.path), type: o.type, name: o.name, new: false });

/** An attachment's own name, for its chip. @param {Attachment} a */
const nameOf = (a) => ('file' in a ? String(a.file.name ?? '') : a.path.split('/').pop() ?? a.path);

/**
 * Hands Shiori what is in the box: the new files are kept first (in the open trip's Files, or waiting with Shiori when none is open), one
 * at a time, then the message goes with them all, and the Conversation shows it.
 * @param {any} ctx @param {string} text @param {Attachment[]} items
 */
export async function handOver(ctx, text, items) {
  const scope = ctx.agent.target ?? SYS_WAITING;
  /** @type {HandedFile[]} */
  const handed = [];
  const files = items.flatMap((a) => ('file' in a ? [a.file] : []));
  if (files.length) {
    const { paths, notes, problems } = await keepFiles(ctx, scope, files);
    for (const note of notes) ctx.notices.card({ tone: 'warn', title: t`A photo was kept as it is`, body: note });
    for (const problem of problems) ctx.notices.card({ tone: 'warn', title: t`A calendar file couldn't be read`, body: problem });
    const kept = new Map((await ctx.ws.list(scope, '/files/')).map((/** @type {any} */ f) => [f.path, f.type]));
    paths.forEach((p, i) => handed.push({ path: shownPath(scope, p), type: kept.get(p) ?? 'application/octet-stream', name: files[i]?.name || p.split('/').pop() || p, new: true }));
  }
  for (const a of items) {
    if ('file' in a) continue;
    const entry = await ctx.store.tx(['files'], 'readonly', (/** @type {any} */ x) => x.getFile(a.scope, a.path));
    handed.push(handedOf(a, { type: entry?.type ?? 'application/octet-stream', name: a.path.split('/').pop() ?? a.path }));
  }
  ctx.agent.send(text, handed.length ? { handed, handover: newId('h') } : {});
  if (!location.hash.startsWith('#/talk')) ctx.go('#/talk');
}

/**
 * The box's chips and its +. A chip shows the file's own name and a real Remove button; suggestions (Read it again) are kept with the
 * chips for whoever draws them.
 * @param {any} ctx @param {{ onChange?: () => void }} [o] onChange: the chips changed
 */
export function createComposer(ctx, o = {}) {
  /** @type {Attachment[]} */
  let list = [];
  /** @type {string[]} */
  let suggestions = [];
  const el = h('div', { class: 'chips', hidden: true });
  const draw = () => {
    el.hidden = !list.length;
    el.replaceChildren(...list.map((a, i) => {
      const name = nameOf(a);
      return h('span', { class: 'attach-chip' },
        h('span', { class: 'attach-name', dir: 'auto', text: name }),
        h('button', { class: 'attach-remove', type: 'button', 'aria-label': tc('a file in the message')`Remove ${name}`, title: tc('a file in the message')`Remove ${name}`, onclick: () => {
          list = list.filter((_, j) => j !== i);
          if (!list.length) suggestions = [];
          draw();
          o.onChange?.();
        } }, h('span', { 'aria-hidden': 'true', text: '×' })));
    }));
  };
  const input = h('input', { id: 'dock-attach', type: 'file', multiple: true, accept: ACCEPT, class: 'visually-hidden' });
  input.addEventListener('change', () => {
    const picked = [...(input.files ?? [])];
    input.value = '';
    if (picked.length) attach(picked.map((file) => ({ file })));
  });
  const plus = h('span', { class: 'attach' },
    h('label', { class: 'attach-plus', for: 'dock-attach', 'aria-label': t`Give Shiori photos or files`, title: t`Give Shiori photos or files` }, h('span', { 'aria-hidden': 'true', text: '+' })), input);
  /** @param {Attachment[]} items @param {{ suggestions?: string[] }} [x] */
  const attach = (items, x = {}) => {
    list = [...list, ...items];
    if (x.suggestions) suggestions = x.suggestions;
    draw();
    o.onChange?.();
  };
  return {
    el, plus, attach,
    items: () => [...list],
    suggestions: () => [...suggestions],
    clear() {
      list = [];
      suggestions = [];
      draw();
    },
    /**
     * A paste: a confirmation email becomes a file chip, its text not typed (My call 6). @param {ClipboardEvent} e
     * @returns {boolean} whether it was taken
     */
    paste(e) {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text || !pasteBecomesFile(text)) return false;
      e.preventDefault();
      attach([{ file: new File([text], pastedName(Date.now()), { type: 'text/plain' }) }]);
      return true;
    },
  };
}

/** Whether annai's own dock is there to ask Shiori in (a plugin's dock has no box with chips, so no button asks). @param {any} ctx */
export const canAsk = (ctx) => typeof ctx.dock?.attach === 'function';

/**
 * Ask Shiori about this (goal 7): the file goes in the box as a chip, the box opens, and the Conversation shows. A trip's file opens
 * that trip first; a file waiting with Shiori is asked about with no trip open, where she sees it.
 * @param {any} ctx @param {{ scope: string, path: string }} ref @param {{ suggestions?: string[] }} [o]
 */
export async function askAbout(ctx, ref, o = {}) {
  const want = ref.scope === SYS_WAITING ? null : ref.scope;
  if (ctx.agent.target !== want) {
    await updateAppSettings(ctx.ws, { activeTrip: want });
    await ctx.agent.open(want).catch((/** @type {unknown} */ e) => ctx.notices.card({ tone: 'warn', title: t`That conversation didn't open`, body: messageOf(e) }));
  }
  ctx.dock.attach([ref], o);
  ctx.dock.openTyping();
  ctx.go('#/talk');
}
