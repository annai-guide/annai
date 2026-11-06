import { h, crumb, t } from '../dom.js';

/** A block of text as it is sent; folded, its title alone shows (a long conversation is the part that is read). @param {string} title @param {string} text @param {string} [lang] @param {boolean} [fold] */
const block = (title, text, lang, fold = false) => {
  const pre = h('pre', { class: 'mono wrap-text', ...(lang ? { lang } : {}), text });
  return h('section', { class: 'panel', 'aria-label': title }, fold
    ? h('details', { class: 'instructions' }, h('summary', { text: title }), pre)
    : [h('h2', { class: 'section', text: title }), pre]);
};

/** The titles that fold: the instructions and the tools are long and change little; the conversation is what is read. */
const FOLDED = () => [t`Its instructions`, t`Its setup: instructions`, t`Its tools`];

/** What a half sees, as the screen and Copy both show it. @param {any} seen @returns {{ lead: string, parts: [string, string, string?][] }} */
function shown(seen) {
  const tools = seen.tools.join(', ');
  if (seen.how === 'live') {
    return {
      lead: seen.open
        ? t`A live session gets its setup once, and the provider holds the rest. So this is the setup it was given, then the lines since, as annai wrote them down. It isn't a copy of a request.`
        : t`No live session is going. This is the setup the next one would get.`,
      parts: [[t`Its setup: instructions`, seen.system, 'en'], [t`Its setup: the conversation so far, and the moment`, seen.context], [t`Its tools`, tools, 'en'],
        ...(seen.open ? /** @type {[string, string][]} */ ([[t`The lines since`, seen.lines.join('\n') || t`Nothing yet.`]]) : [])],
    };
  }
  return {
    lead: seen.one ? t`Shiori is one half right now, so this is all of her: her next request, built by the code that sends it.` : t`Its next request, built by the code that sends it.`,
    parts: [[t`Its instructions`, seen.system, 'en'], [t`Its tools`, tools, 'en'], [t`Its conversation`, seen.lines.join('\n') || t`Nothing yet.`], [t`The block that ends the request`, seen.tail]],
  };
}

/** What each half sees (the second-drive design). Its route stands alone, so the menu that opens it can move. @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderSees(ctx, route) {
  const koe = route.params.half === 'koe';
  const title = koe ? t`What Koe sees` : t`What Kokoro sees`;
  const seen = await ctx.agent.sees(koe ? 'koe' : 'kokoro');
  const pick = (/** @type {string} */ half, /** @type {string} */ name) => h('a', { class: 'btn', href: `#/sees?half=${half}`, ...((half === 'koe') === koe ? { 'aria-current': 'page' } : {}), text: name });
  const head = [h('p', { class: 'crumbs' }, crumb('#/talk', t`Conversation`)), h('h1', { class: 'title', text: title }),
    h('div', { class: 'acts sees-switch', role: 'group', 'aria-label': t`Which half` }, pick('kokoro', t`Kokoro`), pick('koe', t`Koe`))];
  if (seen.how === 'off') return h('div', { class: 'screen' }, ...head, h('p', { class: 'sub', text: t`Koe isn't in use: Shiori is one half right now. Give Koe a model in Settings → Models to have two.` }));
  const { lead, parts } = shown(seen);
  const copy = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const all = parts.map(([name, text]) => `# ${name}\n${text}`).join('\n\n'); // folded or not, it all copies
      try {
        await navigator.clipboard.writeText(all);
        ctx.notices.toast(t`Copied.`);
      } catch {
        ctx.notices.toast(t`Copying didn't work here. Select the text on this screen instead.`);
      }
    },
  }, t`Copy`);
  return h('div', { class: 'screen sees' }, ...head, h('p', { class: 'sub', text: lead }), h('div', { class: 'acts' }, copy), ...parts.map(([name, text, lang]) => block(name, text, lang, FOLDED().includes(name))));
}
