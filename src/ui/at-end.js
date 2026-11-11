/**
 * A page read to its end stays there when its end moves: the dock changes height (53 px tall, 41 on its side; voice on, typing open, her words) or a
 * phone is turned (the window's width changes). Anywhere else nothing moves.
 * The dock's change is read as it comes (keep): the dock is fixed, so until the page makes room for it the page is laid out as before, and whether the
 * user sees its end is true then, whatever opened below or however it is zoomed (a remembered end was stale by then: the final review of home2, F1).
 * A turn's resize comes with the page at its new size and WebKit's scroll clamped to it (and WebKit's documentElement still a frame behind), so for a
 * turn "at its end" is what the user's own scrolls left: not one at another size than the last resize's, nor one to where the page was put (its
 * event comes after the next fit; WebKit's clamp to a stale layout lands there too). It is put back after the cards' fit (their resize handler runs
 * first) and two frames on. A pinch-zoomed reader is not at its end for a turn: iOS's innerWidth follows a pinch, so its scrolls can't be read here.
 * A resize that keeps the width is a toolbar or a keyboard, which come as the user scrolls or types: the page stays where the user has it. Its size
 * is still the one the next scrolls are read at.
 * @param {Window} [win] @returns {{ keep: (change: () => void) => void }} keep: makes a change of the dock's height, then puts the page back at its
 *   end if the user saw its end
 */
export function keepAtEnd(win = window) {
  const d = win.document.documentElement;
  /** The user sees the page's end (innerHeight: what is shown, zoomed too), the page scrolled (one that fits is at its top). */
  const seen = () => win.scrollY > 0 && win.scrollY + win.innerHeight >= d.scrollHeight - 1;
  let atEnd = false;
  let ours = -1;
  const put = () => {
    win.scrollTo(win.scrollX, d.scrollHeight);
    ours = win.scrollY;
  };
  const sizeNow = () => `${win.innerWidth}x${win.innerHeight}`;
  let sizeSeen = sizeNow();
  let width = win.innerWidth;
  const zoomed = () => (win.visualViewport?.scale ?? 1) > 1;
  const turned = () => { if (atEnd && !zoomed()) put(); };
  win.addEventListener('scroll', () => {
    if (zoomed()) atEnd = false;
    else if (sizeNow() !== sizeSeen || win.scrollY === ours) return;
    else atEnd = seen();
    ours = -1;
  }, { passive: true });
  win.addEventListener('resize', () => {
    sizeSeen = sizeNow();
    if (win.innerWidth === width) return;
    width = win.innerWidth;
    turned();
    win.requestAnimationFrame(() => win.requestAnimationFrame(turned));
  });
  return {
    keep(change) {
      const was = seen();
      change();
      if (was) put();
    },
  };
}
