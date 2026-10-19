# Device checklist: Koe and Kokoro

The design is docs/superpowers/specs/2026-10-19-koe-kokoro-design.md, built in milestones K1–K6 (docs/superpowers/plans/2026-10-19-koe-kokoro.md). Each section is checked on an iPhone, in annai installed to the Home Screen.

## K1: the text split

You need a Gemini key from AI Studio (free). Before you start, open Settings → Updates: if it offers Chat Completions 0.8.0 or Google Gemini 1.2.0, update them.

- [ ] **Gemini 3 with tools works.** Add Google Gemini with your key, add `gemini-3.8-flash` by id, put it in Main, and ask Shiori something that needs a tool ("what's the weather at Bixby Bridge?"). She answers after the tool call; before this update, her second step failed with "Function call is missing a thought_signature". Trace → Type contains `net.request`: the second request is `ok (200)`.
- [ ] **The split is opt-in.** Models: right after Main, "Koe for talking" and "Koe for typing", both saying "Empty: Shiori is one half, the main model." Adding a provider fills neither. Type to Shiori: one model call, as before (Trace → Type contains `model.turn`: one `Shiori · main` turn).
- [ ] **Two halves.** Add `gemini-3.5-flash-lite` and `gemini-3.5-flash` by id. Put `gemini-3.5-flash-lite` in "Koe for typing", and `gemini-3.5-flash` in Main after `gemini-3.8-flash` (all free on AI Studio; on 2026-10-19 the free tier allowed `gemini-3.8-flash` only 20 requests a day, which two halves use up in a few questions). Koe's "Wait for the first words" shows 8.
- [ ] **A live question.** Voice off, type "Is Nepenthe open now?". Within about a second Shiori says she's checking (that's Koe). Below the dock, "Kokoro is working" shows, with Stop. About 10 to 15 seconds later, Shiori says the hours in her own words, and the sign goes. The conversation shows only you and Shiori: no notes, no "Shiori woke".
- [ ] **A stable question.** Type "What is Bixby Bridge?": Shiori answers at once from what she knows. Trace → Type contains `model.turn`: one `Kokoro · main` turn for it, as for the live question. If Kokoro finds Koe wrong, she corrects herself and apologises.
- [ ] **The halves' notes.** At the foot of the conversation, tick "Show what the halves tell each other": quiet lines "Koe to Kokoro: …" and "Kokoro to Koe: …" appear between the bubbles. Leave the screen and come back: still ticked. Untick it.
- [ ] **Trace.** Trace → Kind **Halves**: the notes, and any "annai to Kokoro" block. Kind **Models**, Type contains `model.turn`: turns labelled `Koe · koe-type` and `Kokoro · main`.
- [ ] **Stop.** Ask something that takes Kokoro a while ("Plan our afternoon around the sunset"). While "Kokoro is working" shows, tap **Stop** (a button as tall as the dock's others): the sign goes, Shiori's "checking" line stays, no error card; if she says more, it is that the check was stopped, never that there was nothing to add. Type again: Shiori answers.
- [ ] **Voice on** (K1 only; from K2 on, Koe talks aloud: see K2). Turn voice on and ask aloud: Shiori talks as before (Koe types only, for now). Trace → Kind **Halves**: "Voice is on, and Koe can't speak aloud yet; talk to the user directly." Turn voice off and type: Koe answers again, and Trace has "Koe is speaking again; use tell_koe."
- [ ] **Spend per day counts both.** Settings → Models → Spend per day: after a few questions, today's spending includes both halves' calls (Trace shows each turn's cost).
- [ ] **Free tier limits.** When `gemini-3.8-flash` has used its free requests (5 a minute, 20 a day), Trace → Type contains `net.request` says `rate (429)`, never "credit", and Main's next model answers. With no model of Main's left, no card shows while Koe talks: Koe says it couldn't check, and offers to try again. Once the day's 20 are used, with "Show what the halves tell each other" ticked, the note to Koe names the model and says "its daily limit is used up; it rests until" a time on your clock, not the provider's "quota" words.

## K2: voice through the speech pipeline

In the car, with the iPhone on the car's Bluetooth, and a passenger. Set up as for K1, and also:
- **Koe for talking:** `gemini-3.5-flash-lite` (or leave it empty: voice then uses Koe for typing, and that is worth one drive too).
- **Speech in:** "Send audio to the model" first (Gemini hears audio), or a transcription model such as Groq's (free).
- **Quick decision:** `gemini-3.5-flash-lite`, so talk not meant for Shiori is left alone.
- **Voice:** Auto (it turns on in the car) or On.

- [ ] **A live question aloud.** Tap Shiori and ask "Is Nepenthe open now?". About a second after you stop, plus the voice's own start, Shiori says she's checking (that's Koe), and "Kokoro is working" shows. 10 to 15 seconds later she says the hours aloud, in her own words. While she waits, the microphone listens: say something else meanwhile, and she answers that first, then the hours.
- [ ] **A stable question aloud.** "What's that bridge?" near Bixby Bridge: she answers at once. Trace → Kind **Models**, Type contains `model.turn`: a `Kokoro · main` turn after it, woken for "Koe answered the user". If Kokoro finds her wrong, she stops mid-sentence, corrects herself and apologises: write down what she said.
- [ ] **A passenger.** While she listens after answering, the passenger says something to you, not to her ("Can you pass the water?"): she stays silent. The conversation shows "Heard, not for Shiori: …". Trace: no Kokoro turn for it. If she ever answers or remarks on it, write down what she said.
- [ ] **Cut her off.** Tap Shiori while she speaks: she stops at once and listens. Say something: she answers it.
- [ ] **A review.** Tap Shiori and say something to the passenger, not to her: she stays silent. More than 3 minutes later, do it again: Trace → Kind **Models**: a `Kokoro · main` turn woken for "a review", and Kokoro usually tells Koe nothing. With the toggle "Show what the halves tell each other" on, nothing new shows unless Kokoro found something.
- [ ] **Music after she sleeps.** Play music in the car. Ask her something, and let her finish: within a few seconds of her going back to sleep, the music is back at full Bluetooth quality, not the narrow phone-call sound.
- [ ] **Her voice is one voice.** With voice on, Shiori never talks over herself: Kokoro's notes come out only in her own words, after what she was saying (or, for a correction, cutting it).
- [ ] **Hear Shiori tell it.** With voice off, a trip's Recap → **Hear Shiori tell it**: she tells it aloud, and doesn't listen afterwards.
- [ ] **Voice off again.** Turn voice off and type: she answers in bubbles (Trace: `Koe · koe-type` turns).

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

## K4: The realtime contract and Gemini Live

You need your Gemini key from AI Studio (free). Before you start, open Settings → Updates: if it offers Google Gemini 1.3.0, update it. Live sessions don't talk to Shiori yet (that is K5): these checks are the connection, the sound and the Trace.

- [ ] **Live voice arrives off.** Settings → Models → Google Gemini: a **Live voice** panel, its switch off, with a note that what you say goes to Google as audio while a session is open. Settings → Plugins has no Gemini Live yet.
- [ ] **Switching it on installs it.** Turn **Use Live voice** on: "Saved", and its two models show (Gemini 3.8 Live, Gemini 3.8 Live Extended Thinking). Settings → Plugins now lists Gemini Live.
- [ ] **Test, on Wi-Fi.** In the Live voice panel, tap **Test**: within a second or two you hear Shiori's Gemini voice say "OK" (through the phone's speaker, or the car's), and the panel says "✓ It answered aloud: OK." Write down roughly how long from the tap to the word.
- [ ] **Test over cellular.** Turn Wi-Fi off and tap Test again: the same. If it says annai couldn't reach the address, write down the words.
- [ ] **Sound after the tap only.** Close annai fully (swipe it away), open it, go straight to the Live voice panel and tap Test: you still hear "OK" (the tap itself unlocks sound).
- [ ] **Bluetooth.** With the phone connected to the car (or headphones), tap Test: "OK" comes through them. Music playing before comes back afterwards.
- [ ] **A locked screen.** Tap Test and lock the phone at once. Unlock: the panel says what happened (an answer, or that the session closed), and the next Test works.
- [ ] **The Trace.** Trace → Kind **Models**, Type contains `live.session`: "live session open", "live session ready · Gemini 3.8 Live · … s", and "live session closed · … · test · … in, … out". Type contains `net.request`: a line for the turn, `ok (101)`. Search the page for your key: it isn't there (Copy diagnostics too).
- [ ] **A wrong key.** On Google Gemini's page, change the key to something wrong and tap Test: "✗ The key was rejected." Put the right key back.

## K5: Koe live

You need Gemini's Live voice switched on (K4), **Gemini 3.8 Live** first in Settings → Models → **Koe for talking**, a model in **Koe for typing** (gemini-3.5-flash-lite) and in Main (gemini-3.8-flash), and a trip open. Most of this is in the car, with the phone on the car's Bluetooth.

- [ ] **A tap opens it.** Voice on, tap Shiori: the chip says **Listening live** (in red). Ask "Is Nepenthe open right now?": within about a second Koe says it's checking, and a few seconds later says the hours, in its own words, never naming notes or Kokoro. The sign shows "Kokoro is working" meanwhile. Write down how long from the end of your question to Koe's first word.
- [ ] **A stable fact.** "What's that bridge?" near Bixby Bridge: Koe answers at once, from what it knows.
- [ ] **A correction.** If Kokoro corrects Koe (say a wrong year), Koe stops mid-sentence and corrects itself. The Conversation shows the first line cut off, ending in ✂.
- [ ] **Chatter.** Talk to a passenger, not Shiori: Koe stays silent. Turn on "Show what the halves tell each other": the line shows as heard, not for Shiori.
- [ ] **Cutting in.** While Koe talks, say something: she stops at once and listens. Does her own voice from the car's speakers ever cut her off (echo)? If it does, turn off Settings → Voice → **Cut her off by speaking** and check a tap still stops her.
- [ ] **The quiet spell.** Say nothing for 30 seconds: the chip goes back to "Voice on", and music returns to full quality (not the thin phone-call sound). Settings → Voice → **Close a live session after** changes the wait.
- [ ] **A reminder.** After an earlier tap, set a reminder a few minutes ahead ("remind me in 3 minutes to check the fuel"): when it fires, Koe says it aloud, and the chip says Listening live again until the quiet spell.
- [ ] **A tunnel.** Drive through a tunnel or a dead spot mid-answer: when the signal comes back, Koe carries on (the session resumes), or the typing model finishes the answer through Shiori's usual voice. Nothing you said is missing from the Conversation; a cut line ends in ✂.
- [ ] **A locked screen.** While a session is open, lock the phone: it closes (the chip isn't "Listening live" when you unlock). Tap Shiori: a session opens and remembers what you were talking about.
- [ ] **Out of view.** While a session is open, switch to another app: it closes, and the microphone indicator (the orange dot) goes. Coming back, nothing listens until you tap.
- [ ] **Typing to it.** Voice off, type a question: Koe's answer appears as a bubble; nothing plays, and the microphone indicator never shows.
- [ ] **Data and cost.** Trace → Kind **Models**, Type contains `live.session`: each session's lines, "live session closed · Gemini 3.8 Live · … · quiet · … KB in, … KB out · $…". Write down the data for a minute of talk. Settings → Models → Spend per day counts the sessions.
- [ ] **Erase** (last, on a test install): with a session open, Settings → Erase: the microphone indicator goes at once.

## K6: OpenAI Realtime

You need an OpenAI API key (platform.openai.com/api-keys) with a little credit: these checks cost cents. Before you start, open Settings → Updates: if it offers OpenAI 1.1.0, update it. The checks marked **(with K5)** need Koe's live sessions, so do them once K5 is in too.

- [ ] **The first question: does OpenAI take your key from the phone?** Settings → Models → OpenAI: a **Realtime voice** panel, its switch off, with a note about telephone audio, gpt-transcribe's own bill and short-lived keys. Turn **Use Realtime voice** on: "Saved", and its two models show (GPT Realtime 2.1, GPT Realtime 2.1 mini). Tap **Test** on GPT Realtime 2.1 mini: you hear "OK", and the panel says "✓ It answered aloud: OK." If it says instead that the key was rejected, or that annai couldn't reach the address, Test a chat model on the same page. If chat works with the same key, OpenAI refuses standard keys from a browser, and its realtime voice would need a server annai doesn't have: write down the exact words and stop here.
- [ ] **Over cellular.** Wi-Fi off, Test again: the same.
- [ ] **Bluetooth.** Connected to the car (or headphones), Test: "OK" comes through them, and music playing before comes back afterwards.
- [ ] **The Trace.** Trace → Kind **Models**, Type contains `live.session`: "live session ready · GPT Realtime 2.1 mini" and "live session closed · … · test", with the data both ways. Type contains `net.request`: the turn, priced. Kind **Everything**, Type contains `live.error`: nothing (anything there is OpenAI refusing something mid-session: write down its words). Search the page for your key, and Copy diagnostics: it isn't there.
- [ ] **A wrong key.** Change OpenAI's key to a wrong one, Test: "✗ The key was rejected." Put the right key back.
- [ ] **What it cost.** After a few Tests, compare annai's Spend per day with OpenAI's usage page for today. The realtime model's cost should match within a cent; the transcription (gpt-transcribe) shows on OpenAI's page only, as the note says.
- [ ] **(with K5) A short drive's conversation.** Put GPT Realtime 2.1 mini in Koe for talking, voice on, tap Shiori. Ask a live fact ("Is Nepenthe open now?": she says she's checking, and Kokoro's answer comes in her words), a stable one ("What's Bixby Bridge?": she answers at once), cut her off by speaking (she stops at once, and never finishes the old sentence later), and talk to a passenger for a while (she stays quiet).
- [ ] **(with K5) μ-law against PCM in a noisy car.** With the fan or the windows making noise, ask five questions with names in them ("Where's the nearest Chevron?", "How far is Pfeiffer Beach?", "Is Nepenthe open?", "Find Big Sur Bakery", "Take me to Point Sur"). In the Trace, count the words the `heard` lines got wrong, and note the data out per minute of speech. Then on OpenAI's page, Realtime voice → Tunables, set `{"input": "pcm16"}`, ask the same five, and count again. μ-law should send about a sixth of the data; write down whether it heard worse. Set it back (or not) by what you found.
- [ ] **(with K5, optional) A drive past 55 minutes.** OpenAI ends a session at an hour: after 55 minutes the Trace shows a goaway and a new session opening, and the conversation carries on without a gap.
