// The browser side of a realtime check: annai served from this checkout, driven in Chromium the way a user would (the
// Gemini provider and its key typed in, a trip, voice on, a tap on Shiori), the microphone and the speaker taps of
// page-mic.mjs installed first, and everything that crosses the live socket noted (kinds, sizes, the transcripts; never an
// address, which holds the key). One scenario is one fresh browser context, so nothing carries over from the last.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium, devices } from '@playwright/test';
import { installMic } from './page-mic.mjs';
import { SOUND } from './analyse.mjs';
import { framesOf } from './frames.mjs';
import { LANGUAGES } from '../../src/core/languages.js';

const SERVE = fileURLToPath(new URL('../serve.mjs', import.meta.url));
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Serves this checkout, or the annai tree at app (its own scripts/serve.mjs), with the security headers as in production, on a port of this machine. @param {number} port @param {string} [app] */
export async function serve(port, app) {
  const child = spawn(process.execPath, [app ? `${app.replace(/\/$/, '')}/scripts/serve.mjs` : SERVE, '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/_headers`).then((r) => r.ok, () => false)) return { origin, stop: () => { child.kill(); } };
    await wait(100);
  }
  child.kill();
  throw new Error('the dev server did not start');
}

/** Opens Chromium as a Pixel 7. */
export function launch() {
  return chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
}

/** annai's own trace since a time: every entry that is not a file or a plugin being written, with its texts. @param {import('@playwright/test').Page} page @param {number} since */
export async function traceSince(page, since) {
  return page.evaluate(async (from) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('annai'); r.onsuccess = () => res(/** @type {IDBDatabase} */ (r.result)); r.onerror = () => rej(r.error); });
    const all = await new Promise((res) => { const q = db.transaction('events').objectStore('events').getAll(); q.onsuccess = () => res(/** @type {any[]} */ (q.result)); });
    const out = [];
    for (const e of /** @type {any[]} */ (all).filter((x) => x.ts >= from && !/^(file\.|plugin\.|location|install)/.test(x.type))) {
      /** @type {string[]} */
      const texts = [];
      for (const h of e.refs ?? []) {
        const b = await new Promise((res) => { const q = db.transaction('blobs').objectStore('blobs').get(h); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
        const bb = /** @type {any} */ (b);
        if (bb && String(bb.type).startsWith('text/') && bb.size < 6000) texts.push(new TextDecoder().decode(bb.data));
      }
      const { url, ...data } = e.data ?? {};
      out.push({ at: e.ts, type: e.type, actor: e.actor, data, ...(texts.length ? { text: texts.join(' | ').slice(0, 400) } : {}) });
    }
    db.close();
    return out;
  }, since);
}

/** Adds the Google Gemini provider from the catalog and types the key in; its free-tier switch is on, as a free key's owner would set it. @param {import('@playwright/test').Page} page @param {string} key */
async function addGemini(page, key) {
  await page.getByRole('heading', { level: 1, name: 'Models' }).waitFor();
  await page.getByRole('button', { name: 'Getting the sign-in ready…' }).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await page.getByLabel('Search the catalog').fill('Google Gemini');
  await page.getByRole('button', { name: /^Add (another )?Google Gemini$/ }).click();
  const byHand = page.getByRole('button', { name: 'Add by hand' });
  const remove = page.getByRole('button', { name: 'Remove provider' });
  await byHand.or(remove).first().waitFor({ timeout: 30_000 });
  if (await byHand.isVisible()) await byHand.click();
  await remove.waitFor({ timeout: 30_000 });
  await page.getByRole('heading', { level: 1, name: 'Google Gemini' }).waitFor();
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('API key').and(page.locator('[placeholder^="saved"]')).waitFor();
  const free = page.getByLabel("This key is on the free tier (Google doesn't charge)");
  await free.check();
  await free.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor();
}

/**
 * Adds a model to Koe's list on the Models screen: "Koe · Realtime" where Koe has two lists (a realtime one and a classic one),
 * else "Koe" (the build with one). @param {import('@playwright/test').Page} page @param {string} model its name in the list
 */
export async function addToKoe(page, model) {
  await page.getByLabel(/^Add a model to Koe/).first().waitFor();
  const name = (await page.getByLabel('Add a model to Koe · Realtime').count()) ? 'Koe · Realtime' : 'Koe';
  const list = page.getByLabel(`Add a model to ${name}`);
  await list.selectOption({ label: model });
  await page.getByRole('button', { name: `Add to ${name}` }).click();
  await list.locator('option', { hasText: new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).waitFor({ state: 'detached' });
}

/**
 * annai set up as a user would: the Google Gemini provider from the catalog, the key typed in, the free-tier switch, a trip,
 * voice on, and (the tap on Shiori is the caller's). With Gemini for Kokoro too, "Use the recommended models" fills Main and Koe
 * (Gemini Live first in Koe, or in Koe · Realtime where Koe has two lists). With a stand-in Kokoro (an Anthropic Messages server at standIn),
 * Custom provider is Main and Gemini only Koe's: Live voice switched on and its model added to Koe (Koe · Realtime), as the e2e tests do.
 * @param {import('@playwright/test').Page} page @param {string} key @param {(s: string) => void} log @param {{ standIn?: string }} [o]
 */
export async function setUp(page, key, log, { standIn } = {}) {
  page.setDefaultTimeout(25_000);
  await page.goto('/#/models');
  await page.locator('main.view > *').first().waitFor();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  if (standIn) {
    await page.getByRole('heading', { level: 1, name: 'Models' }).waitFor();
    await page.getByRole('button', { name: 'Getting the sign-in ready…' }).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
    await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
    // Named Another address in the builds before 2026-10-22 (the control run's tree).
    await page.getByRole('button', { name: /^Add (another )?(Custom provider|Another address)$/ }).click();
    await page.getByLabel('Address', { exact: true }).fill(`${standIn}/kokoro`);
    await page.getByLabel('API key (optional)').fill('sk-test-kokoro');
    await page.getByRole('button', { name: 'Look for what it offers' }).click();
    await page.getByRole('button', { name: 'Add with these' }).click({ timeout: 30_000 });
    const name = page.getByLabel('Name', { exact: true });
    await name.fill('Kokoro stand-in');
    await name.blur();
    await page.getByRole('heading', { level: 1, name: 'Kokoro stand-in' }).waitFor();
    const panel = page.getByRole('region', { name: 'Anthropic Messages', exact: true });
    const use = panel.getByLabel('Use Anthropic Messages');
    if (!(await use.isChecked())) {
      await use.check();
      await use.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 30_000 });
    }
    await panel.getByLabel('Add a model by id').fill('kokoro-model');
    await panel.getByRole('button', { name: 'Add model' }).click();
    await page.getByRole('link', { name: /^kokoro-model/ }).waitFor();
    await page.getByRole('link', { name: '← Models' }).click();
    await page.getByLabel('Add a model to main').selectOption({ label: 'kokoro-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.getByText('1. kokoro-model').waitFor();
    await addGemini(page, key);
    const live = page.getByRole('region', { name: 'Live voice', exact: true }).getByLabel('Use Live voice');
    await live.check();
    await live.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 30_000 });
    await page.goto('/#/models');
    await addToKoe(page, 'Gemini 3.8 Live');
    log('    providers: Kokoro on a stand-in, Koe on Gemini Live');
  } else {
    await addGemini(page, key);
    await page.getByRole('button', { name: 'Use the recommended models' }).click();
    await page.locator('.toast', { hasText: 'Roles updated.' }).waitFor({ timeout: 30_000 });
    log(`    providers: Gemini for both; ${(await page.locator('.toast', { hasText: 'Roles updated.' }).first().innerText()).trim().slice(0, 160)}`);
  }
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await page.getByRole('heading', { name: 'Big Sur' }).waitFor();
  await page.locator('.voice-chip').click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await page.locator('.voice-chip').filter({ hasText: 'Voice on' }).waitFor();
}

/**
 * The languages setting, set the way a user would, in Settings → Shiori → Languages (phase 2): the browser's language (English) is the
 * list's first, the others are added in order (a list of English alone is made by adding a language and removing it again, so it is the
 * user's own), and the answer language is chosen. A build with no such section (the control run on the
 * build before the setting) is left as it is, and the record says so. Returns what the record says of it.
 * @param {import('@playwright/test').Page} page @param {{ spoken: string[], answer: string }} want
 * @returns {Promise<{ spoken: string[], answer: string, applied: boolean, why?: string }>}
 */
export async function setLanguages(page, want) {
  const back = new URL(page.url()).hash || '#/trips';
  await page.goto('/#/shiori');
  const panel = page.getByRole('region', { name: 'Languages', exact: true });
  if (!(await panel.waitFor({ timeout: 8000 }).then(() => true, () => false))) {
    await page.goto(`/${back}`);
    return { ...want, applied: false, why: 'this build of annai has no languages setting' };
  }
  const list = panel.getByRole('list', { name: 'Languages you speak' });
  await list.getByRole('listitem').first().waitFor();
  const shown = (await list.getByRole('listitem').allInnerTexts()).map((t) => t.trim());
  for (const id of want.spoken) {
    const name = LANGUAGES.find((l) => l.id === id)?.name ?? id;
    if (shown.some((t) => t.startsWith(name))) continue;
    await panel.getByLabel('Add a language').selectOption(id);
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await list.getByRole('listitem').filter({ hasText: name }).waitFor();
    await panel.getByRole('status').filter({ hasText: 'Saved' }).first().waitFor();
  }
  // The browser's language alone is only a default, which no model is given as a hint: a user who means it picks it, which is a list of the user's own.
  if (await panel.getByText('None picked').count()) {
    await panel.getByLabel('Add a language').selectOption('ja');
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await list.getByRole('listitem').filter({ hasText: 'Japanese' }).waitFor();
    await panel.getByRole('button', { name: 'Remove Japanese' }).click();
    await list.getByRole('listitem').filter({ hasText: 'Japanese' }).waitFor({ state: 'detached' });
    await panel.getByText('None picked').waitFor({ state: 'detached' });
  }
  if (want.answer !== 'follow') {
    const answer = panel.getByLabel('Shiori answers in');
    await answer.selectOption(want.answer);
    await answer.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  }
  await page.goto(`/${back}`);
  return { ...want, applied: true };
}

/** What one scenario run is given. @typedef {{ origin: string, standIn?: string, key: string, clips: Record<string, string>, roomDb: number | null, settleMs: number, answerTimeoutMs: number, log: (s: string) => void, scrub: (s: string) => string }} Env */

/**
 * One scenario in a fresh context.
 * @param {import('@playwright/test').Browser} browser @param {string} name @param {import('./scenarios.mjs').Scenario} sc @param {Env} env
 * @returns {Promise<import('./analyse.mjs').Rec & { convo: { who: string, text: string }[] }>}
 */
export async function runScenario(browser, name, sc, env) {
  const { log } = env;
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL: env.origin, permissions: ['microphone'] });
  const page = await context.newPage();
  /** @type {import('./analyse.mjs').Frame[]} */
  const frames = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const notes = [];
  /** Only what happens once she is listening counts: setting up probes servers that answer 404. */
  let talking = false;
  page.on('console', (m) => { if (talking && m.type() === 'error' && errors.length < 10) errors.push(`console: ${env.scrub(m.text()).slice(0, 200)}`); });
  page.on('pageerror', (e) => { if (talking && errors.length < 10) errors.push(`page error: ${env.scrub(String(e)).slice(0, 200)}`); });
  page.on('websocket', (ws) => {
    if (!/generativelanguage\.googleapis\.com/.test(ws.url())) return;
    ws.on('framesent', (f) => frames.push(...framesOf('out', f.payload, Date.now())));
    ws.on('framereceived', (f) => frames.push(...framesOf('in', f.payload, Date.now())));
  });
  await page.addInitScript(installMic, { route: sc.route, roomDb: env.roomDb, echo: sc.echoDb === null ? null : { db: sc.echoDb, delayMs: sc.echoDelayMs ?? 60 }, clips: env.clips });
  const began = Date.now();
  /** The record as far as it got. @param {number} opened */
  const collect = async (opened) => {
    const trace = (await traceSince(page, began - 1000)).map((t) => ({ ...t, data: JSON.parse(env.scrub(JSON.stringify(t.data))), ...(t.text ? { text: env.scrub(t.text) } : {}) }));
    const rt = await page.evaluate(() => {
      const r = /** @type {any} */ (window).__rt;
      const lv = (/** @type {number[][]} */ xs) => xs.map((l) => [r.t0 + l[0], Math.round(l[1] * 10_000) / 10_000]);
      return r ? { plays: r.plays, level: lv(r.level), mic: lv(r.mic), opens: r.opens } : { plays: [], level: [], mic: [], opens: 0 };
    });
    const shown = await page.evaluate(() => [...document.querySelectorAll('.notice strong')].map((e) => (e.textContent ?? '').trim())).catch(() => []);
    const cards = [...new Set(shown.filter((c) => !before.includes(c)))].map((c) => env.scrub(c).slice(0, 120));
    const convo = await page.evaluate(() => [...document.querySelectorAll('.convo .you, .convo .shiori, .convo .system-line')].map((e) => ({ who: e.classList.contains('you') ? 'you' : e.classList.contains('system-line') ? 'system' : 'shiori', text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) })));
    // A close annai did not ask for is an error with its kind; the socket's own close code is annai's trace's, not the page's.
    for (const t of trace) {
      if (t.type === 'live.session' && t.data.state === 'closed' && t.data.kind) frames.push({ at: t.at, dir: 'in', kind: 'close', code: t.data.code, reason: `${t.data.kind}: ${t.data.why ?? ''}` });
    }
    return { scenario: name, route: sc.route, echoDb: sc.echoDb, startedAt: opened, endedAt: Date.now(), keyLine: null, plays: rt.plays, frames, level: rt.level, micLevel: rt.mic, trace, errors, notes, cards, convo, ...(languages ? { languages } : {}) };
  };
  let opened = began;
  /** What the scenario asked of the languages setting, and whether this build took it (phase 2). @type {import('./analyse.mjs').Rec['languages']} */
  let languages;
  /** The cards on the page as she starts listening: only those that come after are hers to report. @type {string[]} */
  let before = [];
  try {
    await setUp(page, env.key, log, env.standIn ? { standIn: env.standIn } : {});
    if (sc.languages) {
      languages = await setLanguages(page, sc.languages);
      log(`    languages: ${languages.applied ? `${languages.spoken.join(', ')}; answers in ${languages.answer}` : `not applied (${languages.why})`}`);
    }
    log('    annai is set up; tapping Shiori');
    await page.getByRole('button', { name: 'Shiori' }).click();
    await page.locator('.voice-chip').filter({ hasText: 'Listening live' }).waitFor({ timeout: 40_000 });
    await page.waitForFunction(() => typeof /** @type {any} */ (window).__rt?.say === 'function', null, { timeout: 15_000 });
    talking = true;
    before = await page.evaluate(() => [...document.querySelectorAll('.notice strong')].map((e) => (e.textContent ?? '').trim()));
    await wait(1200); // the detector hears the room before the first word
    opened = frames.find((f) => f.kind === 'setup')?.at ?? began;
    log('    listening live; running the conversation');

    /** The latest time annai played any sound (epoch ms), or 0. */
    const lastSound = async () => page.evaluate((limit) => {
      const rt = /** @type {any} */ (window).__rt;
      for (let i = rt.level.length - 1, n = 0; i >= 0 && n < 400; i--, n++) if (rt.level[i][1] >= limit) return rt.t0 + rt.level[i][0];
      return 0;
    }, SOUND);
    /** The end and the start of the last clip that was played (epoch ms). */
    let lastEnd = 0;
    let lastAt = 0;
    for (const step of sc.steps) {
      if ('say' in step) {
        const p = await page.evaluate(([n, g]) => /** @type {any} */ (window).__rt.say(n, { gainDb: g }), /** @type {[string, number]} */ ([step.say, step.gainDb ?? 0]));
        if (step.say !== 'silence') {
          lastEnd = p.end;
          lastAt = p.at;
        }
        log(`    + ${((p.at - opened) / 1000).toFixed(1)} s  says ${step.say}`);
      } else if ('wait' in step) await wait(step.wait);
      else if ('sounding' in step) {
        const end = Date.now() + 30_000;
        while (Date.now() < end && (await lastSound()) <= lastAt) await wait(100);
        await wait(step.sounding);
      } else {
        // Her answer heard out: audio after the clip, then a turnComplete after that audio (Koe's own tool calls end turns with no sound);
        // when she asked Kokoro, the answer is the one that follows Kokoro's note; then her sound quiet, then ms more. A clip no turn was
        // made of (begun over her on the phone's speaker, let go by design) gets no answer: then only the quiet, from 1.5 s after it.
        const end = Date.now() + env.answerTimeoutMs;
        let why = 'timeout';
        while (Date.now() < end) {
          const after = frames.filter((f) => f.at > lastEnd);
          const heard = after.filter((f) => f.dir === 'in');
          const noteFrame = after.find((f) => f.dir === 'out' && f.kind === 'text' && (f.text ?? '').startsWith('<from_kokoro'));
          const asked = heard.some((f) => f.kind === 'toolCall' && f.name === 'tell_kokoro');
          const from = asked ? noteFrame?.at : lastEnd;
          const complete = from === undefined ? undefined : heard.find((f) => f.kind === 'turnComplete' && f.at > from && (asked || heard.some((a) => a.kind === 'audio' && a.at > from && a.at < f.at)));
          const quietFrom = Math.max(await lastSound(), heard.at(-1)?.at ?? 0, lastEnd);
          if (complete && Date.now() - quietFrom >= Math.max(step.answered, 400)) {
            why = 'answered';
            break;
          }
          const made = frames.some((f) => f.dir === 'out' && f.kind === 'activityStart' && f.at >= lastAt - 200);
          if (!made && Date.now() - lastEnd >= 1500 && Date.now() - quietFrom >= Math.max(step.answered, 400)) {
            why = 'no turn was made of it';
            break;
          }
          await wait(100);
        }
        if (why === 'timeout') notes.push(`no complete answer within ${env.answerTimeoutMs / 1000} s after ${((lastEnd - opened) / 1000).toFixed(1)} s`);
        log(`    + ${((Date.now() - opened) / 1000).toFixed(1)} s  ${why}`);
      }
    }
    await wait(1500);
    // Voice off closes the session; its closing is traced.
    await page.locator('.voice-chip').click();
    await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Off' }).click();
    await page.locator('.voice-chip').filter({ hasText: 'Voice off' }).waitFor();
    await wait(2500);
    return await collect(opened);
  } catch (e) {
    // The run goes no further, but what was recorded is kept, with the page's words as they stood.
    errors.push(`harness: ${env.scrub(String(/** @type {any} */ (e)?.message ?? e)).split('\n').filter((l) => l.trim() && !/^Call log:/.test(l)).slice(0, 3).join(' | ').slice(0, 400)}`);
    notes.push(`the page said: ${env.scrub(await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)}`);
    return await collect(opened).catch((/** @type {any} */ x) => ({ scenario: name, route: sc.route, echoDb: sc.echoDb, startedAt: opened, endedAt: Date.now(), keyLine: null, plays: [], frames, level: [], trace: [], errors: [...errors, `collect: ${env.scrub(String(x?.message ?? x)).slice(0, 200)}`], notes, convo: [], ...(languages ? { languages } : {}) }));
  } finally {
    await context.close();
  }
}

/** The clips as the page takes them: base64 WAV files (silence made here). @param {Record<string, { kind: string, pcm: Float32Array }>} clips */
export async function clipFiles(clips) {
  const { DIR, SEND_RATE } = await import('./clips.mjs');
  const { encodeWav } = await import('../../src/core/voice/pcm.js');
  /** @type {Record<string, string>} */
  const out = {};
  for (const [n, c] of Object.entries(clips)) {
    out[n] = c.kind === 'silence' ? Buffer.from(encodeWav(c.pcm, SEND_RATE)).toString('base64') : (await readFile(new URL(`${n}.wav`, DIR))).toString('base64');
  }
  return out;
}
