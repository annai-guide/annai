/**
 * Keeps one running copy of annai per device (spec §4.6), using a Web Lock held
 * until the page closes. If another tab holds it, onHeldElsewhere decides
 * whether to take it over; the tab that loses the lock gets onStolen.
 * @param {{ onHeldElsewhere: () => Promise<boolean>, onStolen: () => void }} hooks
 * @returns {Promise<boolean>} true when this page holds the lock
 */
export async function acquireInstanceLock({ onHeldElsewhere, onStolen }) {
  if (!navigator.locks) return true;
  if (await request({ ifAvailable: true }, onStolen)) return true;
  if (!(await onHeldElsewhere())) return false;
  return request({ steal: true }, onStolen);
}

/** @param {LockOptions} opts @param {() => void} onStolen @returns {Promise<boolean>} */
function request(opts, onStolen) {
  return new Promise((resolve) => {
    navigator.locks
      .request('annai-instance', opts, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise(() => {}); // held until the page closes or another tab steals it
      })
      .catch((e) => {
        if (e?.name === 'AbortError') onStolen();
      });
  });
}
