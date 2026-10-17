import { modelOf, endpointOf, STAND_INS, SPEECH_DEFAULTS } from '../llm/config.js';

/**
 * Where your voice goes (spec §11.7): for each speech-in entry, where what you say is sent; for
 * each speech-out entry, where her words go. Phone dictation and the browser voice are the
 * browser's own: it sends them itself, so annai's trace can't show those requests.
 * @typedef {import('../llm/config.js').ModelConfig} ModelConfig
 * @typedef {import('./platform.js').SystemVoice} SystemVoice
 * @typedef {{ id: string, name: string, where: string }} Where
 */

export const DICTATION_AWAY = "Your browser's own speech service hears it: on Android usually Google's servers, on iPhone Apple's (sometimes on the phone itself). annai doesn't send this request, so the trace can't show it.";
export const DICTATION_HERE = 'On this phone only: the browser recognizes your speech on the device.';

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** An endpoint in words: its name, and its host when it has one. @param {ModelConfig} cfg @param {string} endpointId */
function placeOf(cfg, endpointId) {
  const rec = cfg.endpoints[endpointId];
  if (!rec) return 'its provider';
  const ep = endpointOf(rec);
  const host = hostOf(ep.baseUrl);
  return host && host !== ep.name ? `${ep.name} (${host})` : ep.name;
}

/** The model's name, for an entry. @param {ModelConfig} cfg @param {string} id */
const nameOf = (cfg, id) => STAND_INS[id]?.name ?? (cfg.models[id] ? modelOf(cfg.models[id]).name : id);

/**
 * Where what you say goes, for each speech-in entry in order. "Send audio to the model" goes to
 * the models that hear you (the main and quick-decision roles') that take audio.
 * @param {ModelConfig} cfg @param {{ dictation: { available: boolean, local: boolean } }} o
 * @returns {Where[]}
 */
export function whereHeard(cfg, { dictation }) {
  return (cfg.roles?.['speech-in']?.models ?? SPEECH_DEFAULTS['speech-in']).map((id) => {
    const name = nameOf(cfg, id);
    if (id === 'send-audio') {
      const hearers = ['main', 'decide'].flatMap((r) => cfg.roles?.[r]?.models ?? []).filter((m) => cfg.models[m] && modelOf(cfg.models[m]).input.includes('audio'));
      const places = [...new Set(hearers.map((m) => placeOf(cfg, cfg.models[m].endpoint)))];
      return { id, name, where: places.length ? `As sound, to the model that hears it: ${places.join(', or ')}.` : 'Only to a model that takes audio, and none of the models that hear you takes audio now: nothing goes this way.' };
    }
    if (id === 'dictation') {
      return { id, name, where: !dictation.available ? 'This browser has no dictation: it is skipped.' : dictation.local ? DICTATION_HERE : DICTATION_AWAY };
    }
    const rec = cfg.models[id];
    return { id, name, where: rec ? `As sound, to ${placeOf(cfg, rec.endpoint)}, to be written down.` : 'This model is gone: it is skipped.' };
  });
}

/**
 * Where what she says goes, for each speech-out entry in order. @param {ModelConfig} cfg
 * @param {{ browser: boolean, voice: SystemVoice | null }} o  browser: this browser has a voice of its own; voice: the one it speaks with (browserVoiceFor)
 * @returns {Where[]}
 */
export function whereSaid(cfg, { browser, voice }) {
  return (cfg.roles?.['speech-out']?.models ?? SPEECH_DEFAULTS['speech-out']).map((id) => {
    const name = nameOf(cfg, id);
    if (id === 'browser-voice') {
      if (!browser) return { id, name, where: 'This browser has no voice of its own: it is skipped.' };
      if (!voice) return { id, name, where: "The browser's choice of voice: annai can't tell whether it speaks on this phone or sends her words to a service." };
      if (voice.local) return { id, name, where: `Spoken on this phone (${voice.name}): her words stay on it.` };
      const whose = /google/i.test(voice.name) ? " (Google's)" : /microsoft/i.test(voice.name) ? " (Microsoft's)" : '';
      return { id, name, where: `Her words go to the service behind ${voice.name}${whose}, to be spoken; they aren't spoken on this phone.` };
    }
    const rec = cfg.models[id];
    return { id, name, where: rec ? `Her words go to ${placeOf(cfg, rec.endpoint)}, which sends back the sound.` : 'This voice is gone: it is skipped.' };
  });
}

/**
 * The browser voice she speaks with: the one chosen in Settings → Voice; else one on this phone for
 * the language, so her words stay on it; else the browser's default for the language, or its first
 * voice in it; else the browser's default. annai then asks for that voice by name, so what Settings →
 * Voice says is what speaks. null: the browser lists no voices (yet).
 * @param {SystemVoice[]} voices @param {{ chosen?: string, lang?: string }} o @returns {SystemVoice | null}
 */
export function browserVoiceFor(voices, { chosen, lang }) {
  const picked = chosen ? voices.find((v) => v.id === chosen) : undefined;
  if (picked) return picked;
  const want = String(lang ?? '').toLowerCase().replace('_', '-');
  const base = want.split('-')[0];
  const of = (/** @type {SystemVoice} */ v) => String(v.lang).toLowerCase().replace('_', '-');
  const same = (/** @type {SystemVoice} */ v) => of(v).split('-')[0] === base;
  return voices.find((v) => v.local && of(v) === want)
    ?? voices.find((v) => v.local && same(v))
    ?? voices.find((v) => v.default && same(v))
    ?? voices.find(same)
    ?? voices.find((v) => v.default)
    ?? null;
}
