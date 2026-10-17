/**
 * What annai needs from the device for voice (spec §10), given by the built-in voice-browser
 * plugin (src/plugins/voice-browser/) and by fakes in tests: the core never touches the DOM (§3).
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @typedef {{ open(o: { onFrames: (pcm: Float32Array, sampleRate: number) => void, onError: (e: Error) => void }): Promise<{ close(): void }> }} Mic
 *   the microphone: open only while listening (§10.2)
 * @typedef {{ unlock(): Promise<boolean>, play(clip: Clip, o: { signal: AbortSignal, onLevel?: (x: number) => void }): Promise<{ ended: boolean, fraction: number }> }} Player
 *   the one audio player (§10.1); unlock(), inside a tap, gives whether sound may play now; play() resolves with ended false when stopped, and rejects with a NotAllowedError while the page may not play sound
 * @typedef {{ id: string, name: string, lang: string }} SystemVoice
 * @typedef {{ available(): boolean, voices(): SystemVoice[],
 *   say(text: string, o: { signal: AbortSignal, voice?: string, rate?: number, lang?: string, onLevel?: (x: number) => void }): Promise<{ ended: boolean, charIndex: number }> }} Synth
 *   the browser voice; charIndex: where the word being spoken starts
 * @typedef {{ available(): boolean, open(o: { lang?: string, onSegment: (text: string) => void, onSpeech?: () => void, onQuiet?: () => void, onError: (e: Error & { code?: string }) => void }): { close(): void } }} Dictation
 *   phone dictation (§10.2); onQuiet: what began like speech gave no words (a noise)
 * @typedef {'play-and-record' | 'playback'} SessionType  the audio session type (§10.1): playback while she speaks and after, play-and-record while listening
 * @typedef {{ player: Player, synth: Synth, mic: Mic, dictation: Dictation, session(type: SessionType): void,
 *   devices?(): Promise<{ kind: string, label: string }[]>, onDeviceChange?(fn: () => void): void }} VoicePlatform
 *   devices: the audio devices, by name, and onDeviceChange when they change (§10.5)
 */

/** The voice platform a running plugin gives (built-ins are plugins, spec §5.4), or null. @param {import('../registry.js').Registry} registry @returns {VoicePlatform | null} */
export function voicePlatform(registry) {
  return registry.list('voice-platform')[0] ?? null;
}
