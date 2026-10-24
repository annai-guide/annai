import { h, t, plural, linkIn } from './dom.js';
import { size, relTime, num, list, sentences, sentenceGap } from './format.js';
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

/** "2 hours ago", or nothing when the manifest doesn't say when (an empty at). @param {string} at */
export function downloadedWhen(at) {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? relTime(ms) : '';
}

/**
 * What the panel says, and its button.
 * @param {PackStatus} s @param {string} connection what connectionOf says
 * @returns {{ lines: string[], button: string | null }}
 */
export function packWords(s, connection) {
  if (s.running) {
    const r = s.running;
    const [done, total] = [num(Math.min(r.done + 1, r.total)), num(r.total)];
    const line = r.total ? (r.label ? t`Downloading ${done} of ${total}: ${r.label}…` : t`Downloading ${done} of ${total}…`) : r.label ? t`Downloading: ${r.label}…` : t`Downloading…`;
    return { lines: [line], button: null };
  }
  if (!s.stops) return { lines: [t`The pack follows the plan: once the plan has places, it can be downloaded here.`], button: null };
  const about = size(s.estimate);
  const m = s.manifest;
  if (!m) {
    return {
      lines: [
        plural(s.stops, "For when there's no connection: places from OpenStreetMap, Wikipedia summaries and Wikivoyage guides, around the plan's stop and along the way between them. Shiori's nearby and guide read it first.",
          "For when there's no connection: places from OpenStreetMap, Wikipedia summaries and Wikivoyage guides, around the plan's # stops and along the way between them. Shiori's nearby and guide read it first."),
        t`Downloading sends the plan's places to OpenStreetMap and Wikipedia, and place names to Wikivoyage.`,
      ],
      button: t`Download (about ${about})`,
    };
  }
  const when = downloadedWhen(m.at);
  const lines = [when ? t`Downloaded ${when} · ${size(m.bytes)} · ${holds(m)}.` : t`Downloaded · ${size(m.bytes)} · ${holds(m)}.`];
  if (m.guides.length) lines.push(t`Guides: ${list(m.guides.map((g) => g.title), 'plain')}.`);
  if (m.full) lines.push(t`It stopped at its ${size(MAX_BYTES)} limit, so it holds only the start of the plan.`);
  if (s.cut) lines.push(t`This plan is longer than a pack holds, so some of the way between stops is left out.`);
  if (m.failed.length) {
    const f = m.failed[0];
    lines.push(plural(m.failed.length, "One part didn't download: {0} ({1}).", "# parts didn't download: {0} ({1}).", f.label, f.why.replace(/[.!?]$/, '')));
  } else if (m.stopped) lines.push(t`The download was stopped before the end.`);
  /** @type {string | null} */
  let button = null;
  if (s.why === 'plan') {
    lines.push(t`The plan changed since.`);
    button = t`Update (about ${about})`;
  } else if (s.why === 'missing') button = m.failed.length ? t`Try again (about ${about})` : t`Download the rest (about ${about})`;
  else if (s.why === 'old') {
    lines.push(t`It is more than a month old.`);
    button = t`Update (about ${about})`;
  }
  lines.push(connection === 'unknown' ? t`This browser doesn't tell annai when it is on Wi-Fi, so update it here.` : t`On Wi-Fi, annai keeps it up to date by itself while this trip is open.`);
  return { lines, button };
}

/**
 * The trip's Offline pack panel: what packWords says, its button, Stop while downloading, and the
 * sources' credits. It follows the download as it goes.
 * @param {any} ctx @param {string} id the trip @returns {Promise<HTMLElement>}
 */
export async function packPanel(ctx, id) {
  const box = h('section', { class: 'pack', 'aria-label': t`Offline pack` });
  const keeper = ctx.pack;
  if (!keeper) return box;
  const go = () => {
    keeper.download(id).catch((/** @type {unknown} */ e) => {
      if (explainStorageFull(ctx, e)) return;
      const why = String(/** @type {any} */ (e)?.message ?? e).replace(/[.!?]?$/, '.');
      ctx.notices.card({ tone: 'warn', title: t`The offline pack didn't download`, body: sentences(why, t`What came is kept. Try again in a moment.`) });
    });
  };
  const draw = async () => {
    const s = await keeper.status(id);
    const { lines, button } = packWords(s, connectionOf(navigator));
    // replaceChildren, unlike h, would show a null as the word.
    box.replaceChildren(...[
      h('h2', { class: 'section', text: t`Offline pack` }),
      ...lines.map((line) => h('p', { class: 'sub', text: line })),
      button || s.running ? h('div', { class: 'acts' },
        button ? h('button', { class: 'btn', type: 'button', onclick: go }, button) : null,
        s.running ? h('button', { class: 'btn', type: 'button', onclick: () => keeper.stop() }, t`Stop`) : null) : null,
      h('p', { class: 'sub' }, ...credits()),
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

/** The sources' credits, their licence's and contributors' names as they write them. */
function credits() {
  const osm = h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, /* en */ 'OpenStreetMap contributors');
  const cc = h('a', { href: 'https://creativecommons.org/licenses/by-sa/4.0/', target: '_blank', rel: 'noopener' }, /* en */ 'CC BY-SA');
  return linkIn(t`Places © ${osm.textContent}; summaries from Wikipedia and guides from Wikivoyage, ${cc.textContent}.`, osm, cc);
}

/** Now's line about the pack, with the way to it; null when the plan has no places. @param {any} ctx @param {string} id @returns {Promise<HTMLElement | null>} */
export async function packLine(ctx, id) {
  const s = ctx.pack ? await ctx.pack.status(id).catch(() => null) : null;
  if (!s?.stops) return null;
  const when = s.manifest ? downloadedWhen(s.manifest.at) : '';
  const text = !s.manifest ? t`No offline pack for this trip yet.`
    : s.why === 'plan' ? t`The offline pack is from before the plan changed.`
      : when ? t`Offline pack: downloaded ${when}.` : t`Offline pack: downloaded.`;
  return h('p', { class: 'sub pack-line' }, text, sentenceGap(), h('a', { href: /* en */ `#/trip/${encodeURIComponent(id)}` }, t`Offline pack`));
}
