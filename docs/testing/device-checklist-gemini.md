# Device checklist: Gemini, natively

The design is docs/superpowers/specs/2026-10-19-gemini-native-design.md, built in milestones G1–G4 (docs/superpowers/plans/2026-10-19-gemini-native.md). Each section is checked on an iPhone, in annai installed to the Home Screen, and the voice items also on an Android phone.

## G1: Gemini chat, through Gemini's own API

You need a Gemini key from AI Studio. Before you start, open Settings → Updates: if it offers Google Gemini 2.0.0, update it (it brings Gemini API with it).

- [ ] **The update.** If you had Google Gemini before: after the update its page says "Uses Gemini's own API", its Chat says "Gemini API" under its name, and your key is still saved. Models you added before are still there. Ask Shiori something: one of them answers. If one doesn't, or shows no context window, remove it and add it again with Fetch model list, as its Chat note says.
- [ ] **A new Gemini.** Add a provider → Google Gemini, with your key. Its Chat lists Gemini 3.8 Flash, Gemini 3.6 Flash and Gemini 3.5 Flash Lite, each "1049K context" with its price. Models: Main holds those three, Utility and Quick decision Flash Lite; Koe stays empty.
- [ ] **Test.** On Google Gemini's page, Chat → Test: "Everything works.", with "Tool calls work.", "Photos work: it saw the red square." and "Photo uploads work".
- [ ] **Fetch model list.** Chat → Fetch model list: chat models only (no TTS, Live, image or embedding models). Add one: its card shows its context window.
- [ ] **The free tier.** On a free key, tick "This key is on the free tier (Google doesn't charge)". A model's Try this model: each reply says "free". Trace → Type contains `model.turn`: each turn says "free". On a paid key, leave it off: Try this model shows a price.
- [ ] **Tools over two steps.** Ask Shiori something that needs a tool ("what's the weather at Bixby Bridge?"). She answers after the tool call. Trace → Type contains `net.request`: each request is `ok (200)`.
- [ ] **The iPhone sends AAC, not WAV.** Voice on, Speech in "Send audio to the model" first, Main a Gemini model. Ask aloud. Trace → Type contains `net.request`: Gemini's request's audio is `mp4` (or `aac`), a few KB a second, never `wav`. On Android it is `ogg` or `webm` (Opus).
- [ ] **A voice message answered.** Ask "where can we eat near here?" aloud: Shiori answers what you asked, so Gemini heard the clip.
- [ ] **A used-up day.** On a free key, once a flash model has used its day (20 requests on 2026-10-19), Trace says `rate (429)`, never "credit"; the model's line says "its daily limit is used up; it rests until" a time on your clock, and Main's next flash answers.
- [ ] **Use the recommended models.** Google Gemini's page → Use the recommended models: Live voice switches on (it may install Gemini Live), and Koe holds Gemini 3.8 Live, then Gemini 3.5 Flash Lite. With voice off, typing to Shiori uses Flash Lite as Koe; with voice on, a tap opens a live session.

## G3: Gemini's transcription and voices, streamed

Before you start, open Settings → Updates: if it offers Google Gemini 2.1.0, update it. Its Transcription and Voice arrive switched off ("New in the last update"); Use the recommended models switches them on and puts them in Speech in and Speech out. On a free key, Google allows each voice 10 sentences a day and 3 a minute (2026-10-20), so check the voice items early in the day, a minute apart, or with a paid key.

- [ ] **Transcription.** Google Gemini's page → Transcription → Test → Say something, "Where should we eat?": it writes your words down. Trace → Type contains `net.request`: the request's audio is `mp4` (or `aac`) on the iPhone, `ogg` on Android, never `wav`.
- [ ] **A voice, streamed.** Voice → Test → Play a sample: you hear Kore within about a second. Trace: the line says `streamed PCM at 24 kHz` and its size. Voice on, Speech out with the Gemini voice first: ask Shiori something with a reply of two or three sentences. She starts within about a second of the first sentence, with no gap mid-word, and the sentences follow each other closely.
- [ ] **The silent switch.** iPhone silent switch on: you still hear her (playback, as with whole clips).
- [ ] **Bluetooth and the car.** With earbuds, then in the car over Bluetooth (or CarPlay audio): her streamed voice plays there, from its first word, and music pauses while she speaks and comes back after.
- [ ] **The screen locking mid-sentence.** Ask something with a long reply, then lock the screen while she speaks: she finishes the sentence (or stops cleanly), and annai shows what she said when you unlock. Nothing plays twice.
- [ ] **A weak connection.** In a place with one bar (or the phone's Settings → Developer → Network Link Conditioner, "3G" or "Edge" on the iPhone): she waits longer before speaking, then speaks each sentence without a gap. Phone quality (below) waits less.
- [ ] **Phone quality.** Voice → Sound → Phone quality, 8 kHz: Play a sample sounds like a phone call, and Trace says `streamed PCM at 8 kHz` at a third of the size (the Trace counts the sound as decoded 16-bit PCM; on the wire it's about a fifth).
- [ ] **The way back to whole clips.** Untick "Stream her voice, so she starts sooner": Play a sample still works, the Trace line says `wav`, and Shiori's replies start a little later. If anything above failed with streaming on (the silent switch, Bluetooth, the car, the lock screen), check it again with streaming off and say which.
- [ ] **A used-up day.** On a free key, after ten sentences in a day, the Gemini voice rests (Trace: `rate (429)`, "10 requests per day"), and the next voice in Speech out speaks the rest without a pause.
