import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { TELL_RECAP } from '../../src/core/after/recap.js';

test('asked to tell the recap, Shiori reads it and says it aloud, even with voice off; the tap is the user\'s, so budgets don\'t hold it (spec §13, choice 6)', async () => {
  const k = await agentKit([{
    rules: [{
      match: "asked to hear the trip's recap",
      reply: { toolCalls: [{ name: 'read', input: { path: '/trip/recap.md' } }] },
      then: { toolCalls: [{ name: 'speak', input: { text: 'Friday began at Bixby Bridge.' } }, { name: 'sleep', input: {} }] },
    }],
  }], { voice: { mode: 'off' } });
  await k.ws.write(k.trip, '/recap.md', '# Big Sur\n\nFriday began at Bixby Bridge.\n', { author: 'shiori' });
  const { updateAppSettings } = await import('../../src/core/settings.js');
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  await k.agent.wake({ kind: 'trigger', text: 'something fired' }); // uses the hour's one wake
  await k.agent.idle();
  await k.agent.wake({ kind: 'recap', aloud: true, text: TELL_RECAP });
  await k.agent.idle();
  assert.ok(k.said.includes('Friday began at Bixby Bridge.'), k.said.join(' | '));
  const [speak] = (await k.events(['out.speak'])).slice(-1);
  assert.equal(speak.data.voice, true);
  const wake = (await k.events(['wake'])).at(-1);
  assert.deepEqual(wake.data.reasons.map((/** @type {any} */ r) => r.kind), ['recap']);
  assert.equal(k.voice.on, false); // the voice setting itself didn't change
});
