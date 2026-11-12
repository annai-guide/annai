// A few flags, read by hand: --name value, --flag, and the words before them.
/**
 * @param {string[]} argv @param {{ flags?: string[] }} [o] flags: the names that take no value
 * @returns {{ words: string[], opts: Record<string, string | true> }}
 */
export function parseArgs(argv, { flags = [] } = {}) {
  /** @type {string[]} */
  const words = [];
  /** @type {Record<string, string | true>} */
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      words.push(a);
      continue;
    }
    const name = a.slice(2);
    if (flags.includes(name)) opts[name] = true;
    else if (i + 1 < argv.length) opts[name] = argv[++i];
    else throw new Error(`--${name} needs a value.`);
  }
  return { words, opts };
}

/** The keys a command uses: --keys-file with --lines, else GEMINI_KEY. @param {Record<string, string | true>} opts @param {Record<string, string | undefined>} env */
export async function keysFrom(opts, env) {
  const { Keys } = await import('./keys.mjs');
  if (typeof opts['keys-file'] === 'string') {
    if (typeof opts.lines !== 'string') throw new Error('--keys-file needs --lines (for example --lines 1-11): a key file is read only on the lines named.');
    return Keys.fromPath(opts['keys-file'], opts.lines);
  }
  return Keys.fromEnvironment(env);
}

/**
 * The Anthropic key for a real Kokoro: ANNAI_LIVE_ANTHROPIC_KEY (as test/live reads it), which wins, else the first line of --anthropic-key's file;
 * none, undefined. Read here, held like the Gemini keys, never printed. @param {Record<string, string | true>} opts @param {Record<string, string | undefined>} env
 */
export async function anthropicFrom(opts, env) {
  const { Keys } = await import('./keys.mjs');
  const key = (env.ANNAI_LIVE_ANTHROPIC_KEY ?? '').trim();
  if (key) return new Keys([{ line: null, key }]);
  return typeof opts['anthropic-key'] === 'string' ? Keys.fromPath(opts['anthropic-key'], '1') : undefined;
}
