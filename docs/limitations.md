# Known limitations and deferrals

Each entry here was approved by the user. Reviewers read this file first and don't raise these again. Anything not listed here is still an open finding.

### A loud, jumping room sends one noise turn as a voice session opens
- **Kind:** known limitation.
- **What the user sees:** in a loud room whose noise jumps suddenly (about -45 to -40 dBFS, with steps of about 4 dB), about 1.5 s of room sound goes to the live model as a turn, 1.1 to 1.5 s after the microphone opens. Shiori may answer it with nothing. If Koe was about to say a reminder, it can be cut: in probes, 4 of 36 cases, against 2 of 36 before this change. The version before this change sends its own false turn in those rooms anyway, about 2 s later. In traffic, the first false turn is 0.9 s longer than before.
- **Why:** the detector learns the room only once it has heard it. A short word said the instant a new microphone stops giving zeros must be heard (the user asked for that), so sound over a guessed floor is held, and after a second it is judged against the room. A room that jumps looks like speech at that point. Three cheaper variants didn't fix it, and two of them lost the short words again.
- **Measured:** 2 of 27 synthetic changing rooms (`probe-live2` in the detector-floor review); the other 25 behave exactly as before.
- **Revisit when:** a phone test (device-checklist-phase2 L6, the car and loud-room step) shows it, or the detector is redesigned.
- **Approved:** 2026-10-23, the user: "Accept".

### A microphone that dips below -90 dB without exact zeros
- **Kind:** known limitation.
- **What the user sees:** with a microphone that dips its signal below -90 dBFS without giving exact zeros, for about 60 ms every half second, in a room of about -50 dBFS or louder, annai sends back-to-back 15-second noise turns while the microphone is open, and a sentence said inside them is swallowed.
- **Why:** such dips make a young floor a guess, and the first dipped frame (filter ringing, about -66 dB) counts as the room. No device is known to do this. The iPhone trace's gate gives exact zeros, which are handled, and the version before this change breaks the same way with such a gate from the start. A proper fix, treating a frame far under the run's own frames as a gate, is not cheap.
- **Revisit when:** a phone trace shows a device that gates this way.
- **Approved:** 2026-10-23, the user: "Accept".

### Official plugin downloads carry every language's translation
- **Kind:** deferred.
- **What the user sees:** nothing on screen. Each official plugin download includes its Japanese and its Chinese translation, whatever language the screens are in. For a typical OpenRouter user's three plugins that is about 4 KB of 20 KB compressed. Across all 31 official plugins, translations are about a quarter of the bytes, and each added language adds about 12%.
- **Why:** annai verifies an official plugin by every file the catalog lists. A plugin downloaded with only the screens' language would look like a changed copy and be offered as an update forever. A language change would also need a fetch. For two languages the cost is small.
- **Revisit when:** a third language ships. Then move official plugins' translations to a per-language fetch, as `catalog/l10n/<tag>.json` already does for the catalog's own words.
- **Approved:** 2026-10-27, the user: "Defer to a 3rd language".

### A non-English value quoted in a developer's English is read in an English voice
- **Kind:** known limitation.
- **What the user sees:** with a screen reader on Japanese or Chinese screens, a developer's English error (a broken plugin's manifest, skill or package check; a Simulate itinerary error) is read in an English voice. A non-English value it quotes, such as a manifest's `"language": "日本語"`, a Japanese stop name in an itinerary, or a zip entry's name, is read in that English voice too. Before the errors were marked, the whole sentence was read in a Japanese voice.
- **Why:** the mark covers annai's English sentence as a whole. Marking each quoted value with its own language needs every error that quotes a value to carry it as a separate part, which is more moving parts for a rare case on a developer's message.
- **Revisit when:** a screen-reader user reports it.
- **Approved:** 2026-10-27, the user: "Accept as known limitation".

### A page on an older annai refuses plugins that need plugin API 2 until it restarts
- **Kind:** known limitation.
- **What the user sees:** a page still running release 7f0dc027 or older, before it restarts into the new annai, can't add or update the official plugins that say `api: 2`: OpenRouter, Custom provider, Gemini, the four backup kinds, the three search providers and Remote trace. Tapping Update says "was made for plugin API 2; this version of annai supports API 1", keeps the version it has, and offers it again at the next check. Other updates apply, nothing retries on its own, and a restart into the new annai fixes it.
- **Why:** these plugins use `annai.l10n`, which pre-L7 annai doesn't give, so an older annai has to refuse them rather than start them broken. A 7f0dc027 page has `annai.l10n` but predates API 2, and its words can't be changed now.
- **Revisit when:** a user reports being stuck, which shouldn't happen once the page restarts.
- **Approved:** 2026-10-27, the user: "Accept as known limitation".

### A skill on a site that hides its 404s can't be installed if its SKILL.md links to a missing file
- **Kind:** known limitation.
- **What the user sees:** installing a skill from an address whose SKILL.md links to a file that isn't there, on a site that sends its browser-access (CORS) header only on success (nginx `add_header` without `always`), fails with "annai couldn't read <file> from <site>, a file its SKILL.md names…". An installed skill from such a site fails its update check the same way.
- **Why:** a linked file is left out only when the site answers that it isn't there (404, 410, or 403). No answer fails the install, so a network blip can't silently drop a file and then offer the skill as changed. A site that hides its 404s looks like no answer. GitHub raw, GitHub Pages, jsDelivr and Hugging Face send the header on 404s, and are fine.
- **Revisit when:** a user meets it on a site they can't change.
- **Approved:** 2026-10-27, the user: "Accept as known limitation".

### Claude's reasoning isn't carried between tool steps within a turn
- **Kind:** deferred.
- **What the user sees:** nothing on screen. Within one turn, a Claude model (Opus, Sonnet, Haiku) plans each tool step from what it sees, without the reasoning it wrote at the step before. Anthropic's documentation calls passing that reasoning back "Required" within a tool turn, for reasoning quality, though the API accepts a request without it.
- **Why:** annai changes a request between steps (each step's now block, and each half's and tidy-up's own instructions). Anthropic binds a thinking block to everything before it, so every block sent back was refused with a 400, which put Kokoro on weak fallback models. So annai stopped sending thinking back (anthropic-messages 0.4.1).
- **Revisit when:** next, after the bookings plans. Make each turn's requests append-only (keep each step's now block, and freeze the instructions and tools within a turn), then send Claude's thinking back again.
- **Approved:** 2026-10-28, the user: "Defer, do it next".

### A repeated note can be said twice in live voice
- **Kind:** known limitation.
- **What the user sees:** with Koe on a live (realtime) model, if Kokoro sends a second note that repeats the first while Koe is already speaking, Koe may say it twice.
- **Why:** live audio can't be cut and rerun the way a typed call can (Classic Koe's call is cut and rerun with both notes). The only guard in live voice is Koe's instruction to skip a note she has already said, which a weak model can ignore.
- **Revisit when:** it happens on the user's phone with a live model.
- **Approved:** 2026-10-28, the user: "Accept as known limitation".
