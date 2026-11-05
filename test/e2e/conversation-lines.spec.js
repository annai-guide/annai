import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { savedBy, openApp, startTrip, writeEvent, startModelServer, modelSetUp, anthropicToolReply } from './helpers.js';

// The Conversation shows faithfully what happened (the second-drive design, section 1), read from stored events. Fixtures are synthetic.
const LONG = 'A-very-long-model-name-with-no-spaces-to-break-at-whatsoever-preview-2026-11-04-experimental-build';
const by = { name: 'Model One', first: null, tried: false };
const EVENTS = [
  { type: 'msg.user', data: { text: 'When do we leave for the station?' } },
  { type: 'out.speak', data: { id: 's1', half: 'koe', by, text: 'Leave by 8:40.' } },
  { type: 'msg.user', data: { text: 'The earlier one', chose: true } },
  { type: 'heard', data: { id: 'h1', source: 'dictation', text: 'Is the noodle place on the way?' } },
  { type: 'out.speak', data: { id: 's2', half: 'koe', voice: true, by, text: 'Four minutes off your route.' } },
  { type: 'heard', data: { id: 'h2', source: 'live', text: 'What is the next turn?' } },
  { type: 'out.speak', data: { id: 's3', half: 'koe', live: true, voice: true, by: { name: LONG, first: null, tried: false }, text: 'Left at the light.' } },
  { type: 'heard', data: { id: 'h3', source: 'live', text: 'lyrics of a song on the radio', dismissed: true, gate: 'chatter' } },
  { type: 'heard', data: { id: 'h4', source: 'mic', text: 'Did you grab the umbrella?', dismissed: true, gate: 'chatter' } },
  { type: 'out.speak', data: { id: 's4', half: 'kokoro', by, text: 'The train is on time today.' } },
  { type: 'out.speak', data: { id: 's5', live: true, voice: true, by: null, text: 'An old live line.' } },
  { type: 'reminder', data: { watch: 'w1', text: 'Check out by 11:00.' } },
  { type: 'reminder', data: { watch: 'w2', text: 'Check out by 11:00.', aloud: true } },
  { type: 'reminder', data: { watch: '', text: 'The train leaves from platform 2.', answer: true, aloud: true } },
  { type: 'reminder', data: { watch: '', text: 'An older note of hers.', title: "Shiori's answer" } },
  { type: 'heard', data: { id: 'h5', source: 'mic' } },
  { type: 'out.speak', data: { id: 's6', by, text: 'One half, as now.' } },
];
const LABELS = ['typed', 'Koe · text · Model One', 'tapped', 'spoken · phone dictation', 'Koe · said aloud · Model One', 'spoken · live voice', `Koe · live · ${LONG}`, "heard · she didn't answer", 'heard · judged not for her',
  'Kokoro directly · Model One', 'Koe · live', 'annai · shown', 'annai · said aloud', "Kokoro's words · said aloud", "Kokoro's words · shown", 'spoken · no words yet', 'Model One'];

/** Every kind of line in a trip's Conversation. @param {import('@playwright/test').Page} page */
async function everyLine(page) {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Sample trip');
  for (const ev of EVENTS) await writeEvent(page, trip, ev);
  await page.goto('/#/talk'); // no reload: she opened this conversation before these lines, so she owes none of them an answer
  await expect(page.locator('.convo > li')).toHaveCount(EVENTS.length);
  return trip;
}

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  test.describe(`${scheme}, at phone width`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 390, height: 844 } });

    test('each kind of line says what it is; a long model name wraps inside its bubble; no bubble sticks out of the page', async ({ page }, info) => {
      await everyLine(page);
      await expect(page.locator('.convo .line-label')).toHaveText(LABELS);
      const fit = await page.evaluate(() => [...document.querySelectorAll('.convo > li')].flatMap((li) => {
        const box = li.getBoundingClientRect();
        const out = [...li.querySelectorAll('.line-label, .line-label span')].filter((x) => { const r = x.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; });
        return out.length || box.right > innerWidth || li.scrollWidth > li.clientWidth + 1 ? [li.textContent] : [];
      }));
      expect(fit).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const long = page.locator('.convo .line-koe-live .line-label').first();
      expect(/** @type {{ height: number }} */ (await long.boundingBox()).height).toBeGreaterThan(24); // on more than one line
      {
        // The tints show, and each label reads on its wash as the browser draws it (4.5:1).
        const low = await page.evaluate(() => {
          const rgb = (/** @type {string} */ c) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
          const lum = (/** @type {number[]} */ c) => { const [r, g, b] = c.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
          const under = (/** @type {Element | null} */ el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length < 4 || c[3] > 0) return c; } return [255, 255, 255]; };
          return [...document.querySelectorAll('.convo .line-label')].flatMap((l) => {
            const [a, b] = [lum(rgb(getComputedStyle(l).color)), lum(under(l))].sort((x, y) => y - x);
            const ratio = (a + 0.05) / (b + 0.05);
            return ratio < 4.5 ? [`${l.textContent}: ${ratio.toFixed(2)}`] : [];
          });
        });
        expect(low).toEqual([]);
        const wash = (/** @type {string} */ sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
        const expected = scheme === 'light' ? { teal: 'rgb(240, 248, 246)', blue: 'rgb(241, 245, 252)', violet: 'rgb(245, 241, 251)' } : { teal: 'rgb(24, 37, 42)', blue: 'rgb(26, 34, 48)', violet: 'rgb(32, 29, 46)' };
        expect(await wash('.convo .line-koe-live')).toBe(expected.teal);
        expect(await wash('.convo .line-koe-aloud')).toBe(expected.blue);
        expect(await wash('.convo .you.line-spoken')).toBe(expected.blue);
        expect(await wash('.convo .line-kokoro')).toBe(expected.violet);
        expect(await wash('.convo .you.quiet')).toBe('rgba(0, 0, 0, 0)');
      }
      // Evidence, for the eye: only one browser's, one file per theme (gitignored).
      if (info.project.name === 'webkit') {
        await mkdir('.superpowers/evidence', { recursive: true });
        // The whole conversation in one picture: what stays on screen as it scrolls would otherwise lie across its middle.
        await page.evaluate(() => {
          for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('header, .screen > .title-row, nav.dock'))) el.style.setProperty('position', 'static', 'important');
          for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.notices'))) el.style.setProperty('display', 'none', 'important');
        });
        await page.screenshot({ path: `.superpowers/evidence/conversation-${scheme}.png`, fullPage: true });
      }
    });
  });
}

test('words still coming become the line they are, drawn from the log; with "Show what she says" off, spoken words fold away above their label', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trip = await everyLine(page);
  await expect(page.locator('.convo .line-hearing')).toHaveCount(1);
  await writeEvent(page, trip, { type: 'heard.text', data: { of: 'h5', text: 'Now the words are in.' } });
  await page.goto('/#/trips');
  await page.goto('/#/talk');
  await expect(page.locator('.convo .line-hearing')).toHaveCount(0);
  const line = page.locator('.convo .you.line-spoken').last();
  await expect(line).toContainText('Now the words are in.');
  await expect(line.locator('.line-label')).toHaveText('spoken');
  // Her spoken words are the normal size, not smaller and grey.
  const size = (/** @type {import('@playwright/test').Locator} */ l) => l.evaluate((el) => getComputedStyle(el).fontSize);
  expect(await size(page.locator('.convo .said p').first())).toBe(await size(page.locator('.convo .line-koe-text p').first()));
  await page.goto('/#/voice');
  await page.getByLabel('Show what she says').uncheck();
  await expect(savedBy(page.getByLabel('Show what she says'))).toHaveText('Saved');
  await page.goto('/#/talk');
  const said = page.locator('.convo .line-koe-aloud');
  await expect(said).toBeVisible();
  await expect(said.getByText('Four minutes off your route.')).toBeHidden();
  await expect(said.locator('.line-label')).toHaveText('Koe · said aloud · Model One');
  await said.getByRole('button', { name: 'Show what she said' }).click();
  await expect(said.getByText('Four minutes off your route.')).toBeVisible();
});

test('"This was for Shiori" on an old line: a tap sends the words as a spoken line, the quiet line loses its button, and the model reads what happened', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [{ status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Got it.' } }, { name: 'sleep', input: {} }]) }] });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await modelSetUp(page, llm.origin, 'Sample trip');
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await writeEvent(page, trip, { type: 'heard', data: { id: 'h9', source: 'mic', text: 'Is there parking nearby?', dismissed: true, gate: 'chatter' } });
    await page.goto('/#/talk');
    await page.reload();
    const quiet = page.locator('.convo .you.quiet');
    await expect(quiet).toContainText('Is there parking nearby?');
    await quiet.getByRole('button', { name: 'This was for Shiori' }).click();
    await expect(quiet.getByRole('button')).toHaveCount(0);
    const spoken = page.locator('.convo .you.line-spoken');
    await expect(spoken).toContainText('Is there parking nearby?');
    await expect(spoken.locator('.line-label')).toHaveText('spoken');
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[0])).toContain('[the user says this was for you] \\"Is there parking nearby?\\"');
    await expect(page.locator('.convo .shiori p')).toHaveText('Got it.');
    // Drawn again from the log: still no button, and still a spoken line.
    await page.reload();
    await expect(page.locator('.convo .you.quiet')).toHaveCount(1);
    await expect(page.locator('.convo .you.quiet').getByRole('button')).toHaveCount(0);
    await expect(page.locator('.convo .you.line-spoken')).toHaveCount(1);
  } finally {
    await llm.stop();
  }
});

test('a quiet line offers "This was for Shiori" only once it has real words: not before they come, not for a sound that was never written down', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Sample trip');
  await writeEvent(page, trip, { type: 'heard', data: { id: 'q1', source: 'mic', dismissed: true, gate: 'chatter' } });
  await writeEvent(page, trip, { type: 'heard', data: { id: 'q2', source: 'mic', dismissed: true, gate: 'chatter' } });
  await writeEvent(page, trip, { type: 'heard.text', data: { of: 'q2', text: '[audio, not transcribed]' } });
  await writeEvent(page, trip, { type: 'heard', data: { id: 'q3', source: 'mic', dismissed: true, gate: 'chatter' } });
  await writeEvent(page, trip, { type: 'heard.text', data: { of: 'q3', text: 'Is there parking nearby?' } });
  await page.goto('/#/talk');
  const quiet = page.locator('.convo .you.quiet');
  await expect(quiet).toHaveCount(3); // the quiet line, not the dashed bubble, before its words come
  await expect(page.locator('.convo .line-hearing')).toHaveCount(0);
  await expect(quiet.getByRole('button', { name: 'This was for Shiori' })).toHaveCount(1);
  await expect(quiet.nth(2).getByRole('button')).toHaveCount(1);
  await expect(quiet.nth(0).getByRole('button')).toHaveCount(0);
  await expect(quiet.nth(1).getByRole('button')).toHaveCount(0);
});

test('a tap on a card\'s choice and on a Driving quick ask say "tapped", not "typed"', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Got it.' } }, { name: 'sleep', input: {} }]) },
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Here.' } }, { name: 'sleep', input: {} }]) },
  ] });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await modelSetUp(page, llm.origin, 'Sample trip');
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await writeEvent(page, trip, { type: 'out.show', data: { card: { title: 'Which one?', text: 'Pick a place.', choice: ['The noodle place'] } } });
    await page.goto('/#/talk');
    await page.reload();
    await page.locator('.convo').getByRole('button', { name: 'The noodle place' }).click();
    const tapped = page.locator('.convo .you.line-tapped');
    await expect(tapped).toHaveCount(1);
    await expect(tapped.locator('.line-label')).toHaveText('tapped');
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Got it.');
    await page.goto('/#/drive');
    await page.locator('.quick-ask button').first().click();
    await page.goto('/#/talk');
    await expect(page.locator('.convo .you.line-tapped')).toHaveCount(2);
    await expect(page.locator('.convo .you.line-typed')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test.describe('the bottom bar, at phone width', () => {
  for (const [width, height] of [[360, 640], [320, 844], [390, 844], [320, 544], [568, 296]]) {
    test.describe(`${width} × ${height}`, () => {
      test.use({ viewport: { width, height } });
      test('the working sign floats just above the bar: nothing in the bar moves as it shows, the bar costs it no height, and the page foot clears it', async ({ page }) => {
        await openApp(page, '#/talk');
        const boxes = () => page.evaluate(() => ['nav.dock', '.dock .talk', '.voice-chip', '.live-chip'].map((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && [b.x, b.y, b.width, b.height]; }));
        for (const voice of ['Off', 'On']) {
          await page.goto('/#/voice');
          await page.getByRole('radio', { name: voice, exact: true }).check();
          await page.goto('/#/talk');
          await expect(page.locator('nav.dock')).toHaveClass(voice === 'On' ? /\bvoice\b/ : /^(?!.*\bvoice\b)/);
          const sign = page.locator('.halves-sign');
          await expect(sign).toBeHidden();
          // The voice chip's words settle a moment after the screen draws, and move the chips beside them: measure once they have.
          let before = await boxes();
          await expect.poll(async () => {
            await page.waitForTimeout(150);
            const now = await boxes();
            const same = JSON.stringify(now) === JSON.stringify(before);
            before = now;
            return same;
          }).toBe(true);
          await sign.evaluate((el) => el.classList.remove('idle'));
          await expect(sign).toBeVisible();
          expect(await boxes()).toEqual(before);
          const where = await sign.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const dock = /** @type {Element} */ (document.querySelector('nav.dock')).getBoundingClientRect();
            const style = getComputedStyle(el);
            return { inside: r.left >= 0 && r.right <= innerWidth, above: r.bottom <= dock.top, near: dock.top - r.bottom <= 8, left: style.borderLeftWidth };
          });
          expect(where).toMatchObject({ inside: true, above: true, near: true, left: '1px' });
          // The end of the conversation is readable under the sign (the page learns the bar's height a moment after it changes).
          await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom) - /** @type {Element} */ (document.querySelector('nav.dock')).getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
          await sign.evaluate((el) => el.classList.add('idle'));
          // Hidden, it takes nothing a tap could find, and no name for a screen reader.
          await expect(page.getByRole('button', { name: 'Stop Kokoro' })).toHaveCount(0);
          expect(await boxes()).toEqual(before);
        }
      });
    });
  }

  for (const [width, height] of [[280, 640], [320, 844], [360, 640], [390, 844]]) {
    test(`${width} × ${height}: "Ignoring sound" or "Offline" under her, and the working sign over the bar: each shows, neither covers the other, whole (from 320), and nothing in the bar moves`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openApp(page, '#/talk');
      await page.goto('/#/voice');
      await page.getByRole('radio', { name: 'On', exact: true }).check();
      await page.goto('/#/talk');
      await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/);
      // The bar, her and the buttons beside her: the side buttons moved when a long label widened the middle column.
      const boxes = () => page.evaluate(() => [...document.querySelectorAll('nav.dock, .dock .av, .dock .ib')].map((e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }));
      expect((await boxes()).length).toBeGreaterThan(3);
      const before = await boxes();
      await page.evaluate(() => /** @type {Element} */ (document.querySelector('.halves-sign')).classList.remove('idle'));
      await expect(page.locator('.halves-sign')).toBeVisible();
      const words = await page.evaluate(async () => {
        const load = (/** @type {string} */ url) => import(url);
        const { LABELS } = await load('/src/core/agent/loop.js');
        return [LABELS.ignoring, LABELS.offline, '音を無視中 · タップで話す', '忽略声音 · 轻点说话', '忽略聲音 · 輕點說話'];
      });
      expect(words[0]).toMatch(/^Ignoring/);
      for (const text of words) {
        await page.evaluate((x) => {
          /** @type {HTMLElement} */ (document.querySelector('.talk-label')).textContent = x;
          /** @type {Element} */ (document.querySelector('.dock .av')).setAttribute('data-state', 'ignoring');
        }, text);
        await expect(page.locator('.talk-label')).toBeVisible();
        expect(await boxes(), text).toEqual(before);
        const seen = await page.evaluate(() => {
          const box = (/** @type {string} */ s) => /** @type {Element} */ (document.querySelector(s)).getBoundingClientRect();
          const [label, sign] = [box('.talk-label'), box('.halves-sign')];
          const el = /** @type {HTMLElement} */ (document.querySelector('.talk-label'));
          return { apart: sign.bottom <= label.top, inside: label.left >= 0 && label.right <= innerWidth, whole: el.scrollWidth <= el.clientWidth };
        });
        expect(seen, text).toMatchObject({ apart: true, inside: true });
        if (width >= 320) expect(seen.whole, `${text} is cut`).toBe(true); // 280 is narrower than a phone: the bar holds still, and the label may end in an ellipsis
      }
    });
  }

  test('at 360 × 640 the bar is no taller than it was before the sign had a row: 138 px voice off, 168 px voice on', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await openApp(page, '#/talk');
    const heights = [];
    for (const voice of ['Off', 'On']) {
      await page.goto('/#/voice');
      await page.getByRole('radio', { name: voice, exact: true }).check();
      await page.goto('/#/talk');
      await expect(page.locator('nav.dock')).toHaveClass(voice === 'On' ? /\bvoice\b/ : /^(?!.*\bvoice\b)/);
      heights.push(await page.locator('nav.dock').evaluate((el) => Math.round(el.getBoundingClientRect().height)));
    }
    expect(heights[1] - heights[0]).toBeGreaterThanOrEqual(26);
    expect(heights[0]).toBeLessThanOrEqual(142);
    expect(heights[1]).toBeLessThanOrEqual(172);
  });
});

test.describe('the GPS chip', () => {
  test('one tap on, one tap off, with no menu; the screen is kept on by default and the setting is in Settings → Voice', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 10, longitude: 20, accuracy: 10 });
    await openApp(page, '#/talk');
    const chip = page.locator('.live-chip');
    await expect(chip).toHaveText('GPS off');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();
    await expect(chip).toHaveText(/^GPS on\b/);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#live-menu')).toBeHidden();
    await chip.click();
    await expect(chip).toHaveText('GPS off');
    await page.goto('/#/voice');
    const keep = page.getByLabel('Keep the screen on while GPS is on');
    if (await page.evaluate(() => 'wakeLock' in navigator)) await expect(keep).toBeChecked();
  });
});

test('the Driving screen has no "Keep the screen on" button, with GPS off or on: its one home is Settings → Voice', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 10, longitude: 20, accuracy: 10 });
  await openApp(page, '#/trips');
  await startTrip(page, 'Sample trip');
  await page.goto('/#/drive');
  await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn GPS on' }).click();
  await expect(page.getByRole('button', { name: 'Turn GPS on' })).toHaveCount(0);
  await expect(page.locator('.live-chip')).toHaveText(/^GPS on\b/);
  await expect(page.getByText('Keep the screen on')).toHaveCount(0);
});
