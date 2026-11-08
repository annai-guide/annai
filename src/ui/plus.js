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
  // Already open (+ again before a word was said): opening it again would close its microphone, and a tap on one listening stops it.
  const here = ctx.agent.target === id;
  if (!here) openOrTell(ctx, id);
  const listening = here && ['listening', 'hearing'].includes(ctx.agent.state?.name);
  if (!ctx.voice?.on || (!listening && ctx.agent.tap() === 'typing')) ctx.dock?.openTyping?.();
  location.hash = talkHref(id);
}
