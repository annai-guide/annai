import { h, field } from '../dom.js';
import { SPEEDS } from '../../core/live/sim-run.js';
import { listTrips } from '../../core/scopes.js';
import { answerJSON } from '../../core/answer.js';
import { dayClock } from '../format.js';

const SAMPLE = '/assets/simulations/big-sur.json';
/** @type {Record<string, string>} */
const SPEED_WORDS = { 10: '10 times real time: an hour takes 6 minutes', 60: '60 times: an hour takes a minute', 600: '600 times: an hour takes 6 seconds', fast: 'As fast as it can go: Shiori still answers each wake, so the sample takes about a minute and a long recorded track several' };

/**
 * Settings → Developer → Simulate a trip (spec §13): a sample drive, an itinerary file or a trip's
 * recorded track, played through live mode and Shiori in a new trip of its own (7a choices 9–13).
 * While it runs this screen shows its clock and controls; afterwards, Replay it and Recap it.
 * @param {any} ctx
 */
export async function renderSimulate(ctx) {
  const sim = ctx.sim;
  const screen = h('div', { class: 'screen simulate' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Simulate a trip' }));
  if (!sim) return screen;
  const body = h('div', { class: 'screen' });
  screen.append(body);
  /** @type {any} */
  let timer = null;
  // While it is being built the screen isn't on the page yet; once it has been, leaving it ends the drawing.
  let shown = false;
  const gone = () => {
    if (screen.isConnected) shown = true;
    return shown && !screen.isConnected;
  };
  const draw = async () => {
    clearInterval(timer);
    if (gone()) return;
    body.replaceChildren(...(sim.running ? running(ctx) : [...ended(ctx), await form(ctx)]));
    if (sim.running) {
      timer = setInterval(() => {
        if (gone()) return clearInterval(timer);
        tickTime(ctx, body);
      }, 1000);
      tickTime(ctx, body);
    }
  };
  const off = sim.onChange(() => {
    if (gone()) off();
    else draw();
  });
  await draw();
  return screen;
}

/** The simulated time and how far it has got. @param {any} ctx @param {HTMLElement} body */
function tickTime(ctx, body) {
  const s = ctx.sim.state;
  const now = ctx.sim.now();
  const time = body.querySelector('.sim-time');
  const bar = body.querySelector('progress');
  if (!s || now === null || !time || !bar) return;
  time.textContent = dayClock(now, s.tz);
  bar.value = Math.max(0, now - s.from);
}

/** While it runs (choice 10). @param {any} ctx */
function running(ctx) {
  const sim = ctx.sim;
  const s = sim.state;
  const speed = typeof s.speed === 'number'
    ? field('Speed', (() => {
      const sel = h('select', { id: 'sim-speed' }, ...SPEEDS.map((v) => h('option', { value: String(v), text: SPEED_WORDS[v] })));
      sel.value = String(s.speed);
      sel.addEventListener('change', () => sim.setSpeed(Number(sel.value)));
      return sel;
    })())
    : h('p', { class: 'sub', text: SPEED_WORDS.fast });
  const trip = `#/trip/${encodeURIComponent(s.trip)}`;
  return [
    h('h2', { class: 'section', text: s.title }),
    h('p', { class: 'sim-time now-place' }),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'How far it has got' }), h('progress', { max: String(Math.max(1, s.to - s.from)), value: '0' })),
    speed,
    h('div', { class: 'acts' },
      h('button', { class: 'btn', type: 'button', onclick: () => (s.paused ? sim.resume() : sim.pause()) }, s.paused ? 'Resume' : 'Pause'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => sim.stop() }, 'Stop')),
    h('p', { class: 'sub', text: 'Watch it on Now, Driving and the Conversation; Shiori wakes as with GPS on. Opening another trip stops it.' }),
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/now' }, 'Now'), h('a', { class: 'btn', href: '#/drive' }, 'Driving'), h('a', { class: 'btn', href: '#/talk' }, 'Conversation'), h('a', { class: 'btn', href: trip }, 'The trip')),
  ];
}

/** After one ended: how, and where its trip is. @param {any} ctx */
function ended(ctx) {
  const s = ctx.sim.state;
  if (!s) return [];
  const trip = `#/trip/${encodeURIComponent(s.trip)}`;
  const how = s.error ? `The simulation stopped: ${s.error}` : s.stopped ? 'You stopped the simulation.' : 'The simulation has ended.';
  return [h('section', { class: 'panel', 'aria-label': 'The last simulation' },
    h('h2', { class: 'section', text: s.title }),
    h('p', { role: 'status', text: `${how} What it did is in its own trip.` }),
    h('div', { class: 'acts' },
      h('a', { class: 'btn pri', href: `${trip}/replay` }, 'Replay it'),
      h('a', { class: 'btn', href: `${trip}/recap` }, 'Recap it'),
      h('a', { class: 'btn', href: trip }, 'Open the trip')))];
}

/** Choosing a track and a speed (7a choices 12 and 13). @param {any} ctx */
async function form(ctx) {
  const { active, archived } = await listTrips(ctx.store);
  /** @type {{ id: string, title: string }[]} */
  const recorded = [];
  for (const t of [...active, ...archived]) {
    const two = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(t.id, { types: ['location'], limit: 2 }));
    if (two.length >= 2) recorded.push({ id: t.id, title: t.title });
  }
  const name = `sim-${Math.random().toString(36).slice(2)}`;
  const radio = (/** @type {string} */ value, /** @type {string} */ label, checked = false) => {
    const input = h('input', { type: 'radio', name, value });
    input.checked = checked;
    return { input, el: h('label', { class: 'check' }, input, h('span', { text: label })) };
  };
  const sample = radio('sample', 'Big Sur on Highway 1: a sample drive, about ten hours, with a plan and bookings', true);
  const fromTrip = radio('trip', 'The recorded track of a trip on this device');
  const fromFile = radio('file', 'An itinerary file');
  const trips = h('select', { id: 'sim-trip', disabled: !recorded.length }, ...(recorded.length ? recorded.map((t) => h('option', { value: t.id, text: t.title })) : [h('option', { value: '', text: 'No trip has a recorded track yet' })]));
  const file = h('input', { id: 'sim-file', type: 'file', accept: '.json,application/json' });
  const speed = h('select', { id: 'sim-speed-start' }, ...[...SPEEDS.map(String), 'fast'].map((v) => h('option', { value: v, text: SPEED_WORDS[v] })));
  speed.value = '10';
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const start = h('button', { class: 'btn pri', type: 'button' }, 'Start the simulation');
  start.addEventListener('click', async () => {
    error.hidden = true;
    start.disabled = true;
    try {
      /** @type {any} */
      let source;
      if (fromTrip.input.checked) {
        if (!trips.value) throw new Error('No trip on this device has a recorded track yet: GPS records one while it is on.');
        source = { kind: 'trip', trip: trips.value };
      } else if (fromFile.input.checked) {
        const f = file.files?.[0];
        if (!f) throw new Error('Choose an itinerary file first.');
        source = { kind: 'itinerary', itinerary: readItinerary(await f.text()) };
      } else {
        source = { kind: 'itinerary', itinerary: await answerJSON(await fetch(SAMPLE), 'annai') };
      }
      await ctx.sim.start(source, { speed: speed.value === 'fast' ? 'fast' : Number(speed.value) });
    } catch (e) {
      error.textContent = String(/** @type {any} */ (e)?.message ?? e);
      error.hidden = false;
      start.disabled = false;
    }
  });
  const main = (await ctx.llm?.config().catch(() => null))?.roles?.main?.models ?? [];
  return h('section', { class: 'panel', 'aria-label': 'A new simulation' },
    h('p', { class: 'sub', text: 'A recorded or made-up GPS track, and its clock, run through GPS and Shiori as on a real trip, in a new trip of its own: then replay it and recap it.' }),
    h('p', { class: 'sub', text: main.length
      ? 'Shiori wakes with your own models, as she would with GPS on: the sample wakes her about 24 times. A scripted model (Settings → Models) makes it free.'
      : "No model is set up, so Shiori can't answer: annai shows the reminders itself." }),
    h('fieldset', { class: 'radios' }, h('legend', { text: 'The track' }), sample.el, fromTrip.el, field('Trip', trips), fromFile.el, field('Itinerary file', file)),
    field('Speed', speed),
    error,
    h('div', { class: 'acts' }, start));
}

/** An itinerary file's text, as an itinerary, or a plain error. @param {string} text */
function readItinerary(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    // said below
  }
  throw new Error("That file isn't an itinerary annai can read: it needs to be JSON like the Big Sur sample (a start, a route of places, and times).");
}
