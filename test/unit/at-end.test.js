import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAtEnd } from '../../src/ui/at-end.js';

/**
 * A window as keepAtEnd sees it, whose events the test sends in the order a phone may: a page `content` px tall in a window w x h. Like a
 * browser, scrollTo clamps to the page and queues a scroll event only when the page moved; `scrolled()` delivers the queued one.
 * @param {{ w?: number, h?: number, content?: number }} [o]
 */
function phone({ w = 393, h = 659, content = 3000 } = {}) {
  /** @type {Record<string, ((e?: any) => void)[]>} */
  const on = { scroll: [], resize: [] };
  /** @type {(() => void)[]} */
  let frames = [];
  let queued = false;
  const end = () => Math.max(0, win.content - win.innerHeight);
  const win = {
    innerWidth: w, innerHeight: h, scrollY: 0, content,
    document: { documentElement: { get clientHeight() { return win.innerHeight; }, get scrollHeight() { return win.content; } } },
    addEventListener: (/** @type {string} */ type, /** @type {() => void} */ fn) => on[type]?.push(fn),
    requestAnimationFrame: (/** @type {() => void} */ fn) => frames.push(fn),
    scrollTo: (/** @type {number} */ _x, /** @type {number} */ y) => {
      const to = Math.min(Math.max(0, y), end());
      if (to !== win.scrollY) queued = true;
      win.scrollY = to;
    },
    end,
    /** The user's own scroll to y, its event delivered. @param {number} y */
    user(y) { win.scrollTo(0, y); win.scrolled(); },
    /** The scroll event a move queued, if any. */
    scrolled() { if (queued) { queued = false; for (const f of on.scroll) f(); } },
    resized() { for (const f of on.resize) f(); },
    /** The next frames: what they asked for runs, and the scroll events it queued come. @param {number} [n] */
    frame(n = 1) {
      for (let i = 0; i < n; i++) {
        const run = frames;
        frames = [];
        for (const f of run) f();
        win.scrolled();
      }
    },
  };
  return win;
}

test("at the end, the user scrolls up and a tab's toolbar shows, its resize handled before the scroll: the user's scroll stands", () => {
  const win = phone();
  keepAtEnd(/** @type {any} */ (win));
  win.user(win.end()); // read to its end: 2341
  win.scrollTo(0, win.scrollY - 40); // the finger moves the page 40 px up, its scroll event still to come...
  win.innerHeight -= 50; // ...and the toolbar shows: only the height changes
  win.resized(); // the resize steps run before the scroll steps
  win.scrolled();
  win.frame(3); // the rest of the toolbar's animation
  assert.equal(win.scrollY, 2301);
  win.user(2261); // and the next scroll goes on from there
  win.resized();
  win.frame(3);
  assert.equal(win.scrollY, 2261);
});

test("at the end, a gesture's scrolls come at the toolbar's new size before its resize: the reader stays where they scrolled", () => {
  const win = phone();
  keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  win.innerHeight -= 50; // the toolbar shows; its resize comes late
  for (const y of [2241, 2041, 1841]) win.user(y); // 500 px up, each scroll at the new size, not yet seen
  win.resized();
  win.frame(3);
  assert.equal(win.scrollY, 1841);
});

test('a phone turned at the end is at its end again, after its fits; mid-page nothing moves', () => {
  const win = phone();
  const { toEnd } = keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  // Turned: the width changes; the page is shorter in landscape, and the cards fit again over the next frames.
  Object.assign(win, { innerWidth: 659, innerHeight: 393, content: 2400 });
  win.resized();
  win.scrolled();
  win.content = 2440;
  win.frame(2);
  assert.equal(win.scrollY, win.end());
  Object.assign(win, { innerWidth: 393, innerHeight: 659, content: 3000 });
  win.resized();
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, win.end());
  // The dock grows 40 px: its observer puts the end back.
  win.content += 40;
  toEnd();
  win.scrolled();
  assert.equal(win.scrollY, win.end());
  // Mid-page: nothing moves on a turn.
  win.user(1200);
  Object.assign(win, { innerWidth: 659, innerHeight: 393 });
  win.resized();
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 1200);
});

test("after a toolbar's resize the user's scrolls count again: one to mid-page, then a turn, doesn't send the page to its end", () => {
  const win = phone();
  keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  win.innerHeight -= 50;
  win.resized();
  win.frame(3);
  win.user(1300);
  Object.assign(win, { innerWidth: 609, innerHeight: 393 });
  win.resized();
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 1300);
});
