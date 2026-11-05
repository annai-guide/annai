/**
 * Sound may play only after a tap (an iPhone rule, spec §10.1). Only some events count: on a touch
 * screen pointerup, touchend and click, never pointerdown (HTML's user activation); keydown for a
 * keyboard. It stays armed: sound that got stuck later needs a tap too, and unlock does nothing while sound is fine.
 */
export const UNLOCK_EVENTS = Object.freeze(['pointerup', 'touchend', 'click', 'keydown']);

/**
 * @param {EventTarget} target @param {() => unknown} unlock  called inside the tap (after a wait it no longer counts)
 * @returns {() => void} stops listening
 */
export function armUnlock(target, unlock) {
  const attempt = () => {
    try {
      unlock();
    } catch {
      // the next tap tries again
    }
  };
  for (const type of UNLOCK_EVENTS) target.addEventListener(type, attempt, true);
  return () => {
    for (const type of UNLOCK_EVENTS) target.removeEventListener(type, attempt, true);
  };
}
