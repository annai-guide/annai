/** Notes every listEvents query a store answers. @param {any} store @returns {any[]} */
export function noteQueries(store) {
  /** @type {any[]} */
  const queries = [];
  const tx = store.tx.bind(store);
  store.tx = (/** @type {any} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => tx(names, mode, (/** @type {any} */ t) => fn(new Proxy(t, {
    get(o, k) {
      const v = o[k];
      if (k !== 'listEvents') return typeof v === 'function' ? v.bind(o) : v;
      return (/** @type {string} */ scope, /** @type {any} */ q = {}) => {
        queries.push(q);
        return o.listEvents(scope, q);
      };
    },
  })));
  return queries;
}
