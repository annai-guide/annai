import { test, expect } from '@playwright/test';
import { openApp, atConversation } from './helpers.js';

// A smart text box (the user, 2026-10-23): "the send and close are on the left side … put it at the right side … do we need the close
// button? maybe click on the keyboard button again closes the input box? … maybe we can also close the box when the message is sent?
// let's make the text box only there when it is needed and reduce the amount the user need to interact with the screen (make it 'smart')"

/** In a conversation: on home at rest the dock is the chips and the + alone (timeline stage 4). @param {import('@playwright/test').Page} page */
async function inConversation(page) {
  await openApp(page, '#/talk');
  await atConversation(page);
}
const typeButton = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('button', { name: 'Type', exact: true });
const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByLabel('Message to Shiori');

test('the keyboard button opens the box with focus, and tapping it again closes it; there is no Close button', async ({ page }) => {
  await inConversation(page);
  await expect(box(page)).toBeHidden();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'false');
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
  await typeButton(page).click();
  await expect(box(page)).toBeHidden();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'false');
});

// Several lines (the user, 2026-11-16: "can you make it multiline? auto expanding text box would be ideal. also the keyboard button is send
// not change line, maybe should do that? as we already have a send button near the text box").
test("on a touch screen the box takes several lines, and its keyboard key is the return key: Enter adds a line and sends nothing; Ctrl+Enter or ⌘+Enter sends them, line breaks and all, and the box closes after sending", async ({ page }) => {
  await inConversation(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'a touch screen: the phone\'s return key').toBe(true);
  await typeButton(page).click();
  await expect(box(page)).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(box(page)).not.toHaveAttribute('enterkeyhint', 'send');
  await box(page).fill('Where is the nearest petrol station?');
  await box(page).press('Enter');
  await box(page).pressSequentially('And a café?');
  await expect(box(page)).toHaveValue('Where is the nearest petrol station?\nAnd a café?');
  await expect(box(page)).toBeVisible();
  await expect(page.locator('.convo .you')).toHaveCount(0); // nothing sent
  await box(page).press('Control+Enter');
  await atConversation(page);
  await expect.poll(() => page.locator('.convo .you p').first().evaluate((el) => /** @type {HTMLElement} */ (el).innerText)).toBe('Where is the nearest petrol station?\nAnd a café?');
  await expect(box(page)).toBeHidden();
  // Opened again, it is empty; ⌘+Enter sends too.
  await typeButton(page).click();
  await expect(box(page)).toHaveValue('');
  await box(page).fill('Thanks');
  await box(page).press('Meta+Enter');
  await expect(page.locator('.convo .you p').last()).toHaveText('Thanks');
  await expect(box(page)).toBeHidden();
});

/** The box's height, whether it scrolls and shows its last line, and the send arrow's bottom and the box's, in CSS pixels. @param {import('@playwright/test').Page} page */
const sizes = (page) => page.evaluate(() => {
  const el = /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text'));
  const arrow = /** @type {HTMLElement} */ (document.querySelector('.send-arrow')).getBoundingClientRect();
  const r = el.getBoundingClientRect();
  // The last line is in view: the browser scrolls to the caret's line, not to the padding under it.
  const end = el.scrollHeight - Number.parseFloat(getComputedStyle(el).paddingBottom);
  return { height: Math.round(r.height), bottom: r.bottom, arrowBottom: arrow.bottom, scrolls: el.scrollHeight > el.clientHeight + 1, atEnd: el.scrollTop + el.clientHeight >= end - 1 };
});
/** n lines of words, each short enough for one line of the box. @param {number} n */
const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n');

test('the box grows with each line typed, one line high at rest, to five lines, then scrolls inside with the last line in view; the send arrow stays on its last line; sent, it is one line again', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  const rest = await sizes(page);
  expect(rest.height).toBe(48);
  await box(page).fill(lines(3));
  await expect.poll(async () => (await sizes(page)).height).toBe(96);
  const three = await sizes(page);
  expect(three.scrolls).toBe(false);
  // On its last line: its bottom 4 px above the box's (as at rest, where it is centred), and well below the box's top half.
  expect(Math.abs(three.bottom - three.arrowBottom - 4)).toBeLessThanOrEqual(1);
  await box(page).fill(lines(5));
  await expect.poll(async () => (await sizes(page)).height).toBe(144);
  expect((await sizes(page)).scrolls).toBe(false);
  // Typed past five lines, one key at a time as a person types: it stays at five, scrolls, and shows the line being typed.
  for (const line of ['Line 6', 'Line 7', 'Line 8']) {
    await box(page).press('Enter');
    await box(page).pressSequentially(line);
  }
  const eight = await sizes(page);
  expect(eight.height).toBe(144);
  expect(eight.scrolls).toBe(true);
  expect(eight.atEnd).toBe(true);
  // Lines taken away shrink it again.
  await box(page).fill('One line');
  await expect.poll(async () => (await sizes(page)).height).toBe(48);
  await box(page).fill(lines(4));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box(page)).toBeHidden();
  await typeButton(page).click();
  expect((await sizes(page)).height).toBe(48);
});

test('a short screen grows the box to three lines; a phone on its side keeps it one line high, scrolling inside, so the page keeps about a third of the height (as phone-fit.spec.js measures it open)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill(lines(5));
  await expect.poll(async () => (await sizes(page)).height).toBe(96);
  expect((await sizes(page)).scrolls).toBe(true);
  // The dock with the box at its cap takes the share of the screen five lines take on a Pixel 7 (shiori.css: 36%, measured 202 of 568 px).
  const dock = /** @type {{ height: number }} */ (await page.getByRole('navigation', { name: 'Shiori' }).boundingBox());
  expect(dock.height / 568).toBeLessThanOrEqual(0.37);
  await page.setViewportSize({ width: 568, height: 296 });
  await expect.poll(async () => (await sizes(page)).height).toBe(44);
  const turned = await sizes(page);
  expect(turned.scrolls).toBe(true);
  expect(Math.abs(turned.bottom - turned.arrowBottom - 2)).toBeLessThanOrEqual(1);
  const top = /** @type {{ y: number }} */ (await page.getByRole('navigation', { name: 'Shiori' }).boundingBox());
  expect(top.y).toBeGreaterThanOrEqual(296 * 0.32); // the page's room above the dock, from the top of the screen (no top bar since timeline stage 8)
});

test("a draft of several lines kept by Escape is as tall as its lines when the box opens again", async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill(lines(3));
  await expect.poll(async () => (await sizes(page)).height).toBe(96);
  await box(page).press('Escape');
  await expect(box(page)).toBeHidden();
  await typeButton(page).click();
  await expect(box(page)).toHaveValue(lines(3));
  expect((await sizes(page)).height).toBe(96);
});

test('a small send arrow sits inside the box, on its right, for a keyboard whose key adds a line and for a mouse; it sends and closes the box', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeVisible();
  const field = /** @type {{ x: number, y: number, width: number, height: number }} */ (await box(page).boundingBox());
  const arrow = /** @type {{ x: number, y: number, width: number, height: number }} */ (await send.boundingBox());
  // Inside the box's frame, in its right half.
  expect(arrow.x).toBeGreaterThan(field.x + field.width / 2);
  expect(arrow.x + arrow.width).toBeLessThanOrEqual(field.x + field.width + 1);
  expect(arrow.y).toBeGreaterThanOrEqual(field.y - 1);
  expect(arrow.y + arrow.height).toBeLessThanOrEqual(field.y + field.height + 1);
  await box(page).fill('Hello Shiori');
  await send.click();
  await atConversation(page);
  await expect(page.locator('.convo .you').first()).toContainText('Hello Shiori');
  await expect(box(page)).toBeHidden();
});

/**
 * The phone's disk fills, as the Linux builds of WebKit and Chromium refuse a full one (the probe of 2026-11-19, WebKit: no error; Chromium: a
 * DataError for its blob files): every request of a write succeeds, and the browser aborts its commit. Faked here with no error, as WebKit's.
 * Each write that logs is kept open until `release()` (held), then aborted 100 ms on, well after annai's few requests in it. `room()` ends it.
 * @param {import('@playwright/test').Page} page @param {{ held?: boolean }} [o]
 */
const fillDisk = (page, { held = false } = {}) => page.evaluate((held) => {
  const w = /** @type {any} */ (window);
  w.full = { held, since: Date.now() };
  w.release = () => { w.full = { held: false, since: Date.now() }; };
  w.room = () => { w.full = null; };
  const real = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = /** @type {any} */ (/** @this {IDBDatabase} */ function (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any[]} */ ...rest) {
    const t = real.call(this, stores, mode, ...rest);
    const names = [stores].flat();
    if (!w.full || mode !== 'readwrite' || !names.includes('events')) return t;
    const made = Date.now();
    const keep = () => {
      try {
        if (!w.full?.held && Date.now() - Math.max(made, w.full?.since ?? 0) > 100) return void t.abort();
        t.objectStore(names[0]).count().onsuccess = keep;
      } catch { /* it ended */ }
    };
    keep();
    return t;
  });
}, held);

// A line typed when nothing could take it stays in the box (the user's pick of 2026-11-14, "Put it back in the type box"): one the full
// phone refuses to save comes back to it.
test("a line the full phone refuses to save comes back in the box, and the storage card says to free up space in the phone's own Settings; with room again it sends", async ({ page, browserName }) => {
  await inConversation(page);
  await fillDisk(page);
  await typeButton(page).click();
  await box(page).fill('Is the castle open today?');
  await box(page).press('Control+Enter');
  await expect(box(page)).toHaveValue('Is the castle open today?');
  await expect(box(page)).toBeVisible();
  await expect(page.locator('.convo .you')).toHaveCount(0);
  const notices = page.locator('.notices');
  await expect(notices.getByText("There's no room left", { exact: true })).toBeVisible();
  await expect(notices).toContainText(browserName === 'webkit' ? 'Free up space on this iPhone in Settings → General → iPhone Storage, then try again.' : 'Free up space on this phone in Settings → Storage, then try again.');
  await expect(notices).toContainText('Your message is back in the box.');
  await expect(notices).not.toContainText('Shiori stopped'); // one card for the one refusal: the turn that stopped on it adds none
  await expect(notices.locator('.notice')).toHaveCount(1);
  await page.evaluate(() => /** @type {any} */ (window).room());
  await box(page).press('Control+Enter');
  await expect(page.locator('.convo .you p').first()).toHaveText('Is the castle open today?');
  await expect(box(page)).toBeHidden();
});

test('a refused line comes back before what was typed in the box since, on a line of its own', async ({ page }) => {
  await inConversation(page);
  await fillDisk(page, { held: true });
  await typeButton(page).click();
  await box(page).fill('Is the castle open today?');
  await box(page).press('Control+Enter');
  await expect(box(page)).toBeHidden();
  await typeButton(page).click();
  await box(page).fill('And the garden?');
  await page.evaluate(() => /** @type {any} */ (window).release());
  await expect(box(page)).toHaveValue('Is the castle open today?\nAnd the garden?');
  await expect(page.locator('.notices').getByText("There's no room left", { exact: true })).toBeVisible();
  await expect(page.locator('.notices .notice')).toHaveCount(1);
});

test("a message with a file the full phone can't keep: the card says which file wasn't kept, and the words come back in the box", async ({ page }) => {
  await inConversation(page);
  await fillDisk(page);
  await typeButton(page).click();
  await page.locator('#dock-attach').setInputFiles({ name: 'ticket.txt', mimeType: 'text/plain', buffer: Buffer.from('A ticket') });
  await box(page).fill('Is the castle open today?');
  await box(page).press('Control+Enter');
  await expect(box(page)).toHaveValue('Is the castle open today?');
  await expect(box(page)).toBeVisible();
  const notices = page.locator('.notices');
  await expect(notices.locator('.notice')).toHaveCount(1); // one card at a time: the file's gave way to the line's
  await expect(notices).toContainText('Your message is back in the box.');
  await expect(page.locator('.convo .you')).toHaveCount(0);
});

// What stops a turn after its line was kept shows the storage card in place of "Shiori stopped" (main.js), saying first that she stopped.
test('a turn the full phone stops after its line was kept shows the storage card, with Shiori stopped first, and nothing is given back', async ({ page }) => {
  await inConversation(page);
  // The first line is kept; from then on every write of the log fails, as WebKit refuses them on a full disk.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const real = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = /** @type {any} */ (/** @this {IDBObjectStore} */ function (/** @type {any} */ value, /** @type {any} */ key) {
      if (this.name === 'events' && w.kept) throw new DOMException('Unable to store record in object store', 'UnknownError');
      if (this.name === 'events' && value?.type === 'msg.user') w.kept = true;
      return real.call(this, value, key);
    });
  });
  await typeButton(page).click();
  await box(page).fill('Is the castle open today?');
  await box(page).press('Control+Enter');
  await expect(page.locator('.convo .you p').first()).toHaveText('Is the castle open today?');
  const notices = page.locator('.notices');
  await expect(notices.getByText("There's no room left", { exact: true })).toBeVisible();
  await expect(notices).toContainText('Shiori stopped.');
  await expect(notices).not.toContainText('Something went wrong');
  await expect(box(page)).toBeHidden(); // the line was kept: nothing to give back
});

test('Escape closes the box and keeps the draft', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill('half a thought');
  await box(page).press('Escape');
  await expect(box(page)).toBeHidden();
  await typeButton(page).click();
  await expect(box(page)).toHaveValue('half a thought');
});

test('a tap elsewhere on the page closes the box when it is empty, and leaves it, with its draft, when it is not', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  await page.locator('main').click({ position: { x: 5, y: 5 }, force: true });
  await expect(box(page)).toBeHidden();
  await typeButton(page).click();
  await box(page).fill('still typing');
  await page.locator('main').click({ position: { x: 5, y: 5 }, force: true });
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toHaveValue('still typing');
  // Taps inside the box and on its send arrow are not "elsewhere".
  await box(page).click();
  await expect(box(page)).toBeVisible();
});

test("the dock steps aside for a field outside it on a touch screen, but never for its own box (the box's own input is still in the dock)", async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill('hi');
  await expect(page.locator('html')).not.toHaveClass(/typing-elsewhere/);
  await expect(page.getByRole('navigation', { name: 'Shiori' })).toBeVisible();
});

test('the box and its send arrow are labelled for a screen reader, and the keyboard button says whether the box is open', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await expect(page.getByRole('textbox', { name: 'Message to Shiori' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'true');
});

// The user types Chinese and Japanese: Enter that picks a candidate in an IME must never send the half-composed text, nor add a line
// (its default, a line, is prevented: a dispatched event adds no text either way, so what it would do is read from defaultPrevented).
test('Enter while an IME is composing neither sends nor adds a line, Ctrl+Enter too; nothing is sent until a real Ctrl+Enter after the composition ends', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill('にほん');
  const prevented = await page.evaluate(() => {
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text'));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // Chrome and Firefox say isComposing; Safari's Enter that ends a composition comes after compositionend with keyCode 229.
    const a = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(a);
    const b = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(b);
    // The form's own submit while composing.
    input.form?.requestSubmit();
    return a.defaultPrevented && b.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toHaveValue('にほん');
  await expect(page.locator('.convo .you')).toHaveCount(0); // nothing sent
  await page.evaluate(() => {
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text'));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    // Safari: keydown Enter with keyCode 229 right after compositionend.
    const b = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    input.dispatchEvent(b);
    return b.defaultPrevented;
  }).then((p) => expect(p, 'the 229 Enter adds no line').toBe(true));
  await expect(box(page)).toHaveValue('にほん');
  await expect(page.locator('.convo .you')).toHaveCount(0); // nothing sent
  // A real Ctrl+Enter, later, sends.
  await page.waitForTimeout(300);
  await box(page).press('Control+Enter');
  await atConversation(page);
  await expect(page.locator('.convo .you').first()).toContainText('にほん');
});

// Fix pass 2, item 7: focus after a send goes to the keyboard button, never into the hidden box.
test('after a send from the box, focus is on the keyboard button, and keys typed then go nowhere hidden', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill('first');
  await box(page).press('Control+Enter');
  await atConversation(page);
  await expect(box(page)).toBeHidden();
  await expect(typeButton(page)).toBeFocused();
  await page.keyboard.type('unseen'); // no space: a space on the focused button opens the box, as it should
  expect(await page.evaluate(() => /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text')).value)).toBe('');
});

// Fix pass 2, item 11: a press elsewhere never closes the box under the finger: it closes with the press's click.
test('a press elsewhere closes the empty box only with its click, so nothing moves under the finger while it is down', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  const at = /** @type {{ x: number, y: number }} */ (await page.locator('main p.empty').boundingBox()); // plain content: the empty conversation's note
  await page.mouse.move(at.x + 5, at.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await expect(box(page)).toBeVisible();
  await page.mouse.up();
  await expect(box(page)).toBeHidden();
});

// Fix pass 2, item 12 and Step's S1: Android keyboards may send Enter as keyCode 229 with no composition: that Enter adds its line. A 229
// Enter is held back only while composing, or right after a composition ended (Safari's confirming Enter), and a composition the box lost
// (blur, closed) holds nothing back afterwards.
test("Enter as keyCode 229 holds back only while composing or right after a composition ended; with none, an Android keyboard's Enter is let through", async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill('hello');
  // The whole sequence in the page: the box holds a 229 Enter back for 100 ms after a composition ended (by the events' own time stamps),
  // so "right after" has to be right after in the page's own time, not after a round trip to the test, which a slow machine stretches
  // past the 100 ms. "A while after" is a wait in the page too, and a timer never fires early.
  const held = await page.evaluate(async () => {
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text'));
    const enter229 = () => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
      input.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const composition = (/** @type {'compositionstart' | 'compositionend'} */ type) => input.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    const out = { android: enter229(), composing: false, afterwards: false, later: true };
    composition('compositionstart');
    out.composing = enter229();
    composition('compositionend');
    out.afterwards = enter229();
    await new Promise((r) => setTimeout(r, 150));
    out.later = enter229();
    return out;
  });
  expect(held.android, 'no composition: Android').toBe(false);
  expect(held.composing, 'while composing').toBe(true);
  expect(held.afterwards, "Safari's Enter that confirms a candidate").toBe(true);
  expect(held.later, 'a while after the composition ended').toBe(false);
});

test('a composition the box lost (it closed, or lost focus) holds back nothing: a real Ctrl+Enter afterwards sends', async ({ page }) => {
  await inConversation(page);
  for (const lose of ['close', 'blur']) {
    await typeButton(page).click();
    await box(page).fill(`words after ${lose}`);
    await page.evaluate(() => { /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text')).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    if (lose === 'close') {
      await typeButton(page).click();
      await expect(box(page)).toBeHidden();
      await typeButton(page).click();
    } else await page.evaluate(() => { /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text')).blur(); });
    await page.waitForTimeout(300);
    await box(page).press('Control+Enter');
    await expect(page.locator('.convo .you p').last()).toHaveText(`words after ${lose}`);
  }
});

// Fix pass 3, item 6: iOS sends no click for a tap on plain content, or a drag: the box closes NO_CLICK_MS after the pointer is up.
test('a press elsewhere that brings no click (iOS, on plain content) still closes the empty box, a moment after it ends', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  // It is still open 100 ms after the pointer is up, looked at in the page: the box closes 400 ms after, by its own timer, and a look from the
  // test can come after that on a slow machine. The page's timers fire in the order of their times, so a wait of 100 ms there always comes
  // before the 400 ms close; and a close in a microtask or a zero-delay timer would be caught by it (NO_CLICK_MS at 0 fails this).
  const stillOpen = await page.evaluate(async () => {
    const el = /** @type {HTMLElement} */ (document.querySelector('main p.empty'));
    for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerType: 'touch' }));
    await new Promise((r) => setTimeout(r, 100));
    return /** @type {HTMLElement} */ (document.getElementById('dock-text')).offsetParent !== null;
  });
  expect(stillOpen, 'still open 100 ms after the pointer is up').toBe(true);
  await expect(box(page)).toBeHidden({ timeout: 2000 });
});

// Follow-up 4: a drag (the pointer moved) or a mouse (which always sends its click) is no tap elsewhere.
test('a drag elsewhere, or a mouse press with no click, leaves the empty box open', async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  await page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.querySelector('main p.empty'));
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerType: 'touch', clientX: 20, clientY: 100 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'touch', clientX: 20, clientY: 160 }));
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerType: 'mouse', clientX: 20, clientY: 100 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'mouse', clientX: 20, clientY: 100 }));
  });
  await page.waitForTimeout(800);
  await expect(box(page)).toBeVisible();
});

// A turn of the phone: the words wrap again at the new width, and the box is as tall as they are then (dock.js: the resize handler).
test('a turn of the phone wraps the words again, and the box fits them at the new width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill('Where is the nearest petrol station, please?');
  await expect.poll(async () => (await sizes(page)).height).toBeGreaterThan(48);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(async () => (await sizes(page)).height).toBe(48);
});

// The user, 2026-11-16, from an iPhone (the installed app, a new conversation from +, voice off): "bug report: text box cursor is at the wrong
// place": the caret was drawn about 106 px under the box, over the dock's buttons; "Only after +", not from the keyboard button inside a
// conversation. The cause is inferred, not yet verified on the phone: what the app did under the focused box while the keyboard rose. + opens
// the box in its tap, while home is still drawn, and the conversation's screen comes a moment later. Three things happened under the box: the
// dock's buttons row came with the screen, which pushed the box up by its height (87 px); the shell scrolled the page to its top as the screen
// landed; and a home read to its end was put back at its end as the dock grew (at-end.js). The box now takes focus where it stays, and the app
// scrolls nothing under it: a page already where it should be is not scrolled at the landing, nor a screen being left kept at its end.
// Where home is read when + is tapped: its top, partway down, or to its end (scrollTo clamps 1e6 to the page's end).
for (const [read, y] of /** @type {[string, number][]} */ ([['', 0], [', scrolled down', 1500], [', read to its end', 1e6]])) {
  test(`+ on home${read}, voice off: the box takes focus where it stays; the conversation that opens under it moves it nowhere, and nothing scrolls the page under it`, async ({ page }) => {
    // Installed, as on the phone: in a browser tab the data-safety banner makes the empty conversation taller than a small phone's screen, and a
    // page that lands scrolled is put at its top, as before.
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
    await openApp(page, '#/trips');
    // A long home, read partway down or to its end: the conversation is a short page, which a scrolled one is past the end of. Read to its end, the
    // page is kept at its end as the dock grows (at-end.js), which it is not while the screen is being left.
    if (y) {
      await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('main.view')).append(Object.assign(document.createElement('div'), { style: 'height: 3000px' })));
      await page.evaluate((to) => scrollTo(0, to), y);
      const seen = await page.evaluate(() => ({ y: scrollY, end: scrollY + innerHeight >= document.documentElement.scrollHeight - 1 }));
      expect(seen.y).toBeGreaterThan(0);
      expect(seen.end).toBe(y === 1e6);
    }
    // Where the box is at its focus, and at every frame after while it keeps it.
    await page.evaluate(() => {
      /** @type {number[]} */
      const tops = [];
      /** @type {any} */ (window).boxTops = tops;
      // The page's own scrolls while the box has focus.
      /** @type {string[]} */
      const scrolls = [];
      /** @type {any} */ (window).pageScrolls = scrolls;
      for (const name of ['scrollTo', 'scrollBy', 'scroll']) {
        const was = /** @type {any} */ (window)[name];
        /** @type {any} */ (window)[name] = (/** @type {any[]} */ ...to) => {
          if (document.activeElement?.id === 'dock-text') scrolls.push(`${name}(${to.join(', ')}) at ${scrollY}`);
          return was.apply(window, to);
        };
      }
      document.addEventListener('focusin', (e) => {
        const el = /** @type {HTMLElement} */ (e.target);
        if (el.id !== 'dock-text') return;
        const frame = () => {
          if (document.activeElement !== el) return;
          tops.push(el.getBoundingClientRect().top);
          requestAnimationFrame(frame);
        };
        frame();
      });
    });
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(box(page)).toBeFocused();
    await atConversation(page);
    await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
    await expect(page.locator('.dock .dock-row')).toBeVisible();
    // Two more frames: the page has made room for the dock as tall as it is now (the shell's observer).
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
    const tops = /** @type {number[]} */ (await page.evaluate(() => /** @type {any} */ (window).boxTops));
    expect(tops.length).toBeGreaterThan(2);
    expect(Math.max(...tops) - Math.min(...tops), `the box's top at its focus and after, frame by frame: ${[...new Set(tops)].join(', ')}`).toBeLessThan(0.5);
    expect(await page.evaluate(() => /** @type {any} */ (window).pageScrolls)).toEqual([]);
    expect(await page.evaluate(() => scrollY)).toBe(0); // the conversation opens at its top all the same
  });
}
