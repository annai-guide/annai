# Second drive follow-ups

What came out of the user's second test drive with GPS and live voice, on 2026-11-04, and what they asked for afterwards.
Built on 8cc90d39. The drive's trace stays on this machine: this document holds no place, address or personal detail, and
neither may anything committed for it.

## The user's words

The issues, as the main session read them back from the trace and the user confirmed ("yes sounds about right. we need to fix
most if not all of them."):

1. In Auto, tapping the avatar opens a text box. They expect it to start voice ("I expect tapping avatar starts a voice session even if I'm in auto").
2. GPS takes two taps; one tap on, one tap off.
3. Keep the screen on while GPS is on.
4. Is there auto GPS? (Answered: there is none. See decision 3.)
5. The "Kokoro working" status and its stop button pop in and out of the bottom bar, and the layout moves.
6. Lyrics get treated as the user and answered. A Japanese song came out as Korean, and Koe replied in Korean.
7. The user's real speech gets marked "not meant for you".
8. Koe's filler: apologies, "I understand", "I'll make sure". ("it makes it super AI")
9. Telling the user's voice from the song.
10. Classic mode: the mic closes right after Koe replies. "maybe make this a default behavior and if it doesn't do that it's just expect a reply and you can also explicitly call to go to sleep if you don't expect any reply".
11. Koe said two lines in a row: its own answer, then Kokoro's note.
12. The spoken reminder got cut off when a session opened.
13. Koe said nothing for minutes while sessions opened and closed. "I do see kokoro's note to koe but koe does not seems to be speaking at all? not even notes"
14. The 3 km and 3-minutes-parked triggers never fired.
15. "Moving fast" fired again after a red light.
16. Kokoro's status said voice was off while it was on.

Then, in the user's words:

> if we typed, that is definatly what we typed right? even with typo generally LLM can understand correctly. for transcription though, can be often in accurate in its own way. we should treat them differently and also let the model to know that if we are not already doing that. This means for a typed message, and a spoken message, the user block shall be marked differently so a mixed typed and spoken can be understanded correctly. I am thinking maybe we shall also mark them differently in the UI as well? This is to make the user know what exactly they did.

> for the not-for-shiori one, I am actually thinking maybe we can have a not highlighted transcription block? if not streamed, we indicate that somehow that is what shiori heared. and if shiori thinks it is ment for her, mark it somehow differently.

> the conversation tab says conversation on top... and we already have a tab card says conversation... so maybe let it show something more useful? ... if conversation belongs to a trip, maybe show the trip name instead of just placeholder text conversation?

> the shiori block in classic mode have model name, but not in realtime mode?

> I did also mention in trip, I kinda want to check kokoro and koe's prompt template. maybe should also be viewable and adjustable by user? just like in trip, we probably want koe's one tuned significantly. let it know it is not a dedicated agent. it is just a response engine and tts engine for kokoro. it should not state anything that it have not being told or have delibrately checked. never trust its own internal knownledge base.

> maybe we should have different color bubble or someway to indicate what mode is shiori talking? like live mode koe, classic mode koe, or if you want to make text mode seperate? and fallback kokoro direct text? just like different user input shall also be different indicated somehow differently in the UI. the UI shall be a somewhat faithful representation of the transcript (or transcript for koe?) ( is there way to see kokoro's transcript? )

> I also want to note on 9, maybe do something clever? maybe unfeasible but would love if even can distingush who is talking... a really advanced feature maybe we don't need

## Decisions

1. **Bubbles.** The mock-up's Option B, with softer colours: "I would still like the color also. just maybe more pastel and suttle than the ones you showed in the mockup. color bind person can still see the labels just fine and not color blind peoples have the colors to assist." Mock-up (private): https://claude.ai/artifact/BbSa9hwLL1C4aMPf9bkEve
2. **Item 9.** "Music check now, who later (Recommended)": the check on the phone now; who is talking is deferred (docs/limitations.md).
3. **GPS.** No auto GPS: "one tap is enough. reason being often phoen will show another window asking for permission to use location. so one tap in our control, and two tap in most cases."
4. **Koe is a relay,** as the user said. Stated to them: a factual question then waits for Kokoro (about 12 to 13 seconds in the two cases timed on the drive), and Koe can't answer facts while Kokoro is down.

## 1. The Conversation (branch `drive2-ui`)

### One rule for what a line is
One function, used by the screen and nowhere re-derived, takes an event and gives its kind and its label. Stored events don't change: every kind below is read from fields events already carry, so old conversations draw correctly.

| The line | From | Look | Label |
|---|---|---|---|
| Typed | `msg.user` | Fill (`--ai-wash`, as now) | keyboard icon, "typed" |
| A tapped choice | `msg.user` with `chose` | as typed | "tapped" |
| Spoken, dictation | `heard`, `source: 'dictation'`, not dismissed | pastel blue fill | mic icon, "spoken · phone dictation" |
| Spoken, live | `heard`, `source: 'live'`, not dismissed | pastel blue fill | mic icon, "spoken · live voice" |
| Spoken, other | `heard`, other sources | pastel blue fill | mic icon, "spoken" |
| Words still coming | a `heard` whose words aren't in yet | no fill, dashed line | mic icon, "hearing you" |
| Heard, Koe didn't answer | `heard`, `source: 'live'`, dismissed | no bubble, quiet, on the user's side | ear icon, "heard · she didn't answer" + the button below |
| Heard, judged not for her | `heard`, other sources, dismissed | no bubble, quiet, on the user's side | ear icon, "heard · judged not for her" + the button below |
| Koe in a live session | `out.speak` with `live` | pastel teal | wave icon, "Koe · live · <model>" |
| Koe, said aloud | `out.speak`, `half: 'koe'`, `voice` | pastel blue | wave icon, "Koe · said aloud · <model>" |
| Koe, text | `out.speak`, `half: 'koe'`, no `voice` | `--sheet`, as now | text icon, "Koe · text · <model>" |
| Kokoro talking directly | `out.speak`, `half: 'kokoro'` | pastel violet | text icon (wave if `voice`), "Kokoro directly · <model>" |
| One half (no Koe) | `out.speak`, no `half` | `--sheet` | "<model>", as now |
| Kokoro's words that annai showed as a backstop | `reminder` with `answer` (older lines: `title === "Shiori's answer"`) | pastel violet tint | "Kokoro's words · said aloud" or "Kokoro's words · shown", by `aloud` |
| A reminder | `reminder` otherwise | pastel amber line | "annai · said aloud" or "annai · shown", by `aloud` |

- The `who` line ("SHIORI") stays. Cards (`out.show`) and asks (`out.ask`) take the same tint and label by their `half`.
- "Show what she says" off still folds spoken words away. With it on, spoken words are the normal size (the mock-up), not the smaller grey they are today.
- The colours are new tokens in `src/ui/tokens.css`, light and dark, as the mock-up's: light washes `#f0f8f6` (teal), `#f1f5fc` (blue), `#f5f1fb` (violet), each with a border one step darker (`#d3e8e4`, `#d9e3f4`, `#e3daf3`); dark washes `#18252a`, `#1a2230`, `#201d2e`, borders `#27393c`, `#2b3648`, `#352f49`. The label's text must stay readable (4.5:1) on each wash, in both themes. Every kind keeps its words: colour only assists.
- The chosen icons are inline SVG in annai's style, with no new dependency.

### Live lines name their model
`src/core/koe/live.js:1188` writes `by: null`. `by` is `{ name, first, tried }` (`src/ui/screens/talk.js`, about line 304; `loop.js`, about 1908): write `{ name: <the model's display name>, first: null, tried: false }`. Lines stored with `by: null` draw without a model.

### "This was for Shiori"
A small button on both "heard" lines, the main session's addition (the user had to say "This is for you" aloud). A tap sends the words through the existing `send` path as a `msg.user` with `claim: <heard id>`: no new event type or wake kind, and the wake, Kokoro and live-text paths already exist. The models read it as `[the user says this was for you] "…"`. On screen it draws as a spoken line, and the quiet line loses its button. It works the same on an old line.

### The title and navigation: not in this build
The user is choosing how annai's screens are organised (section 5). `drive2-ui` leaves the title, the tabs, the Now screen and the word Plan alone.

### Controls
- **Item 1, the avatar in Auto.** A tap on the avatar starts voice, in Auto as in On: the keyboard button is how to type. Auto on the phone's speaker has `voice.on` false (`src/core/voice/mode.js`), so removing `'typing'` from `tap()` (`src/core/agent/loop.js`, about line 3122; `src/core/koe/live.js`, about 591) isn't enough: `koeWay` needs `voiceOn` for Realtime, and `#voiceNow` stays false, so the reply would be a bubble. A tap in Auto holds voice on (`voiceMode`, `why: 'tapped'`) until that exchange ends, and Halves refreshes before routing. With voice set to Off, a tap still opens typing. If the microphone can't be used, say so as today.
- **Items 2 and 3, the GPS chip.** A tap on the chip turns GPS on or off at once; the phone's own permission prompt is the only other step. Keep the screen on while GPS is on becomes the default. What was in the chip's menu moves to Settings → Voice or the Drive screen, whichever holds it best, except that the simulation's menu (`src/ui/live-chip.js`, about line 76) stays on the chip while a simulation runs, and "Where are you?" needs a named home too. "Keep the screen on while GPS is on" becomes one setting, default on; the old per-situation values (`live.awake`) are ignored and the code for them goes. `src/ui/screens/drive.js` imports `screenOn` too.
- **Item 5, the bottom bar.** The space for the "working" status and its stop button is always kept, so nothing moves when it shows. Check at phone width, with the dock in each of its states.

## 2. Prompts and what the models see (branch `drive2-prompts`)

### Typed and spoken
The models are mostly there: Kokoro reads `[the user typed] "…"` and `[heard] …`, Koe reads plain text and `[heard] …`. Add:
- Koe's transcript marks typed lines `[typed] …` (`src/core/agent/transcript.js`). The live session's text path and its "conversation so far" block mark them the same way.
- One line in each prompt: typed words are exactly what the user wrote, so read them as written, allowing for typos; `[heard]` lines are speech recognition and may be wrong. One half's typed lines stay plain, with that line saying that plain lines are typed.

### "Not for you" says what happened
In a live session `dismissed` means only that the model said nothing (`src/core/koe/live.js:1074`): no one judged the words. So in Kokoro's transcript a dismissed `heard` with `source: 'live'` reads `[heard, Koe didn't answer]`, in Koe's `[heard, you didn't answer]`, and the others keep `[heard, not meant for you]`. The new labels are defined in the prompts. The other readers follow: `src/core/agent/self-tools.js` (about line 157) and `src/ui/screens/trace.js` (about 177); `loop.js` (about 1266) keeps its logic. Classify by `source`; stored events don't change.

Kokoro's prompt: when Koe didn't answer something that was clearly for it, tell Koe what to say. Dismissed lines set no cue today (`src/core/agent/halves.js`, about line 988), so a line Koe didn't answer reached Kokoro only at the 3-minute review. A dismissed live turn now cues Kokoro only if its peak is within 6 dB of `voiceDb` (section 3): the user's own level. Lyrics don't cost a Kokoro call, and "Okay, cool" costs what an answered turn already does. The main session's call.

### Koe's prompt, rewritten
The user's words decide this: Koe "is not a dedicated agent… just a response engine and tts engine for kokoro… should not state anything that it have not being told or have delibrately checked… never trust its own internal knownledge base". In `KOE_CORE` and `KOE_LIVE` (`src/core/koe/instructions.js`):
- Who it is: the voice of Shiori, not an agent of its own. Kokoro thinks, looks up and does the work.
- What it may state: only what a note from Kokoro, the `<now>` and `<today>` blocks, a tool's result, or the user has just told it. Nothing from its own knowledge, general facts and anything about annai included. Remove `STABLE`. Asked anything else: a couple of words saying it's checking, then `tell_kokoro`.
- Never say something is done until a note says so (as now). Never promise.
- How it talks: remove "warmly". No apologies, no sympathy, no "I understand", no "I'll make sure", no echoing the user's words. An acknowledgement is a word or two, or nothing.
- What it leaves alone: lyrics, music, other people, noise, single stray words, and anything in a language the Languages section doesn't list. Silence is a fine answer. It never changes language because of a stray word.
- A note from Kokoro is always said, even when told earlier to stay silent: going to sleep ends with the session, and doesn't carry over (see 3, item 13).
- If Kokoro can't be reached: say so plainly, without answering from its own knowledge.

Kokoro's part (`KOKORO_PART`) changes to match: Koe knows only what it's told, so what the user should hear must be in a note; and it never writes "stay silent until…" into a sleep note. The classic listening rule (see 3) changes `CORE` and `KOE_CORE`'s last lines. `NOTE` says "apologise briefly" when a note doesn't answer the question: that goes. `CHANGES` is covered by the new rule, so it merges into it. `koeSystem` still appends the personality; check that the shipped presets and `DEFAULT_PERSONALITY` ("Warm") don't work against the new lines, and change the default if so. Anything in these prompts not named here stays as it is.

### The classic gate (item 7)
`gatePrompt` in `src/core/voice/gate.js` (called from `loop.js` `#gate`; a tap's window skips it) says the user is "often in a car with other people" and shows only her last line. Both pushed real speech to `chatter`, twice on the drive. Change it: give the last few lines of the conversation, not just her last; say that speech about annai, its behaviour, or a thing just said is for her; when unsure, it's for her (a wrong "for her" costs a short reply; a wrong "not for her" loses what the user said). Keep the options and the cheap model. Check the two wrong verdicts' shapes against the real small model, on a free key.

### Instructions you can read and change
Settings → Shiori gets a section, "Her instructions", under Personality. Four files in `/me/instructions/`: `shiori.md` (`CORE`), `kokoro.md` (`KOKORO_PART`), `koe.md` (`KOE_CORE`), `koe-live.md` (`KOE_LIVE`).
- A file exists only once the user has changed that text: nothing is installed. The editor shows the file, or annai's text when there is none. Save writes the file and records in the app settings the hash of annai's text it was based on. Reset to original deletes the file, with the toast from 8cc90d39. When annai's text has changed since that hash, the section offers the new original beside theirs (Keep mine, which records the new hash; Use the new original, which deletes the file). This needs no sync and no generalising of `syncPersonalities`, so leave `src/core/agent/personalities.js` alone.
- The section's one line of help says these hold how Shiori works, including her safety rules, and that Reset brings them back.
- The snapshot reads them where it reads the personality, and a change applies at her next wake: `nextSnapshot` (`src/core/agent/context.js`, about line 52) must compare them. A missing or empty file uses annai's text.
- Shiori never writes these files: one line in `writable()` in `src/plugins/files/index.js` covers every write tool. `tune_personality` is unchanged.
- The built-in text stays in the JS.

### What each half sees
The Conversation's ⋯ menu gets "See what Kokoro sees" and "See what Koe sees". Each opens a screen with that half's system text and its conversation. For Kokoro and classic Koe, it's built by the code that builds the real request: a public method over `#systemFor`, `#sendable` and `#half.tail` (`#warmSummary` is the pattern), with Koe's conversation opened first (`#koeOpen`), so it can't disagree with what the model got. A live session is different: setup goes once and the provider holds the rest, and the Trace keeps no request bodies. So it shows the setup LiveKoe kept, then the lines since, labelled as such. Tool calls and results, and Kokoro's private text, show. Pictures and audio show as a short line. A Copy button. It answers "is there way to see kokoro's transcript?". The ⋯ menu may move with section 5: keep the screen's route independent of it.

### Item 16
Kokoro read "voice: off" while Koe was talking and classic voice was working. `loop.js` (about line 1832) reads `#voiceNow`, which `#voiceOn` (about 2708) makes false while Koe holds the voice. The block reads `voice.on`.

### Item 11
At the drive's voice test Koe answered, and then read Kokoro's note, which said the same. `NOTE` already forbids repeating, and it failed on the drive, so this is a known risk the rewrite may not fix. Check it in the real run with `already_told`, and report what you find.

## 3. Voice (branch `drive2-voice`)

### Item 10, classic keeps listening
After Koe says something aloud, annai keeps listening by default. Today `speak` already listens unless `sleep` is in the same reply (or `more`), and `#afterTurn` closes the mic at the turn's end. So the change is the prompts ("a speak listens by itself; call sleep only when no reply is expected"), plus a window after a turn that didn't sleep. That window's owner can't be `'tap'`, which bypasses the gate. Same rule for one half and for Kokoro talking directly. `sleep` closes the mic at once only in a reply that also speaks, shows or asks (the user's ruling, 2026-11-05): a stray word in the window that Koe answers with `sleep` alone, as its prompt says silence is fine, leaves the window open to its same deadline (`#saidAt + silenceSeconds`, never extended), and owes that word no answer (no `UNANSWERED` cue, no "Shiori didn't answer" card); `sleep` with a redundant `already_told` leaves it open too, and a tap still closes. A turn that only sleeps after a silent `speak` shouldn't cost a model call: return `endTurn` there.

The window is `silenceSeconds`, default up from 8 to 20 (a saved value stays). Its `?? 8` literals are at `loop.js` about 3142 and `live.js` about 335 and 205. That setting also sets a live session's `#answerMs`, `ask` and the tap windows: the user asked about classic, and a longer open mic during music costs more, so those live windows keep 8 s with their own constant (the main session's call). During the window the avatar shows it's listening and the iPhone's mic indicator is on; the mic closes while she speaks (`#closeEar('speaking')`), as now.

### Items 6 and 9, the level check
Measured on the drive (53 live turns, one car, one volume): the user's voice peaked at about -3 to -13 dB; lyrics at about -16 to -26 dB; a few quiet words of the user's were lower ("yeah." at -19). The floor with music on was about -54 to -66 dB; without it, mostly -66 to -86 dB.

annai decides when each audio turn begins (`automaticActivityDetection: { disabled: true }`), so lyrics that never open a turn never reach the model, cost nothing, and can't be answered:
- The detector (`src/core/voice/detector.js`, about line 240) gains a minimum level for starting speech, reaching LiveInput through a callback as `speaking` does. Under it, a frame doesn't start a turn. A turn already going on is untouched. Every turn start comes from the detector's one `speech` event. Frames kept out this way raise `blips`, so `noisy` turns true and she plays at once: keep them out of that count, and test that the floor's creep doesn't defeat the -70 dB line.
- `voiceDb`: the second-loudest peak of the last 5 turns she answered (none with fewer than two), not a running maximum, so one loud answered lyric (-7.8 against a normal voice of -23.3) can't leave the normal voice opening no turns until a tap. A turn she lets go teaches nothing, and it never falls with time. It lives on the Koe live object across sessions, and resets when the audio route changes (`voice.route`), or when a turn begun in a tap's lift is answered: that turn starts it again. (Reversed from a first version that fell 3 dB a minute and learned from every turn: lyrics got through after a minute, and each woke Kokoro.)
- While the floor is above about -70 dB, the minimum is `voiceDb - 10`. In a quiet car there is no minimum. With no `voiceDb` yet there is no minimum.
- A tap lifts the minimum for 8 s from when the microphone hears: a tap only opens the mic (`live.js`, about 579 to 595), so it can't force a turn.
- `live.turn` also logs `voiceDb` and the minimum in force, and a count of frames over the floor that the minimum kept from starting a turn, so the next drive can tune the constants. The constants are the main session's first guess, measured from one drive.
- Dictation has no level to read (the browser holds the audio), so classic relies on the gate.

The check doesn't replace the prompts, and Kokoro's non-stop rule stays for music louder than the voice.

### Item 13, the silence
What the trace shows: after Kokoro's note "Stop now, go to sleep, and stay silent until the user clearly talks to you", the session closed. Then, for about 4 minutes, four sessions opened for Kokoro's notes (`ready` once, `resumed` three times), each closed after 9 to 24 seconds with 1 or 2 turns and no line said. Kokoro's `for_user` words weren't shown either. Not verified: the suspected cause is that the resumed sessions still carry the stay-silent note, and proactive audio lets the model stay silent to a note.

Reproduce with the fake realtime server, then fix at the source:
- A note goes in so that the model answers it (a note is not user audio: decide whether `#due` should arm for it, and what proactive audio does with a text turn).
- A session opened after a `sleep` doesn't resume the context that holds the sleep note, unless the check shows that isn't the cause.
- A note with `for_user` that the session closes without saying is shown, and said aloud if voice is on. No note the user is owed disappears.

### Item 6, the silent retry
`#silent` (`src/core/koe/live.js:833`) restarted the session three times on the drive, and the first restart was followed by a heard Korean word and a reply in Korean. It does resend the heard words to a fresh session (`live.js`, about 853 to 857). Not checked: whether `#due` survives an empty `#complete`, so whether proactive silence counts as a failure. Make sure a turn the model chose not to answer is never retried.

Measured (2026-11-04): after the user's turn music got an empty turn, or no message for 12 s from a session that then answered speech and notes at once. That is the model's choice, so a fresh session isn't given the words (it has no reason to let them go too: a lyric was answered in Korean). A session really dead shows itself at the next note or typed line.

A turn whose tool call was answered silently may never get its turnComplete. Real runs, 2026-11-05: it came about at her sound's end, at most 2.9 s after the answer, in 48 of 48 probes, silent or not; in one of 31 full runs it never came, and the turn held the note that waited for it until the session closed, 35 s later. So `#endLater` ends the turn `TURN_END_S` (2 s) past the end of her sound, counted from when her sound began (her first word may come late, and a call alone has no sound: it counts from the answer). A turnComplete that comes after the bound, with no new audio between, is that turn's and is swallowed. One that comes after more audio is that audio's end, as the provider sends them in order, and is applied.

### Item 12, the reminder cut off
A reminder began in the fallback voice, and 9 seconds later a session opened for Kokoro's note. A reminder being said finishes first; a session that opens meanwhile doesn't play or capture over it (hold the open, or hold the first sound).

### Extended thinking
To come out of annai (the user, 2026-11-05: "Take it out"), with the long rest below, over two releases. This one brings only the rule that follows, and the model and its rest stay, so a phone behaves as it did. The next takes them out of the plugin and of annai, by which time every page runs the rule whichever order its update comes in: a page on the old code could take the plugin's update first, and pass the one update that drops it. The update takes it out of a saved Koe · Realtime list, as for any model a plugin's description drops, and only at the update that dropped it: the previous description named it and this one doesn't, so a model the user puts back stays. A description that lists no models at all for that ability is partial, and leaves the list alone. The order of the rest stays. A drop that would empty the list puts in the description's recommended model for that ability (its first, if it recommends none): a plugin update swapping a Live model's id keeps Live working, and a list that held only Extended Thinking gets the normal Live model, as the user was told: "Koe uses the normal Live model, with no refused sessions and no 6-hour rest." The list changes in the same write as the provider, so a kill can't leave one without the other. Its record, Kokoro's picks and models added by hand stay. What follows is what was first asked.

"Gemini 3.8 Live Extended Thinking" (`plugins-official/provider-gemini/annai-plugin.json`) failed all 5 opens with 1007 "Thinking level must be specified for this model". The Gemini Live protocol (`plugins-official/gemini-live/index.js`) never sends one. Send what the API takes, checked against the current docs and on a free key, with the model's level as the catalog's other Gemini entries give it. Bump the plugin's version as the catalog gate needs. A model that fails every open on a bad request is also marked so, so the next try goes straight to the next model: today a reminder fired, tried it first, and lost its moment.

## 4. GPS and triggers (branch `drive2-gps`)

### "Moving fast" stuck (the main session's fix of 2026-11-03 didn't hold)
The status read "moving fast" about 4 minutes after the car had stopped: speed fell to 0.8 m/s by about 90 s after a 3.2 m/s fix, fixes came every minute or so, and it read "still" about 6 minutes after stopping. At a red light earlier it settled correctly. The likely cause, from reading the code and not yet run: 3.2 m/s falls in the 3 to 5 dead zone, so `#seen` is null; and `speed: null` fixes over 60 s apart give no derived speed, yet they reset `#lastAt`, so `QUIET_STILL_MS` never elapses. Write a test from that shape of fixes first, confirm the cause, then fix it in `src/core/live/activity.js`.

### Items 14 and 15
- **"Moved" (3 km).** It never fired after about 8 km. `src/core/live/live.js` (about line 990, `#heard`) resets `km0` on any half's wake, and every voice turn is a wake (spec §11.3 says "since the last wake", which is wrong for a watch someone sets for a distance). Remove the reset, and reword MOVED's summary and firing text. `km0` is memory only, so it counts from when the watch was set, or annai's last start. It changes a behaviour: add a LESSONS.md entry and list it in Calls to confirm.
- **Parked 3 minutes.** Not the activity's fault: `arrived` reads `m.stop` (`src/core/live/triggers.js`, about lines 150 to 162). Shiori also cancelled the leftover watches about 3 minutes after the car stopped, so it may not have had its chance. Read how `m.stop` behaves with those fixes and report; fix only if it's wrong.
- **Red lights.** "When moving fast starts" fired again after a stop at a light. It fires unless moving fast ended under 5 minutes ago: that also covers parked for an hour, walked 3 minutes, then drove. Watches on stopping still fire as they do: the user counted that as a pass. No new options on `watch_set`.

### Surviving a reload (the user, 2026-11-04)
"I think we might need to fix this? because iphone clears background apps (we are web pages?) quite aggressively? And if user want to be notified then it is quite important we make that accurate. and user may actually want to know where they said that as well?" And: "I think restart actaully might be quite common? indeed today I almost did not switch away still happened?"

- All a reload needs lives in **one small overwritten record**, read synchronously at start: `{ at, odometer, odo: { lat, lng, at, accuracy }, activity, ended, stale }`, where `stale` is set while a record too old to show waits for a reading. It stays in localStorage (`annai.drive`), reached through Live's injected `keep`, so a simulation writes none and core stays testable; it isn't in exports, backups or the trace sink, and Erase clears it. It is written on each activity change, each km while moving, the 5-minute beat and going off screen, all from one method. (Three earlier rounds kept this state in several places: in-memory fields, `state` entries read back at start, the open trip's last point. Each round found another disagreement among them.)
- The `state` entries stay as evidence for the Trace (no position), and nothing reads them back.
- The odometer and the place it counts from come back whatever the record's age. They are written together, so the way since then counts once at the first fix back, even after a page killed unseen, and whichever conversation is open. A `moved` watch records the odometer reading and place when set and at each firing, and its firing says where it was set. (A first version recounted from the logged points: it skipped the odometer's filters and couldn't count outside the open trip.)
- The activity and when moving fast ended come back if the record is under 5 minutes old, so a reload at a light or mid-drive doesn't re-fire "moving fast starts". A record that says moving fast and is older takes the same path as any gap, below, and differs only in what shows.
- A place the user gives is a jump: the next fix counts from where it is. A fix coarser than 100 m is no place to count from.
- **One path for any gap in evidence** (a reload, an unlock, an old record): moving fast stays as it was, and the first reading that can say decides. Nothing else re-judges it, and a real stop is a stop from moving fast. A reading on the road says so: no "stops", no "starts", voice held throughout.
- A slow reading (below 3 m/s) says stopped, unless the car may have gone on. The phone stayed put only if the way since the last evidence is under 0.5 m/s, the sensor's own "still": not walking's 3 m/s, and not the way fast cars are told by, since a way of 2.5 to 5 m/s can't be called fast or slow (4 m/s in a straight line is a city with lights). The two mistakes aren't equal: a moving car read as parked fires a false "stops" and a false drive end on the road, while a parked phone read as moved takes the hold. So at 0.5 m/s or more the hold starts at this reading, and a light after a lock or a reload is only a light. The cost: the true "stops" of a phone that was parked comes a minute after the reading (a phone carried 200 m on foot during a 3-minute gap reads "stops" a minute after its first reading, not never). Behind a lock of any length, or a reload with a record under 5 minutes old, that stop is treated like one seen on screen: a minute of hold, voice on about 3 minutes, and the same-drive rule's 5 minutes, which loses a true "starts" inside them rather than delaying it. Only a kill (an old record) dates the end from the record, as K2 says. Under that, the hold dates from the last evidence, and the first reading can end it, so a parked phone ends at once. A reading with no speed says stopped only if its way over at least 15 s is slow: 2 minutes of silence after it ends moving fast. A way is slow only if it would still be with both accuracies added, so one too short for its accuracy says nothing.
- A reading that can't say keeps the hold: coarse; no speed, with a way too short to say (under 15 s, or for its accuracy) or a fast way; a GPS speed at accuracy 51 to 100 with nothing to work a speed from; a speed of 3 to 5 m/s, which also starts the bound again, since readings are coming. A GPS that never gives its own speed decides by the speed worked out from its fixes.
- The user's pick, 2026-11-05: "Coarse says nothing (Recommended)". A reading worse than 100 m says nothing about the activity, not just during a hold, and doesn't count as the last fix. As they were told: "No false stop in a tunnel, and slightly less code. The cost: in an underground garage with only coarse readings and the app on screen, annai reads moving fast for up to 15 minutes instead of ending at 60 s. With Precise Location off, activity stays unknown instead of still."
- With no reading that says, moving fast holds for up to 5.5 minutes of time on screen. A long lock between two short unlocks doesn't use it up, and unlocks every 5 minutes don't reset it. One no-speed fix then silence never means 15 minutes of moving fast.
- Past that bound, the user's pick, 2026-11-05: "Fire at 5.5 minutes (Recommended)". Voice off, one "stops", and the end written to the record, dated at the bound. As they were told: "Parked in a garage: the reminder comes on time. Still on the road with dead GPS: one false stop, and voice comes back at the next good reading." A good reading on the road then brings moving fast and voice back at once, and the same-drive rule keeps "starts" silent if it comes within 5 minutes of the bound end. Past 5 minutes, "starts" fires: that's the one false "starts" this leaves.
- A reload after a bound end brings nothing back: no moving fast, no second "stops", no second drive end. What it forgets is the place: the road after it takes the usual 30 s to read moving fast, and voice turned off for that drive doesn't survive it.
- A reload chain is bounded: during a hold the record keeps the age of the last evidence, and a fix that moved the odometer counts as evidence. Under 5 minutes from it, a reload restores; after that it's an old record. The record is written when a hold ends on a good reading.
- An old record (5 minutes or more, so the page was killed) takes the same path with two differences until a reading decides: Live shows unknown, and voice isn't held; the record keeps saying moving fast. And there's no bound. With no readings at all, nothing fires and no moving fast shows, for as long as that lasts: silence is no evidence here.
- Reopened on the road: at the first reading that can say, moving fast with voice on, and no second "starts".
- Reopened parked, the user's pick, 2026-11-05: "Fire when you reopen (Recommended)". As they were told: "Once the first readings confirm you've stopped, the reminder fires then. It's a true stop, just late. Voice is off at that point, so it's shown, not spoken." One late "stops"; moving fast never shows; voice is told the end once; no "starts", and driving off later does start. With a way under 0.5 m/s it's told at the first reading with a speed; a first reading with no speed is told at its change (up to 2 minutes later), since a no-speed reading says stopped only with its 2 minutes of silence. With a way of 0.5 m/s or more, the car may have gone on and a slow reading may be a light, so it's told at the change, a minute after the reading, with "stops", and a light tells nothing. Its end is dated from the record when the way says no (under 5 m/s), since the drive it describes was over long ago, so driving off later does start and a "when I stop" set in that minute is not spent by it. A reload or a kill in that minute, or a gap the phone moved across in it, drops that date, and the same-drive rule applies. At a way of 5 m/s or more the car drove until now, and the same-drive rule applies: no "starts" for 5 minutes. It holds for fixes over 2 minutes apart, and a reload or a voice tap before the confirming reading doesn't lose it. Silence alone doesn't fire it, but a reading whose way is slow says stopped, as after a reload, so a lone no-speed fix can fire it 2 minutes later.
- Reopened with a fast speed and a way under 5 m/s, at least 5 minutes since the last evidence: a new drive, or the same one on a city grid, a winding road or an errand loop, whose straight line looks slow. Nothing can say which, so the old drive ends silently: no "stops" and no drive end. "Starts" fires after the usual 30 s, as it did before (the user's accepted "Rare wrong moving fast starts"), and "stops" waits for a real stop. The cost: a truly new drive gets no "stops" for the old one, and a one-time watch fires at the end of the new drive.
- Voice turned off during a drive stays off across any gap while the way hasn't decided, and clears when it decides the drive ended. A choice of voice while waiting cancels the end to tell. A silent end of an old drive (the entry before) leaves a voice-off through the usual voice hold, so it lasts through a light or a crawl, and a stop past the hold clears it. A reload inside the silent end's 30 s keeps it, if the record carries the silent end's mark and is under 5 minutes old; a record that says unknown for another reason doesn't.
- A watch set after a stale record's drive ended isn't for it: such a change tells the triggers when it happened, and one from before the watch was set doesn't fire it. Any other stop is the watch's, however early its hold is dated.
- A record that says moving fast again after a light tells no drive end, however recent that light.
- One-time watches rest on deletion: a fired one's file is gone, so a backup taken after it has none to fire, and nothing else marks it. An untriggered one fires on import (the user: "that can be intentional"). A backup or a kill in the milliseconds between the log and the delete can fire it twice, which is better than a reminder lost.
- `app.start` is logged per page load. The trace can't show reloads today, so how common they are is not yet measured.

### A parked phone drifting to walking
Not decided. The user will leave the app open at home with GPS on, on the build with the activity log and its 5-minute heartbeat: "do you want to test now? I can have the app open while at home to see if it drifts?"

## 5. How annai's screens are organised (waiting for the user)

The user, on 2026-11-04: "Yeah I do not think Now is a good idea. however I kinda want to explore some other options as well... because everything come back to the conversation screen, maybe make that the base screen to come back to?... maybe the plan screen can say something like agenda, calendar or something? because plan is also a verb... for the trip, is more like to manage this trip? maybe we can make that a screen they enter after pressing a button? this way maybe we do not need the three tabs at all?... or maybe we can emulate some sort of chat app? user click a trip to open its conversation, and manage everything related to it inside that trip?... let's explore some wild ideas first and decide on the more general stuff before digging into which module where".

Sketches (private): https://claude.ai/artifact/XKxbX3EtPvHkDBxXHjyueP. Nothing here is decided, and nothing here is built yet.

## 6. Voice switches (after the branches above)

The user: "the voice is bit busy? it says Voice on ` your last choice ` realtime, which almost takes the whole line... for the auto voice mode, shall we review its design? do you think user will understand what it does? should it just be a simple toggle for on and off? ( well also the realtime mode on and off )". Picked: "On/off, plus on while driving (Recommended)". Evidence: across the whole trace the iPhone's audio read only as unknown or speaker; a car was never detected.

- Voice is one tap on or off. Live is its own switch (it replaces the Realtime and Classic wording). The chips read `Voice on` and `Live`, and `Voice on · driving` while driving; no other reason shows.
- A tap on Shiori always talks, for that exchange, with Voice off too. The keyboard button is how to type. The hold from item 1 stays.
- One automatic rule: voice is on while driving (needs GPS on).
- Auto goes, with `route`, `lastChoices` and the audio-name matching. A saved `auto` reads as off. The settings format stays tolerant.

Voice also turns off by itself, in two cases. The user: "I am thinking maybe we should include some automatic turns voice off senerios? maybe like from moving fast to stopped, or headphone disconnect? for things we know user might not want it play through speaker. and they can always just start talking again by tapping the avator."
- **A drive ends:** when Auto's old "moving" hold ends, about 3 minutes after stopping (section 4's `fastEnded`), voice goes off, even if the user turned it on themselves. Only at that moment: turning it on afterwards stays on. A reminder due in that same moment is said first.
- **The microphone's input disconnects:** when the input the microphone is open on (`inUse`) is no longer among the audio devices (`devicechange`, with no name matching, and only in a list that still holds inputs), voice goes off at once and stops mid-word. That covers AirPods or a car's Bluetooth taken away while she listens. Any other device coming or going counts for nothing: a Receiver that comes as the microphone opens and goes as it closes, a watch, an id with no name, anything while the microphone is closed (it was the first reading that turned voice off on every exchange, and on a watch, with the headphones' note). The cost, accepted: AirPods taken out before the microphone ever opened on them go unnoticed. Not verified: that iOS tells a web page. A device check, and `voice.route` logs the change.
- A short note says why and names what went ("Voice off: AirPods Pro disconnected", "Voice off: you stopped driving"). A tap on Shiori still talks.
- **A drive's end is the user's to cancel and never cuts in:** the end waits for the exchange it finds her in (she finishes her sentence, the user's turn is heard), then voice goes off with the note. A drive's end found only after annai opened, from a record whose hold ran out, waits for the first good fix and dies if that fix is fast (a fix with no speed is judged by the way from the record's place; with no place either, the next good fix says); with no good fix 15 s after annai opened, the end fires (going off is the safe way). A choice of voice's since annai opened cancels such an end, before it fires. At the hold's end, a last speed that is moving fast again (a light that lasted 150 to 180 s) is not an end.

## 7. Detailed trace (before the next long drive)

The user: "do you want to build a more enhanced and heavier trace mode (option) with more information like recordings / even screenshots able to be collected?" Picked: "Yes, before the next long drive (Recommended)". Off by default; sends only to the user's own trace server.

- Recordings of what the microphone heard, including samples of sound the level check kept out. Stored and sent as blobs named as spec §4.9 asks. The trace server takes them.
- A text copy of what's on screen at each moment that matters. Real screenshots aren't possible from an iPhone web page as far as the main session knows (not checked).
- A "flag this" button: it marks the moment and keeps the sound and screen around it.
- A plain warning: recordings include passengers and whatever is playing.

## Out of scope

- Who is talking (deferred, docs/limitations.md).
- Choosing a conversation's trip from dates or location: asked about, not requested.
- Shiori changing Koe's prompt herself.

## The main session's calls

- "This was for Shiori" (the user didn't ask for a button).
- Live's "not for Shiori" becomes "she didn't answer", and Kokoro is told the same.
- `silenceSeconds` default 8 → 20.
- The level check's constants.
- Screen on by default with GPS (the user asked; battery cost).
- "See what Koe sees" beside Kokoro's (the user asked about Kokoro's).
- A dismissed live turn at the user's own level cues Kokoro; lyrics don't.
- A live session's listening windows stay at 8 s.
- `voiceDb` learns only from answered turns, as the second-loudest of the last 5: learning from every turn, or a running maximum, let lyrics read as the user's own, and one loud lyric lock the normal voice out.
- A turn at the user's own level is also one let go over a quiet floor with nothing learned; those cue Kokoro once until an exchange.
- `REFUSED_REST_MS` (6 h) is for a refusal naming a thinking level; any other 1007 gets the normal rest.
