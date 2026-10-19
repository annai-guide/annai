# Device checklist: Koe and Kokoro

The design is docs/superpowers/specs/2026-10-19-koe-kokoro-design.md, built in milestones K1–K6 (docs/superpowers/plans/2026-10-19-koe-kokoro.md). Each section is checked on an iPhone, in annai installed to the Home Screen.

## K3: Audio in the smallest format

What the phone makes is found by trying at run time, never by its name, so these checks are the only way to know what an iPhone does. Write down what each one shows.

- [ ] **What this iPhone makes and plays.** Settings → Voice → Listening, under "Keep voice clips": "Speech leaves this phone in the smallest format each service takes. Made here: … Played here: …". Write both lists down.
  - Expected on iOS 26: Made here has `ogg, webm` (Opus) and `aac`, maybe `flac`, and `wav`; MP3 is unlikely.
  - Made here showing only `wav`, with "(recorded: mp4)": this iPhone has no WebCodecs audio, and MediaRecorder records alongside instead.
  - Made here without `ogg, webm` or `aac` though iOS 26 has WebCodecs audio: Safari may take those codecs only at 48 kHz, while annai encodes at 16 kHz. Say so: a 48 kHz path was left out until a phone needs it.
  - Played here should list `ogg`. If it doesn't, kept clips are WebM or AAC, and OpenAI's voice answers in AAC.
- [ ] **A transcription model gets Opus.** With Groq (or OpenAI) in Models: open its transcription model → **Say something** → say "Where should we stop for lunch?": it writes it down. Then Trace → Kind **Web**: its line ends "· webm, 6.0 KB" or so (about 3 KB a second of speech; the same as WAV would be about 32 KB a second). Write down the format and the size.
- [ ] **Gemini through Chat Completions gets WAV.** Put a Gemini model in Main, and "Send audio to the model" first in Speech in. Turn voice on, tap Shiori and ask something. Trace → Kind **Web**: Gemini's request line ends "· audio: wav, … KB" (or "mp3" if Made here listed mp3), once: Gemini took it the first time.
- [ ] **OpenRouter gets Opus or AAC.** With an OpenRouter chat model that takes audio (a Gemini model there) in Main, and "Send audio to the model" first: Trace → Web shows "· audio: ogg, … KB" (or aac). If OpenRouter's model refused it, the next request line shows "audio: wav", and every later one too, until annai restarts: say which model.
- [ ] **Kept clips are small and play.** Settings → Voice → **Keep voice clips** on. Talk to Shiori. Trace → Kind **Conversation**: the `heard` line says "clip kept: ogg, … KB" (or the format Played here allows). Open it → **Show what was stored**: a player plays what you said. Turn Keep voice clips off afterwards if you don't want them.
- [ ] **OpenAI's Opus voice plays** (needs an OpenAI key). OpenAI → Voice → a voice → **Play a sample**: you hear it. Trace → Web: the voice's line ends "· ogg, … KB" when Played here lists ogg.
- [ ] **A weak signal: the same bytes again.** On cellular, somewhere the signal is weak (or turn on Airplane mode right after you finish a sentence, and off again within a second or two), talk to Shiori with a transcription model first in Speech in. Trace → Web: when an upload fails, the same model's line comes again, with the same format and the same size, at most twice more; then the next entry.
- [ ] **Your own speech servers**, if you run them. A Speaches or Kokoro voice: **Play a sample** plays, and Trace → Web shows "· mp3, … KB" (Speaches refuses Opus and AAC). A whisper.cpp transcription: **Say something** writes it down; Trace → Web shows its first request refused and the next sent as "wav", and every later one as WAV.
- [ ] **The microphone test.** Settings → Voice → **Test the microphone**: "Heard … seconds of speech", and the first transcription model's words.
