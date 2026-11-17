import { updateAppSettings } from '../core/settings.js';
import { talkHref } from './format.js';
import { openOrTell, tellNotOpen } from './open-trip.js';
import { requestPersist } from './platform.js';
import { explainStorageFull } from './storage-full.js';

/**
 * Opens the standing draft once one is ready, as the open conversation: what + waits for in the first moments, and what the dock does first with nothing
 * open. annai opens the draft whenever nothing else is (the user's pick of 2026-11-14, "Open the new conversation"), so nothing is open only where that failed:
 * a start with no draft to be made, or a removal whose draft didn't open (trip.js only logs that), and the dock tries again at the user's next word.
 * Rejects when no draft can be made or it doesn't open: the caller says so (`cantStart`).
 * @param {any} ctx the shell's: chats, agent, ws @returns {Promise<string>} the draft
 */
export async function openDraft(ctx) {
  const id = await ctx.chats.whenReady();
  updateAppSettings(ctx.ws, { activeTrip: id }).catch(() => {});
  if (ctx.agent.target !== id) await ctx.agent.open(id);
  return id;
}

/**
 * Opens the ready draft as the open conversation at once, awaiting nothing, so what the tap does next (the microphone's unlock, an iPhone rule) stays inside
 * the gesture. False when no draft is ready yet: the caller waits for one (`openDraft`), late for the microphone, as + is in the first moments.
 * @param {any} ctx the shell's: chats, agent, ws @returns {boolean}
 */
export function openReadyDraft(ctx) {
  const id = ctx.chats?.ready;
  if (!id) return false;
  updateAppSettings(ctx.ws, { activeTrip: id }).catch(() => {});
  if (ctx.agent.target !== id) openOrTell(ctx, id);
  return true;
}

/** The card for a conversation that couldn't be started: storage full says what to free; anything else, that it didn't open. @param {any} ctx @param {unknown} e */
export const cantStart = (ctx, e) => { explainStorageFull(ctx, e) || tellNotOpen(ctx, e); };

/**
 * The +: a new conversation, with no naming step. With voice on, the draft is opened and tapped before anything is awaited, so the
 * microphone's start stays inside the tap (an iPhone rule). With voice off the box opens: a tap would hold voice on for the exchange, and
 * voice from home is then + and Shiori. In the first moments no draft is ready yet, and it goes once one is open; if none can be made, the card says so
 * and the tap is over: it never fires later, wherever the user has gone since.
 * @param {any} ctx the shell's: chats, agent, voice, ws, dock (a plugin's dock may have no openTyping)
 */
export function newConversation(ctx) {
  requestPersist(); // inside the tap, so browsers that ask the user can: a traveller who starts trips with + would never be asked otherwise
  const id = ctx.chats?.ready;
  if (!id) return void openDraft(ctx).then(() => newConversation(ctx), (/** @type {unknown} */ e) => cantStart(ctx, e));
  // Already open (+ again before a word was said): opening it again would close its microphone, and a tap on one listening, or getting ready to, stops it.
  const here = ctx.agent.target === id;
  openReadyDraft(ctx);
  const listening = here && ['opening', 'listening', 'hearing'].includes(ctx.agent.state?.name);
  if (!ctx.voice?.on || (!listening && ctx.agent.tap() === 'typing')) ctx.dock?.openTyping?.();
  location.hash = talkHref(id);
}
