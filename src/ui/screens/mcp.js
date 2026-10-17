import { h, field, twoStep } from '../dom.js';
import { explainStorageFull } from '../storage-full.js';

const message = (/** @type {any} */ e) => String(e?.message ?? e);
const AUTH = /** @type {Record<string, string>} */ ({ none: 'No key', token: 'A bearer token, kept on this device', headers: 'Headers, kept on this device' });

/**
 * Settings → Tools → MCP servers (spec §5.1): the servers whose tools Shiori has, and adding one with
 * an address and a bearer token or headers (kept in secrets, never shown again).
 * @param {any} ctx
 */
export async function renderMcp(ctx) {
  /** @type {any} */
  const service = ctx.registry.list('mcp-servers')[0];
  const back = h('p', { class: 'crumbs' }, h('a', { href: '#/tools' }, '← Tools'));
  if (!service) {
    return h('div', { class: 'screen' }, back, h('h1', { class: 'title', text: 'MCP servers' }),
      h('p', { text: "annai's MCP client isn't running. Reload annai and try again." }));
  }
  const servers = await service.list();
  const name = h('input', { id: 'mcp-name', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'trail' });
  const address = h('input', { id: 'mcp-address', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://…/mcp' });
  const kind = h('select', { id: 'mcp-key' },
    h('option', { value: 'none', text: 'None' }), h('option', { value: 'token', text: 'Bearer token' }), h('option', { value: 'headers', text: 'Headers' }));
  const token = h('input', { id: 'mcp-token', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const headers = h('textarea', { id: 'mcp-headers', rows: 3, spellcheck: 'false', autocapitalize: 'off', class: 'mono', placeholder: 'X-Api-Key: …' });
  const tokenField = field('Token', token);
  const headersField = field('Headers, one "Name: value" a line', headers);
  const show = () => {
    tokenField.hidden = kind.value !== 'token';
    headersField.hidden = kind.value !== 'headers';
  };
  kind.addEventListener('change', show);
  show();
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const add = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      error.hidden = true;
      add.disabled = true;
      add.textContent = 'Checking…';
      try {
        const { tools } = await service.add({
          name: name.value, url: address.value,
          ...(kind.value === 'token' ? { token: token.value } : {}), ...(kind.value === 'headers' ? { headers: headers.value } : {}),
        });
        ctx.notices.toast(`Added ${name.value.trim()}: ${tools} tool${tools === 1 ? '' : 's'}.`);
        ctx.render();
      } catch (e) {
        if (explainStorageFull(ctx, e)) return;
        error.textContent = message(e);
        error.hidden = false;
      } finally {
        add.disabled = false;
        add.textContent = 'Add server';
      }
    },
  }, 'Add server');
  return h('div', { class: 'screen' }, back,
    h('h1', { class: 'title', text: 'MCP servers' }),
    h('p', { class: 'sub', text: "An MCP server gives Shiori tools of its own. Its tools appear in Settings → Tools, where each can be switched off, and every request to it is in the trace. What a server answers is yours to trust, as anything you bring in is." }),
    servers.length ? h('ul', { class: 'cards' }, ...servers.map((/** @type {any} */ s) => serverCard(ctx, service, s))) : h('p', { class: 'empty', text: 'No MCP servers yet.' }),
    h('section', { class: 'panel', 'aria-label': 'Add a server' },
      h('h2', { class: 'section', text: 'Add a server' }),
      field('Name', name),
      field('Address', address),
      field('Key', kind),
      tokenField, headersField,
      h('p', { class: 'sub', text: "The server must let web apps call it (CORS): allow annai's address, the headers Content-Type, Accept, Authorization, Mcp-Session-Id and MCP-Protocol-Version, and expose Mcp-Session-Id." }),
      error,
      h('div', { class: 'acts' }, add)));
}

/** @param {any} ctx @param {any} service @param {any} s a server as the service lists it */
function serverCard(ctx, service, s) {
  return h('li', { class: 'card' },
    h('span', { class: 'name', text: s.name }),
    h('span', { class: 'sub', text: s.url }),
    h('span', { class: 'sub', text: AUTH[s.auth] ?? AUTH.none }),
    h('ul', { class: 'brings' }, ...s.tools.map((/** @type {any} */ t) => h('li', { text: t.name }))),
    s.more ? h('p', { class: 'sub', text: `and ${s.more} more it has, which annai leaves out` }) : null,
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            const { tools } = await service.refresh(s.name);
            ctx.notices.toast(`${s.name}: ${tools} tool${tools === 1 ? '' : 's'}.`);
          } catch (e) {
            ctx.notices.card({ tone: 'warn', title: `${s.name}'s tools weren't refreshed`, body: message(e) });
          }
          ctx.render();
        },
      }, 'Refresh tools'),
      twoStep('Remove', 'Tap again to remove', async () => {
        try {
          await service.remove(s.name);
        } catch (e) {
          if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: `${s.name} wasn't removed`, body: `${message(e)} Try again.` });
        }
        ctx.render();
      })));
}
