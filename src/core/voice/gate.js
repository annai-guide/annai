/**
 * The quick-decision gate's question (spec §10.4): is what the microphone heard meant for Shiori?
 * What was heard follows the question, resolved for the decision model like any heard speech.
 */
export const GATE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'shiori', label: 'Meant for Shiori: said to her, or answering her' }),
  Object.freeze({ id: 'chatter', label: 'Not meant for her: people talking among themselves, a phone call, the radio' }),
]);

/** @param {string} lastSaid what she said aloud last ('' when nothing yet) */
export function gatePrompt(lastSaid) {
  return [
    "Shiori is a travel guide in a phone app. She listens through the phone's microphone, often in a car with other people.",
    lastSaid ? `She last said aloud: "${lastSaid.slice(0, 300)}"` : 'She has said nothing aloud yet.',
    'What the microphone heard comes after the options. Is it meant for Shiori?',
  ].join('\n');
}
