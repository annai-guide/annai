/**
 * The words speak, wait and ask return about listening (spec §7.1). What the user said follows them
 * as heard speech, resolved for each model, so these say only what happened.
 * @typedef {{ heard?: import('../voice/resolve.js').Heard, dismissed?: import('../voice/resolve.js').Heard, text?: string, chosen?: string,
 *   stopped?: boolean, deaf?: string, gate?: string, earlier?: boolean, note?: string }} Got
 *   what a listen got: speech for her (heard) or not (dismissed), typing, a tap on an option, a stop, why annai couldn't listen,
 *   or nothing (a silence); gate: what the quick-decision gate made of it; earlier: no listening, as speech heard while she
 *   thought is waiting (it follows the result); note: a note from the other half came (its name), which follows the result
 */

/** How speak's result begins: what she said, and whether the user stopped her (spec §7.1). @param {import('../voice/speaker.js').Spoken} spoken */
export function spokenText(spoken) {
  if (!spoken.cut) /* en */ return 'Said aloud.';
  /* en */ return spoken.heard ? `The user stopped you after: "${spoken.heard}".` : 'The user stopped you before you said anything.';
}

/** A reply that couldn't be said aloud, for speak's result. @param {'no-voice' | 'blocked'} why */
export function unspoken(why) {
  /* en */ return `Not said aloud: ${why === 'blocked' ? "the browser didn't let annai play sound yet" : 'no voice in the speech-out list could speak'}. It was shown on screen instead; the user may type.`;
}
