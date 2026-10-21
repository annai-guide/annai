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
- [ ] **A new key, or Remove key.** With turns kept, the line under the key says annai first asks Google to delete them. Remove key: "Asking Google to delete what it keeps…" shows for a moment, and Trace shows `kept turn deleted` for each. Put the key back.
- [ ] **A day later.** On the next day, a conversation from yesterday sends its first message whole once (no "after a kept turn"), then chains again.
- [ ] **Offline.** Talk in another trip, turn on airplane mode, remove the trip. Google Gemini's page says "N deletions waiting". Turn airplane mode off: the line goes (reopen the page), and Trace shows the deletions.
- [ ] **Removing the provider, offline.** With turns kept and airplane mode on, the words above Remove provider say "Google keeps N turns until they expire, up to 55 days." (1 day on the free tier). Online, they say annai asks Google to delete them first.
- [ ] **Erase.** With turns kept, Settings → Erase names them before the tap; after Erase, nothing of annai is left on the phone.

