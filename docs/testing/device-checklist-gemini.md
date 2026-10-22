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

## G2: Google keeps the conversation

- [ ] **The switch.** Google Gemini's page → Chat: "Let Google keep the conversation between turns: sends less each time." is on, with a note on what Google keeps, for how long (a day free, up to 55 days paid), and that annai deletes it when you remove it.
- [ ] **Less sent.** Talk with Shiori for three turns, one with a photo. Trace → Type contains `net.request`: from the second turn on, Gemini's requests say "sent, after a kept turn", and each is about the size of what you just said, not the whole conversation: the photo's turn is large once, never again.
- [ ] **Switched off.** Turn the switch off, talk again: each request is whole (no "after a kept turn"), and Trace shows `kept turn deleted` for each kept turn. Turn it back on.
- [ ] **Removing a trip.** Talk in a trip you don't need, then remove it: the first question names what Google keeps, and Trace (System log) shows `kept turn deleted` once per turn of that trip.
- [ ] **A new key, or Remove key.** With turns kept, start typing a new key: the line under it says annai first asks Google to delete them. Remove key (tap twice): the line shows again, "Asking Google to delete what it keeps…" shows for a moment, and Trace shows `kept turn deleted` for each. Put the key back.
- [ ] **A day later.** On the next day, a conversation from yesterday sends its first message whole once (no "after a kept turn"), then chains again.
- [ ] **Offline.** Talk in another trip, turn on airplane mode, remove the trip. Google Gemini's page says "N deletions waiting". Turn airplane mode off: the line goes (reopen the page), and Trace shows the deletions.
- [ ] **Removing the provider, offline.** With turns kept and airplane mode on, tap Remove provider once: the words above it say "Google keeps N turns until they expire, up to 55 days." Online, they say annai asks Google to delete them first. Settings → Plugins → Google Gemini → Remove says the same.
- [ ] **Erase.** With turns kept, Settings → Erase names them before the tap; after Erase, nothing of annai is left on the phone.

## G3: Gemini's transcription and voices, streamed

Before you start, open Settings → Updates: if it offers Google Gemini 2.1.0, update it. Its Transcription and Voice arrive switched off ("New in the last update"); Use the recommended models switches them on and puts them in Speech in and Speech out. On a free key, Google allows each voice 10 sentences a day and 3 a minute (2026-10-20), so check the voice items early in the day, a minute apart, or with a paid key.

- [ ] **Transcription.** Google Gemini's page → Transcription → Test → Say something, "Where should we eat?": it writes your words down. Trace → Type contains `net.request`: the request's audio is `mp4` (or `aac`) on the iPhone, `ogg` on Android, never `wav`.
- [ ] **A voice, streamed.** Voice → Test → Play a sample: you hear Sulafat (a calm, warm voice) within about a second; the model's page has a Voice and a Style, and each sentence of a reply is the same voice. Trace: the line says `streamed PCM at 24 kHz` and its size. Voice on, Speech out with the Gemini voice first: ask Shiori something with a reply of two or three sentences. She starts within about a second of the first sentence, with no gap mid-word, and the sentences follow each other closely.
- [ ] **The silent switch.** iPhone silent switch on: you still hear her (playback, as with whole clips).
- [ ] **Bluetooth and the car.** With earbuds, then in the car over Bluetooth (or CarPlay audio): her streamed voice plays there, from its first word, and music pauses while she speaks and comes back after.
- [ ] **The screen locking mid-sentence.** Ask something with a long reply, then lock the screen while she speaks: she finishes the sentence (or stops cleanly), and annai shows what she said when you unlock. Nothing plays twice.
- [ ] **A weak connection.** In a place with one bar (or the phone's Settings → Developer → Network Link Conditioner, "3G" or "Edge" on the iPhone): she waits longer before speaking, then speaks each sentence without a gap. Phone quality (below) waits less.
- [ ] **Phone quality.** Voice → Sound → Phone quality, 8 kHz: Play a sample sounds like a phone call, and Trace says `streamed PCM at 8 kHz` at a third of the size (the Trace counts the sound as decoded 16-bit PCM; on the wire it's about a fifth).
- [ ] **The way back to whole clips.** Untick "Stream her voice, so she starts sooner": Play a sample still works, the Trace line says `wav`, and Shiori's replies start a little later. If anything above failed with streaming on (the silent switch, Bluetooth, the car, the lock screen), check it again with streaming off and say which.
- [ ] **A used-up day.** On a free key, after ten sentences in a day, the Gemini voice rests (Trace: `rate (429)`, "10 requests per day"), and the next voice in Speech out speaks the rest without a pause.

## G4: Google Search

Before you start, open Settings → Updates: if it offers Google Gemini 2.2.0, update it (it brings Gemini API 0.4.0). Search needs a key on a paid project: Google refuses any request with it from a free key. Within a month's first 5,000 searches it costs nothing.

- [ ] **The switch.** Google Gemini's page → Chat: "Let Gemini search Google" is on, with a note on what it costs (5,000 a month free, then $14 per 1,000) and that Google keeps searched prompts for 30 days. Settings → Tools → "Your models' own tools" has Google Search, and its switch is the same one.
- [ ] **A grounded answer.** Ask Shiori something that changes ("what time does Nepenthe close today?"). The conversation shows a card, "From Google Search": Google's words as they came, its sources as links, and Google's suggestion chips under them. Tap a source: it opens in a new tab. Tap a chip: Google Search opens in a new tab (Safari), annai stays as it was.
- [ ] **Its cost.** Trace → Type contains `model.turn`: the turn's cost is what its tokens cost, the searches free (Google's 5,000 a month). Trace → Conversation lists the card.
- [ ] **With Koe.** Koe on (Use the recommended models), voice off, the halves' notes hidden: ask the same. The card still shows, and Koe says the answer in her own words.
- [ ] **What she writes.** With Koe off, the card's words read as an answer to you, not as Shiori's notes to herself; she may also say or show a shorter one.
- [ ] **The free tier, mid-conversation.** In the same conversation as a grounded answer, tick "This key is on the free tier": the search switch goes off and greyed, saying "Google doesn't offer search on the free tier.", and Settings → Tools no longer lists Google Search. Back in that conversation, ask a follow-up that needs the web: Shiori answers with annai's own search (Jina), with no error from Google, though Google's earlier search steps go with the conversation; the earlier card is still there. Untick it: the switch is back on.
- [ ] **Offline.** Open an earlier conversation with a card in airplane mode: its words and links show; the chips' frame may be empty (it needs the network), and nothing else on the page breaks.
- [ ] **Light and dark.** In the phone's dark mode, the chips are drawn dark, as Google's own HTML says; in light mode, light.
