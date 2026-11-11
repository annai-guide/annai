/**
 * A page read to its end stays there when its end moves: a phone turned (the window's width changes) or the dock's height (53 px tall, 41 on
 * its side). "At its end" is what the user's own scrolls left: not one at another size than the last resize's (WebKit clamps first), nor one to
 * where toEnd last put the page (its event comes after the next fit; WebKit's clamp to a stale layout lands there too). Put back after each fit:
 * the cards' (their resize handler runs first), the dock's (it calls toEnd), and the engine's layout two frames on.
 * A resize that keeps the width is a tab's toolbar or a keyboard, which come and go as the user scrolls or types: the page is left where the
 * user has it (its resize can come before or after the scroll that showed the toolbar, so "at its end" may be from before that scroll). Its
 * size is still the one the next scrolls are read at.
 * @param {Window} [win] @returns {{ toEnd: () => void }} toEnd: puts the page back at its end, if the user left it there
 */
export function keepAtEnd(win = window) {
  const d = win.document.documentElement;
  let atEnd = false;
  let ours = -1;
  const sizeNow = () => `${win.innerWidth}x${win.innerHeight}`;
  let sizeSeen = sizeNow();
  let width = win.innerWidth;
  const toEnd = () => {
    if (!atEnd) return;
    win.scrollTo(0, d.scrollHeight);
    ours = win.scrollY;
  };
  win.addEventListener('scroll', () => {
    if (sizeNow() !== sizeSeen || win.scrollY === ours) return;
    atEnd = win.scrollY > 0 && win.scrollY + d.clientHeight >= d.scrollHeight - 1;
    ours = -1;
  }, { passive: true });
  win.addEventListener('resize', () => {
    sizeSeen = sizeNow();
    if (win.innerWidth === width) return;
    width = win.innerWidth;
    toEnd();
    win.requestAnimationFrame(() => win.requestAnimationFrame(toEnd));
  });
  return { toEnd };
}
