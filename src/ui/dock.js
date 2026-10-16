import { h } from './dom.js';
import { createAvatar } from './avatar.js';
import { addFiles } from './add-files.js';

/**
 * The dock at the bottom of every screen (spec §16.2): camera · Shiori · type. Tapping Shiori
 * stops her while she works (§6.7); while she rests it opens typing, until voice comes (milestone 3).
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
      for (const p of paths) ctx.agent.wake({ kind: 'file', text: `The user took a photo: /trip${p}` });
      ctx.go('#/talk');
    } catch (e) {
      ctx.notices.card({ tone: 'warn', title: "The photo wasn't added", body: String(/** @type {any} */ (e)?.message ?? e) });
    }
  });
  const talk = h('button', {
    class: 'talk', type: 'button', 'aria-label': 'Shiori',
    onclick: () => {
      const busy = ['thinking', 'speaking', 'away', 'waiting'].includes(ctx.agent.state.name);
      if (busy && ctx.agent.state.name !== 'waiting') ctx.agent.interrupt();
      else openTyping();
    },
  }, avatar.el, label);
  ctx.agent.on('state', (/** @type {any} */ s) => {
    avatar.setState(s.name);
    label.textContent = s.label;
  });
  avatar.setState(ctx.agent.state.name);
  const el = h('nav', { class: 'dock', 'aria-label': 'Shiori' },
    sheet,
    h('div', { class: 'dock-row' },
      h('label', { class: 'ib', for: 'dock-camera', 'aria-label': 'Camera', title: 'Camera' }, h('span', { class: 'ib-icon', 'aria-hidden': 'true', text: '◉' })), camera,
      talk,
      h('button', { class: 'ib', type: 'button', 'aria-label': 'Type', title: 'Type', onclick: openTyping }, h('span', { class: 'ib-icon', 'aria-hidden': 'true', text: '⌨' }))));
  return { el, avatar };
}
