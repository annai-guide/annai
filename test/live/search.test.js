// Opt-in: asks annai's free search services one real question each, keyless (a few requests; the services are free tiers of
// other people, so run it rarely). Notices a vendor that went keyed or closed its browser access (CORS) before a user does.
//   ANNAI_LIVE_SEARCH=1 npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_PROVIDERS } from '../../src/plugins/web/free.js';
import { normalizeRows } from '../../src/core/web-search.js';

const skip = process.env.ANNAI_LIVE_SEARCH ? false : 'ANNAI_LIVE_SEARCH is not set';
const ORIGIN = 'https://annai.guide';
const ADDRESS = { exa: 'https://mcp.exa.ai/mcp', parallel: 'https://search.parallel.ai/mcp', firecrawl: 'https://mcp.firecrawl.dev/v2/mcp' };

for (const p of FREE_PROVIDERS) {
  test(`${p.name}: answers a keyless search from annai's origin, and lets a web app read it`, { skip }, async () => {
    // A browser asks first whether annai's origin may send the request's headers; the answer must allow it.
    const pre = await fetch(/** @type {Record<string, string>} */ (ADDRESS)[p.id], { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': p.id === 'exa' ? 'content-type,x-exa-source' : 'content-type' } });
    assert.ok(pre.status >= 200 && pre.status < 300, `preflight ${pre.status}`);
    assert.match(String(pre.headers.get('access-control-allow-origin')), new RegExp(`^(\\*|${ORIGIN.replace(/\./g, '\\.')})$`));
    assert.match(String(pre.headers.get('access-control-allow-headers')), /content-type|\*/i);
    if (p.id === 'exa') assert.match(String(pre.headers.get('access-control-allow-headers')), /x-exa-source|\*/i);
    /** @type {string | null} */
    let allowed = null;
    const asBrowser = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      const res = await fetch(url, { ...init, headers: { ...init.headers, origin: ORIGIN } });
      allowed = res.headers.get('access-control-allow-origin');
      return res;
    };
    const rows = normalizeRows(await p.search('Nepenthe restaurant Big Sur opening hours', { fetch: asBrowser, signal: AbortSignal.timeout(20_000), limit: 8 }), 'Nepenthe restaurant Big Sur opening hours');
    assert.ok(rows.length > 0, 'no rows');
    assert.ok(rows.every((r) => /^https?:\/\//.test(r.url) && r.snippet.length <= 400));
    assert.match(String(allowed), /^(\*|https:\/\/annai\.guide)$/, 'the answer carries no CORS header for annai');
  });
}
