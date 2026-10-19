/**
 * Another address's provider plugin with code (spec §9.8; docs/plugins.md, "Model providers with code"): its
 * own Add flow looks for what an address offers, at no cost (probe.js), then adds a provider with what was
 * found switched on, so annai installs only the protocol plugins those need. A provider made from it has
 * annai's standard page, where each ability has its switch.
 */
import { probe, LOOKS } from './probe.js';

/** The note under what was found (the mockup's words). */
const FREE = 'annai only asked for the model list and sent an empty request to each known path. Nothing here costs money; Test sends real requests.';

/** @param {unknown} e */
const words = (e) => String(/** @type {any} */ (e)?.message ?? e);
/** A reason, after a colon. @param {string} s */
const after = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * One line of what was found: ✓ there, ✗ not there (or blocked), ? no telling.
 * @param {string} name @param {import('./probe.js').Finding} f
 */
export function findingLine(name, f) {
  if (f.state === 'found') return `✓ ${name}${f.count !== undefined ? `: ${f.count} model${f.count === 1 ? '' : 's'}` : ''}${f.why ? `: ${after(f.why)}` : ''}`;
  if (f.state === 'absent') return `✗ ${name}: not found${f.why ? ` (${after(f.why).replace(/\.$/, '')})` : ''}`;
  if (f.state === 'blocked') return `✗ ${name}: blocked: it doesn't allow web apps (no CORS)`;
  return `? ${name}: ${after(f.why ?? "annai can't tell.")}`;
}

/**
 * What was found, in a line or two above the list. @param {import('./probe.js').Probe} r @param {string} host
 * @param {boolean} any whether anything annai can use was found
 */
function summary(r, host, any) {
  const all = [r.list, ...Object.values(r.abilities)];
  if (all.every((f) => f.state === 'unreachable')) return `annai couldn't reach ${host}. Check the address and your connection.`;
  if (all.every((f) => f.state === 'blocked')) return `${host} doesn't allow web apps like annai to call it (no CORS headers), so annai can't use it from a browser. If it has a setting for the addresses allowed to call it (CORS), add annai's.`;
  return any ? `What ${r.base} offers:` : `annai found nothing at ${r.base} that it can use. Below is why.`;
}

/**
 * The setup annai.providers.setup takes. io: annai's traced fetch, the no-cors check and its address check.
 * @param {import('./probe.js').Io} io
 */
export function anotherAddress(io) {
  return {
    /** The address, a key if it needs one, a look at what it offers, and Add with these. @param {any} ui @param {any} provider */
    panel(ui, provider) {
      if (provider) return null; // a provider's own page: annai's switches, one for each ability
      const { h } = ui;
      const results = h('div', {});
      const status = h('p', { class: 'sub', role: 'status' });
      // A look is for the address and key it looked with: changing either asks for another.
      const changed = () => {
        results.replaceChildren();
        status.textContent = '';
      };
      const address = h('input', { id: 'probe-address', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://…/v1', oninput: changed });
      const key = h('input', { id: 'probe-key', type: 'password', autocomplete: 'off', placeholder: 'if it needs one', oninput: changed });
      /** @param {import('./probe.js').Probe} r @param {string | null} k */
      const show = (r, k) => {
        const host = new URL(r.base).host;
        const found = LOOKS.filter((l) => r.abilities[l.id].state === 'found');
        const add = h('button', {
          class: 'btn pri', type: 'button',
          onclick: async () => {
            add.disabled = true;
            status.textContent = 'Adding it, with what it needs…';
            try {
              await ui.add({
                name: host, baseUrl: r.base, key: k ?? undefined, roles: null,
                // Anthropic Messages at the address without /v1, as that protocol adds /v1/messages itself.
                abilities: Object.fromEntries(found.map((l) => [l.id, { on: true, ...(l.root && r.root !== r.base ? { baseUrl: r.root } : {}) }])),
              });
              status.textContent = `Added ${host}.`;
            } catch (e) {
              status.textContent = words(e);
              add.disabled = false;
            }
          },
        }, 'Add with these');
        status.textContent = summary(r, host, found.length > 0);
        results.replaceChildren(
          h('h3', { text: 'Found, at no cost' }),
          h('ul', { class: 'checks-result' },
            ...[['Model list', r.list], ...LOOKS.map((l) => [l.name, r.abilities[l.id]])].map(([name, f]) => {
              const line = findingLine(/** @type {string} */ (name), /** @type {any} */ (f));
              return h('li', { class: line.startsWith('✓') ? 'ok' : 'bad', text: line });
            })),
          h('p', { class: 'sub', text: FREE }),
          found.length ? h('div', { class: 'acts' }, add) : null);
      };
      const look = h('button', {
        class: 'btn pri', type: 'button',
        onclick: async () => {
          look.disabled = true;
          changed();
          status.textContent = 'Looking: the model list, then an empty request to each known path…';
          try {
            const k = key.value.trim() || null;
            show(await probe(address.value, k, io), k);
          } catch (e) {
            status.textContent = words(e);
          } finally {
            look.disabled = false;
          }
        },
      }, 'Look for what it offers');
      /** @param {string} label @param {any} input */
      const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input);
      return h('div', {},
        h('p', { text: 'Give its address, and its key if it needs one. annai looks for what it offers, at no cost, then adds it with what it found.' }),
        field('Address', address),
        field('API key (optional)', key),
        h('div', { class: 'acts' }, look),
        status,
        results);
    },
  };
}

/** @param {any} annai */
export function activate(annai) {
  /** @type {import('./probe.js').Fetch} */
  const fetch = (url, init) => annai.net.fetch(url, init);
  // Whether a server answers at all, as the Test button asks: a no-cors GET, which a browser sends whatever the server's
  // CORS says. It carries no key, no body and no cookies. A browser sends no-cors requests only if they may follow a
  // redirect (otherwise they fail as unreachable), so this one may; the requests with the key never do.
  const reach = (/** @type {string} */ url) => annai.net.fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15_000) }).then(() => true, () => false);
  return annai.providers.setup(anotherAddress({ fetch, reach, problem: annai.helpers.addressProblem }));
}
