import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAtEnd } from '../../src/ui/at-end.js';

/**
 * A window as keepAtEnd sees it, whose events the test sends in the order a phone may: a page `content` px tall in a window w x h. Like a
 * browser, scrollTo clamps to the page and queues a scroll event only when the page moved; `scrolled()` delivers the queued one. Pinched in
 * (`pinch`), it is as iOS Safari shows it (not verified on a phone): innerWidth, innerHeight and scrollY are what is shown, visualViewport.scale
 * says the zoom, the layout's height (documentElement's clientHeight) stays, and no resize comes.
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
    innerWidth: w, innerHeight: h, scrollY: 0, content, scale: 1,
    visualViewport: { get scale() { return win.scale; } },
    document: { documentElement: { get clientHeight() { return Math.round(win.innerHeight * win.scale); }, get scrollHeight() { return win.content; } } },
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
    /** Pinched to zoom `s` (1: zoomed out again), its scroll clamped to what can be shown, its scroll event still to come. @param {number} s */
    pinch(s) {
      const [lw, lh] = [win.innerWidth * win.scale, win.innerHeight * win.scale];
      Object.assign(win, { scale: s, innerWidth: lw / s, innerHeight: lh / s });
      win.scrollTo(0, win.scrollY);
    },
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
  const { keep } = keepAtEnd(/** @type {any} */ (win));
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
  keep(() => { win.content += 40; });
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

// The dock's change is read as it happens (the final review of home2, F1): what the user's scrolls left is not what the page is by then.
test('at the end, something opens below with no scroll (Archived trips), then the dock grows: the page stays where it is', () => {
  const win = phone();
  const { keep } = keepAtEnd(/** @type {any} */ (win));
  win.user(win.end()); // read to its end: 2341
  win.content += 400; // a fold opened at the end: the page is longer below, and no scroll comes
  keep(() => { win.content += 60; }); // the whole dock shows as she speaks: its observer
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 2341); // before: 2801, past the cards just opened
});

test('at the end, pinched in and panned up to an earlier line, then the dock grows: the page stays where it is, and zoomed out again too', () => {
  const win = phone();
  const { keep } = keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  win.pinch(1.5);
  win.scrolled();
  win.user(1000); // panned up, zoomed in
  keep(() => { win.content += 60; }); // she speaks
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 1000); // before: 2621, her end
  win.pinch(1);
  win.scrolled();
  keep(() => { win.content -= 60; }); // she stops
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 1000); // before: 2341
});

test('at the end, pinched in and panned up, zoomed out and then turned: the page stays where the user has it', () => {
  const win = phone();
  keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  win.pinch(1.5);
  win.scrolled();
  win.user(1000);
  win.pinch(1);
  win.scrolled();
  Object.assign(win, { innerWidth: 659, innerHeight: 393 });
  win.resized();
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 1000); // before: 2607, the end
});

test('a pinch that comes with a resize is no turn: the page stays where the pinch left it', () => {
  const win = phone();
  keepAtEnd(/** @type {any} */ (win));
  win.user(win.end()); // 2341
  win.pinch(1.5);
  win.resized(); // if Safari sends one: innerWidth follows the pinch
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 2341); // before: 2561, pulled down to what can be shown of the end
});

test("a turn whose dock changes height in its own frame: at the end it ends at its end; mid-page nothing moves", () => {
  const win = phone();
  const { keep } = keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  Object.assign(win, { innerWidth: 659, innerHeight: 393, content: 2400 });
  win.resized(); // the turn: the page is put at its end
  keep(() => { win.content -= 12; }); // the dock, 41 px tall on its side: its observer, after the frame's layout
  win.scrolled();
  win.content += 40; // the cards fit again
  win.frame(2);
  assert.equal(win.scrollY, win.end());
  win.user(1200);
  Object.assign(win, { innerWidth: 393, innerHeight: 659, content: 3000 });
  win.resized();
  keep(() => { win.content += 12; }); // 53 px upright
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, 1200);
});

test('pinched in at the end and panned up a little, still within the last screen: the dock grows, then the phone turns, and the page stays where the user has it', () => {
  const win = phone();
  const { keep } = keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  win.pinch(1.5);
  win.scrolled();
  win.user(win.end() - 200); // 200 px above what can be shown of the end: the layout's last screen still reaches it
  const y = win.scrollY;
  keep(() => { win.content += 60; });
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, y); // read by the layout's height: thrown to the end, 260 px
  Object.assign(win, { innerWidth: 659 / 1.5, innerHeight: 393 / 1.5 });
  win.resized();
  win.scrolled();
  win.frame(2);
  assert.equal(win.scrollY, y);
});

test('pinched in at the end and zoomed back out there, then turned: the page is at its end again', () => {
  const win = phone();
  keepAtEnd(/** @type {any} */ (win));
  win.user(win.end());
  win.pinch(1.5);
  win.user(win.end()); // to what can be shown of the end: a zoomed scroll, which says nothing for a turn
  win.pinch(1); // zoomed out: the scroll comes back to the end
  win.scrolled();
  Object.assign(win, { innerWidth: 659, innerHeight: 393, content: 2400 });
  win.resized();
  win.scrolled();
  win.content = 2440;
  win.frame(2);
  assert.equal(win.scrollY, win.end());
});
