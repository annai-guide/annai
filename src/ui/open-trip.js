import { t, messageOf } from './dom.js';
import { parseHash } from './router.js';
import { talkHref } from './format.js';
import { updateAppSettings } from '../core/settings.js';

/** Opens a conversation, or says it didn't and is false. @param {any} ctx @param {string | null} id */
export const openOrTell = (ctx, id) => ctx.agent.open(id).then(() => true, (/** @type {unknown} */ e) => {
  ctx.notices.card({ tone: 'warn', title: t`That conversation didn't open`, body: messageOf(e) });
  return false;
});

/**
 * A screen at a trip's own address (its conversation, Itinerary or Details) opens that trip's conversation, and only when the user
 * moved there: a redraw opens nothing, as `open` stops a turn and closes voice, and Shiori may have moved on meanwhile. A trip that
 * isn't here (removed, an old notification, a bookmark) goes home in place of this entry, so Back doesn't return to it; reached by Back or
 * Forward, the shell goes on the same way (shell.js `leave`).
 * @param {any} ctx the screen's: `moved` says it's a move, not a redraw @param {string} id
 * @returns {Promise<any>} the trip's scope record; null: it went home, and the screen draws nothing
 */
export async function openTrip(ctx, id) {
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ x) => x.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    ctx.goneTrip();
    return null;
  }
  if (ctx.agent && ctx.moved && ctx.agent.target !== id) {
    updateAppSettings(ctx.ws, { activeTrip: id }).catch(() => {});
    openOrTell(ctx, id);
  }
  return scope;
}

/** The address of the conversation being opened, or open: a trip's own, else the one outside any trip. @param {any} ctx */
export const talkOf = (ctx) => (ctx.agent?.target ? talkHref(ctx.agent.target) : '#/talk');

/**
 * Shows the open conversation, unless it shows already. On another's conversation, that entry becomes this one's, as a redraw would.
 * @param {any} ctx
 */
export function toTalk(ctx) {
  const want = talkOf(ctx);
  if (location.hash === want) return;
  if (parseHash(location.hash).name === 'talk') ctx.replace(want);
  else ctx.go(want);
}
