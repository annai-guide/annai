import { h, crumb, t, field, twoStep, messageOf as message, showError, plural } from '../dom.js';
import { explainStorageFull } from '../storage-full.js';
import { num } from '../format.js';

const AUTH = /** @type {Record<string, string>} */ ({ none: t`No key`, token: t`A bearer token, kept on this device`, headers: t`Headers, kept on this device` });

/**
 * Settings → Tools → MCP servers (spec §5.1): the servers whose tools Shiori has, and adding one with
 * an address and a bearer token or headers (kept in secrets, never shown again).
 * @param {any} ctx
 */
export async function renderMcp(ctx) {
  /** @type {any} */
  const service = ctx.registry.list('mcp-servers')[0];
  const back = h('p', { class: 'crumbs' }, crumb('#/tools', t`Tools`));
  if (!service) {
    return h('div', { class: 'screen' }, back, h('h1', { class: 'title', text: t`MCP servers` }),
      h('p', { text: t`annai's MCP client isn't running. Reload annai and try again.` }));
  }
  const servers = await service.list();
  const name = h('input', { id: 'mcp-name', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: t`trail` });
  const address = h('input', { id: 'mcp-address', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: /* en */ 'https://…/mcp' });
  const kind = h('select', { id: 'mcp-key' },
    h('option', { value: 'none', text: t`None` }), h('option', { value: 'token', text: t`Bearer token` }), h('option', { value: 'headers', text: t`Headers` }));
  const token = h('input', { id: 'mcp-token', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const headers = h('textarea', { id: 'mcp-headers', rows: 3, spellcheck: 'false', autocapitalize: 'off', class: 'mono', placeholder: /* en */ 'X-Api-Key: …' });
  const tokenField = field(t`Token`, token);
  const headersField = field(t`Headers, one "Name: value" a line`, headers);
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
      add.textContent = t`Checking…`;
      try {
        const { tools } = await service.add({
          name: name.value, url: address.value,
          ...(kind.value === 'token' ? { token: token.value } : {}), ...(kind.value === 'headers' ? { headers: headers.value } : {}),
        });
        ctx.notices.toast(plural(tools, 'Added {0}: # tool.', 'Added {0}: # tools.', name.value.trim()));
        ctx.render();
      } catch (e) {
        if (explainStorageFull(ctx, e)) return;
        showError(error, e);
        error.hidden = false;
      } finally {
        add.disabled = false;
        add.textContent = t`Add server`;
      }
    },
  }, t`Add server`);
  return h('div', { class: 'screen' }, back,
    h('h1', { class: 'title', text: t`MCP servers` }),
    h('p', { class: 'sub', text: t`An MCP server gives Shiori tools of its own. Its tools appear in Settings → Tools, where each can be switched off, and every request to it is in the trace. What a server answers is yours to trust, as anything you bring in is.` }),
    servers.length ? h('ul', { class: 'cards' }, ...servers.map((/** @type {any} */ s) => serverCard(ctx, service, s))) : h('p', { class: 'empty', text: t`No MCP servers yet.` }),
    h('section', { class: 'panel', 'aria-label': t`Add a server` },
      h('h2', { class: 'section', text: t`Add a server` }),
      field(t`Name`, name),
      field(t`Address`, address),
      field(t`Key`, kind),
      tokenField, headersField,
      h('p', { class: 'sub', text: t`To change a server's token or headers later, remove it and add it again.` }),
      h('p', { class: 'sub', text: t`The server must let web apps call it (CORS): allow annai's address, the headers Content-Type, Accept, Authorization, Mcp-Session-Id and MCP-Protocol-Version, and expose Mcp-Session-Id.` }),
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
    s.more ? h('p', { class: 'sub', text: t`and ${num(s.more)} more it has, which annai leaves out` }) : null,
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            const { tools } = await service.refresh(s.name);
            ctx.notices.toast(plural(tools, '{0}: # tool.', '{0}: # tools.', s.name));
          } catch (e) {
            ctx.notices.card({ tone: 'warn', title: t`${s.name}'s tools weren't refreshed`, body: message(e) });
          }
          ctx.render();
        },
      }, t`Refresh tools`),
      twoStep(t`Remove`, t`Tap again to remove`, async () => {
        try {
          await service.remove(s.name);
        } catch (e) {
          if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: t`${s.name} wasn't removed`, body: t`${message(e)} Try again.` });
        }
        ctx.render();
      })));
}
