import { h } from './dom.js';
import { createAvatar } from './avatar.js';
import { addFiles } from './add-files.js';
import { voiceChip } from './voice-chip.js';

/**
 * The dock at the bottom of every screen (spec §16.2): camera · Shiori · type. Tapping Shiori stops
 * her while she works or speaks (§6.7, §10.4), and starts listening while she rests with voice on; with voice off it opens typing.
 * @param {any} ctx
 */
export function createDock(ctx) {
  const avatar = createAvatar({ size: 'dock' });
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
  ctx.agent.on('state', (/** @type {any} */ s) => {
    avatar.setState(s.name);
    label.textContent = s.label;
  });
  // The glow follows the sound (spec §16.3): her voice while she speaks, yours while she hears you.
  ctx.voice?.onLevel((/** @type {number} */ x, /** @type {'her' | 'you'} */ who) => {
    const s = ctx.agent.state.name;
    if ((who === 'her' && s === 'speaking') || (who === 'you' && s === 'hearing')) avatar.setLevel(x, who);
  });
  avatar.setState(ctx.agent.state.name);
  // Voice (spec §10.5, §16.2): the chip, "Show what she's saying", and a larger dock while voice is on.
  const chip = ctx.voice ? voiceChip(ctx) : null;
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
  ctx.agent.on('event', (/** @type {any} */ e) => {
    if (e.type !== 'out.speak' || !e.data?.voice) return;
    lastSaid = String(e.data.text ?? '');
    if (!caption.hidden) caption.textContent = lastSaid;
  });
  const el = h('nav', { class: 'dock', 'aria-label': 'Shiori' },
    chip ? h('div', { class: 'voice-row' }, chip.el, showWords) : null, caption,
    sheet,
    h('div', { class: 'dock-row' },
      h('label', { class: 'ib', for: 'dock-camera', 'aria-label': 'Camera', title: 'Camera' }, h('span', { class: 'ib-icon', 'aria-hidden': 'true', text: '◉' })), camera,
      talk,
      h('button', { class: 'ib', type: 'button', 'aria-label': 'Type', title: 'Type', onclick: openTyping }, h('span', { class: 'ib-icon', 'aria-hidden': 'true', text: '⌨' }))));
  /** @param {{ on: boolean }} m */
  const layout = (m) => {
    el.classList.toggle('voice', m.on);
    showWords.hidden = !m.on;
    if (!m.on) caption.hidden = true;
  };
  ctx.voice?.onChange(layout);
  if (ctx.voice) layout(ctx.voice.mode);
  return { el, avatar };
}
