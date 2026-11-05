/**
 * The quick-decision gate's question (spec §10.4): is what the microphone heard meant for Shiori?
 * What was heard follows the question, resolved for the decision model like any heard speech.
 */
/* en */ export const GATE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'shiori', label: 'Meant for Shiori: said to her, or answering her' }),
  Object.freeze({ id: 'chatter', label: 'Not meant for her: people talking among themselves, a phone call, the radio' }),
]);

/**
 * @param {string[]} lines the conversation's last lines, oldest first, each with who said it ([] when none yet). A wrong "for her" costs a
 * short reply, and a wrong "not for her" loses what the user said (the second drive: real comments in a quiet car, right after she spoke), so it leans to her.
 */
export function gatePrompt(lines) {
  /* en */ return [
    "Shiori is a travel guide in a phone app, and the user talks to her through the phone's microphone.",
    lines.length ? `The conversation's last lines:\n${lines.join('\n')}` : 'Nothing has been said yet.',
    'Speech about annai (the app), about how Shiori behaves, or about a thing just said is for her, even with no question in it and without her name: a comment, a suggestion or an opinion counts. Only plain talk to someone else, a phone call, the radio or a song is not. When unsure, it is for her: a wrong "for her" costs a short reply; a wrong "not for her" loses what the user said.',
    'What the microphone heard comes after the options. Is it meant for Shiori?',
  ].join('\n');
}
