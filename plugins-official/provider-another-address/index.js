/**
 * Custom provider's provider plugin with code (spec §9.8; docs/plugins.md, "Model providers with code"): its
 * own Add flow looks for what an address offers, at no cost (probe.js), then adds a provider with what was
 * found switched on, so annai installs only the protocol plugins those need. A provider made from it has
 * annai's standard page, where each ability has its switch.
 */
import { probe, LOOKS } from './probe.js';

/** @param {unknown} e */
const words = (e) => String(/** @type {any} */ (e)?.message ?? e);

/**
 * One line of what was found, in whole sentences after its name: ✓ there, ✗ not there (or blocked), ? no telling. A speech
 * path (transcription, voice) a server may answer for every model it has (Ollama does), so it says only that it is there;
 * Test says whether a model there can listen or speak. off: its model list names none, so it is added switched off.
 * @param {any} l10n annai.l10n @param {string} name @param {import('./probe.js').Finding} f
 * @param {{ id: string, off: boolean }} [speech]
 */
export function findingLine({ t, plural, format }, name, f, speech) {
  /** @param {string} mark @param {...string} parts */
  const line = (mark, ...parts) => `${mark} ${parts.some(Boolean) ? t`${name}: ${format.sentences(...parts)}` : name}`;
  const why = f.why ?? '';
  if (f.state === 'found' && speech) {
    const listen = speech.id === 'transcription';
    return line('✓', listen ? t`The path is there; Test says whether a model there can listen.` : t`The path is there; Test says whether a model there can speak.`, why,
      !speech.off ? '' : listen ? t`Its model list names no transcription model, so it's added switched off.` : t`Its model list names no voice, so it's added switched off.`);
  }
  if (f.state === 'found') return line('✓', f.count === undefined ? '' : plural(f.count, '# model.', '# models.'), why);
  if (f.state === 'absent') return line('✗', t`Not found.`, why);
  if (f.state === 'blocked') return line('✗', t`Blocked: it doesn't allow web apps (no CORS).`);
  return line('?', why || t`annai can't tell.`);
}

/**
 * What was found, in a line or two above the list. @param {any} l10n @param {import('./probe.js').Probe} r @param {string} host
 * @param {boolean} any whether anything annai can use was found
 */
function summary({ t }, r, host, any) {
  const all = [r.list, ...Object.values(r.abilities)];
  if (all.every((f) => f.state === 'unreachable')) return t`annai couldn't reach ${host}. Check the address and your connection.`;
  if (all.every((f) => f.state === 'blocked')) return t`${host} doesn't allow web apps like annai to call it (no CORS headers), so annai can't use it from a browser. If it has a setting for the addresses allowed to call it (CORS), add annai's.`;
  return any ? t`What ${r.base} offers:` : t`annai found nothing at ${r.base} that it can use. Below is why.`;
}

/** The speech paths, which say only that they are there. */
const SPEECH = new Set(['transcription', 'voice']);

/**
 * The setup annai.providers.setup takes. io: annai's traced fetch, the no-cors check and its address check.
 * @param {import('./probe.js').Io} io
 */
export function anotherAddress(io) {
  const { t } = io.l10n;
  /** A path's name: a protocol's as written, transcription and voice in words. @param {(typeof LOOKS)[number]} l */
  const nameOf = (l) => (l.id === 'transcription' ? t`Transcription` : l.id === 'voice' ? t`Voice` : l.name);
  return {
    /** The address, a key if it needs one, a look at what it offers, and Add with these. @param {any} ui @param {any} provider */
    panel(ui, provider) {
      if (provider) return null; // a provider's own page: annai's switches, one for each ability
      const { h } = ui;
      const results = h('div', {});
      const status = h('p', { class: 'sub', role: 'status' });
      // A look is for the address and key it looked with: changing either, even while it runs, asks for another.
      let looks = 0;
      let looked = false;
      /** @param {string} [what] the field changed, said once there has been a look */
      const changed = (what) => {
        looks += 1;
        results.replaceChildren();
        status.textContent = !what || !looked ? '' : what === 'address' ? t`The address changed: look again.` : t`The key changed: look again.`;
      };
      const address = h('input', { id: 'probe-address', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://…/v1', oninput: () => changed('address') });
      const key = h('input', { id: 'probe-key', type: 'password', autocomplete: 'off', placeholder: t`if it needs one`, oninput: () => changed('key') });
      /** @param {import('./probe.js').Probe} r @param {string | null} k */
      const show = (r, k) => {
        const host = new URL(r.base).host;
        const found = LOOKS.filter((l) => r.abilities[l.id].state === 'found');
        // A speech path found is switched on only where the model list names a model for it.
        const off = (/** @type {string} */ id) => SPEECH.has(id) && !r.list.speech?.[/** @type {'transcription' | 'voice'} */ (id)];
        const add = h('button', {
          class: 'btn pri', type: 'button',
          onclick: async () => {
            add.disabled = true;
            status.textContent = t`Adding it, with what it needs…`;
            try {
              await ui.add({
                name: host, baseUrl: r.base, key: k ?? undefined, roles: null,
                // Anthropic Messages at the address without /v1, as that protocol adds /v1/messages itself.
                abilities: Object.fromEntries(found.filter((l) => !off(l.id)).map((l) => [l.id, { on: true, ...(l.root && r.root !== r.base ? { baseUrl: r.root } : {}) }])),
              });
              status.textContent = t`Added ${host}.`;
            } catch (e) {
              status.textContent = words(e);
              add.disabled = false;
            }
          },
        }, t`Add with these`);
        status.textContent = summary(io.l10n, r, host, found.length > 0);
        results.replaceChildren(
          h('h3', { text: t`Found, at no cost` }),
          h('ul', { class: 'checks-result' },
            h('li', { class: r.list.state === 'found' ? 'ok' : 'bad', text: findingLine(io.l10n, t`Model list`, r.list) }),
            ...LOOKS.map((l) => {
              const line = findingLine(io.l10n, nameOf(l), r.abilities[l.id], SPEECH.has(l.id) ? { id: l.id, off: off(l.id) } : undefined);
              return h('li', { class: line.startsWith('✓') ? 'ok' : 'bad', text: line });
            })),
          h('p', { class: 'sub', text: t`annai only asked for the model list and sent an empty request to each known path. Nothing here costs money; Test sends real requests.` }),
          ...(found.length ? [h('div', { class: 'acts' }, add)] : []));
      };
      const look = h('button', {
        class: 'btn pri', type: 'button',
        onclick: async () => {
          look.disabled = true;
          looked = true;
          changed();
          const mine = looks;
          status.textContent = t`Looking: the model list, then an empty request to each known path…`;
          try {
            const k = key.value.trim() || null;
            const r = await probe(address.value, k, io);
            if (mine === looks) show(r, k);
          } catch (e) {
            if (mine === looks) status.textContent = words(e);
          } finally {
            look.disabled = false;
          }
        },
      }, t`Look for what it offers`);
      /** @param {string} label @param {any} input */
      const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input);
      return h('div', {},
        h('p', { text: t`Give its address, and its key if it needs one. annai looks for what it offers, at no cost, then adds it with what it found.` }),
        field(t`Address`, address),
        field(t`API key (optional)`, key),
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
  return annai.providers.setup(anotherAddress({ fetch, reach, problem: annai.helpers.addressShown, l10n: annai.l10n }));
}
