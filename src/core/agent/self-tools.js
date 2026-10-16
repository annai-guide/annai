import { tunePersonality } from './personalities.js';

/**
 * Self tools (spec §7.2): the loop's own tools for Shiori herself.
 * @param {import('./loop.js').Agent} agent @returns {import('./loop.js').LoopTool[]}
 */
export function selfTools(agent) {
  return [
    {
      name: 'tune_personality', pluginId: 'core', group: 'Self',
      description: 'Rewrite your personality (the whole Markdown file) to change how you behave, with a short reason the user will see. Facts about the user go in /me/memory.md instead. A review checks it, and it applies at your next wake. Give a new name to create another personality.',
      input: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 }, name: { type: 'string' } }, required: ['text', 'reason'] },
      run: async (/** @type {{ text: string, reason: string, name?: string }} */ i, /** @type {any} */ call) =>
        tunePersonality({ agent, name: i.name ?? (await agent.settings()).personality, text: i.text, reason: i.reason, callId: call.id, wake: call.wake }),
    },
  ];
}
