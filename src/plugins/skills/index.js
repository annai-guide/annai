import { VERSION } from '../../app/version.js';
import { parseSkill } from '../../core/skills.js';

/**
 * Shiori's own skills (spec §19: skills/), in the open format anyone's skills use (§5.1): one
 * SKILL.md each, cached by the service worker for offline use. Only their names and descriptions
 * sit in her context; she loads a text with the skill tool.
 */
export const BUILT_IN = Object.freeze(['driving-companion', 'replanning', 'plan-a-trip']);

/** provides.skill: the names are annai's even when a file didn't load, so no package can take one. */
export const manifest = {
  id: 'skills',
  name: 'Built-in skills',
  version: VERSION,
  api: 1,
  description: "Shiori's own skills: the driving companion, replanning, and planning a trip.",
  provides: { skill: [...BUILT_IN] },
};

/**
 * annai's own skills, read from /skills/<name>/SKILL.md; one that is missing or unreadable is left out.
 * @param {(path: string) => Promise<string | null>} read
 * @returns {Promise<{ name: string, description: string, text: string }[]>}
 */
export async function loadBuiltinSkills(read) {
  const out = [];
  for (const name of BUILT_IN) {
    try {
      const text = await read(`/skills/${name}/SKILL.md`);
      if (text === null) continue;
      const s = parseSkill(text);
      out.push({ name: s.name, description: s.description, text: s.body.trim() });
    } catch {
      // offline before the first install, or a broken file: the others still load
    }
  }
  return out;
}

/** @param {any} annai */
export async function activate(annai) {
  const read = async (/** @type {string} */ path) => {
    try {
      const res = await fetch(path);
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const offs = (await loadBuiltinSkills(read)).map((s) => annai.register('skill', s));
  return () => offs.forEach((off) => off());
}
