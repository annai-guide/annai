import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { SOURCES, FONTS } from '../../src/ui/credits.js';

const root = new URL('../../', import.meta.url);

/**
 * Hosts annai's code names that aren't data sources, each with why. A new host fails the test below
 * until it is credited on Settings → About (src/ui/credits.js) or added here with its reason.
 * @type {Record<string, string>}
 */
const NOT_SOURCES = {
  'annai.guide': "annai's own site: the app, its catalogs, and the address its requests name",
  'push.annai.guide': "annai's own push relay, which Settings → Notifications and About describe",
  'raw.githubusercontent.com': 'a package the user installs from a GitHub address they give',
  'github.com': "annai's source, and a GitHub repository the user backs up to",
  'api.github.com': 'a GitHub repository the user backs up to',
  's3.us-east-1.amazonaws.com': "a placeholder for the user's own bucket",
  'dav.example.com': "a placeholder for the user's own WebDAV folder",
  'git.example.com': "a placeholder for the user's own Forgejo or Gitea server",
  'codeberg.org': 'a Forgejo server the user may back up to',
  'git-lfs.github.com': "the Git LFS pointer format's name, which a Forgejo place compares files by; nothing is fetched from it",
  'maps.apple.com': 'a link the user opens in their maps app',
  'www.google.com': 'a link the user opens in their maps app',
  'www.openstreetmap.org': 'links to OpenStreetMap: its copyright page, and where a photo was taken',
  'creativecommons.org': 'a licence link',
  'www.w3.org': "SVG's namespace",
  '127.0.0.1': 'this computer, for testing',
};

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Every host named in what annai ships: the service worker's shell, sw.js and the official plugins. @returns {Promise<Map<string, string[]>>} */
async function hostsInCode() {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const shell = [...(/const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').matchAll(/'\/([^']+\.js)'/g)].map((m) => m[1]);
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const f of [...shell, 'sw.js', ...(await walk('plugins-official'))]) {
    const text = await readFile(new URL(f, root), 'utf8');
    for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
      const host = m[1].toLowerCase();
      out.set(host, [...new Set([...(out.get(host) ?? []), f])]);
    }
  }
  return out;
}

/** Hosts of the providers in annai's catalog: endpoints the user chooses, and their key pages. */
async function providerHosts() {
  const text = await readFile(new URL('catalog/templates.json', root), 'utf8');
  return new Set([...text.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
}

const hostOf = (/** @type {string} */ href) => new URL(href).hostname;

test('every data source annai contacts has a credit on Settings → About', async () => {
  const credited = new Set(SOURCES.flatMap((s) => s.hosts));
  const links = new Set(SOURCES.flatMap((s) => s.links.map((l) => hostOf(l.href))));
  const providers = await providerHosts();
  const missing = [...(await hostsInCode())]
    .filter(([host]) => !credited.has(host) && !links.has(host) && !providers.has(host) && !Object.hasOwn(NOT_SOURCES, host))
    .map(([host, files]) => `${host} (${files.join(', ')})`);
  assert.deepEqual(missing, [], 'credit these in src/ui/credits.js, or say in NOT_SOURCES why they are not sources');
});

test('every credited host is one annai still contacts, and every credit says whose it is', async () => {
  const inCode = await hostsInCode();
  for (const s of SOURCES) {
    assert.ok(s.name && s.use && s.credit, `${s.name}: a name, what annai uses it for, and its credit`);
    assert.ok(s.links.length > 0, `${s.name}: a link`);
    for (const l of s.links) assert.match(l.href, /^https:\/\//, `${s.name}: ${l.text}`);
    for (const h of s.hosts) assert.ok(inCode.has(h), `${s.name}: ${h} is credited but no longer in the code`);
  }
});

test("each licence's own attribution is in its credit", () => {
  const by = (/** @type {string} */ name) => /** @type {(typeof SOURCES)[number]} */ (SOURCES.find((s) => s.name === name));
  // OSMF's attribution guidelines: "© OpenStreetMap contributors", linked to its copyright page.
  assert.match(by('OpenStreetMap').credit, /© OpenStreetMap contributors/);
  assert.ok(by('OpenStreetMap').links.some((l) => l.href === 'https://www.openstreetmap.org/copyright'));
  // CC BY-SA 4.0 for Wikipedia and Wikivoyage, with the licence linked.
  for (const n of ['Wikipedia', 'Wikivoyage']) {
    assert.match(by(n).credit, /CC BY-SA 4\.0/);
    assert.ok(by(n).links.some((l) => l.href === 'https://creativecommons.org/licenses/by-sa/4.0/'), n);
  }
  // Open-Meteo's licence page: "Weather data by Open-Meteo.com", linked, under CC BY 4.0.
  assert.match(by('Open-Meteo').credit, /Weather data by Open-Meteo\.com/);
  assert.ok(by('Open-Meteo').links.some((l) => l.href === 'https://open-meteo.com/' && l.text === 'Weather data by Open-Meteo.com'));
  assert.ok(by('Open-Meteo').links.some((l) => l.href === 'https://creativecommons.org/licenses/by/4.0/'));
  // Nominatim's usage policy, linked.
  assert.ok(by('Nominatim').links.some((l) => l.href === 'https://operations.osmfoundation.org/policies/nominatim/'));
});

test('the fonts annai ships are credited, each under the SIL Open Font License', async () => {
  const shipped = (await readdir(new URL('assets/fonts/', root))).filter((f) => f.endsWith('.woff2'));
  const families = new Set(shipped.map((f) => f.replace(/-\d+\.woff2$/, '')));
  assert.deepEqual([...families].sort(), FONTS.map((f) => f.file).sort());
  const ofl = await readFile(new URL('assets/fonts/OFL.txt', root), 'utf8');
  for (const f of FONTS) assert.ok(ofl.includes(f.copyright), `${f.name}'s copyright line is the one in OFL.txt`);
});
