import { h, t, messageOf } from './dom.js';
import { createAvatar } from './avatar.js';
import { addFiles } from './add-files.js';
import { voiceChip } from './voice-chip.js';
import { liveChip } from './live-chip.js';
import { readAppSettings } from '../core/settings.js';
import { shownSettings } from '../core/shown.js';
import { wording, mark } from './format.js';
import { SYS_SETTINGS } from '../core/scopes.js';
import { storedTexts } from '../core/agent/log.js';
import { component, mount, cleanUp, slotEntries, runAction, made } from './slots.js';
import { onTap } from './dock-hides.js';
import { createComposer, handOver } from './composer.js';

/** How long her last words stay in the bubble once she has stopped, to read them. */
const CAPTION_LINGER_MS = 2500;
const SVG = 'http://www.w3.org/2000/svg';
/** A line icon the dock's buttons show, drawn in the text colour. @param {string} d @param {string} [extra] the shapes beyond the path */
function icon(d, extra = '') {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ib-svg' })) svg.setAttribute(k, v);
  for (const part of [d, extra].filter(Boolean)) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', part);
    svg.append(path);
  }
  return svg;
}
/** A camera, and a keyboard: what the side buttons do, at a glance (the user, 2026-10-18). */
const cameraIcon = () => icon(/* en */ 'M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', /* en */ 'M12 9.8a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8z');
const keyboardIcon = () => icon(/* en */ 'M4 6.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16V8A1.5 1.5 0 0 1 4 6.5z', /* en */ 'M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 13.5h.01M17 13.5h.01M9.5 13.8h5');

/**
 * The dock at the bottom of every screen (spec §16.2): camera · Shiori · type. Tapping Shiori stops
 * her while she works or speaks (§6.7, §10.4), and starts listening while she rests with voice on; with voice off it opens typing.
 * dispose() lets go of everything it listens to, for a dock made again (minors 13).
 * @param {any} ctx
 */
export function createDock(ctx) {
  const avatar = dockAvatar(ctx);
  const label = h('span', { class: 'talk-label', text: ctx.agent.state.label });
  // A smart text box (the user, 2026-10-23): there only while it is needed. The keyboard button opens it and, tapped again, closes it;
  // sending closes it; Escape closes it; a tap elsewhere closes it while it is empty. A single line, so the keyboard's own key sends.
  const input = h('input', { id: 'dock-text', type: 'text', 'aria-label': t`Message to Shiori`, enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'sentences' });
  // Chinese and Japanese are typed through an IME, whose Enter picks a candidate: it never sends the half-composed text. Chrome and Firefox
  // say isComposing on that keydown; Safari ends the composition first and sends the Enter with keyCode 229. Some Android keyboards send
  // every Enter as 229: one with no composition just ended sends. A composition the box loses (blur, closed) holds nothing back after.
  let composing = false;
  let endedAt = -Infinity;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', (e) => {
    composing = false;
    endedAt = e.timeStamp;
  });
  input.addEventListener('blur', () => { composing = false; });
  input.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Enter' && (e.isComposing || composing || (e.keyCode === 229 && e.timeStamp - endedAt < 100))) e.preventDefault();
  });
  const sendArrow = h('button', { class: 'send-arrow', type: 'submit', 'aria-label': t`Send`, title: t`Send` }, icon(/* en */ 'M12 19V6M6.5 11.5L12 6l5.5 5.5'));
  // The + inside the box, before the words, and the chips of what it picked (the bookings-and-trips design, goal 1): sent with the
  // words, or alone. A long paste into an empty box (a confirmation email) becomes a chip too, which can be put back as words.
  const composer = createComposer(ctx, {
    onChange: () => ctx.agent.typing?.(Boolean(input.value.trim() || composer.items().length)),
    onPutBack: (/** @type {string} */ pasted) => {
      // The box is one line: the paste's lines become words with spaces between, never glued together.
      const words = pasted.trim().replace(/\s*[\r\n]+\s*/g, ' ');
      input.value = input.value.trim() ? `${input.value} ${words}` : words;
      input.focus();
      ctx.agent.typing?.(true);
    },
    // Read it again: its words go at once, with the chips (goal 7).
    onSuggest: (/** @type {string} */ words) => {
      input.value = words;
      sheet.requestSubmit();
    },
  });
  input.addEventListener('paste', (/** @type {ClipboardEvent} */ e) => { composer.paste(e, !input.value.trim()); });
  /** The files being kept: the box stays, saying how far it is, until they are all in (the user, 2026-10-29: "Show progress"). */
  let keepingNow = false;
  const sheet = h('form', {
    class: 'type-sheet', hidden: true,
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      if (composing || keepingNow) return; // an IME's candidate is not yet text to send; files being kept are sent once kept
      const text = input.value.trim();
      const items = composer.items();
      if (!text && !items.length) return;
      const done = () => {
        input.value = '';
        composer.clear();
        closeTyping();
        typeButton.focus(); // not left in the hidden box
      };
      if (!items.some((a) => 'file' in a)) {
        done();
        if (items.length) return void handOver(ctx, text, items).catch((/** @type {unknown} */ x) => ctx.notices.card({ tone: 'warn', title: t`Your files didn't reach Shiori`, body: messageOf(x) }));
        ctx.agent.send(text);
        if (!location.hash.startsWith('#/talk')) ctx.go('#/talk');
        return;
      }
      keepingNow = true;
      input.readOnly = true;
      composer.keeping(0, items.filter((a) => 'file' in a).length);
      handOver(ctx, text, items, { progress: (n, total) => composer.keeping(n, total) })
        .catch((/** @type {unknown} */ x) => ctx.notices.card({ tone: 'warn', title: t`Your files didn't reach Shiori`, body: messageOf(x) }))
        .finally(() => {
          keepingNow = false;
          input.readOnly = false;
          composer.keeping(null);
          done();
        });
    },
  }, composer.el, h('div', { class: 'type-box' }, composer.plus, input, sendArrow));
  const typeButton = h('button', { class: 'ib', type: 'button', 'aria-label': t`Type`, 'aria-expanded': 'false', title: t`Type`, onclick: () => (sheet.hidden ? openTyping() : closeTyping()) }, keyboardIcon());
  /** A tap elsewhere on the page (onTap: never at its press): an empty box closes; one with a draft stays. @param {EventTarget | null} at */
  const elsewhere = (at) => {
    const node = /** @type {Node} */ (at);
    if (!input.value.trim() && !composer.items().length && !sheet.contains(node) && !typeButton.contains(node)) closeTyping();
  };
  /** @type {(() => void) | undefined} */
  let offTap;
  const closeTyping = () => {
    sheet.hidden = true;
    composing = false;
    typeButton.setAttribute('aria-expanded', 'false');
    offTap?.();
    ctx.agent.typing?.(false);
  };
  // While the box holds text, a turn of the user's waits for them (spec §6.1, item 16).
  input.addEventListener('input', () => {
    ctx.agent.typing?.(Boolean(input.value.trim()));
    composer.typing(Boolean(input.value.trim()));
  });
  sheet.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Escape') return;
    closeTyping();
    typeButton.focus();
  });
  const openTyping = () => {
    sheet.hidden = false;
    typeButton.setAttribute('aria-expanded', 'true');
    input.focus();
    offTap?.();
    offTap = onTap(elsewhere);
    ctx.agent.typing?.(Boolean(input.value.trim() || composer.items().length)); // a draft kept from before is typed text again
  };
  const camera = h('input', { id: 'dock-camera', type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden' });
  camera.addEventListener('change', async () => {
    const files = [...(camera.files ?? [])];
    camera.value = '';
    if (!files.length) return;
    if (!ctx.agent.target) {
      ctx.notices.card({ tone: 'warn', title: t`Open a trip first`, body: t`Photos are kept in a trip. Open one from Trips, then take the photo again.` });
      return;
    }
    ctx.agent.photoComing?.(true); // words said while the photo is made wait for it (spec §6.8)
    try {
      const { paths } = await addFiles(ctx, ctx.agent.target, files);
      // Snap and ask: the photo goes to Shiori, who guesses why it was taken (spec §16.2).
      ctx.agent.typing?.(false); // text left in the box isn't being typed now
      ctx.agent.send('', { photos: paths.map((/** @type {string} */ p) => ({ path: `/trip${p}` })) });
      ctx.go('#/talk');
    } catch (e) {
      ctx.notices.card({ tone: 'warn', title: t`The photo wasn't added`, body: messageOf(e) });
    } finally {
      ctx.agent.photoComing?.(false);
    }
  });
  const talk = h('button', {
    class: 'talk', type: 'button', 'aria-label': t`Shiori`,
    onclick: () => {
      // While she speaks, a tap stops her and listens; asleep with voice on, it listens; with voice off, typing opens (spec §10.4).
      if (ctx.agent.tap() === 'typing') openTyping();
    },
  }, avatar.el, label);
  /** @type {((() => void) | undefined)[]} what it listens to, let go of by dispose() */
  const offs = [];
  offs.push(ctx.agent.on('state', (/** @type {any} */ s) => {
    avatar.setState(s.name);
    label.textContent = s.label;
  }));
  // The glow follows the sound (spec §16.3): her voice while she speaks, yours while she hears you.
  offs.push(ctx.voice?.onLevel((/** @type {number} */ x, /** @type {'her' | 'you'} */ who) => {
    const s = ctx.agent.state.name;
    if ((who === 'her' && s === 'speaking') || (who === 'you' && s === 'hearing')) avatar.setLevel(x, who);
  }));
  avatar.setState(ctx.agent.state.name);
  // Voice (spec §10.5, §16.2): the chip, her words, and a larger dock while voice is on.
  const chip = ctx.voice ? voiceChip(ctx) : null;
  const live = ctx.live ? liveChip(ctx) : null;
  offs.push(chip?.dispose, live?.dispose);
  // Her words, in a bubble of their own that points down at her, and never like a box to type in (the user, 2026-10-22). It shows them while
  // she speaks, with voice on, and lets go a moment after she stops; "Show what she says" in Settings → Voice turns it off (the user, 2026-10-23).
  // Not a live region: the conversation's announcer says each of her lines once, spoken or not (fix pass 2).
  const captionText = h('span', { class: 'caption-text' });
  const caption = h('p', { class: 'caption', 'aria-live': 'off', hidden: true }, captionText);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let lingering;
  const hideCaption = () => { clearTimeout(lingering); caption.hidden = true; };
  /** Hides the bubble once she is not speaking: at once, if she is not now, else when she stops. */
  const letGo = () => {
    clearTimeout(lingering);
    if (ctx.agent.state.name !== 'speaking') lingering = setTimeout(hideCaption, CAPTION_LINGER_MS);
  };
  /** Her words in the bubble; a long answer shows its latest words, faded at the top. @param {string} words @param {ReturnType<typeof wording>} say */
  const showCaption = (words, say) => {
    captionText.textContent = words;
    // The bubble's own: the caption is slanted unless its words are Chinese, Japanese or Korean (shiori.css).
    mark(caption, say(words));
    caption.hidden = !words;
    captionText.scrollTop = captionText.scrollHeight;
    captionText.classList.toggle('cut', captionText.scrollHeight > captionText.clientHeight + 1);
    letGo();
  };
  const clearCaption = () => {
    hideCaption();
    captionText.textContent = '';
  };
  /** "Show what she says" and the way to mark her words, read once and again whenever the app settings change: switched off mid-speech, the bubble goes at once, words and all. */
  const readOn = () => readAppSettings(ctx.ws).then((a) => ({ on: shownSettings(a).showWords, say: wording(a, true) }), () => ({ on: true, say: wording({}, true) }));
  let wordsOn = readOn();
  offs.push(ctx.ws?.onChange?.((/** @type {{ scope: string, path: string }} */ c) => {
    if (c.scope !== SYS_SETTINGS || c.path !== '/app.json') return;
    wordsOn = readOn();
    wordsOn.then(({ on }) => {
      if (on) return;
      latest++;
      clearCaption();
    });
  }));
  // Each line reads its stored text before it shows: a slower read of an earlier line never replaces a later one's words.
  let latest = 0;
  /** @param {() => Promise<string> | string} words */
  const show = async (words) => {
    const mine = ++latest;
    const { on, say } = await wordsOn;
    const text = on ? await words() : '';
    if (mine !== latest) return;
    if (on) showCaption(text, say);
    else clearCaption();
  };
  offs.push(ctx.agent.on('event', (/** @type {any} */ e) => {
    if (e.type === 'out.speak' && e.data?.voice) show(async () => String({ ...e.data, ...(await storedTexts(ctx.store, e)) }.text ?? ''));
  }));
  // A live Koe's words as the transcript grows, while she speaks (fix pass 2): its line is written only once she has finished.
  offs.push(ctx.agent.on('saying', (/** @type {string} */ words) => { show(() => String(words)); }));
  offs.push(ctx.agent.on('state', (/** @type {any} */ s) => {
    if (s.name === 'speaking') clearTimeout(lingering);
    else if (!caption.hidden) letGo();
  }), () => clearTimeout(lingering));
  // While Kokoro works behind Koe, a sign says so, with Stop for Kokoro's turn alone (the Koe and Kokoro design).
  const halves = h('span', { class: 'halves-sign', hidden: true },
    h('span', { class: 'chip', role: 'status', text: t`Kokoro is working` }),
    h('button', { class: 'btn', type: 'button', 'aria-label': t`Stop Kokoro`, onclick: () => ctx.agent.stopKokoro() }, t`Stop`));
  if ('kokoroWorking' in ctx.agent) {
    halves.hidden = !ctx.agent.kokoroWorking;
    offs.push(ctx.agent.on('halves', (/** @type {{ kokoroWorking: boolean }} */ x) => { halves.hidden = !x.kokoroWorking; }));
  }
  // Plugins' status chips and dock actions (spec §16.4), drawn again whenever they change (refreshSlots).
  const pluginChips = h('span', { class: 'plugin-chips' });
  const pluginActions = h('span', { class: 'plugin-actions' });
  // The buttons used most sit above; the states line, used less, at the very bottom, which is harder to reach (the user, 2026-10-18).
  const el = h('nav', { class: 'dock', 'aria-label': t`Shiori` },
    sheet,
    caption, // under the text panel, right above Shiori: its tail points at her
    h('div', { class: 'dock-row' },
      h('label', { class: 'ib', for: 'dock-camera', 'aria-label': t`Camera`, title: t`Camera` }, cameraIcon()), camera,
      talk,
      h('span', { class: 'dock-end' },
        typeButton,
        pluginActions)),
    h('div', { class: 'voice-row' }, chip?.el, live?.el, halves, pluginChips));
  const refreshSlots = () => {
    cleanUp('dock');
    pluginChips.replaceChildren(...slotEntries(ctx, 'ui:status-chip').map((e) => {
      const c = h('span', { class: 'chip plugin-chip' });
      mount(ctx, e, c, (ui) => e.item.render(c, ui), { group: 'dock', what: /* en */ `status chip ${e.item.id}` });
      return c;
    }));
    pluginActions.replaceChildren(...slotEntries(ctx, 'ui:dock-action').map((e) => h('button', {
      class: 'ib plugin-action', type: 'button', 'aria-label': String(e.item.label), title: String(e.item.label),
      onclick: () => runAction(ctx, e),
    }, h('span', { class: 'ib-icon', 'aria-hidden': 'true', text: String(e.item.icon) }))));
  };
  refreshSlots();
  /** The Driving screen's big dock, voice or not (spec §16.2). */
  let large = false;
  /** @param {{ on: boolean }} m */
  const layout = (m) => {
    el.classList.toggle('voice', m.on || large);
    if (!m.on) hideCaption();
  };
  offs.push(ctx.voice?.onChange(layout));
  if (ctx.voice) layout(ctx.voice.mode);
  return {
    el, avatar, refreshSlots, openTyping,
    /** Files in the box as chips (Ask Shiori about this), with what to suggest under them. @param {import('./composer.js').Attachment[]} items @param {{ suggestions?: string[] }} [o] */
    attach: (items, o) => composer.attach(items, o),
    dispose: () => {
      for (const off of offs.splice(0)) off?.();
      composer.dispose();
      composing = false;
      offTap?.();
      ctx.agent.typing?.(false);
    },
    /** @param {boolean} on */
    setLarge(on) {
      large = on;
      layout(ctx.voice?.mode ?? { on: false });
    },
  };
}

/**
 * The dock's avatar: a plugin's, when one replaces it and makes one that works (spec §16.4: avatar art),
 * else annai's own. A plugin's that fails counts against it: made, and each call after (minors 12),
 * where three throws in a row give annai's own back in its place. A call that works ends its own run,
 * and its plugin's (fix pass 8b-4); a setLevel that works doesn't end a setState's.
 * @param {any} ctx
 */
function dockAvatar(ctx) {
  const c = component(ctx, 'avatar');
  const a = c && made(ctx, c, 'avatar', () => c.item.create({ size: 'dock' }), (/** @type {any} */ a) =>
    a?.el instanceof Node && typeof a.setState === 'function' && typeof a.setLevel === 'function' ? null : /* en */ 'its avatar create() must return el, setState and setLevel');
  if (!a) return createAvatar({ size: 'dock' });
  /** @type {any} annai's own, once theirs threw three times in a row */
  let own = null;
  /** @type {Record<string, number>} each call's throws in a row */
  const runs = {};
  const call = (/** @type {string} */ name) => (/** @type {any[]} */ ...args) => {
    if (own) return own[name](...args);
    try {
      if (typeof a[name] === 'function') a[name](...args);
      if (runs[name]) {
        runs[name] = 0;
        ctx.registry?.succeeded(c.pluginId);
      }
    } catch (e) {
      ctx.registry?.fail(c.pluginId, `avatar ${name}`, e);
      runs[name] = (runs[name] ?? 0) + 1;
      if (Object.values(runs).reduce((n, x) => n + x, 0) < 3) return;
      own = createAvatar({ size: 'dock' });
      own.setState(ctx.agent.state.name);
      own[name](...args);
      /** @type {any} */ (a.el).replaceWith?.(own.el);
    }
  };
  return { get el() { return own?.el ?? a.el; }, setState: call('setState'), setLevel: call('setLevel'), glance: call('glance'), blink: call('blink') };
}
