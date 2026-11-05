import { CORE } from './instructions.js';
import { KOKORO_PART, KOE_CORE, KOE_LIVE } from '../koe/instructions.js';
import { ME } from '../scopes.js';
import { readAppSettings, updateAppSettings } from '../settings.js';
import { sha256Hex } from '../hash.js';
import { utf8 } from '../bytes.js';

/**
 * Her instructions, the user's to read and change (the second-drive design): a file in /me/instructions/ exists only once the user has
 * changed that text, and takes the place of annai's while it holds words. Shiori never writes them (files plugin). The app settings keep
 * the hash of annai's text each was based on, so a new original can be offered beside theirs.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {'shiori' | 'kokoro' | 'koe' | 'koeLive'} InstructionId
 */

/** @type {readonly { id: InstructionId, file: string, original: string }[]} */
export const INSTRUCTIONS = Object.freeze([
  /* en */ { id: 'shiori', file: '/instructions/shiori.md', original: CORE },
  /* en */ { id: 'kokoro', file: '/instructions/kokoro.md', original: KOKORO_PART },
  /* en */ { id: 'koe', file: '/instructions/koe.md', original: KOE_CORE },
  /* en */ { id: 'koeLive', file: '/instructions/koe-live.md', original: KOE_LIVE },
]);

const hashOf = (/** @type {string} */ text) => sha256Hex(utf8(text));
const item = (/** @type {InstructionId} */ id) => /** @type {typeof INSTRUCTIONS[number]} */ (INSTRUCTIONS.find((x) => x.id === id));

/** The texts the user changed, for the snapshot: a missing or empty file isn't there, so annai's text stands. @param {Workspace} ws @returns {Promise<Partial<Record<InstructionId, string>>>} */
export async function editedInstructions(ws) {
  /** @type {Partial<Record<InstructionId, string>>} */
  const out = {};
  for (const { id, file } of INSTRUCTIONS) {
    const text = await ws.readText(ME, file).catch(() => undefined);
    if (text?.trim()) out[id] = text;
  }
  return out;
}

/**
 * What the editor shows of one: the file's words or annai's, whether the user's are in use, and annai's new text when it changed since theirs was based on it.
 * @param {Workspace} ws @param {InstructionId} id @returns {Promise<{ text: string, edited: boolean, newOriginal: string | null }>}
 */
export async function instructionState(ws, id) {
  const { file, original } = item(id);
  const text = await ws.readText(ME, file).catch(() => undefined);
  if (!text?.trim()) return { text: original, edited: false, newOriginal: null };
  const based = (await readAppSettings(ws)).instructions?.[id]?.based;
  return { text, edited: true, newOriginal: based === (await hashOf(original)) ? null : original };
}

/** No file, and no record of one: annai's text stands. @param {Workspace} ws @param {InstructionId} id */
export async function resetInstruction(ws, id) {
  if (await ws.read(ME, item(id).file)) await ws.delete(ME, item(id).file, { author: 'user' });
  await updateAppSettings(ws, { instructions: { [id]: null } });
}

/**
 * The user's words become that text; words that are annai's own, or none, are no change, so no file. @param {Workspace} ws @param {InstructionId} id @param {string} words
 * @returns {Promise<boolean>} whether a file now holds them
 */
export async function saveInstruction(ws, id, words) {
  const { file, original } = item(id);
  if (!words.trim() || words === original) {
    await resetInstruction(ws, id);
    return false;
  }
  await ws.write(ME, file, words, { author: 'user' });
  await keepMyInstruction(ws, id);
  return true;
}

/** Keeps the user's text, based on annai's as it is now, so it isn't offered again. @param {Workspace} ws @param {InstructionId} id */
export async function keepMyInstruction(ws, id) {
  await updateAppSettings(ws, { instructions: { [id]: { based: await hashOf(item(id).original) } } });
}
