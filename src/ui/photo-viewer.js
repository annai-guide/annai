import { h } from './dom.js';

const MAX_ZOOM = 8;

/**
 * Shows a photo over everything at full size (spec §16.2): pinch or scroll to zoom, drag to move,
 * double-tap to zoom in or back out, Close, Escape or Back to leave. Focus returns where it was.
 * Opening it adds a history entry, so Back on a phone closes the photo instead of leaving its page.
 * @param {string} src @param {string} label
 * @returns {() => void} closes it
 */
export function openPhotoViewer(src, label) {
  const opener = document.activeElement;
  const img = h('img', { class: 'viewer-img', src, alt: label, draggable: 'false' });
  const stage = h('div', { class: 'viewer-stage' }, img);
  const close = h('button', { class: 'btn viewer-close', type: 'button' }, 'Close');
  const root = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Photo ${label}`, dataset: { zoom: '1' } }, stage, close);
  let scale = 1;
  let x = 0;
  let y = 0;

  /** Applies the zoom and pan, keeping the photo over the whole stage once zoomed in. */
  const apply = () => {
    const limitX = (stage.clientWidth * (scale - 1)) / 2;
    const limitY = (stage.clientHeight * (scale - 1)) / 2;
    x = Math.min(limitX, Math.max(-limitX, x));
    y = Math.min(limitY, Math.max(-limitY, y));
    img.style.setProperty('transform', `translate(${x}px, ${y}px) scale(${scale})`);
    root.dataset.zoom = String(Math.round(scale * 100) / 100);
  };
  /** Zooms to s, keeping the point (px, py), measured from the stage's centre, where it is. @param {number} s @param {number} px @param {number} py */
  const zoomTo = (s, px, py) => {
    const next = Math.min(MAX_ZOOM, Math.max(1, s));
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    apply();
  };
  /** @param {{ clientX: number, clientY: number }} e @returns {[number, number]} */
  const fromCentre = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2];
  };

  /** @type {Map<number, { x: number, y: number }>} */
  const pointers = new Map();
  /** @type {{ distance: number, scale: number } | null} */
  let pinch = null;
  let lastTap = { at: 0, x: 0, y: 0 };
  let moved = 0;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  stage.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    pinch = pointers.size === 2 ? { distance: spread(), scale } : null;
  });
  stage.addEventListener('pointermove', (/** @type {PointerEvent} */ e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    moved += Math.abs(dx) + Math.abs(dy);
    p.x = e.clientX;
    p.y = e.clientY;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const [cx, cy] = fromCentre({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      zoomTo(pinch.scale * (spread() / pinch.distance), cx, cy);
    } else if (pointers.size === 1 && scale > 1) {
      x += dx;
      y += dy;
      apply();
    }
  });
  /** A lifted finger ends a pinch or a drag; two quick taps in one spot zoom in, or back out. @param {PointerEvent} e */
  const lift = (e) => {
    pointers.delete(e.pointerId);
    pinch = pointers.size === 2 ? { distance: spread(), scale } : null;
    if (e.type !== 'pointerup' || pointers.size > 0 || moved > 10) return;
    const now = performance.now();
    if (now - lastTap.at < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      const [px, py] = fromCentre(e);
      zoomTo(scale > 1 ? 1 : 2.5, px, py);
      lastTap = { at: 0, x: 0, y: 0 };
    } else {
      lastTap = { at: now, x: e.clientX, y: e.clientY };
    }
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('wheel', (/** @type {WheelEvent} */ e) => {
    e.preventDefault();
    const [px, py] = fromCentre(e);
    zoomTo(scale * Math.exp(-e.deltaY * 0.002), px, py);
  }, { passive: false });

  /** Close and Escape take back the history entry opening added; popstate then closes the viewer. */
  const leave = () => {
    if (history.state?.annaiViewer) history.back();
    else done();
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') leave();
  };
  let open = true;
  function done() {
    if (!open) return;
    open = false;
    root.remove();
    removeEventListener('keydown', onKey);
    removeEventListener('popstate', done);
    removeEventListener('hashchange', done);
    if (opener instanceof HTMLElement) opener.focus();
  }
  close.addEventListener('click', leave);
  addEventListener('keydown', onKey);
  history.pushState({ annaiViewer: true }, '');
  addEventListener('popstate', done);
  addEventListener('hashchange', done); // any navigation closes it too
  document.body.append(root);
  close.focus();
  return leave;
}
