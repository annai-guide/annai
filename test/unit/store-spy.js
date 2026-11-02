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

/** Notes the stores each transaction a store runs opens. @param {any} store @returns {string[][]} */
export function noteStores(store) {
  /** @type {string[][]} */
  const opened = [];
  const tx = store.tx.bind(store);
  store.tx = (/** @type {string[]} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => {
    opened.push([...names]);
    return tx(names, mode, fn);
  };
  return opened;
}

/** Counts the blobs a store's transactions read whole (getBlob) and by key (hasBlob). @param {any} store */
export function noteBlobReads(store) {
  const reads = { whole: 0, key: 0 };
  const tx = store.tx.bind(store);
  store.tx = (/** @type {any} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => tx(names, mode, (/** @type {any} */ t) => fn(new Proxy(t, {
    get(o, k) {
      if (k === 'getBlob') return (/** @type {string} */ h) => { reads.whole++; return o.getBlob(h); };
      if (k === 'hasBlob') return (/** @type {string} */ h) => { reads.key++; return o.hasBlob(h); };
      const v = o[k];
      return typeof v === 'function' ? v.bind(o) : v;
    },
  })));
  return reads;
}
