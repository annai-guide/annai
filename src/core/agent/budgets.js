/**
 * Budgets and safeguards (spec §6.6). All are opt-in, with no defaults. Cost is always visible:
 * per wake, per trip and over all trips, from the model.turn records, speech requests and live sessions' turns.
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('./loop.js').Budgets} Budgets
 */
import { t } from '../l10n.js';
import { money, num } from '../intl.js';
import { wallClock, instantOf } from '../time.js';

/** Whether an entry carries a call's cost: a role call's model.turn, or a speech request or a live session's turn (their costs aren't in any model.turn). @param {any} e */
const priced = (e) => e.type === 'model.turn' || (e.type === 'net.request' && /^(speech-|realtime$)/.test(String(e.data?.kind ?? '')));

/** Minutes since local midnight. @param {number} now @param {string} timeZone */
function minutes(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
/** @param {string} hhmm */
const parse = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** @param {number} now @param {{ from: string, to: string }} quiet @param {string} timeZone */
export function inQuiet(now, quiet, timeZone) {
  const t = minutes(now, timeZone);
  const from = parse(quiet.from);
  const to = parse(quiet.to);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/** When the quiet hours that hold now end, in ms. @param {number} now @param {{ from: string, to: string }} quiet @param {string} timeZone */
export function quietEnds(now, quiet, timeZone) {
  const t = minutes(now, timeZone);
  const to = parse(quiet.to);
  const left = (to - t + 24 * 60) % (24 * 60) || 24 * 60;
  return Math.floor(now / 60_000) * 60_000 + left * 60_000;
}

/** Local midnight back days before today's: that day's first instant on the phone's clock, also when the clocks change. @param {number} now @param {string} timeZone @param {number} back */
function midnight(now, timeZone, back) {
  const w = wallClock(now, timeZone);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day - back));
  return instantOf({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, timeZone);
}

/**
 * A scope's first page when the range has an edge: one with nothing in it (most, on most days) ends there. 20: in the cost-display
 * design's measurements it read today's spend 4 to 8 times faster than 1000, with the same sum (WebKit, 100 and 300 conversations).
 */
const FIRST = 20;
/** The pages after it, newest first, while the last of the page before is in the range. */
const PAGE = 1000;

/** Whether a priced call answered: a model answered the turn, or the speech or live request came back ok. @param {any} e */
const answered = (e) => (e.type === 'model.turn' ? Boolean(e.data?.answeredBy) : e.data?.outcome === 'ok');

/**
 * USD of the priced calls in every scope since local midnight days[i] - 1 days back (1: today, Spend per day's day; 7: the 6 days
 * before too; Infinity: all time), and how many in the longest range answered with no cost (no prices). Newest first, a FIRST page,
 * then pages while the last of the page before is in the range, so a day of web requests can't hide what was spent; all time reads each scope whole.
 * @param {Store} store @param {number} now @param {string} timeZone @param {number[]} days
 * @returns {Promise<{ sums: number[], unpriced: number }>}
 */
export async function spentIn(store, now, timeZone, days) {
  const since = days.map((n) => (n === Infinity ? -Infinity : midnight(now, timeZone, n - 1)));
  const from = Math.min(...since);
  return store.tx(['scopes', 'events'], 'readonly', async (t) => {
    const sums = since.map(() => 0);
    let unpriced = 0;
    for (const s of await t.listScopes()) {
      /** @type {number | undefined} */
      let before;
      for (let limit = from === -Infinity ? Infinity : FIRST; ; limit = PAGE) {
        const page = await t.listEvents(s.id, { types: ['model.turn', 'net.request'], reverse: true, limit, ...(before ? { before } : {}) });
        const inside = page.filter((e) => e.ts >= from);
        for (const e of inside.filter(priced)) {
          const cost = e.data?.cost;
          if (typeof cost === 'number') since.forEach((c, i) => { if (e.ts >= c) sums[i] += cost; });
          else if (answered(e)) unpriced++;
        }
        // Stops when the page's last (the oldest in the log) is before the range: an older entry in the log is taken to be older in time. So entries written late (stamped before the range and written after today's: a midnight race, a clock set back) end the read early only while one of them is a page's last: a lone one until the next entry is written, a run of them for as many writes as it is long (20 or more in a row on the first page, 1000 on a later one: a clock set back for that many calls, until as many newer ones are written).
        if (page.length < limit || page[page.length - 1].ts < from) break;
        before = page[page.length - 1].seq;
      }
    }
    return { sums, unpriced };
  });
}

/** USD since local midnight, in every scope: Spend per day's. @param {Store} store @param {number} now @param {string} timeZone */
export async function spentToday(store, now, timeZone) {
  return (await spentIn(store, now, timeZone, [1])).sums[0];
}

/** The cost of a conversation, per wake and in all. @param {Store} store @param {string} scope */
export async function costs(store, scope) {
  const turns = (await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['model.turn', 'net.request'] }))).filter(priced);
  /** @type {Map<string, number>} */
  const byWake = new Map();
  let total = 0;
  for (const e of turns) {
    const c = typeof e.data?.cost === 'number' ? e.data.cost : 0;
    total += c;
    if (e.data?.wake) byWake.set(e.data.wake, (byWake.get(e.data.wake) ?? 0) + c);
  }
  return { total, byWake };
}

/** With no Steps per wake set, a turn nobody is watching stops after this many model calls: no one is there to tap Stop on a wake a web page talked into calling tools forever (spec §6.6). */
export const UNWATCHED_STEPS = 50;

/**
 * Whether a budget ends the turn before the next model call. watched: the user started the turn or joined it (isWatched); only
 * a turn nobody watches has annai's own step limit, and only while Steps per wake is empty. What stopped it is data (which, the
 * steps, whether annai's own limit, the spend), kept in the log, with the card's words made from it.
 * @param {{ budgets: Budgets, steps: number, spent: number, watched?: boolean }} c
 * @returns {(BudgetStop & { title: string, body: string }) | null}
 */
export function budgetStop({ budgets, steps, spent, watched = true }) {
  /** @type {BudgetStop | null} */
  let over = null;
  if (budgets.stepsPerWake && steps >= budgets.stepsPerWake) over = { which: 'steps', steps: budgets.stepsPerWake };
  else if (!budgets.stepsPerWake && !watched && steps >= UNWATCHED_STEPS) over = { which: 'steps', steps: UNWATCHED_STEPS, own: true };
  else if (budgets.spendPerDay && spent >= budgets.spendPerDay) over = { which: 'spend', spent, perDay: budgets.spendPerDay };
  return over && { ...over, ...budgetWords(over) };
}

/**
 * @typedef {{ which: 'steps', steps: number, own?: boolean } | { which: 'spend', spent: number, perDay: number }} BudgetStop
 *   own: annai's own limit on a turn nobody watches
 */

/**
 * A budget's card, from what stopped the turn: in the screens' language, or (plain) annai's English for the log.
 * @param {BudgetStop} over @param {boolean} [plain] @returns {{ title: string, body: string }}
 */
export function budgetWords(over, plain = false) {
  if (over.which === 'spend') {
    /* en */
    if (plain) return { title: "Shiori stopped: today's budget is spent", body: `Today's model calls, voices and live talk cost $${over.spent.toFixed(2)} of the $${over.perDay.toFixed(2)} a day you set. She can go on tomorrow, or you can raise it in Settings → Models → Spend per day.` };
    return { title: t`Shiori stopped: today's budget is spent`, body: t`Today's model calls, voices and live talk cost ${money(over.spent)} of the ${money(over.perDay)} a day you set. She can go on tomorrow, or you can raise it in Settings → Models → Spend per day.` };
  }
  /* en */
  if (plain) return { title: 'Shiori stopped: step limit', body: over.own ? `She took ${over.steps} steps on something she was doing on her own, with no one asking, so she stopped there. Ask her to go on if you want more.` : `She took the ${over.steps} steps a wake may take (Settings → Shiori → How often she acts on her own). Ask her to go on if you want more.` };
  return {
    title: t`Shiori stopped: step limit`,
    body: over.own ? t`She took ${num(over.steps)} steps on something she was doing on her own, with no one asking, so she stopped there. Ask her to go on if you want more.`
      : t`She took the ${num(over.steps)} steps a wake may take (Settings → Shiori → How often she acts on her own). Ask her to go on if you want more.`,
  };
}
