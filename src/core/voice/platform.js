/**
 * What annai needs from the device for voice (spec §10), given by the built-in voice-browser
 * plugin (src/plugins/voice-browser/) and by fakes in tests: the core never touches the DOM (§3).
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @typedef {{ close(): void, take?(): Promise<Uint8Array | null>, again?(): void }} OpenMic  take: the file since the last cut; again: it, thrown away
 * @typedef {{ open(o: { onFrames: (pcm: Float32Array, sampleRate: number) => void, onError: (e: Error) => void, record?: string }): Promise<OpenMic> }} Mic
 *   the microphone: open only while listening (§10.2); record: a MediaRecorder type to record alongside
 * @typedef {{ unlock(): Promise<boolean>, play(clip: Clip, o: { signal: AbortSignal, onLevel?: (x: number) => void }): Promise<{ ended: boolean, fraction: number }>, plays?(): string[] }} Player
 *   the one audio player (§10.1); unlock(), inside a tap, gives whether sound may play now; play() resolves with ended false when stopped, and rejects with a NotAllowedError while the page may not play sound
 * @typedef {{ makes(): Promise<string[]>, records?(): { type: string, format: string }[], encode(pcm: Int16Array, rate: number, format: string): Promise<Uint8Array>,
 *   decode?(data: Uint8Array, mediaType: string): Promise<{ pcm: Float32Array, rate: number }> }} Encoder  the audio encoders (§10.6); records: MediaRecorder's
 * @typedef {{ id: string, name: string, lang: string, local?: boolean, default?: boolean }} SystemVoice
 *   local: it speaks on this phone (otherwise the browser sends the words to the voice's service, spec §11.7); default: the browser's own choice
 * @typedef {{ available(): boolean, voices(): SystemVoice[],
 *   say(text: string, o: { signal: AbortSignal, voice?: string, rate?: number, lang?: string, onLevel?: (x: number) => void }): Promise<{ ended: boolean, charIndex: number }> }} Synth
 *   the browser voice; charIndex: where the word being spoken starts
 * @typedef {{ available(): boolean, local?(lang?: string): Promise<boolean>,
 *   open(o: { lang?: string, local?: boolean, onSegment: (text: string) => void, onSpeech?: () => void, onQuiet?: () => void, onError: (e: Error & { code?: string }) => void }): { close(): void } }} Dictation
 *   phone dictation (§10.2); onQuiet: what began like speech gave no words (a noise); local(): whether it can recognize speech on this
 *   phone for the language now, nothing to download (§11.7); open's local: do so
 * @typedef {'play-and-record' | 'playback'} SessionType  the audio session type (§10.1): playback while she speaks and after, play-and-record while listening
 * @typedef {{ player: Player, synth: Synth, mic: Mic, dictation: Dictation, session(type: SessionType): void, encoder?: Encoder,
 *   devices?(): Promise<{ kind: string, label: string }[]>, onDeviceChange?(fn: () => void): void }} VoicePlatform
 *   devices: the audio devices, by name, and onDeviceChange when they change (§10.5)
 */

/** The voice platform a running plugin gives (built-ins are plugins, spec §5.4), or null. @param {import('../registry.js').Registry} registry @returns {VoicePlatform | null} */
export function voicePlatform(registry) {
  return registry.list('voice-platform')[0] ?? null;
}
