import { candidates } from '../llm/fallback.js';
import { KOE_ROLES } from '../llm/config.js';

/**
 * Koe's list (the Koe and Kokoro design): voice on uses "Koe for talking", voice off "Koe for typing",
 * and an empty list uses the other (§10.5 decides voice). The split never flips with the voice setting.
 * @param {import('../llm/config.js').ModelConfig} cfg @param {boolean} voiceOn
 * @returns {{ role: 'koe-talk' | 'koe-type', models: string[] }} the role (its level and wait) and the models it tries
 */
export function koeList(cfg, voiceOn) {
  const role = voiceOn ? 'koe-talk' : 'koe-type';
  return { role, models: candidates(cfg, role) };
}

/** Whether Shiori is two halves: a Koe list holds a model. Otherwise she is one, as before. @param {import('../llm/config.js').ModelConfig} cfg */
export function splitOn(cfg) {
  return KOE_ROLES.some((r) => (cfg.roles?.[r]?.models?.length ?? 0) > 0);
}
