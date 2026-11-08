import { updateAppSettings } from '../core/settings.js';
import { talkHref } from './format.js';
import { openOrTell } from './open-trip.js';

/**
 * The +: a new conversation, with no naming step. With voice on, the draft is opened and tapped before anything is awaited, so the
 * microphone's start stays inside the tap (an iPhone rule). With voice off the box opens: a tap would hold voice on for the exchange, and
 * voice from home is then + and Shiori. In the first moments no draft is ready yet, and it goes once one is.
 * @param {any} ctx the shell's: chats, agent, voice, ws, dock (a plugin's dock may have no openTyping)
 */
export function newConversation(ctx) {
  const id = ctx.chats?.ready;
  if (!id) return void ctx.chats?.whenReady().then(() => newConversation(ctx));
  updateAppSettings(ctx.ws, { activeTrip: id }).catch(() => {});
  openOrTell(ctx, id);
  if (!ctx.voice?.on || ctx.agent.tap() === 'typing') ctx.dock?.openTyping?.();
  location.hash = talkHref(id);
}
