import { test, expect } from '@playwright/test';

// What a caller of the shell's render() gets back (a save awaits it before its toast): the screen drawn, however many draws began meanwhile.
// The real startShell, with a fake core: '#/models' draws through renderModels, which awaits llm.ready, a getter that hands out a deferred per
// draw, so the test decides when each draw's screen is ready, or that it never is. '#/ext/probe/*' are a fake plugin's screens.

/** @param {import('@playwright/test').Page} page @param {string} hash */
async function setup(page, hash) {
  await page.route('**/probe.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body></body></html>' }));
  await page.goto(`/probe.html${hash}`);
  await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.unhandled = [];
    addEventListener('unhandledrejection', (e) => { w.unhandled.push(`${e.reason?.name}: ${e.reason?.message ?? e.reason}`); e.preventDefault(); });
    w.defs = [];
    const deferred = () => {
      let res; let rej;
      const p = new Promise((a, b) => { res = a; rej = b; });
      return { p, res, rej };
    };
    w.goCount = 0;
    const llm = {
      get ready() { const d = deferred(); w.defs.push(d); return d.p; },
      config: async () => { throw new Error('probe: drawn'); },
      types: () => new Map(),
    };
    const screens = [
      { pluginId: 'probe', item: { id: 'a', title: 'A', render: (/** @type {any} */ body) => { body.textContent = 'ext A'; } } },
      // A plugin's screen that asks for itself again, once, as it is drawn (ui.go to the address it is on).
      { pluginId: 'probe', item: { id: 'reenter', title: 'R', render: (/** @type {any} */ body, /** @type {any} */ ui) => { body.textContent = 'ext R'; if (w.goCount++ === 0) ui.go(location.hash); } } },
    ];
    const registry = {
      entries: (/** @type {string} */ k) => (k === 'ui:screen' ? screens : []),
      onChange: () => () => {},
      fail: () => {},
      succeeded: () => {},
      isDisabled: () => false,
      clashes: () => [],
    };
    w.track = (/** @type {Promise<unknown>} */ p) => {
      const s = { state: 'pending', error: '' };
      p.then(() => { s.state = 'resolved'; }, (e) => { s.state = 'rejected'; s.error = `${e?.name}: ${e?.message ?? e}`; });
      return s;
    };
    const at = (/** @type {string} */ p) => p; // an address the browser loads, not a module the checker follows
    const { startShell } = await import(at('/src/ui/shell.js'));
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    w.shell = startShell(root, { registry, llm, plugins: { langOf: () => 'en' }, updates: { restart: async () => {}, waiting: false, plugins: async () => [] }, version: 'probe' });
  });
}

const settle = (/** @type {import('@playwright/test').Page} */ page, ms = 300) => page.waitForTimeout(ms);
const states = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ names) => page.evaluate((n) => n.split(',').map((k) => /** @type {any} */ (window)[k].state + ((/** @type {any} */ (window))[k].error ? ` (${(/** @type {any} */ (window))[k].error})` : '')).join(' / '), names);

test('draws that a newer one supersedes end when the newest lands, a chain of three', async ({ page }) => {
  await setup(page, '#/models');
  await page.evaluate(() => /** @type {any} */ (window).defs[0].res()); // the first draw, startShell's
  await expect(page.getByText('probe: drawn')).toBeVisible();
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.a = w.track(w.shell.render()); w.b = w.track(w.shell.render()); w.c = w.track(w.shell.render()); });
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.defs[1].res(); w.defs[2].res(); });
  await settle(page);
  expect(await states(page, 'a,b,c'), 'the two older screens are ready, but they are not what is shown').toBe('pending / pending / pending');
  await page.evaluate(() => /** @type {any} */ (window).defs[3].res());
  await settle(page);
  expect(await states(page, 'a,b,c')).toBe('resolved / resolved / resolved');
});

test('a draw navigating to a screen that waits ends when a later draw lands, not on that one, which may never finish', async ({ page }) => {
  await setup(page, '#/models');
  await page.evaluate(() => /** @type {any} */ (window).defs[0].res());
  await expect(page.getByText('probe: drawn')).toBeVisible();
  // A save's ctx.render() on Models; the user taps a tab meanwhile (Voice also awaits llm.ready, which never comes).
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.a = w.track(w.shell.render()); location.hash = '#/voice'; });
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).defs.length)).toBe(3);
  await page.evaluate(() => /** @type {any} */ (window).defs[1].res());
  await settle(page, 1000);
  expect(await states(page, 'a'), 'the screen it navigated to has not drawn').toBe('pending');
  // The user goes on to a screen that draws at once: whatever landed ends the save's render.
  await page.evaluate(() => { location.hash = '#/ext/probe/a'; });
  await expect(page.getByText('ext A')).toBeVisible();
  await settle(page);
  expect(await states(page, 'a')).toBe('resolved');
});

test('an error page is a draw that landed: the draws it superseded end with it', async ({ page }) => {
  await setup(page, '#/models');
  await page.evaluate(() => /** @type {any} */ (window).defs[0].res());
  await expect(page.getByText('probe: drawn')).toBeVisible();
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.a = w.track(w.shell.render()); w.b = w.track(w.shell.render()); w.defs[1].res(); w.defs[2].rej(new Error('boom')); });
  await expect(page.getByText('boom')).toBeVisible();
  await settle(page);
  expect(await states(page, 'a,b')).toBe('resolved / resolved');
});

test("a plugin's screen that asks for itself as it is drawn: the draw it began from resolves, with no error", async ({ page }) => {
  await setup(page, '#/ext/probe/reenter');
  await expect(page.getByText('ext R')).toBeVisible();
  await settle(page);
  expect(await page.evaluate(() => /** @type {any} */ (window).unhandled), "startShell's own first draw").toEqual([]);
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.goCount = 0; w.a = w.track(w.shell.render()); });
  await settle(page);
  expect(await states(page, 'a')).toBe('resolved');
  expect(await page.evaluate(() => /** @type {any} */ (window).unhandled)).toEqual([]);
});
