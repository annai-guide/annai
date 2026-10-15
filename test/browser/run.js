import { createRunner, assert } from './mini-test.js';

const suite = new URLSearchParams(location.search).get('suite') ?? '';
const out = /** @type {HTMLElement} */ (document.getElementById('out'));
/** @param {{ name: string, ok: boolean, error?: string }[]} results */
const report = (results) => {
  out.textContent = results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n${r.error}`}`).join('\n');
  /** @type {any} */ (window).__results = results;
};
if (!/^[a-z0-9-]+$/.test(suite)) {
  report([{ name: 'suite name', ok: false, error: 'unknown suite' }]);
} else {
  try {
    const { test, run } = createRunner();
    const mod = await import(`./suites/${suite}.js`);
    await mod.default(test, assert);
    report(await run());
  } catch (e) {
    // A suite that can't even load reports at once instead of timing out.
    report([{ name: `load ${suite}`, ok: false, error: String(/** @type {any} */ (e)?.stack ?? e) }]);
  }
}
