import { h } from './dom.js';
import { createAvatar } from './avatar.js';
import { addFiles } from './add-files.js';
import { voiceChip } from './voice-chip.js';
import { liveChip } from './live-chip.js';
import { component, mount, cleanUp, slotEntries, runAction, made } from './slots.js';

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
const cameraIcon = () => icon('M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 9.8a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8z');
const keyboardIcon = () => icon('M4 6.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16V8A1.5 1.5 0 0 1 4 6.5z', 'M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 13.5h.01M17 13.5h.01M9.5 13.8h5');

/**
 * The dock at the bottom of every screen (spec §16.2): camera · Shiori · type. Tapping Shiori stops
 * her while she works or speaks (§6.7, §10.4), and starts listening while she rests with voice on; with voice off it opens typing.
 * dispose() lets go of everything it listens to, for a dock made again (minors 13).
 * @param {any} ctx
 */
export function createDock(ctx) {
  const avatar = dockAvatar(ctx);
  const label = h('span', { class: 'talk-label', text: ctx.agent.state.label });
  const input = h('textarea', { id: 'dock-text', rows: 2, 'aria-label': 'Message to Shiori', enterkeyhint: 'send' });
  const sheet = h('form', {
    class: 'type-sheet', hidden: true,
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      ctx.agent.send(text);
      if (!location.hash.startsWith('#/talk')) ctx.go('#/talk');
    },
  },
  input,
  h('div', { class: 'acts' },
    h('button', { class: 'btn pri', type: 'submit' }, 'Send'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { sheet.hidden = true; } }, 'Close')));
  input.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sheet.requestSubmit();
    } else if (e.key === 'Escape') sheet.hidden = true;
  });
  const openTyping = () => {
    sheet.hidden = false;
    input.focus();
  };
  const camera = h('input', { id: 'dock-camera', type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden' });
  camera.addEventListener('change', async () => {
    const files = [...(camera.files ?? [])];
    camera.value = '';
    if (!files.length) return;
    if (!ctx.agent.target) {
      ctx.notices.card({ tone: 'warn', title: 'Open a trip first', body: 'Photos are kept in a trip. Open one from Trips, then take the photo again.' });
      return;
    }
    try {
      const { paths } = await addFiles(ctx, ctx.agent.target, files);
      // Snap and ask: the photo goes to Shiori, who guesses why it was taken (spec §16.2).
      ctx.agent.send('', { photos: paths.map((/** @type {string} */ p) => ({ path: `/trip${p}` })) });
      ctx.go('#/talk');
    } catch (e) {
      ctx.notices.card({ tone: 'warn', title: "The photo wasn't added", body: String(/** @type {any} */ (e)?.message ?? e) });
    }
  });
  const talk = h('button', {
    class: 'talk', type: 'button', 'aria-label': 'Shiori',
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
  // Voice (spec §10.5, §16.2): the chip, "Show what she's saying", and a larger dock while voice is on.
  const chip = ctx.voice ? voiceChip(ctx) : null;
  const live = ctx.live ? liveChip(ctx) : null;
  offs.push(chip?.dispose, live?.dispose);
  const caption = h('p', { class: 'caption', 'aria-live': 'polite', hidden: true });
  let lastSaid = '';
  const showWords = h('button', {
    class: 'chip', type: 'button', 'aria-expanded': 'false', hidden: !ctx.voice?.on,
    onclick: () => {
      caption.hidden = !caption.hidden;
      caption.textContent = lastSaid || 'She hasn’t said anything yet.';
      showWords.setAttribute('aria-expanded', String(!caption.hidden));
    },
  }, "Show what she's saying");
  offs.push(ctx.agent.on('event', (/** @type {any} */ e) => {
    if (e.type !== 'out.speak' || !e.data?.voice) return;
    lastSaid = String(e.data.text ?? '');
    if (!caption.hidden) caption.textContent = lastSaid;
  }));
  // While Kokoro works behind Koe, a sign says so, with Stop for Kokoro's turn alone (the Koe and Kokoro design).
  const halves = h('span', { class: 'halves-sign', hidden: true },
    h('span', { class: 'chip', role: 'status', text: 'Kokoro is working' }),
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Stop Kokoro', onclick: () => ctx.agent.stopKokoro() }, 'Stop'));
  if ('kokoroWorking' in ctx.agent) {
    halves.hidden = !ctx.agent.kokoroWorking;
    offs.push(ctx.agent.on('halves', (/** @type {{ kokoroWorking: boolean }} */ x) => { halves.hidden = !x.kokoroWorking; }));
  }
  // Plugins' status chips and dock actions (spec §16.4), drawn again whenever they change (refreshSlots).
  const pluginChips = h('span', { class: 'plugin-chips' });
  const pluginActions = h('span', { class: 'plugin-actions' });
  // The buttons used most sit above; the states line, used less, at the very bottom, which is harder to reach (the user, 2026-10-18).
  const el = h('nav', { class: 'dock', 'aria-label': 'Shiori' },
    caption,
    sheet,
    h('div', { class: 'dock-row' },
      h('label', { class: 'ib', for: 'dock-camera', 'aria-label': 'Camera', title: 'Camera' }, cameraIcon()), camera,
      talk,
      h('span', { class: 'dock-end' },
        h('button', { class: 'ib', type: 'button', 'aria-label': 'Type', title: 'Type', onclick: openTyping }, keyboardIcon()),
        pluginActions)),
    h('div', { class: 'voice-row' }, chip?.el, live?.el, showWords, halves, pluginChips));
  const refreshSlots = () => {
    cleanUp('dock');
    pluginChips.replaceChildren(...slotEntries(ctx, 'ui:status-chip').map((e) => {
      const c = h('span', { class: 'chip plugin-chip' });
      mount(ctx, e, c, (ui) => e.item.render(c, ui), { group: 'dock', what: `status chip ${e.item.id}` });
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
    showWords.hidden = !m.on;
    if (!m.on) caption.hidden = true;
  };
  offs.push(ctx.voice?.onChange(layout));
  if (ctx.voice) layout(ctx.voice.mode);
  return {
    el, avatar, refreshSlots,
    dispose: () => { for (const off of offs.splice(0)) off?.(); },
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
    a?.el instanceof Node && typeof a.setState === 'function' && typeof a.setLevel === 'function' ? null : 'its avatar create() must return el, setState and setLevel');
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
