/**
 * What an engine throws, as the code that throws it (the real thing where Node has one; a browser's DOM gives the rest), keyed by the error's
 * name: a crash is a program doing something wrong, and some of those the engine throws as a DOMException, so no `instanceof TypeError` matches
 * them (plugin-link-fix1: isPluginBug counts these by name). Used by the tests of a start, a hook and a drawing.
 */
/** @type {Record<string, string>} what counts against a plugin */
export const CRASH_CODE = {
  URIError: "decodeURIComponent('%');",
  SyntaxError: "throw new DOMException('\"!!\" is not a valid selector.', 'SyntaxError');", // querySelector('!!')
  InvalidCharacterError: "atob('%%%');",
  DataCloneError: 'structuredClone(() => {});',
  HierarchyRequestError: "throw new DOMException('The new child element contains the parent.', 'HierarchyRequestError');",
  IndexSizeError: "throw new DOMException('The index is not in the allowed range.', 'IndexSizeError');",
};

/** @type {Record<string, string>} what a link, a stop, a time limit, a full phone or annai's own store can give: an answer, never a crash */
export const ANSWER_CODE = {
  AbortError: "throw new DOMException('The operation was aborted.', 'AbortError');",
  TimeoutError: "throw new DOMException('The operation timed out.', 'TimeoutError');",
  NetworkError: "throw new DOMException('A network error occurred.', 'NetworkError');",
  QuotaExceededError: "throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');",
  InvalidStateError: "throw new DOMException('The object is in an invalid state.', 'InvalidStateError');",
  NotFoundError: "throw new DOMException('The object can not be found here.', 'NotFoundError');",
};

/** What one of the above throws. @param {string} code @returns {any} */
export function thrownBy(code) {
  try {
    new Function(code)();
  } catch (e) {
    return e;
  }
  throw new Error(`${code} did not throw`);
}

/** Each of them as a function that throws it, by name. @param {Record<string, string>} codes @returns {Record<string, () => void>} */
export const throwing = (codes) => Object.fromEntries(Object.entries(codes).map(([name, code]) => [name, /** @type {() => void} */ (new Function(code))]));
