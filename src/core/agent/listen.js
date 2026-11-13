/**
 * The words speak, wait and ask return about listening (spec §7.1). What the user said follows them
 * as heard speech, resolved for each model, so these say only what happened.
 * @typedef {{ heard?: import('../voice/resolve.js').Heard, text?: string, claim?: string, chose?: boolean, chosen?: string,
 *   stopped?: boolean, deaf?: string, gate?: string, earlier?: 'spoke' | 'wrote' | 'asked', note?: string, due?: 'reminder' | 'cue', voiced?: string, spoke?: string, also?: { heard: import('../voice/resolve.js').Heard, gate?: string }[],
 *   own?: import('../voice/resolve.js').Heard[], taken?: string[] }} Got
 *   what a listen got: speech for her (heard) or not (dismissed), typing, a tap on an option, a stop, why annai couldn't listen,
 *   or nothing (a silence); gate: what the quick-decision gate made of it; earlier: no listening, as a line of the user's from
 *   while she thought is waiting, spoken or written (it follows the result whole, with its photos and files); note: a note from the other half came (its name), which follows the result; due: a reminder or alert came (Koe's wait); voiced: the option
 *   a heard line answered annai's own question with (Agent.confirm); spoke: the other half's heard line (its id) that ended that question unanswered;
 *   also: the segments kept before heard while that question settled, in order; own: the listed words said to that question before what ended it
 *   (a "Yes" then taken back), written with its answer and never her next line; taken: with spoke, the lines the card took (cardTakes), which her result lists
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
