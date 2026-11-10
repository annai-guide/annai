/** The rows of a list on home the user can see: links in `.rows`, not those in a shut fold (the engines give them boxes too, unseen). @param {Element} el */
const rowsIn = (el) => [...el.querySelectorAll('.rows a[href]')].filter((a) => !a.closest('details:not([open])'));

/**
 * A change on home (a redraw, or words changed in place): the first row in view that is still shown stays where it was, whatever came or went above it, so a
 * finger's tap lands where it was aimed (no page scroll anchoring, base.css: annai keeps the screen in place itself). Not a row under the top bar or the
 * notices box stuck under it (base.css): one that came or went under those would move every row the user sees. A row is the same row by its address.
 * @param {() => number} under where the top bar and the box end, on screen
 * @param {Element} from the element whose rows are in view before @param {() => void} change @param {Element} [to] the element whose rows are in view after (default `from`)
 */
export function keepRows(under, from, change, to = from) {
  const top = under();
  const seen = rowsIn(from).map((a) => ({ href: a.getAttribute('href'), box: a.getBoundingClientRect() })).filter((r) => r.box.bottom > top);
  change();
  const fresh = new Map(rowsIn(to).map((a) => [a.getAttribute('href'), a]));
  const kept = seen.find((r) => fresh.has(r.href));
  const by = kept ? /** @type {Element} */ (fresh.get(kept.href)).getBoundingClientRect().top - kept.box.top : 0;
  if (by) scrollBy(0, by); // only when it moved
}
