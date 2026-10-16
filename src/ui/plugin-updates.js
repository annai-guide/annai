import { officialUpdates, updateOfficial } from '../core/llm/official.js';

/**
 * Looks for newer versions of the official plugins installed, and offers them on one card (spec
 * §5.3). Quiet when offline or when there is nothing new.
 * @param {{ plugins: any, notices: any }} ctx
 * @param {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, reload?: () => void }} [env]
 */
export async function offerPluginUpdates(ctx, env = {}) {
  /** @type {Awaited<ReturnType<typeof officialUpdates>>} */
  let updates;
  try {
    updates = await officialUpdates(ctx.plugins, env);
  } catch {
    return [];
  }
  if (!updates.length) return updates;
  ctx.notices.card({
    title: 'Plugin updates are ready',
    body: `New versions: ${updates.map((u) => `${u.name} ${u.installed} → ${u.available}`).join(', ')}. Nothing changes until you update.`,
    actions: [{ label: 'Update', primary: true, run: () => { applyUpdates(ctx, updates, env); } }],
  });
  return updates;
}

/**
 * Installs the updates the user accepted, and says what happened: done, done after a restart, or
 * which ones failed and why.
 * @param {{ plugins: any, notices: any }} ctx @param {Awaited<ReturnType<typeof officialUpdates>>} updates
 * @param {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, reload?: () => void }} [env]
 */
export async function applyUpdates(ctx, updates, env = {}) {
  let restart = false;
  /** @type {string[]} */
  const failed = [];
  for (const u of updates) {
    try {
      if ((await updateOfficial(ctx.plugins, u.entry, env)) === 'restart') restart = true;
    } catch (e) {
      failed.push(`${u.name}: ${/** @type {any} */ (e)?.message ?? e}`);
    }
  }
  if (failed.length) ctx.notices.card({ tone: 'warn', title: "Some plugins weren't updated", body: failed.join(' ') });
  if (restart) {
    ctx.notices.card({
      title: 'Restart annai to use the new versions',
      body: 'The update is installed. It runs the next time annai starts.',
      actions: [{ label: 'Restart now', primary: true, run: env.reload ?? (() => location.reload()) }],
    });
  } else if (!failed.length) {
    ctx.notices.toast('Plugins updated.');
  }
}
