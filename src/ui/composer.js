import { h, t, tc, plural, messageOf, asUser } from './dom.js';
import { num } from '../core/intl.js';
import { keepFiles } from './bring-in.js';
import { SYS_WAITING, ME, newId } from '../core/scopes.js';
import { FILES_ONLY } from '../core/handover.js';
import { updateAppSettings, readAppSettings } from '../core/settings.js';
import { speaksScreens } from './format.js';

/**
 * The type box's attachments (the bookings-and-trips design, goal 1): a + picks photos or files, and a pasted confirmation email
 * becomes a file, each a chip above the box; sending hands them to Shiori with the words, if any (a hand-over, handover.js). Ask
 * Shiori about this puts a file kept already in the box the same way.
 * @typedef {{ file: Blob & { name?: string }, pasted?: string } | { scope: string, path: string, name?: string }} Attachment  a file handed now
 *   (pasted: the text a paste became), or one kept already (name: what its chip and Shiori call it, a booking's title or a file's short
 *   name; else its own name)
 * @typedef {import('../core/handover.js').HandedFile} HandedFile
 */

/** What the + picks: photos, PDFs, Wallet passes, texts, emails and calendar files. */
const ACCEPT = 'image/*,application/pdf,.pdf,.pkpass,application/vnd.apple.pkpass,text/plain,.txt,.eml,.ics,text/calendar';
/** A paste longer than this, or of this many lines, is a confirmation to hand over, not words to type. */
const PASTE_MAX = 280;
const PASTE_LINES = 4;

/**
 * Whether pasted text is a confirmation to hand over (over 280 characters, or 4 lines or more), not words to type (My call 6; the user,
 * 2026-10-29: "Long pastes only, plus undo"). @param {string} text
 */
export const pasteBecomesFile = (text) => [...text].length > PASTE_MAX || text.trim().split(/\r\n|\r|\n/).length >= PASTE_LINES;

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
const nameOf = (a) => ('file' in a ? String(a.file.name ?? '') : a.name || (a.path.split('/').pop() ?? a.path));

/**
 * Hands Shiori what is in the box: the new files are kept first (in the open trip's Files, or waiting with Shiori when none is open), one
 * at a time, saying how far it is, then the message goes with them all, and the Conversation shows it. A file that can't be kept (no
 * room) stops the rest: what was kept goes, and a card says what wasn't. A file kept already goes only to its own conversation's Shiori.
 * @param {any} ctx @param {string} text @param {Attachment[]} items
 * @param {{ progress?: (done: number, total: number) => void }} [o] progress: kept so far, of how many
 */
export async function handOver(ctx, text, items, o = {}) {
  const scope = ctx.agent.target ?? SYS_WAITING;
  /** @type {HandedFile[]} */
  const handed = [];
  const files = items.flatMap((a) => ('file' in a ? [a.file] : []));
  /** @type {{ path: string, name: string, planned: number }[]} */
  const kept = [];
  for (const [i, file] of files.entries()) {
    o.progress?.(i, files.length);
    try {
      const { paths, notes, problems, plannedBy } = await keepFiles(ctx, scope, [file]);
      for (const note of notes) ctx.notices.card({ tone: 'warn', title: t`A photo was kept as it is`, body: note });
      for (const problem of problems) ctx.notices.card({ tone: 'warn', title: t`A calendar file couldn't be read`, body: problem });
      for (const p of paths) kept.push({ path: p, name: file.name || p.split('/').pop() || p, planned: plannedBy[p] ?? 0 });
    } catch (e) {
      const left = files.length - i;
      ctx.notices.card({ tone: 'warn', title: plural(left, "# file wasn't kept", "# files weren't kept"), body: messageOf(e) });
      break;
    }
  }
  o.progress?.(files.length, files.length);
  const types = new Map((await ctx.ws.list(scope, '/files/')).map((/** @type {any} */ f) => [f.path, f.type]));
  for (const k of kept) handed.push({ path: shownPath(scope, k.path), type: types.get(k.path) ?? 'application/octet-stream', name: k.name, new: true, ...(k.planned ? { planned: k.planned } : {}) });
  for (const a of items) {
    if ('file' in a || a.scope !== scope) continue;
    const entry = await ctx.store.tx(['files'], 'readonly', (/** @type {any} */ x) => x.getFile(a.scope, a.path));
    handed.push(handedOf(a, { type: entry?.type ?? 'application/octet-stream', name: nameOf(a) }));
  }
  if (!text.trim() && !handed.length) return;
  const handover = handed.length ? { handed, handover: newId('h') } : {};
  // Another conversation was opened while the files were kept: the message goes to the one they were kept for, written into it, and
  // answered when it opens.
  if ((ctx.agent.target ?? SYS_WAITING) !== scope) {
    await ctx.agent.wake({ kind: 'user', text: text.trim() || FILES_ONLY, ...handover, scope: scope === SYS_WAITING ? ME : scope });
    return;
  }
  ctx.agent.send(text, handover);
  if (!location.hash.startsWith('#/talk')) ctx.go('#/talk');
}

/**
 * The box's chips and its +. A chip shows the file's name and a real Remove button; under the chips, each suggestion (Read it again) is a
 * button that sends its words with them at once; typing hides them (what is typed is sent instead).
 * @param {any} ctx @param {{ onChange?: () => void, onPutBack?: (text: string) => void, onSuggest?: (text: string) => void }} [o] onChange: the
 *   chips changed; onPutBack: a pasted text's chip was turned back into words, for the box; onSuggest: a suggestion was tapped
 */
export function createComposer(ctx, o = {}) {
  /** @type {Attachment[]} */
  let list = [];
  /** @type {string[]} */
  let suggestions = [];
  let keeping = false;
  const status = h('p', { class: 'keeping', role: 'status' });
  const chips = h('span', { class: 'chip-list' });
  const offers = h('span', { class: 'suggestions' });
  const el = h('div', { class: 'chips', hidden: true }, chips, offers, status);
  let typed = false;
  /** @param {number} i */
  const drop = (i) => {
    list = list.filter((_, j) => j !== i);
    if (!list.length) suggestions = [];
    draw();
    o.onChange?.();
  };
  const draw = () => {
    el.hidden = !list.length;
    offers.replaceChildren(...(typed || keeping ? [] : suggestions).map((words) => h('button', { class: 'btn suggestion', type: 'button', onclick: () => o.onSuggest?.(words) }, words)));
    chips.replaceChildren(...list.map((a, i) => {
      const name = nameOf(a);
      const pasted = 'file' in a && typeof a.pasted === 'string' ? a.pasted : null;
      return h('span', { class: 'attach-chip' },
        h('span', { class: 'attach-name', dir: 'auto', text: name }),
        // A paste that became a file can be words again (the user, 2026-10-29: "plus undo").
        pasted !== null ? h('button', { class: 'attach-back', type: 'button', disabled: keeping, onclick: () => { drop(i); o.onPutBack?.(pasted); } }, t`Put back as text`) : null,
        h('button', { class: 'attach-remove', type: 'button', disabled: keeping, 'aria-label': tc('a file in the message')`Remove ${name}`, title: tc('a file in the message')`Remove ${name}`, onclick: () => drop(i) },
          h('span', { 'aria-hidden': 'true', text: '×' })));
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
  // A file kept already belongs to its conversation: opening another lets go of its chip, so it is never asked about in the wrong one.
  const offOpen = ctx.agent.on?.('open', () => {
    const here = ctx.agent.target ?? SYS_WAITING;
    const before = list.length;
    list = list.filter((a) => 'file' in a || a.scope === here);
    if (list.length !== before) {
      draw();
      o.onChange?.();
    }
  });
  return {
    el, plus, attach,
    items: () => [...list],
    suggestions: () => [...suggestions],
    /** Words in the box hide the suggestions, and none show them again. @param {boolean} words */
    typing(words) {
      if (typed === words) return;
      typed = words;
      draw();
    },
    clear() {
      list = [];
      suggestions = [];
      typed = false;
      status.textContent = '';
      draw();
    },
    /** While the files are being kept: the chips stay, can't be removed, and say how far it is. @param {number | null} done @param {number} [total] */
    keeping(done, total = 0) {
      keeping = done !== null;
      input.disabled = keeping;
      status.textContent = keeping && total ? t`Keeping ${num(Math.min(/** @type {number} */ (done) + 1, total))} of ${num(total)}…` : '';
      draw();
    },
    /**
     * A paste into an empty box: a long one (a confirmation email) becomes a file chip, its text not typed (My call 6); anything else is
     * typed. @param {ClipboardEvent} e @param {boolean} empty the box holds no words @returns {boolean} whether it was taken
     */
    paste(e, empty) {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text || !empty || !pasteBecomesFile(text)) return false;
      e.preventDefault();
      attach([{ file: new File([text], pastedName(Date.now()), { type: 'text/plain' }), pasted: text }]);
      return true;
    },
    dispose: () => offOpen?.(),
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

/**
 * Ask Shiori about this (goal 7), on a booking's or a plan item's details and on a file in a trip's Files: the thing as a chip in the
 * box, with Read it again under it, in the user's words (the language they speak, as other words sent for them). Null where annai's
 * own dock isn't there to ask in. @param {any} ctx @param {{ scope: string, path: string, name?: string }} ref
 * @returns {HTMLElement | null}
 */
export function askAboutButton(ctx, ref) {
  if (!canAsk(ctx)) return null;
  return h('button', {
    class: 'btn', type: 'button',
    onclick: async () => askAbout(ctx, ref, { suggestions: [asUser(speaksScreens(await readAppSettings(ctx.ws)))`Read it again`] }),
  }, t`Ask Shiori about this`);
}
