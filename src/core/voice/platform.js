/**
 * What annai needs from the device for voice (spec §10), given by the built-in voice-browser
 * plugin (src/plugins/voice-browser/) and by fakes in tests: the core never touches the DOM (§3).
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @typedef {{ close(): void, take?(): Promise<Uint8Array | null>, again?(): void }} OpenMic  take: the file since the last cut; again: it, thrown away
 * @typedef {{ open(o: { onFrames: (pcm: Float32Array, sampleRate: number) => void, onError: (e: Error) => void, record?: string }): Promise<OpenMic>,
 *   inUse?(): { label: string, deviceId: string } | null }} Mic
 *   the microphone: open only while listening (§10.2); record: a MediaRecorder type to record alongside; inUse: the input its open
 *   stream takes, by its track's label and deviceId (§10.5); null while closed
 * @typedef {{ unlock(): Promise<boolean>, play(clip: Clip, o: { signal: AbortSignal, onLevel?: (x: number) => void }): Promise<{ ended: boolean, fraction: number }>, plays?(): string[],
 *   stream?(o: { rate: number, onLevel?: (x: number) => void }): PlayerStream, output?(): { sampleRate: number, baseLatency?: number, outputLatency?: number } | null }} Player
 *   the one audio player (§10.1); unlock(), inside a tap, gives whether sound may play now; play() resolves with ended false when stopped, and rejects with a NotAllowedError while the page may not play sound;
 *   stream(): a live session's voice, 16-bit PCM pushed as it arrives (K4); output: the sound's rate, and its processing and output latency (s) where the browser says, for the Trace, once there is sound
 * @typedef {{ push(pcm: Int16Array): void, end(): void, stop(): Played, done: Promise<Played>, queued(): number, running?: Promise<boolean>, started?: Promise<boolean> }} PlayerStream
 *   pieces play as one sound, however fast they come, after a short start (150 ms of it in, the pops investigation); end: no more is coming,
 *   and done settles once it has all played; stop: silent within 15 ms, faded out (always one or the other); queued: pieces still to play;
 *   running: whether its sound can play, once the player knows (false: the page may not play sound now, so it would never end);
 *   started: true as its sound starts playing (after its start buffer), for what should go with it, such as her words; false once it is
 *   done or stopped without a sound, so nobody waits on it forever
 * @typedef {{ playedMs: number, holes?: number, holeMs?: number, waitMs?: number, player?: string, stalled?: boolean }} Played  playedMs: how much was heard, for
 *   cutting what was said where it stopped; holes: times it ran dry and played on, holeMs their silence; waitMs: how long its first sound
 *   waited to play; player: 'worklet', or 'buffers' where the player worklet can't run; stalled: its sound stopped coming (a context
 *   suspended, the audio thread gone), so it was stopped
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
 *   devices?(): Promise<{ kind: string, label: string, deviceId?: string }[]>, onDeviceChange?(fn: () => void): void }} VoicePlatform
 *   devices: the audio devices, by name, and onDeviceChange when they change (§10.5)
 */

/** The voice platform a running plugin gives (built-ins are plugins, spec §5.4), or null. @param {import('../registry.js').Registry} registry @returns {VoicePlatform | null} */
export function voicePlatform(registry) {
  return registry.list('voice-platform')[0] ?? null;
}
