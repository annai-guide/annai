# Device checklist: Koe and Kokoro

The design is docs/superpowers/specs/2026-10-19-koe-kokoro-design.md, built in milestones K1–K6 (docs/superpowers/plans/2026-10-19-koe-kokoro.md). Each section is checked on an iPhone, in annai installed to the Home Screen.

## K1: the text split

You need a Gemini key from AI Studio (free). Before you start, open Settings → Updates: if it offers Chat Completions 0.8.0 or Google Gemini 1.2.0, update them.

- [ ] **Gemini 3 with tools works.** Add Google Gemini with your key, add `gemini-3.8-flash` by id, put it in Main, and ask Shiori something that needs a tool ("what's the weather at Bixby Bridge?"). She answers after the tool call; before this update, her second step failed with "Function call is missing a thought_signature". Trace → Type contains `net.request`: the second request is `ok (200)`.
- [ ] **The split is opt-in.** Models: right after Main, "Koe for talking" and "Koe for typing", both saying "Empty: Shiori is one half, the main model." Adding a provider fills neither. Type to Shiori: one model call, as before (Trace → Type contains `model.turn`: one `Shiori · main` turn).
- [ ] **Two halves.** Add `gemini-3.5-flash-lite` and `gemini-3.5-flash` by id. Put `gemini-3.5-flash-lite` in "Koe for typing", and `gemini-3.5-flash` in Main after `gemini-3.8-flash` (all free on AI Studio; on 2026-10-19 the free tier allowed `gemini-3.8-flash` only 20 requests a day, which two halves use up in a few questions). Koe's "Wait for the first words" shows 8.
- [ ] **A live question.** Voice off, type "Is Nepenthe open now?". Within about a second Shiori says she's checking (that's Koe). Below the dock, "Kokoro is working" shows, with Stop. About 10 to 15 seconds later, Shiori says the hours in her own words, and the sign goes. The conversation shows only you and Shiori: no notes, no "Shiori woke".
- [ ] **A stable question.** Type "What is Bixby Bridge?": Shiori answers at once from what she knows. A moment later Kokoro may look at what she said (Trace: a `Kokoro · main` turn woken by "Koe answered the user"); if Koe was wrong, she corrects herself and apologises.
- [ ] **The halves' notes.** At the foot of the conversation, tick "Show what the halves tell each other": quiet lines "Koe to Kokoro: …" and "Kokoro to Koe: …" appear between the bubbles. Leave the screen and come back: still ticked. Untick it.
- [ ] **Trace.** Trace → Kind **Halves**: the notes, and any "annai to Kokoro" block. Kind **Models**, Type contains `model.turn`: turns labelled `Koe · koe-type` and `Kokoro · main`.
- [ ] **Stop.** Ask something that takes Kokoro a while ("Plan our afternoon around the sunset"). While "Kokoro is working" shows, tap **Stop**: the sign goes, Shiori's "checking" line stays, no error card. Type again: Shiori answers.
- [ ] **Voice on.** Turn voice on and ask aloud: Shiori talks as before (Koe types only, for now). Trace → Kind **Halves**: "Voice is on, and Koe can't speak aloud yet; talk to the user directly." Turn voice off and type: Koe answers again, and Trace has "Koe is speaking again; use tell_koe."
- [ ] **Spend per day counts both.** Settings → Models → Spend per day: after a few questions, today's spending includes both halves' calls (Trace shows each turn's cost).
- [ ] **Free tier limits.** When `gemini-3.8-flash` has used its free requests (5 a minute, 20 a day), Trace → Type contains `net.request` says `rate (429)`, never "credit", and Main's next model answers. With no model of Main's left, no card shows while Koe talks: Koe says it couldn't check, and offers to try again.

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
