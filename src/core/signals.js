/**
 * A signal that aborts when any of these does, with that one's reason. AbortSignal.any came in Chrome 116 and
 * Safari 17.4; annai's floor (iOS 16.4) and Chrome 113 lack it, so it is made by hand there.
 * @param {AbortSignal[]} signals @returns {AbortSignal}
 */
export function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const c = new AbortController();
  const stop = () => {
    for (const s of signals) s.removeEventListener('abort', stop);
    c.abort(signals.find((s) => s.aborted)?.reason);
  };
  if (signals.some((s) => s.aborted)) stop();
  else for (const s of signals) s.addEventListener('abort', stop);
  return c.signal;
}
