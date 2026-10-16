/**
 * Budgets and safeguards (spec §6.6). All are opt-in, with no defaults. Cost is always visible:
 * per wake and per trip, from the model.turn records.
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('./loop.js').Budgets} Budgets
 */

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

/** Local midnight before now, in ms. @param {number} now @param {string} timeZone */
function midnight(now, timeZone) {
  return Math.floor(now / 60_000) * 60_000 - minutes(now, timeZone) * 60_000;
}

/** USD of every model call since local midnight, in every scope. @param {Store} store @param {number} now @param {string} timeZone */
export async function spentToday(store, now, timeZone) {
  const since = midnight(now, timeZone);
  return store.tx(['scopes', 'events'], 'readonly', async (t) => {
    let sum = 0;
    for (const s of await t.listScopes()) {
      for (const e of await t.listEvents(s.id, { types: ['model.turn'], reverse: true, limit: 2000 })) {
        if (e.ts < since) break;
        sum += typeof e.data?.cost === 'number' ? e.data.cost : 0;
      }
    }
    return sum;
  });
}

/** The cost of a conversation, per wake and in all. @param {Store} store @param {string} scope */
export async function costs(store, scope) {
  const turns = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['model.turn'] }));
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

/**
 * Whether a budget ends the turn before the next model call.
 * @param {{ budgets: Budgets, steps: number, spent: number }} c
 * @returns {{ which: 'steps' | 'spend', title: string, body: string } | null}
 */
export function budgetStop({ budgets, steps, spent }) {
  if (budgets.stepsPerWake && steps >= budgets.stepsPerWake) {
    return { which: 'steps', title: 'Shiori stopped: step limit', body: `She took the ${budgets.stepsPerWake} steps a wake may take (Settings → Shiori → Budgets). Ask her to go on if you want more.` };
  }
  if (budgets.spendPerDay && spent >= budgets.spendPerDay) {
    return { which: 'spend', title: "Shiori stopped: today's budget is spent", body: `Today's model calls cost $${spent.toFixed(2)} of the $${budgets.spendPerDay.toFixed(2)} a day you set. She can go on tomorrow, or you can raise it in Settings → Shiori.` };
  }
  return null;
}
