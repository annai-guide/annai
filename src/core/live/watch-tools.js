/**
 * The Time tools (spec §7.2): watch_set, watch_list and watch_cancel. Providers accept only
 * letters, digits, "_" and "-" in a tool's name, so watch.set is watch_set (choice 1). Like the
 * Self tools, they are the loop's own, so they reach the live engine.
 * @param {import('./live.js').Live} live @returns {import('../agent/loop.js').LoopTool[]}
 */
export function watchTools(live) {
  const core = /** @type {const} */ ('core');
  return [
    {
      name: 'watch_set', pluginId: core, group: 'Time',
      // Read each time the tools are sent: a plugin may have added a trigger type (spec §11.3).
      get description() {
        const lines = [...live.types().values()].map((t) => `- ${t.summary}`).join('\n');
        return `Set a watch: annai wakes you when it fires, and says why. when.type is one of:\n${lines}\nfallback (required): what annai shows, and says with voice on, by itself if you can't be reached when it fires, such as "Low tide at Pfeiffer Beach in 30 minutes." repeat: fire every time, not just once (every always repeats; time never does). expires: an ISO date-time after which it is dropped. Location, distance and activity watches need live mode (GPS); time and every watches work whenever annai is on screen. The plan already sets its own reminders (leave, arrived, running late, off plan): don't add those.`;
      },
      get input() {
        return {
          type: 'object', required: ['when', 'fallback'],
          properties: {
            when: {
              type: 'object', required: ['type'],
              properties: {
                type: { enum: [...live.types().keys()] }, at: { type: 'string' }, minutes: { type: 'number' }, km: { type: 'number' },
                lat: { type: 'number' }, lng: { type: 'number' }, radius: { type: 'number' }, name: { type: 'string' },
                activity: { enum: ['still', 'walking', 'moving-fast'] }, edge: { enum: ['start', 'stop'] },
              },
            },
            fallback: { type: 'string', minLength: 1, maxLength: 500 },
            repeat: { type: 'boolean' },
            expires: { type: 'string' },
          },
        };
      },
      run: async (/** @type {any} */ i, /** @type {any} */ call) => live.watchText(await live.setWatch(call.scope, i)),
    },
    {
      name: 'watch_list', pluginId: core, group: 'Time',
      description: "Your watches in this conversation, and the plan's own reminders, as TSV: id, owner, when, repeat, reminder, expires, last_fired.",
      input: { type: 'object', properties: {} },
      run: async (/** @type {any} */ _i, /** @type {any} */ call) => live.listWatches(call.scope),
    },
    {
      name: 'watch_cancel', pluginId: core, group: 'Time',
      description: "Cancel one of your watches by its id (watch_list shows them). The plan's own reminders follow the plan: change the plan item instead.",
      input: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'] },
      run: async (/** @type {{ id: string }} */ i, /** @type {any} */ call) => live.cancelWatch(call.scope, String(i.id)),
    },
  ];
}
