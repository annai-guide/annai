import { h, field, whenGone } from '../dom.js';
import { readJourney } from '../../core/after/journey.js';
import { replayOf, momentAt, entryLine, PLAY_SPEEDS } from '../../core/after/replay.js';
import { stampCount } from '../../core/after/stamps.js';
import { PlayClock } from '../../core/live/clock.js';
import { loadPack } from '../../core/pack/read.js';
import { timeIn } from '../../core/time.js';
import { renderCard } from '../cards.js';
import { openPhotoViewer } from '../photo-viewer.js';
import { stampMarks } from '../stamps.js';

const NS = 'http://www.w3.org/2000/svg';

/** An SVG element: geometry and strokes as attributes, never a style attribute. @param {string} tag @param {Record<string, string | number>} [attrs] @param {...(Node | string | null)} children */
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

/**
 * Replay (spec §13, §16.2): the trip's timeline (places, Shiori's cards, photos, the user's words),
 * the route drawn from its location points on a flat map with no tiles, and playback at adjustable
 * speed. The route is also said in words, and every entry is a list item, so the replay makes sense
 * without seeing the map (§16.5).
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderReplay(ctx, route) {
  const id = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  const locale = navigator.language || 'en-US';
  const pack = await loadPack(ctx.ws, id).catch(() => null);
  const j = await readJourney({ store: ctx.store, ws: ctx.ws, trip: id, namer: (p) => pack?.name(p) ?? null });
  const day = j.days.includes(route.params.day ?? '') ? route.params.day : null;
  const r = replayOf(j, day);
  const base = `#/trip/${encodeURIComponent(id)}/replay`;
  const dayName = (/** @type {string} */ d) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${d}T12:00:00Z`));
  const tab = (/** @type {string | null} */ d, /** @type {string} */ label) => h('a', { class: 'tab', href: d ? `${base}?day=${d}` : base, 'aria-current': d === day ? 'page' : null }, label);
  const head = [
    h('p', { class: 'crumbs' }, h('a', { href: `#/trip/${encodeURIComponent(id)}` }, `← ${scope.title}`)),
    h('h1', { class: 'title', text: 'Replay' }),
    j.days.length > 1 ? h('nav', { class: 'tabs', 'aria-label': 'Days' }, tab(null, 'Whole trip'), ...j.days.map((d) => tab(d, dayName(d)))) : null,
  ];
  if (!r) {
    return h('div', { class: 'screen replay' }, ...head,
      h('p', { class: 'empty', text: "Nothing to replay yet. While GPS is on, annai records where you go; Shiori's cards, your messages and your photos show here too." }));
  }
  const clock = new PlayClock(r.from, { speed: 600, playing: false });
  const clockText = (/** @type {number} */ t) => new Intl.DateTimeFormat(locale, { timeZone: r.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

  // The map: the drawn route grey, what is behind vermilion, jumps dashed, stays and stamps as rings, you as a dot (choice 8).
  const { width, height, xy } = r.map;
  const line = (/** @type {import('../../core/after/route.js').Point[]} */ seg) => seg.map((p) => xy(p).join(',')).join(' ');
  const jumps = r.segments.slice(1).map((seg, i) => {
    const prev = r.segments[i];
    const [x1, y1] = xy(prev[prev.length - 1]);
    const [x2, y2] = xy(seg[0]);
    return svg('line', { class: 'route-jump', x1, y1, x2, y2 });
  });
  const done = r.segments.map((seg, i) => svg('polyline', { class: 'route-done', points: line(seg), 'stroke-dasharray': `${r.lengths[i]} ${r.lengths[i] + 1}`, 'stroke-dashoffset': r.lengths[i] }));
  const stays = /** @type {Extract<import('../../core/after/journey.js').Entry, { kind: 'stay' }>[]} */ (r.entries.filter((e) => e.kind === 'stay'));
  const rings = stays.map((e) => {
    const [cx, cy] = xy(e);
    return svg('circle', { class: e.stamp ? 'route-stamp' : 'route-stay', cx, cy, r: e.stamp ? 16 : 9 }, svg('title', {}, e.name ?? 'A stop'));
  });
  const here = svg('circle', { class: 'route-here', r: 13, cx: -100, cy: -100 });
  const titleId = `route-${Math.random().toString(36).slice(2)}`;
  const map = svg('svg', { class: 'route-map', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': titleId, preserveAspectRatio: 'xMidYMid meet' },
    svg('title', { id: titleId }, `The route: ${r.words}`),
    ...jumps, ...r.segments.map((seg) => svg('polyline', { class: 'route-all', points: line(seg) })), ...done, ...rings, here);

  // At this moment (choice 7).
  const timeEl = h('p', { class: 'replay-time' });
  const whereEl = h('p', { class: 'replay-where now-place' });
  const soFar = h('p', { class: 'sub' });
  const shown = h('div', { class: 'replay-shown' });
  const told = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  /** @type {any} */
  let shownEntry = null;
  let photoUrl = '';
  /** The latest card, words or photo reached. @param {number} index */
  const showLatest = (index) => {
    let e = null;
    for (let i = index; i >= 0 && !e; i--) if (['card', 'said', 'photo'].includes(r.entries[i].kind)) e = /** @type {any} */ (r.entries[i]);
    if (e === shownEntry) return;
    shownEntry = e;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = '';
    if (!e) {
      shown.replaceChildren();
      return;
    }
    const when = h('span', { class: 'sub', text: timeIn(e.at, r.tz) });
    if (e.kind === 'card') shown.replaceChildren(h('div', { class: 'shiori-card' }, h('span', { class: 'who', text: 'SHIORI' }), renderCard(e.card, { ctx }), when));
    else if (e.kind === 'said') shown.replaceChildren(h('div', { class: 'shiori-card' }, h('span', { class: 'who', text: e.spoken ? 'YOU SAID' : 'YOU' }), h('p', { text: e.text }), when));
    else {
      const img = h('img', { class: 'replay-photo', alt: `Photo ${e.path.split('/').pop()}, ${timeIn(e.at, r.tz)}` });
      const open = h('button', { class: 'btn ghost', type: 'button', disabled: true }, 'Open full size');
      shown.replaceChildren(h('figure', { class: 'replay-figure' }, img, h('figcaption', {}, when, open)));
      const mine = e;
      ctx.ws.read(id, e.path).then((/** @type {any} */ got) => {
        if (shownEntry !== mine || !got) return;
        photoUrl = URL.createObjectURL(new Blob([got.bytes], { type: got.entry.type }));
        img.src = photoUrl;
        open.disabled = false;
        open.onclick = () => openPhotoViewer(photoUrl, mine.path);
      }).catch(() => {});
    }
  };

  // The controls (choice 5).
  const play = h('button', { class: 'btn pri', type: 'button' }, 'Play');
  const speed = h('select', { id: 'replay-speed' }, ...PLAY_SPEEDS.map(([v, label]) => h('option', { value: String(v), text: label })));
  speed.value = '600';
  const scrub = h('input', { id: 'replay-scrub', type: 'range', min: String(r.from), max: String(r.to), step: '60000', value: String(r.from) });

  // The timeline (choice 6): each entry a button that moves the playback there.
  const items = r.entries.map((e) => {
    const { when, text } = entryLine(e, r.tz);
    return h('li', { class: ['replay-entry', `kind-${e.kind}`] }, h('button', {
      class: 'replay-item', type: 'button',
      onclick: () => {
        clock.seek(e.at);
        draw(true); // focus stays on the entry: say where it moved to
      },
    }, h('span', { class: 'when', text: when }), h('span', { class: 'what', text })));
  });

  let was = { index: -2, where: '', minute: NaN, stamps: -1 };
  /** @param {boolean} [say] tell the moment, though paused */
  const draw = (say = false) => {
    const t = Math.min(r.to, Math.max(r.from, clock.now()));
    const m = momentAt(r, t);
    if (m.xy) {
      here.setAttribute('cx', String(m.xy[0]));
      here.setAttribute('cy', String(m.xy[1]));
    }
    done.forEach((pl, i) => pl.setAttribute('stroke-dashoffset', String(Math.max(0, r.lengths[i] - m.done[i]))));
    const minute = Math.floor(t / 60_000);
    if (minute !== was.minute || m.where !== was.where) {
      const words = clockText(t);
      timeEl.textContent = words;
      scrub.value = String(t);
      scrub.setAttribute('aria-valuetext', `${words}, ${m.where}`);
    }
    if (m.where !== was.where) whereEl.textContent = m.where;
    // Paused, the scrubber says the moment: nothing older stays told.
    if (say || (clock.playing && m.where !== was.where)) told.textContent = `${timeIn(t, r.tz)}, ${m.where}`;
    else if (!clock.playing) told.textContent = '';
    if (m.stamps !== was.stamps) soFar.textContent = `${stampCount(m.stamps)} so far`;
    if (m.index !== was.index) {
      items[was.index]?.classList.remove('now');
      items[was.index]?.firstElementChild?.removeAttribute('aria-current');
      items[m.index]?.classList.add('now');
      items[m.index]?.firstElementChild?.setAttribute('aria-current', 'true');
      showLatest(m.index);
    }
    was = { index: m.index, where: m.where, minute, stamps: m.stamps };
  };
  const root = h('div', { class: 'screen replay' }, ...head,
    stampMarks(r.stamps, { max: 24, big: true }),
    h('figure', { class: 'route' }, map, h('figcaption', { class: 'sub', text: `${r.words} The timeline below lists each place in order.` })),
    h('section', { class: 'replay-now', 'aria-label': 'At this moment' }, timeEl, whereEl, soFar, shown, told),
    h('div', { class: 'replay-controls' },
      h('div', { class: 'acts' }, play),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Time in the trip' }), scrub),
      field('Speed', speed)),
    h('section', { 'aria-label': 'The trip in order' }, h('h2', { class: 'section', text: 'Timeline' }), h('ol', { class: 'timeline', 'aria-label': 'Timeline' }, ...items)));
  const setPlaying = (/** @type {boolean} */ on) => { play.textContent = on ? 'Pause' : 'Play'; };
  /** The screen is gone: playback stops with it, and the photo shown lets its memory go. */
  const gone = () => {
    clock.pause();
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = '';
  };
  // Paused, nothing else notices the screen leaving.
  whenGone(root, gone);
  const tick = () => {
    if (!root.isConnected) {
      gone();
      return;
    }
    if (clock.now() >= r.to) {
      clock.pause();
      clock.seek(r.to);
      setPlaying(false);
    }
    draw();
    if (clock.playing) requestAnimationFrame(tick);
  };
  play.addEventListener('click', () => {
    if (clock.playing) {
      clock.pause();
      setPlaying(false);
      draw();
      return;
    }
    if (clock.now() >= r.to) clock.seek(r.from); // at the end: from the beginning again
    clock.play();
    setPlaying(true);
    requestAnimationFrame(tick);
  });
  speed.addEventListener('change', () => { clock.speed = Number(speed.value); });
  scrub.addEventListener('input', () => {
    clock.seek(Number(scrub.value));
    draw();
  });
  draw();
  return root;
}
