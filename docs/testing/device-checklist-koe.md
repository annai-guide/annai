# Device checklist: Koe and Kokoro

The design is docs/superpowers/specs/2026-10-19-koe-kokoro-design.md, built in six milestones (the plan, docs/superpowers/plans/2026-10-19-koe-kokoro.md). Each section is checked on an iPhone, in annai installed to the Home Screen, at the address you travel with.

## K1: the text split

You need a Gemini key from AI Studio (free). Before you start, open Settings → Updates: if it offers Chat Completions 0.6.0 or Google Gemini 1.1.0, update them.

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
