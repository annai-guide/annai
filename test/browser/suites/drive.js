import { createMemoryStore } from '../../fakes/store-memory.js';
import { Workspace } from '../../../src/core/workspace.js';
import { createTrip } from '../../../src/core/scopes.js';
import { record } from '../../../src/core/agent/log.js';
import { renderDrive } from '../../../src/ui/screens/drive.js';

/** Shiori as Driving follows her: whether she is opening, and her events, told to whoever listens. */
function fakeAgent() {
  /** @type {Set<(e: any) => void>} */
  const fns = new Set();
  return {
    opening: Promise.resolve(),
    target: null,
    on: (/** @type {string} */ kind, /** @type {(e: any) => void} */ fn) => {
      if (kind !== 'event') return () => {};
      fns.add(fn);
      return () => { fns.delete(fn); };
    },
    emit: (/** @type {any} */ e) => { for (const fn of fns) fn(e); },
    listening: () => fns.size,
    send() {},
  };
}

/** Waits for a condition, or says it never came. @param {() => boolean} ok @param {string} what */
async function until(ok, what) {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/**
 * Driving's latest card (drive.js), in a real DOM, over the memory store: the order in which it reads the log and hears new cards.
 * @param {any} test @param {any} assert
 */
export default function (test, assert) {
  /**
   * A trip in play with one reminder in its log, and a store whose read of the latest card is held once it has read, until released.
   * @returns {Promise<{ ctx: any, agent: ReturnType<typeof fakeAgent>, store: any, trip: string, read: Promise<void>, release: () => void }>}
   */
  const kit = async () => {
    const store = createMemoryStore();
    const ws = new Workspace(store);
    const trip = await createTrip(ws, { title: 'Big Sur' });
    await record(store, trip, { type: 'reminder', actor: 'system', data: { watch: 'plan:lunch:leave', text: 'Leave soon: Lunch at Nepenthe.' } });
    /** @type {() => void} */
    let reached = () => {};
    /** @type {() => void} */
    let release = () => {};
    const read = new Promise((done) => { reached = () => done(undefined); });
    const gate = new Promise((done) => { release = () => done(undefined); });
    let held = false;
    const slow = {
      ...store,
      tx: (/** @type {any[]} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => {
        const r = store.tx(stores, mode, fn);
        if (held || !stores.includes('events')) return r;
        held = true; // the first read of the log, Driving's of its latest card: it has read when it is held
        return r.then(async (v) => { reached(); await gate; return v; });
      },
    };
    const agent = fakeAgent();
    const live = { play: trip, on: false, gps: 'off', activity: 'unknown', fix: null, onChange: () => () => {}, near: () => null };
    const ctx = { store: slow, ws, agent, live, notices: { card() {}, toast() {} } };
    return { ctx, agent, store, trip, read, release };
  };

  test('a reminder that arrives while Driving reads the latest card is the one it shows (the read had the older one)', async () => {
    const { ctx, agent, store, trip, read, release } = await kit();
    const drawing = renderDrive(ctx);
    await read;
    // Written and told as Shiori's loop does, after Driving's read of the log.
    agent.emit(await record(store, trip, { type: 'reminder', actor: 'system', data: { watch: 'plan:dinner:leave', text: 'Leave now: Dinner at Big Sur Bakery.' } }));
    release();
    const screen = await drawing;
    document.body.append(screen);
    const latest = /** @type {HTMLElement} */ (screen.querySelector('.drive-latest'));
    await until(() => (latest.textContent ?? '').includes('Dinner'), `the newer reminder shown; it shows "${latest.textContent}"`);
    await new Promise((done) => setTimeout(done, 100)); // the older card's drawing, had it gone on, would land by now
    assert.ok(!(latest.textContent ?? '').includes('Lunch'), String(latest.textContent));
    screen.remove();
  });

  test("a long line of Shiori's, still being drawn when a later reminder is shown, does not replace it", async () => {
    const store = createMemoryStore();
    const ws = new Workspace(store);
    const trip = await createTrip(ws, { title: 'Big Sur' });
    // Over the inline limit, so it is stored as a blob: its drawing reads the store once more, which is held here.
    await record(store, trip, { type: 'out.speak', actor: 'shiori', data: { id: 's1', half: 'kokoro' }, texts: [['text', `The long way round. ${'It runs along the cliffs. '.repeat(100)}`]] });
    /** @type {() => void} */
    let reached = () => {};
    /** @type {() => void} */
    let release = () => {};
    const read = new Promise((done) => { reached = () => done(undefined); });
    const gate = new Promise((done) => { release = () => done(undefined); });
    const slow = {
      ...store,
      tx: (/** @type {any[]} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => {
        const r = store.tx(stores, mode, fn);
        return stores.includes('blobs') ? r.then(async (v) => { reached(); await gate; return v; }) : r;
      },
    };
    const agent = fakeAgent();
    const live = { play: trip, on: false, gps: 'off', activity: 'unknown', fix: null, onChange: () => () => {}, near: () => null };
    const drawing = renderDrive({ store: slow, ws, agent, live, notices: { card() {}, toast() {} } });
    await read;
    agent.emit(await record(store, trip, { type: 'reminder', actor: 'system', data: { watch: 'plan:dinner:leave', text: 'Leave now: Dinner at Big Sur Bakery.' } }));
    await new Promise((done) => setTimeout(done, 100)); // the reminder is drawn meanwhile
    release();
    const screen = await drawing;
    document.body.append(screen);
    const latest = /** @type {HTMLElement} */ (screen.querySelector('.drive-latest'));
    await new Promise((done) => setTimeout(done, 100)); // the long line's drawing, had it gone on, would land by now
    assert.ok((latest.textContent ?? '').includes('Dinner'), String(latest.textContent).slice(0, 80));
    assert.ok(!(latest.textContent ?? '').includes('long way'), String(latest.textContent).slice(0, 80));
    screen.remove();
  });

  test('with nothing new meanwhile, Driving shows the latest card the log has, and then each new one', async () => {
    const { ctx, agent, store, trip, release } = await kit();
    release();
    const screen = await renderDrive(ctx);
    document.body.append(screen);
    const latest = /** @type {HTMLElement} */ (screen.querySelector('.drive-latest'));
    await until(() => (latest.textContent ?? '').includes('Lunch'), 'the read card shown');
    agent.emit(await record(store, trip, { type: 'reminder', actor: 'system', data: { watch: 'plan:dinner:leave', text: 'Leave now: Dinner at Big Sur Bakery.' } }));
    await until(() => (latest.textContent ?? '').includes('Dinner'), 'the new card shown');
    screen.remove();
  });

  test("another conversation's card, and a line that is no card, leave Driving's card as it is", async () => {
    const { ctx, agent, store, trip, release } = await kit();
    release();
    const screen = await renderDrive(ctx);
    document.body.append(screen);
    const latest = /** @type {HTMLElement} */ (screen.querySelector('.drive-latest'));
    await until(() => (latest.textContent ?? '').includes('Lunch'), 'the read card shown');
    const other = await createTrip(ctx.ws, { title: 'Kyoto' });
    agent.emit(await record(store, other, { type: 'reminder', actor: 'system', data: { watch: 'plan:tea:leave', text: 'Leave soon: Tea in Kyoto.' } }));
    agent.emit(await record(store, trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Where is the bakery?']] }));
    await new Promise((done) => setTimeout(done, 100));
    assert.ok((latest.textContent ?? '').includes('Lunch'), String(latest.textContent));
    screen.remove();
  });

  test('Driving left, it stops listening at the next card, and draws nothing more', async () => {
    const { ctx, agent, store, trip, release } = await kit();
    release();
    const screen = await renderDrive(ctx);
    document.body.append(screen);
    const latest = /** @type {HTMLElement} */ (screen.querySelector('.drive-latest'));
    await until(() => (latest.textContent ?? '').includes('Lunch'), 'the read card shown');
    assert.equal(agent.listening(), 1);
    screen.remove();
    agent.emit(await record(store, trip, { type: 'reminder', actor: 'system', data: { watch: 'plan:dinner:leave', text: 'Leave now: Dinner at Big Sur Bakery.' } }));
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(agent.listening(), 0);
    assert.ok((latest.textContent ?? '').includes('Lunch'), String(latest.textContent));
  });
}
