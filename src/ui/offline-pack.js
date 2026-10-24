import { h, plural } from './dom.js';
import { size, relTime, num, list } from './format.js';
import { connectionOf } from './platform.js';
import { explainStorageFull } from './storage-full.js';
import { MAX_BYTES } from '../core/pack/download.js';

/**
 * The trip's Offline pack panel and Now's line (spec §11.5): what the pack holds, about how much
 * downloading takes (shown before anything is downloaded), how it stays up to date, and its sources.
 * @typedef {import('../core/pack/keeper.js').PackStatus} PackStatus
 */

/** "1,200 places, 40 Wikipedia summaries, 1 Wikivoyage guide". @param {NonNullable<PackStatus['manifest']>} m */
function holds(m) {
  return list([plural(m.places, '# place', '# places'), plural(m.summaries, '# Wikipedia summary', '# Wikipedia summaries'), plural(m.guides.length, '# Wikivoyage guide', '# Wikivoyage guides')], 'plain');
}

/** " 2 hours ago", or nothing when the manifest doesn't say when (an empty at). @param {string} at */
export function downloadedWhen(at) {
  const t = Date.parse(at);
  return Number.isFinite(t) ? ` ${relTime(t)}` : '';
}

/**
 * What the panel says, and its button.
 * @param {PackStatus} s @param {string} connection what connectionOf says
 * @returns {{ lines: string[], button: string | null }}
 */
export function packWords(s, connection) {
  if (s.running) {
    const r = s.running;
    return { lines: [`Downloading${r.total ? ` ${num(Math.min(r.done + 1, r.total))} of ${num(r.total)}` : ''}${r.label ? `: ${r.label}` : ''}…`], button: null };
  }
  if (!s.stops) return { lines: ['The pack follows the plan: once the plan has places, it can be downloaded here.'], button: null };
  const about = `about ${size(s.estimate)}`;
  const m = s.manifest;
  if (!m) {
    return {
      lines: [
        `For when there's no connection: places from OpenStreetMap, Wikipedia summaries and Wikivoyage guides, around the plan's ${s.stops === 1 ? 'stop' : `${s.stops} stops`} and along the way between them. Shiori's nearby and guide read it first.`,
        "Downloading sends the plan's places to OpenStreetMap and Wikipedia, and place names to Wikivoyage.",
      ],
      button: `Download (${about})`,
    };
  }
  const lines = [`Downloaded${downloadedWhen(m.at)} · ${size(m.bytes)} · ${holds(m)}.`];
  if (m.guides.length) lines.push(`Guides: ${m.guides.map((g) => g.title).join(', ')}.`);
  if (m.full) lines.push(`It stopped at its ${size(MAX_BYTES)} limit, so it holds only the start of the plan.`);
  if (s.cut) lines.push('This plan is longer than a pack holds, so some of the way between stops is left out.');
  if (m.failed.length) {
    const f = m.failed[0];
    lines.push(`${m.failed.length === 1 ? 'One part' : `${m.failed.length} parts`} didn't download: ${f.label} (${f.why.replace(/[.!?]$/, '')}).`);
  } else if (m.stopped) lines.push('The download was stopped before the end.');
  /** @type {string | null} */
  let button = null;
  if (s.why === 'plan') {
    lines.push('The plan changed since.');
    button = `Update (${about})`;
  } else if (s.why === 'missing') button = `${m.failed.length ? 'Try again' : 'Download the rest'} (${about})`;
  else if (s.why === 'old') {
    lines.push('It is more than a month old.');
    button = `Update (${about})`;
  }
  lines.push(connection === 'unknown' ? "This browser doesn't tell annai when it is on Wi-Fi, so update it here." : 'On Wi-Fi, annai keeps it up to date by itself while this trip is open.');
  return { lines, button };
}

/**
 * The trip's Offline pack panel: what packWords says, its button, Stop while downloading, and the
 * sources' credits. It follows the download as it goes.
 * @param {any} ctx @param {string} id the trip @returns {Promise<HTMLElement>}
 */
export async function packPanel(ctx, id) {
  const box = h('section', { class: 'pack', 'aria-label': 'Offline pack' });
  const keeper = ctx.pack;
  if (!keeper) return box;
  const go = () => {
    keeper.download(id).catch((/** @type {unknown} */ e) => {
      if (explainStorageFull(ctx, e)) return;
      const why = String(/** @type {any} */ (e)?.message ?? e).replace(/[.!?]?$/, '.');
      ctx.notices.card({ tone: 'warn', title: "The offline pack didn't download", body: `${why} What came is kept. Try again in a moment.` });
    });
  };
  const draw = async () => {
    const s = await keeper.status(id);
    const { lines, button } = packWords(s, connectionOf(navigator));
    // replaceChildren, unlike h, would show a null as the word.
    box.replaceChildren(...[
      h('h2', { class: 'section', text: 'Offline pack' }),
      ...lines.map((t) => h('p', { class: 'sub', text: t })),
      button || s.running ? h('div', { class: 'acts' },
        button ? h('button', { class: 'btn', type: 'button', onclick: go }, button) : null,
        s.running ? h('button', { class: 'btn', type: 'button', onclick: () => keeper.stop() }, 'Stop') : null) : null,
      h('p', { class: 'sub' }, 'Places © ', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap contributors'),
        '; summaries from Wikipedia and guides from Wikivoyage, ', h('a', { href: 'https://creativecommons.org/licenses/by-sa/4.0/', target: '_blank', rel: 'noopener' }, 'CC BY-SA'), '.'),
    ].filter((n) => n !== null));
  };
  let drawing = Promise.resolve();
  const off = keeper.onChange(() => {
    if (!box.isConnected) {
      off();
      return;
    }
    drawing = drawing.then(draw).catch(() => {});
  });
  await draw();
  return box;
}

/** Now's line about the pack, with the way to it; null when the plan has no places. @param {any} ctx @param {string} id @returns {Promise<HTMLElement | null>} */
export async function packLine(ctx, id) {
  const s = ctx.pack ? await ctx.pack.status(id).catch(() => null) : null;
  if (!s?.stops) return null;
  const text = !s.manifest ? 'No offline pack for this trip yet.'
    : s.why === 'plan' ? 'The offline pack is from before the plan changed.'
      : `Offline pack: downloaded${downloadedWhen(s.manifest.at)}.`;
  return h('p', { class: 'sub pack-line' }, `${text} `, h('a', { href: `#/trip/${encodeURIComponent(id)}` }, 'Offline pack'));
}
