/**
 * Sound may play only after a tap (an iPhone rule, spec §10.1). Only some events count: on a touch
 * screen pointerup, touchend and click, never pointerdown (HTML's user activation); keydown for a
 * keyboard. Every tap tries until one works.
 */
export const UNLOCK_EVENTS = Object.freeze(['pointerup', 'touchend', 'click', 'keydown']);

/**
 * @param {EventTarget} target @param {() => Promise<boolean> | boolean} unlock  called inside the tap; true once sound may play
 * @returns {() => void} stops listening
 */
export function armUnlock(target, unlock) {
  let done = false;
  const off = () => {
    for (const type of UNLOCK_EVENTS) target.removeEventListener(type, attempt, true);
  };
  const attempt = () => {
    if (done) return;
    /** @type {Promise<boolean> | boolean} */
    let tried;
    try {
      tried = unlock(); // now, in the tap: after a wait it no longer counts
    } catch {
      return;
    }
    Promise.resolve(tried).then((ok) => {
      if (ok && !done) {
        done = true;
        off();
      }
    }, () => {});
  };
  for (const type of UNLOCK_EVENTS) target.addEventListener(type, attempt, true);
  return () => {
    done = true;
    off();
  };
}
