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
import { key } from '../../src/core/l10n.js';

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

/**
 * annai's trace entries of some types since a time (ms), as {at, type, data}: no blobs read, so it can be polled.
 * @param {import('@playwright/test').Page} page @param {string[]} types @param {number} since
 * @returns {Promise<{ at: number, type: string, data: any }[]>}
 */
export async function eventsOf(page, types, since) {
  return page.evaluate(async ([want, from]) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('annai'); r.onsuccess = () => res(/** @type {IDBDatabase} */ (r.result)); r.onerror = () => rej(r.error); });
    const all = await new Promise((res) => { const q = db.transaction('events').objectStore('events').getAll(); q.onsuccess = () => res(/** @type {any[]} */ (q.result)); });
    db.close();
    return /** @type {any[]} */ (all).filter((e) => e.ts >= from && want.includes(e.type)).map((e) => ({ at: e.ts, type: e.type, data: e.data ?? {} }));
  }, /** @type {[string[], number]} */ ([types, since]));
}

/** Adds the Google Gemini provider from the catalog and types the key in; its free-tier switch is on, as a free key's owner would set it. @param {import('@playwright/test').Page} page @param {string} key */
export async function addGemini(page, key) {
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
  // Named Koe in the first builds, Koe · Realtime, and Koe · Live from the build that renamed it (2026-11).
  let name = 'Koe';
  for (const n of ['Koe · Live', 'Koe · Realtime']) if (await page.getByLabel(new RegExp(`^Add a model to ${n}`)).count()) { name = n; break; }
  const list = page.getByLabel(name === 'Koe' ? 'Add a model to Koe' : new RegExp(`^Add a model to ${name}`));
  await list.selectOption({ label: model });
  await page.getByRole('button', { name: `Add to ${name}` }).click();
  await list.locator('option', { hasText: new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).waitFor({ state: 'detached' });
}

/**
 * annai set up as a user would: the Google Gemini provider from the catalog, the key typed in, the free-tier switch, a trip,
 * voice on, and (the tap on Shiori is the caller's). With Gemini for Kokoro too, "Use the recommended models" fills Main and Koe
 * (Gemini Live first in Koe, or in Koe · Realtime where Koe has two lists). With a stand-in Kokoro (an Anthropic Messages server at standIn),
 * Custom provider is Main and Gemini only Koe's: Live voice switched on and its model added to Koe (Koe · Realtime), as the e2e tests do.
 * card (stage 5, with a stand-in): also a stand-in voice for annai's own spoken question (a Custom provider's Voice, first in speech-out), and a trip
 * of the user's, Testville, dated this week, made before the conversation Koe talks in (Big Sur, a chat); the Always setting stays off.
 * classic (with a stand-in, and card): classic voice, no live session: Koe has no live model (Gemini's Live voice stays off), the user's own speech-to-text
 * server is Speech in (Local speech server, at the stand-in's /asr, which passes transcription requests on), and Gemini 3.5 Flash Lite, which adding
 * Gemini puts in Quick decision, is the gate.
 * real (with a stand-in, for its voice, and card): Kokoro is the real model, Claude Opus 5.5 through the Anthropic provider (given its key), and the utility
 * and quick-decision models Claude Haiku 5.5, which adding the provider put there; Koe is on Gemini Live as before, and Gemini's chat models are taken out of
 * Main, Utility and Quick decision so that no free model answers for a real one that fails.
 * @param {import('@playwright/test').Page} page @param {string} key @param {(s: string) => void} log @param {{ standIn?: string, card?: boolean, classic?: boolean, real?: { anthropic: string } | null }} [o]
 * @returns {Promise<{ testville?: string, chat: string }>} the trips' ids
 */
export async function setUp(page, key, log, { standIn, card = false, classic = false, real = null } = {}) {
  page.setDefaultTimeout(25_000);
  await page.goto('/#/models');
  await page.locator('main.view > *').first().waitFor();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  if (standIn && real) {
    await addAnthropic(page, real.anthropic);
    await page.goto('/#/models');
    await page.getByRole('button', { name: 'Remove Claude Sonnet 5.5 from main' }).click();
    await page.getByRole('button', { name: 'Remove Claude Sonnet 5.5 from main' }).waitFor({ state: 'detached' });
    await addToRole(page, 'main', 'Claude Opus 5.5');
    await addGemini(page, key);
    const live = page.getByRole('region', { name: 'Live voice', exact: true }).getByLabel('Use Live voice');
    await live.check();
    await live.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 30_000 });
    await page.goto('/#/models');
    await addToKoe(page, 'Gemini 3.8 Live');
    await addVoiceStandIn(page, standIn);
    // Gemini's chat models were put behind the real ones in Main, Utility and Quick decision: out, so a real model that fails is not answered for by a free one.
    await page.goto('/#/models');
    for (const role of ['main', 'utility', 'decide']) {
      const gone = page.getByRole('button', { name: new RegExp(`^Remove Gemini .* from ${role}$`) });
      for (let i = 0; i < 6 && (await gone.count()); i++) {
        await gone.first().click();
        await page.waitForTimeout(400);
      }
    }
    log('    providers: Kokoro is Claude Opus 5.5 (Anthropic), utility and quick decision Claude Haiku 5.5, Koe on Gemini Live, speech out on a stand-in voice');
  } else if (standIn) {
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
    await page.getByRole('link', { name: 'Models', exact: true }).click();
    await page.getByLabel('Add a model to main').selectOption({ label: 'kokoro-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.getByText('1. kokoro-model').waitFor();
    await addGemini(page, key);
    if (classic) {
      // No Koe: Shiori is the one model. The gate is Gemini's small model (adding the provider put it in Quick decision), and her ears are the user's own server.
      await page.goto('/#/models');
      await addVoiceStandIn(page, standIn);
      await addTranscription(page, standIn);
      log('    providers: Kokoro on a stand-in, no Koe, the gate on Gemini 3.5 Flash Lite, speech in on the user\'s server (through 127.0.0.1), speech out on a stand-in voice');
    } else {
      const live = page.getByRole('region', { name: 'Live voice', exact: true }).getByLabel('Use Live voice');
      await live.check();
      await live.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 30_000 });
      await page.goto('/#/models');
      await addToKoe(page, 'Gemini 3.8 Live');
      if (card) await addVoiceStandIn(page, standIn);
      log(`    providers: Kokoro on a stand-in, Koe on Gemini Live${card ? ', speech out on a stand-in voice' : ''}`);
    }
  } else {
    await addGemini(page, key);
    await page.getByRole('button', { name: 'Use the recommended models' }).click();
    await page.locator('.toast', { hasText: 'Roles updated.' }).waitFor({ timeout: 30_000 });
    log(`    providers: Gemini for both; ${(await page.locator('.toast', { hasText: 'Roles updated.' }).first().innerText()).trim().slice(0, 160)}`);
  }
  /** @type {string | undefined} */
  let testville;
  if (card) {
    // Another trip of the user's, dated this week (a trip, not a chat: it has dates); then the conversation Koe talks in.
    const day = (/** @type {number} */ plus) => new Date(Date.now() + plus * 86_400_000).toISOString().slice(0, 10);
    await page.goto('/#/trips');
    await page.getByLabel('Trip name').fill('Testville');
    await page.getByText('Add dates (optional)').click();
    await page.getByLabel('Starts').fill(day(0));
    await page.getByLabel('Ends').fill(day(7));
    await page.getByRole('button', { name: 'Start trip' }).click();
    await page.getByRole('heading', { name: 'Testville' }).waitFor();
    testville = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  }
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await page.getByRole('heading', { name: 'Big Sur' }).waitFor();
  const chat = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await voiceSwitch(page, 'On');
  return { ...(testville ? { testville } : {}), chat };
}

/** Adds the Anthropic provider from the catalog and types its key in. @param {import('@playwright/test').Page} page @param {string} key */
async function addAnthropic(page, key) {
  await page.getByRole('heading', { level: 1, name: 'Models' }).waitFor();
  await page.getByRole('button', { name: 'Getting the sign-in ready…' }).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await page.getByLabel('Search the catalog').fill('Anthropic');
  await page.getByRole('button', { name: /^Add (another )?Anthropic$/ }).click();
  const byHand = page.getByRole('button', { name: 'Add by hand' });
  const remove = page.getByRole('button', { name: 'Remove provider' });
  await byHand.or(remove).first().waitFor({ timeout: 30_000 });
  if (await byHand.isVisible()) await byHand.click();
  await remove.waitFor({ timeout: 30_000 });
  await page.getByRole('heading', { level: 1, name: 'Anthropic' }).waitFor();
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('API key').and(page.locator('[placeholder^="saved"]')).waitFor();
}

/**
 * Adds a model to a role's list on the Models screen. @param {import('@playwright/test').Page} page @param {string} role the list's name (main, decide, speech-in...) @param {string} model its name in the list
 */
export async function addToRole(page, role, model) {
  const list = page.getByLabel(new RegExp(`^Add a model to ${role}`));
  await list.selectOption({ label: model });
  await page.getByRole('button', { name: `Add to ${role}` }).click();
  await list.locator('option', { hasText: new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).waitFor({ state: 'detached' });
}

/**
 * Speech in, as a user with a server of their own sets it up: Add a provider for speech-in, Local speech server, its address (the stand-in's /asr, which
 * passes a transcription request on to the user's server: annai calls only https addresses, or http on this device), its Transcription switched on, the model
 * qwen3-asr-1.7b by id, and the model first in Speech in. @param {import('@playwright/test').Page} page @param {string} standIn
 */
export async function addTranscription(page, standIn) {
  await page.goto('/#/models');
  await page.getByRole('link', { name: 'Add a provider for speech-in' }).click();
  await page.getByRole('button', { name: /^Add (another )?Local speech server$/ }).click();
  const byHand = page.getByRole('button', { name: 'Add by hand' });
  const remove = page.getByRole('button', { name: 'Remove provider' });
  await byHand.or(remove).first().waitFor({ timeout: 30_000 });
  if (await byHand.isVisible()) await byHand.click();
  await remove.waitFor({ timeout: 30_000 });
  await page.getByLabel('Name', { exact: true }).fill('Halo speech');
  await page.getByLabel('Address', { exact: true }).fill(`${standIn}/asr/v1`);
  await page.getByLabel('API key', { exact: true }).fill('sk-test-asr');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { level: 1, name: 'Halo speech' }).waitFor();
  await page.getByLabel('API key', { exact: true }).and(page.locator('[placeholder^="saved"]')).waitFor();
  const panel = page.getByRole('region', { name: 'Transcription', exact: true });
  const use = panel.getByLabel('Use Transcription');
  if (!(await use.isChecked())) {
    await use.check();
    await use.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 30_000 });
  }
  await panel.getByLabel('Add a model by id').fill('qwen3-asr-1.7b');
  await panel.getByRole('button', { name: 'Add model' }).click();
  await page.getByRole('link', { name: /^qwen3-asr-1\.7b/ }).waitFor();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await addToRole(page, 'speech-in', 'qwen3-asr-1.7b');
}

/**
 * A stand-in voice for annai's own spoken question: a Custom provider at the stand-in's /voice, its Voice ability on, one model, first in speech-out (the
 * browser's voice says nothing in a container, and what it says is not in the page's audio). From the Models screen, as a user would.
 * @param {import('@playwright/test').Page} page @param {string} standIn
 */
export async function addVoiceStandIn(page, standIn) {
  await page.goto('/#/models');
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await page.getByRole('button', { name: /^Add (another )?(Custom provider|Another address)$/ }).click();
  await page.getByLabel('Address', { exact: true }).fill(`${standIn}/voice`);
  await page.getByLabel('API key (optional)').fill('sk-test-voice');
  await page.getByRole('button', { name: 'Look for what it offers' }).click();
  await page.getByRole('button', { name: 'Add with these' }).click({ timeout: 30_000 });
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('Voice stand-in');
  await name.blur();
  await page.getByRole('heading', { level: 1, name: 'Voice stand-in' }).waitFor();
  const panel = page.getByRole('region', { name: 'Voice', exact: true });
  const use = panel.getByLabel('Use Voice');
  if (!(await use.isChecked())) {
    await use.check();
    await use.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 30_000 });
  }
  await panel.getByLabel('Add a model by id').fill('voice');
  await panel.getByRole('button', { name: 'Add model' }).click();
  await page.getByRole('link', { name: /^voice/ }).waitFor();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  const list = page.getByLabel('Add a model to speech-out');
  await list.selectOption({ label: 'voice' });
  await page.getByRole('button', { name: 'Add to speech-out' }).click();
  await list.locator('option', { hasText: /^voice$/ }).waitFor({ state: 'detached' });
}

/**
 * The voice chip's switch: a tap on the chip turns voice on or off in the current build (2026-11); the builds before it opened a Voice group with On and Off buttons.
 * @param {import('@playwright/test').Page} page @param {'On' | 'Off'} to @param {(en: string, context?: string) => string} [w] the screens' words
 */
export async function voiceSwitch(page, to, w = (en) => en) {
  const chip = page.locator('.voice-chip');
  await chip.click();
  const group = page.getByRole('group', { name: w('Voice', 'voice mode') });
  if (await group.waitFor({ timeout: 1500 }).then(() => true, () => false)) await group.getByRole('button', { name: w(to) }).click();
  await chip.filter({ hasText: w(`Voice ${to.toLowerCase()}`) }).waitFor();
}

/**
 * The languages setting, set the way a user would, in Settings → Languages (Settings → Shiori before phone-fixes-1; an older build is
 * looked for there): the browser's language (English) is the
 * list's first, the others are added in order (a list of English alone is made by adding a language and removing it again, so it is the
 * user's own), and the answer language is chosen. A build with no such section (the control run on the
 * build before the setting) is left as it is, and the record says so. Returns what the record says of it.
 * @param {import('@playwright/test').Page} page @param {{ spoken: string[], answer: string }} want
 * @returns {Promise<{ spoken: string[], answer: string, applied: boolean, why?: string }>}
 */
export async function setLanguages(page, want) {
  const back = new URL(page.url()).hash || '#/trips';
  const panel = await languagesPanel(page);
  if (!panel) {
    await page.goto(`/${back}`);
    return { ...want, applied: false, why: 'this build of annai has no languages setting' };
  }
  const list = panel.getByRole('list', { name: 'Languages you speak' });
  await list.getByRole('listitem').first().waitFor();
  const shown = (await list.getByRole('listitem').allInnerTexts()).map((t) => t.trim());
  for (const id of want.spoken) {
    const name = LANGUAGES.find((l) => l.id === id)?.name ?? id;
    // A row reads "1. English" (with its handle) since phone-fixes-1, "English" before.
    if (shown.some((t) => new RegExp(`^(\\d+\\.\\s*)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t))) continue;
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

/**
 * Settings → Languages, its section with the list, opened; on an older build, Settings → Shiori's; null when neither has it.
 * @param {import('@playwright/test').Page} page
 */
async function languagesPanel(page) {
  for (const hash of ['#/languages', '#/shiori']) {
    await page.goto(`/${hash}`);
    const panel = page.getByRole('region', { name: 'Languages', exact: true }).filter({ has: page.getByRole('list', { name: 'Languages you speak' }) });
    if (await panel.waitFor({ timeout: 8000 }).then(() => true, () => false)) return panel;
  }
  return null;
}

/**
 * The screens' language chosen in Settings → Languages (Settings → Shiori on an older build), the way a user would, once annai is
 * set up in English; annai restarts in it. Returns the words of that language, by English (and a context), for the locators after it.
 * @param {import('@playwright/test').Page} page @param {string} tag
 */
export async function setScreens(page, tag) {
  const back = new URL(page.url()).hash || '#/trips';
  await languagesPanel(page);
  const restarted = page.waitForEvent('load');
  await page.locator('#language-ui').selectOption(tag);
  await restarted;
  await page.waitForFunction((t) => document.documentElement.lang.startsWith(t), tag);
  const words = JSON.parse(await readFile(new URL(`../../l10n/${tag}.json`, import.meta.url), 'utf8'));
  await page.goto(`/${back}`);
  return (/** @type {string} */ en, /** @type {string} */ context = '') => words[key(en, context)] ?? en;
}

/** What one scenario run is given. ui: the screens' language (localization L6); kokoro: the stand-in Kokoro itself (stage 5: it is told which trip a marked question reads); real: the Anthropic key (read by the script, typed into the page, never written) and the most model requests a scenario may make (the 31st is refused). @typedef {{ origin: string, standIn?: string, kokoro?: { readTrip: (id: string | null) => void, log: any[] }, real?: { anthropic: string, cap: number }, key: string, clips: Record<string, string>, roomDb: number | null, settleMs: number, answerTimeoutMs: number, ui?: string, log: (s: string) => void, scrub: (s: string) => string }} Env */

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
      return r ? { plays: r.plays, level: lv(r.level), mic: lv(r.mic), opens: r.opens, media: r.media ?? [] } : { plays: [], level: [], mic: [], opens: 0, media: [] };
    });
    const shown = await page.evaluate(() => [...document.querySelectorAll('.notice strong')].map((e) => (e.textContent ?? '').trim())).catch(() => []);
    const cards = [...new Set(shown.filter((c) => !before.includes(c)))].map((c) => env.scrub(c).slice(0, 120));
    const convo = await page.evaluate(() => [...document.querySelectorAll('.convo .you, .convo .shiori, .convo .system-line')].map((e) => ({ who: e.classList.contains('you') ? 'you' : e.classList.contains('system-line') ? 'system' : 'shiori', text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) })));
    // A close annai did not ask for is an error with its kind; the socket's own close code is annai's trace's, not the page's.
    for (const t of trace) {
      if (t.type === 'live.session' && t.data.state === 'closed' && t.data.kind) frames.push({ at: t.at, dir: 'in', kind: 'close', code: t.data.code, reason: `${t.data.kind}: ${t.data.why ?? ''}` });
    }
    // The conversation's own lines (a card's too, with its buttons and whether they are on), as the page shows them at the end.
    const lines = sc.card ? await page.evaluate(() => [...document.querySelectorAll('.convo li')].map((e) => ({ who: (e.querySelector('.who')?.textContent ?? '').trim(), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), buttons: [...e.querySelectorAll('button')].map((b) => ({ name: (b.textContent ?? '').trim(), disabled: /** @type {HTMLButtonElement} */ (b).disabled })) }))).catch(() => []) : [];
    return { scenario: name, route: sc.route, echoDb: sc.echoDb, startedAt: opened, endedAt: Date.now(), keyLine: null, plays: rt.plays, frames, level: rt.level, micLevel: rt.mic, trace, errors, notes, cards, convo, ...(sc.mode ? { mode: sc.mode } : {}), ...(sc.real ? { model: { requests: modelRequests, capped } } : {}), ...(sc.card ? { media: rt.media, taps, lines, kokoro: (env.kokoro?.log ?? []).filter((x) => x.at >= began).map((x) => ({ ...x, text: env.scrub(x.text ?? '') })) } : {}), ...(languages ? { languages } : {}) };
  };
  let opened = began;
  /** Requests to the real model so far, and whether the cap refused one. */
  let modelRequests = 0;
  let capped = false;
  /** The taps the scenario made on annai's card (epoch ms of the click, the button). @type {{ at: number, label: string, ok: boolean }[]} */
  const taps = [];
  /** What the scenario asked of the languages setting, and whether this build took it (phase 2). @type {import('./analyse.mjs').Rec['languages']} */
  let languages;
  /** The cards on the page as she starts listening: only those that come after are hers to report. @type {string[]} */
  let before = [];
  try {
    const classic = sc.mode === 'classic';
    const trips = await setUp(page, env.key, log, env.standIn ? { standIn: env.standIn, card: sc.card === true, classic, ...(sc.real && env.real ? { real: { anthropic: env.real.anthropic } } : {}) } : {});
    if (sc.card && !sc.real) env.kokoro?.readTrip(trips.testville ?? null);
    // A real model is asked at most cap times (the 31st is refused, and the record says so): a runaway loop of tool calls stops here.
    const real = sc.real ? env.real : undefined;
    if (real) {
      await context.route('https://api.anthropic.com/v1/messages*', (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        if (++modelRequests > real.cap) {
          capped = true;
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
    }
    if (sc.languages) {
      languages = await setLanguages(page, sc.languages);
      log(`    languages: ${languages.applied ? `${languages.spoken.join(', ')}; answers in ${languages.answer}` : `not applied (${languages.why})`}`);
    }
    /** The screens' words for the English the locators below name. @type {(en: string, context?: string) => string} */
    let w = (en) => en;
    if (env.ui) {
      w = await setScreens(page, env.ui);
      log(`    annai's screens: ${env.ui}`);
    }
    log('    annai is set up; tapping Shiori');
    await page.getByRole('button', { name: w('Shiori') }).click();
    // Classic voice has no live session: the tap opens a listening window, and the microphone with it.
    if (!classic) await page.locator('.voice-chip').filter({ hasText: w('Listening live') }).waitFor({ timeout: 40_000 });
    await page.waitForFunction(() => typeof /** @type {any} */ (window).__rt?.say === 'function', null, { timeout: classic ? 30_000 : 15_000 });
    talking = true;
    // The card is annai's own, in the conversation: its buttons are tapped there (the e2e's read-trip does the same).
    if (sc.card) await page.goto(`/#/trip/${trips.chat}/talk`);
    before = await page.evaluate(() => [...document.querySelectorAll('.notice strong')].map((e) => (e.textContent ?? '').trim()));
    await wait(1200); // the detector hears the room before the first word
    opened = frames.find((f) => f.kind === 'setup')?.at ?? Date.now();
    log(classic ? '    listening (classic voice); running the conversation' : '    listening live; running the conversation');

    /** The latest time annai played any sound (epoch ms), or 0. */
    const lastSound = async () => page.evaluate((limit) => {
      const rt = /** @type {any} */ (window).__rt;
      for (let i = rt.level.length - 1, n = 0; i >= 0 && n < 400; i--, n++) if (rt.level[i][1] >= limit) return rt.t0 + rt.level[i][0];
      return 0;
    }, SOUND);
    /** The end and the start of the last clip that was played (epoch ms). */
    let lastEnd = 0;
    let lastAt = 0;
    /** annai's card for read_trip, once it is up (its trace entry's time), and the end of its question once it was said (epoch ms). */
    const card = { at: 0, qStart: 0, qEnd: 0 };
    /** The page's log of its own player (the question's start and end), after a time. @param {number} since @param {string} kind */
    const mediaAfter = (since, kind) => page.evaluate(([from, k]) => (/** @type {any} */ (window).__rt?.media ?? []).find((/** @type {any} */ m) => m.kind === k && m.at >= from)?.at ?? 0, /** @type {[number, string]} */ ([since, kind]));
    for (const step of sc.steps) {
      if ('ask' in step) {
        // Waits for annai's own card (an out.ask of its own), whatever the chain of Koe, Kokoro and the tool takes.
        const end = Date.now() + step.ask;
        while (Date.now() < end && !card.at) {
          card.at = (await eventsOf(page, ['out.ask'], began - 1000)).find((e) => e.data?.own === true)?.at ?? 0;
          if (!card.at) await wait(150);
        }
        if (!card.at) notes.push(`annai's card never came within ${step.ask / 1000} s`);
        else log(`    + ${((card.at - opened) / 1000).toFixed(1)} s  annai's card is up`);
      } else if ('asked' in step || 'asking' in step) {
        // The question said (its player ended), or only begun, and ms more. Without the card, nothing waits.
        const kind = 'asked' in step ? 'ended' : 'playing';
        const ms = 'asked' in step ? step.asked : step.asking;
        if (card.at) {
          const end = Date.now() + 20_000;
          let at = 0;
          while (Date.now() < end && !at) {
            at = await mediaAfter(card.at - 50, kind);
            if (!at) await wait(50);
          }
          if (!at) notes.push(`annai's question was not heard ${kind === 'ended' ? 'to end' : 'to begin'} within 20 s of the card`);
          else if (kind === 'ended') card.qEnd = at;
          else card.qStart = at;
          log(`    + ${(((at || Date.now()) - opened) / 1000).toFixed(1)} s  the question ${kind === 'ended' ? 'is said' : 'begins'}`);
        }
        await wait(ms);
      } else if ('shiori' in step) {
        // A tap on Shiori: classic voice listens for a window at a time, and asleep she hears nothing until tapped.
        await page.getByRole('button', { name: 'Shiori' }).click({ timeout: 8000 }).catch(() => notes.push('no Shiori button to tap'));
        log(`    + ${((Date.now() - opened) / 1000).toFixed(1)} s  taps Shiori`);
      } else if ('tap' in step) {
        if (step.afterHeard !== undefined) {
          // Once annai has the words of the line just said, where its card judges them (Koe talking: the session's transcript of it, which can come long
          // before its `heard` entry; classic voice: the speech-to-text server's answer for the clip, as the stand-in saw it), and ms after.
          const end = Date.now() + 15_000;
          let heard = 0;
          while (Date.now() < end && !heard) {
            heard = classic
              ? (env.kokoro?.log.find((k) => k.kind === 'asr' && k.at + (k.ms ?? 0) >= lastAt)?.at ?? 0) + (env.kokoro?.log.find((k) => k.kind === 'asr' && k.at + (k.ms ?? 0) >= lastAt)?.ms ?? 0)
              : (frames.find((f) => f.dir === 'in' && f.kind === 'heard' && f.at >= lastAt)?.at ?? 0);
            if (!heard) await wait(100);
          }
          if (!heard) notes.push('annai wrote nothing down within 15 s of the clip: tapped anyway');
          await wait(Math.max(0, step.afterHeard - (Date.now() - (heard || Date.now()))));
        }
        const at = Date.now();
        const button = page.locator('.convo li').filter({ hasText: /Read Testville/ }).last().getByRole('button', { name: step.tap, exact: true });
        const ok = await button.click({ timeout: 5000 }).then(() => true, () => false);
        taps.push({ at, label: step.tap, ok });
        log(`    + ${((at - opened) / 1000).toFixed(1)} s  taps ${step.tap}${ok ? '' : ' (the button was not there to tap)'}`);
      } else if ('settled' in step) {
        // The card resolved (the read_trip call's result), then annai and her sound quiet for ms; at most 45 s from the last clip or the card.
        const limit = Date.now() + 45_000;
        let resolved = 0;
        while (Date.now() < limit) {
          resolved ||= (await eventsOf(page, ['tool.result'], card.at || began - 1000)).find((e) => e.data?.name === 'read_trip')?.at ?? 0;
          const quietFrom = Math.max(await lastSound(), frames.at(-1)?.at ?? 0, resolved, lastEnd);
          if (resolved && Date.now() - quietFrom >= step.settled) break;
          await wait(150);
        }
        if (!resolved) notes.push('the card never resolved (no result of read_trip) within the wait');
        log(`    + ${((Date.now() - opened) / 1000).toFixed(1)} s  ${resolved ? 'settled' : 'the card did not resolve'}`);
      } else if ('say' in step) {
        // Classic voice opens the microphone for a window at a time: the clip waits until it is open, and has had a second to hear the room.
        const open = await page.waitForFunction(() => typeof /** @type {any} */ (window).__rt?.say === 'function', null, { timeout: classic ? 3000 : 20_000 }).then(() => true, () => false);
        if (!open) {
          // The listening window is shut (nobody is listening): the user would have to tap Shiori first. The clip is not played.
          notes.push(`the microphone was closed when ${step.say} was to be said: nobody was listening`);
          log(`    + ${((Date.now() - opened) / 1000).toFixed(1)} s  ${step.say} not said: the microphone is closed`);
          continue;
        }
        if (classic) {
          const age = await page.evaluate(() => Date.now() - /** @type {any} */ (window).__rt.micAt).catch(() => 1000);
          if (age < 1000) await wait(1000 - age);
        }
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
    await voiceSwitch(page, 'Off', w);
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
