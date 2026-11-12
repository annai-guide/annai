# The realtime check: real Gemini Live, real speech, annai's own code

The unit tests and the e2e tests of live mode use stand-ins: a fake realtime server, a tone for a voice. They show that annai's code
does what it means to. They cannot show that Gemini Live, spoken to by a person, answers the way annai expects. This check can: it
opens annai in Chromium, in Docker, sets it up as a user would, feeds its microphone real speech (made once by Gemini's text-to-speech)
on a schedule, and records what happens: each turn's start and end and why it ended, the time to the first sound back, whether
she was cut, what Gemini heard, the silences and the errors.

It is **opt-in and never part of `npm run check` or CI**: it needs a Gemini key and the internet, and a full run takes about ten minutes.

## What it does

1. **The clips** (`test/fixtures/realtime/`, 16 kHz mono WAV, committed, no key in them): seven short travel
   questions, a quick "yes", a sentence with a 1.5 s thinking pause inside it, a long question (about 13 s), and silence (only time;
   no file); and, for the languages check (phase 2), four more short English replies ("Sure.", "What?", "Alright.", "No.") and a
   sentence in Japanese and one in Chinese. `clips.json` lists each one's words, voice, language and length. They were made by
   Gemini TTS (`gemini-2.5-flash-preview-tts`, one call for each spoken part, 17 in all); later runs make no TTS calls. (The preview TTS refuses some short texts in some voices with "Model tried to generate text", a 400 that is not retried: "Okay." and "Alright." in Charon failed; "Alright." in Leda worked.)
2. **The microphone** is an injected `getUserMedia`: a stream from an AudioContext, where the harness plays the clips at chosen
   times over a constant room noise (-60 dBFS, brown). To annai it is a microphone: a live audio track with a name (the audio
   route annai reads is from that name: "iPhone Microphone" is the phone's speaker, "AirPods Pro" headphones), frames into its own
   capture worklet. The other way, Chromium's `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`, plays one
   file from the moment the stream opens, so it cannot speak after her answer, or on her cue, or mix her voice back in; and it
   gives no clock to compare against. The injected stream does all three, and tells the harness exactly when each clip played.
3. **The speaker** is tapped: everything the page plays is also heard by the harness (its loudness 50 times a second), so the time to
   first sound is measured at the speaker, not at the socket. In **echo mode** the tap is also mixed into the microphone at a chosen
   level and delay, as a phone's speaker is into its own microphone (the run measures the level it reached and says so). The phone's
   own echo canceller is not here: the echo is the raw speaker, which is harder than a phone.
4. **annai is set up through its screens**, as a user would: Add a provider, Google Gemini, the key typed into the field, the
   free-tier switch, a trip, Voice on, a tap on Shiori. By default Kokoro (the thinking half) is a stand-in on a local port (an
   Anthropic Messages server) that answers every question at once with one note, so the voice path is measured alone and a free
   key's chat 429s and 503s do not blur it; `--kokoro gemini` uses Gemini's chat model for Kokoro too ("Use the recommended
   models", Gemini Live first in Koe, or in Koe · Realtime where Koe has two lists), and then a note can take 30 to 80 s on a free key.
5. **The live socket is watched** by Playwright (frame kinds and sizes, transcripts; never the address, which holds the key), and
   **annai's own trace** is read from its IndexedDB (`live.turn`, `live.session`, `out.speak`, `heard`, errors) and merged with both
   into one timeline.

## Running it

From the repository root. A key: `GEMINI_KEY` (one key), or `--keys-file <path> --lines 1-11` (the lines of a file, tried in
order, the next one after a 429; a file is read only on the lines named, so name only free keys). It is read inside the process,
held in private fields, typed into the page, and checked out of every file and line the script writes; it is never printed.

```sh
# Once, to make the clips (they are committed, so skip this): 11 TTS calls; a free key allows about 3 a minute and 10 a day.
GEMINI_KEY="$(sed -n 1p /path/to/keys)" NODE_OPTIONS=--max-old-space-size=2048 timeout 900 node scripts/realtime-check.mjs clips

# The run, in Docker under a memory cap (the browser runs there, never on the host):
timeout 1500 docker run --rm --ipc=host --memory=6g \
  -v "$PWD":/work -v /path/to/main/node_modules:/path/to/main/node_modules:ro \
  -v /path/to/keys:/keys:ro -w /work \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  timeout 1400 node --max-old-space-size=2048 scripts/realtime-check.mjs run --keys-file /keys --lines 1-11
rm -f core.[0-9]*        # a browser crash dump, if one was left in the repository root
```

(In a worktree, `node_modules` is a symlink to the main checkout's: mount that folder at the same path, as the e2e command does.)

`run` writes under `.superpowers/evidence/realtime-harness/<time>/` (or `--out <dir>`, a path inside the container): per scenario
`<name>.timeline.txt` and `<name>.json`, and `report.txt` and `report.json`. Options: `--list` (the scenarios), `--only a,b`
(some of them), `--times <n>` (each scenario n times, one session each, its later records `<name>.2.json` and on: for a bar over more
lines than one run holds), `--kokoro stand-in|gemini`, `--room-db -60|off`, `--answer-timeout <s>` (default 40), `--max-sessions <n>` (default
10: the harness stops before a scenario that would pass it), `--ui <tag>` (annai's screens in that language, `ja` or `zh-Hans`: chosen in Settings → Shiori once annai is set up in English, and the setup note then says the instructions name the screens in it), `--app <folder>` (serve another build of annai, for a control run:
`git archive <commit> | tar -x -C <folder>` and mount it), `--port`. Exit status 0 when every scenario passes, 1 when one fails,
2 when the harness itself broke. `report <folder>` makes the reports and timelines of a finished run again from its records,
with no network, after the analysis changed.

### Memory and cost

- Node runs with `--max-old-space-size=2048` under an outer `timeout`; the container with `--memory=6g`. A run stayed near
  0.4 to 0.5 GB of the 6 (Chromium and the page; `docker stats`). Delete `core*` dumps after a run.
- **Cost: nothing, on free keys.** One scenario is one realtime session on the same key; a full run is ten sessions. With the stand-in
  Kokoro there is no other model call. With `--kokoro gemini` each question also costs a few chat calls, which a free key limits more
  tightly than Live (503s and a 20-a-day limit on one model were seen). A key out of quota (429) moves the same conversation to the
  next line, and that session counts too. The summary line says how many sessions the run used and on which key lines.
- Never use a paid key for this, or more than the ten sessions a run needs.

## The scenarios

| name | route | what it does |
|---|---|---|
| questions-a, questions-b | phone speaker | three, then four questions in a row, each after her answer (and Kokoro's note) is heard out |
| quick-yes | phone speaker | a question, then "yes" 150 ms after she stops |
| pause | phone speaker | a sentence with a 1.5 s thinking pause inside it, then a question |
| long | phone speaker | one question of about 13 s |
| silence | phone speaker | 22 s of a quiet room (nothing should be sent, nothing should fail), then a question |
| echo-quiet, echo-loud | phone speaker | two questions, her voice back into the microphone at -12 dB and at 0 dB, 60 ms late |
| barge-in | headphones | the user speaks over her answer: she should be cut, and the new question answered |
| talk-over | phone speaker | the same on the speaker, where annai hears nothing while she speaks, by design, and lets go of what was begun over her (no turn); then a question |
| echo-late (only by name) | phone speaker | two questions, her voice back at -6 dB, 400 ms late (a slow speaker, a car) |
| short-replies (only by name) | phone speaker | the languages setting English; a question, then five short replies ("Yes.", "Sure.", "What?", "Alright.", "No."), each after her answer: every answer should come back in English, and what Gemini heard should be English (the user, 2026-10-23: short replies were heard as "¿Qué?" and answered in Spanish) |
| relay-fact (only by name) | phone speaker | a question about annai and a general fact, neither of which Koe was told: read what she said; she should say "One moment." and call tell_kokoro, stating neither (the second drive) |
| relay-filler (only by name) | phone speaker | a question, then being told off for apologising: a scold clip: silence is right, and the check "no filler" fails on an apology, "I understand" or "I will…" in anything she says |
| relay-greet (only by name) | phone speaker | "Good morning, Shiori.", a question, then "What?" after her answer: the greeting gets a greeting, and "What?" gets her last words again (fix pass 1) |
| relay-stray (only by name) | phone speaker | the languages setting English and Japanese: a stray word in Korean and song lyrics, each should get no sound back (the check "strays left alone"); then a question |
| relay-unset-ja (only by name) | phone speaker | no languages set: a Japanese sentence, which the user may speak, is answered (in Japanese); the stay-silent rule must not catch it (fix pass 2) |
| relay-note (only by name) | phone speaker | a question, Kokoro's note, then the same note again once she has said it (the stand-in Kokoro repeats it): the first is said with nothing added, the second settled with already_told |
| multilingual (only by name) | phone speaker | the languages setting English, Chinese and Japanese; a Japanese sentence, a Chinese one and an English one, each after her answer: each should be answered in kind |

## One answer: Koe passes on, acknowledgements get nothing, a cut note is shown and heard once at most, a typed line gets one answer

These scenarios (by name only) hold Koe to its instructions where a drive got two answers, or the wrong half's: a line it should pass on was asked
about, refused or answered from its own head; a note cut as she said it was taken up from its middle (and, asked for again, said twice); a typed line was answered
by both halves; a reminder was said by both.
Their lines are new clips (Gemini TTS, made-up words: `do-all`, `carry-on`, `second-one`, `note-parking`, `plan-beach`, `app-dark`, `app-louder`,
`app-offline`, `app-new`, `stop`: "Stop.", and `stop-reminder`: "Stop the hotel reminder."), made on first use (a run that needs one not made yet stops at once and says the command), and a noise made here (`bump`: 0.8 s
of a voice-band tone as loud as the clips' speech, so it makes a turn that cuts her).

| name | route | what it does | it passes when |
|---|---|---|---|
| relay-pass | phone speaker | five requests Koe could ask the user about or say it can't do ("Let's do all three of them.", "Let's carry on in Kyoto.", "Take us to the second one instead.", "Add to my notes that we parked on level three.", "Change the plan so we go to the beach first."), each after her answer | **passed on**: for each line her `tell_kokoro`, and no question back (a "?" in what she said before Kokoro's note went in, or her own buttons, `ask`); **the bar: at least 9 of 10 lines**, over two runs (`--times 2`), in the report's head. *Passed on as said* (a warning): what the stand-in Kokoro was given keeps 80% of the line's words (against what Gemini heard or what the clip says) |
| relay-annai | phone speaker | five questions about annai Koe can't know ("Is there an auto GPS mode in this app?", "Is there a dark mode in this app?", "Can I make your voice louder in this app?", "Does this app still work without a signal?", "What changed in the latest version of this app?") | the same checks and **the same bar: at least 9 of 10**, over two runs; read what she said before the note: an answer of her own there is the failure the bar can't see. No line is about a reminder: Koe has the reminder tools by design, so its own `watch_list` and a spoken answer is not a miss there (relay-stop-request) |
| relay-ack | phone speaker | ten questions, each answered (Kokoro's note said), then "Sure." or "Alright.", and 8 s for a reply (Koe's own live answers came 2.6 to 5.8 s after the user's turn) | **acknowledgements left quiet**: no run of her sound from an acknowledgement's turn to the next question; **the bar: none in 20**, over two runs. An acknowledgement no turn was made of isn't counted |
| cut-note | headphones | a question; then, 100 ms after her voice begins Kokoro's note, the noise (Gemini writes its turn down as "¿Qué?", a "what?" that Koe's rule answers with its last words again) | **she is cut by the user** and **cut note heard once at most**: from the sound on, annai asks nothing again, shows the note once (its card for the words she didn't say, counted from the clip's start: annai shows it when it hears the sound, 62 to 157 ms before the provider's `interrupted` frame), and no more than one line of hers holds the note whole (more than a third of the note's own words: lines judged whole by hand kept 40% to 77% of them in 22 real runs, partial ones 27% at most). A run where the noise didn't cut her proves nothing, and says so |
| cut-note-stop | headphones | the same with "Stop." in place of the noise, then 25 s (were anything retried, a fresh session would come at about 8.5 s and live voice drop at about 16.5 s) | **she is cut by the user** and **stopped when told**: from the end of the "Stop." no line of hers longer than two words (a word like "Okay." is fine), no `tell_kokoro`, the note shown once (counted from the clip's start, as in cut-note), nothing asked again, and no fresh session, no `live-dropped`, no `live-silent` but a turn let go |
| real-cut-note | headphones | cut-note with Kokoro on Claude Opus 5.5: her own note, whatever she writes, and the noise 100 ms into it; 20 s after her answer | the same as cut-note: the note heard whole at most once, shown once, nothing asked again |
| relay-stop-request | phone speaker | "Stop the hotel reminder.": a request that begins with "stop", not an order to Koe to stop | **acted on it**: she passed it on (`tell_kokoro`), or did it with a tool of her own (Koe has the reminder tools by design) and said so. Silence fails (the stop clause swallowed it), and so do words with no act ("Okay.") and a tool with no word |
| typed-live | phone speaker | live voice, typed on the conversation's page: "Hello?", then "Add to my notes that we parked on level three.", each with 90 s after her answer for a late note (a note from Gemini's chat model on a free key took 30 to 80 s) | **one answer to each typed line**: her lines and what annai showed for her, from the line to the next: one for the greeting (Koe's), at most two for the request ("One moment." and the result). With the stand-in Kokoro it checks only the voice path; run it with `--kokoro gemini --answer-timeout 90`, where Kokoro is a real model |
| real-typed-live | phone speaker | the same with Kokoro on Claude Opus 5.5 (`ANNAI_LIVE_ANTHROPIC_KEY`, or `--anthropic-key <file>`'s first line; held to 30 requests, as the card's real runs) | the same |
| real-typed-plan | phone speaker | Kokoro on Opus 5.5, a trip seeded with three plan items from now on, typed "What's next on my plan?" | **one answer to each typed line**: at most two lines of hers |
| real-reminder-live | phone speaker | Kokoro on Opus 5.5, a stored reminder (a time watch, "Check in at the hotel desk.") due 28 s into the session, then 60 s | **reminder said once**: one line of hers or annai's own voice holds it, not two |

The bars are over lines, so a run of five lines is short of one: `--times 2`, and the report's head gives each scenario's count against its bar
("relay-pass: passed on, no question back, 9 of 10 lines in 2 runs (the bar: at least 9 of 10) MET"). A run's own verdict holds each run to every line.

```sh
# Once, the nine clips (9 TTS calls: a free key allows about 10 a day; a 429 moves to the next line):
NODE_OPTIONS=--max-old-space-size=2048 timeout 900 node scripts/realtime-check.mjs clips --keys-file /path/to/keys --lines 1-11 \
  --only do-all,carry-on,second-one,note-parking,plan-beach,app-dark,app-louder,app-offline,app-new
# And the two cut-note-stop and relay-stop-request need (2 TTS calls):
NODE_OPTIONS=--max-old-space-size=2048 timeout 900 node scripts/realtime-check.mjs clips --keys-file /path/to/keys --lines 1-11 --only stop,stop-reminder

# The bars, with the stand-in Kokoro: six sessions, about 20 minutes.
timeout 2700 docker run --rm --ipc=host --memory=6g \
  -v "$PWD":/work -v /path/to/main/node_modules:/path/to/main/node_modules:ro -v /path/to/keys:/keys:ro -w /work \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  timeout 2600 node --max-old-space-size=2048 scripts/realtime-check.mjs run --keys-file /keys --lines 1-11 --only relay-pass,relay-annai,relay-ack --times 2

# The cut note (three sessions each), and a typed line with a real Kokoro: Gemini's chat model, or Opus with the Anthropic key's file mounted too,
# or with the key in ANNAI_LIVE_ANTHROPIC_KEY (it wins over the file; set it from the file, never typed on the command line or printed):
#   ANNAI_LIVE_ANTHROPIC_KEY="$(sed -n 1p /path/to/anthropic-key)" timeout 2700 docker run --rm -e ANNAI_LIVE_ANTHROPIC_KEY ... --only real-typed-live
...  scripts/realtime-check.mjs run --keys-file /keys --lines 1-11 --only cut-note,cut-note-stop --times 3
...  scripts/realtime-check.mjs run --keys-file /keys --lines 1-11 --only relay-stop-request --times 3
...  scripts/realtime-check.mjs run --keys-file /keys --lines 1-11 --only typed-live --kokoro gemini --answer-timeout 90
...  scripts/realtime-check.mjs run --keys-file /keys --lines 1-11 --only real-typed-live,real-typed-plan,real-reminder-live,real-cut-note --anthropic-key /anthropic-key
```

`report <folder>` reads a run again with no network, the bars included.

## Stage 5's card (read_trip): the spoken yes, with real speech

Before Shiori reads another of the user's trips, annai shows its own card ("Read Testville, Nov 10 – 17?": Allow / Always for my trips / Not now) and says the
question; a tap, or a spoken yes in annai's word list (`spoken-yes.js`), answers it. These scenarios (by name only; `node scripts/realtime-check.mjs run --list`)
put real speech to it:

- **The setup** is a user's: Kokoro is the stand-in (a local Anthropic Messages server) that answers a question naming Testville with a `read_trip` call for that
  trip, and a result with one line (what it read, or that it was not allowed), so the voice path is measured alone; Testville is a trip dated this week, the
  conversation Koe talks in is a chat (Big Sur), Always is off; annai's question is said by a stand-in voice (a Custom provider's Voice, first in Speech out) whose
  clip plays through the page, so the harness hears it (the page's `<audio>` element is routed through the tapped context: `rt.media` logs its playing and ending)
  and can mix it back as echo. The question's end is the end of that player.
- **Koe talking** (`card-yes`, `card-sure`, `card-hai`, `card-hao`, `card-yes-but`, `card-no-thanks`, `card-yes-nowait`, `card-no-yes`, `card-yes-q`, `card-hai-q`,
  `card-mm-q`, `card-what`, `card-passenger`, `card-lyric`, `card-late-18`, `card-late-22`, `card-tap-settling`, `card-tap-not-now`, `card-over`,
  `card-over-headphones`, `card-echo-loud`, `card-echo-quiet`, `card-echo-yes`, `card-echo-car`, `card-echo-car-yes`, and the `-ja` and `-zh` ones, which set Languages
  first). The user's line is `tomorrow.wav` ("What's on tomorrow in Testville?"); each scenario then answers the card. `expect` in scenarios.mjs says what the rule
  gives; the report says what happened (`granted-voice`, `granted-tap`, `unanswered`, `not-now`, `none`: still waiting), the times from the end of the user's last
  clip, what Gemini wrote for it, what Koe said meanwhile, and what Shiori was given.
- **Classic voice** (`classic-*`, with `--asr <origin>`): no Koe; Speech in is a Local speech server whose address is the stand-in's `/asr` (annai calls only https
  addresses, or http on this device, so a server on the network is reached through the stand-in, which passes on transcription requests and nothing else, one at
  a time, and logs the words that came back); the gate is Gemini 3.5 Flash Lite (adding Gemini puts it in Quick decision).
- **A real Kokoro** (`real-yes`, `real-yes-but`, `real-no-thanks`, with `--anthropic-key <file>` or `ANNAI_LIVE_ANTHROPIC_KEY`): Claude Opus 5.5 through the Anthropic provider (Haiku 5.5 as utility),
  Koe on Gemini Live. The key is read inside the process and typed into annai's own field; a scenario is held to 30 requests to api.anthropic.com (the 31st is
  refused), and the report gives annai's own count of tokens and an estimated cost.
- **Lateness** (`lines-en`, `lines-ja`, `lines-zh`, and every other run): `node scripts/realtime-check.mjs lateness <run folders>` reads the records and reports, by
  language, when annai wrote each line Koe heard (`heard`), each later revision (`heard.text`), the socket's own transcription chunks, and the end of the clip.
  `cards <run folders>` makes one table of the card runs, a row a scenario.

New clips (Gemini TTS, synthetic voices, made-up lines): `tomorrow`, `favour`, `yes-but`, `no-wait`, `no-thanks`, `yes-q`, `hai`, `hai-q`, `hao`, `mm-q`, `passenger`, `ask-q`.
The preview TTS refuses a two-character text (it answers with text), so `hao` and `mm-q` are said with a second sentence and cut at the pause (`first: true`).

## What the report says, and when it passes

For each scenario: each clip, with its turns (how long each sent, why it ended: `pause`, `cap`, `transcript`, `close`, `voice`,
`noise`), how long after the user stopped the turn ended, how long until her first audio frame and until sound at the speaker, the
tools she called first, what Gemini heard (with the share of the words), and what she said; then her cuts, the checks and notes.

A scenario **passes** when:
1. **answered**: every question gets audio back (a question begun over her voice, on the speaker, is not expected to: annai is deaf then, by design, lets go of all of it, and the report says so; the run then waits only for quiet before the next clip);
2. **no echo cut**: no turn began that nobody made while she sounded (her own echo), none began in silence, and no cut of hers followed one;
3. **turn ends in time**: each turn ended within 2 s of the user stopping;
4. **no errors**: no `error` entry in the trace, no socket closed with a kind annai did not ask for, no console error once she is listening
   (a silent session the watchdog rescued, by the ask again or a fresh session, with her answer after it and before the next clip, is a
   note, "rescued", not an error: the user was answered, late; a second silence in a row stays an error; and a turn the session let go,
   nothing at all back, is a note, "let go": the model chose, which is right for an acknowledgement or a stray, and a question left so fails "answered");
5. barge-in only: **she is cut by the user**.

**Language kept** (a check of the two languages scenarios only): the scenario sets the languages setting through Settings → Languages (Settings → Shiori on a build before phone-fixes-1) (the browser's English is the list's first; the others are added; a language is picked in the list and committed with Add; a list of English alone is made the user's own by adding a language and removing it again, since the browser's language by itself is only a default and no model is given it as a hint; a build with no such section is left alone and the report says "NOT applied"), and every answer must be in the language its clip was spoken in. Her words are read by their script (kana: Japanese; Chinese characters: Chinese) or by the commonest small words of English, Spanish, French, German, Italian, Portuguese and Dutch, and by a Spanish ¿ ¡ ñ or a Vietnamese vowel; an answer too short to place passes, and one German or Italian answer of a few words may not be placed. The two scenarios are only by name (`--only short-replies,multilingual`), one session each. A note names each transcript Gemini wrote in another language ("Gemini heard "¿Qué?" for "Sure." (Spanish)"), the setup's language hints (`languageCodes ...`, and whether the instructions have a Languages section; never the instructions), and each `heard` line annai flagged as stray (`strayLanguage`: a transcript of fewer than 3 words in a language not listed).

A last check, **whole sentences heard**, is a *warning* (`WARN`, "PASS (2 warnings)"): it fails when a question's turns carried less than
three quarters of its sound or Gemini's transcript has less than 60% of its words. It is what a sentence cut at a thinking pause longer
than annai waits for (her voice waits 1.2 s after the turn's end for the user to go on), or a question's tail sent alone, shows; it does
not fail the scenario, and it is for people to read.

The notes are for people too: a transcript that is not what was said, a first sound later than 3 s, every card annai showed once she
was listening ("card: Tap Shiori to talk over her" in a scenario where nobody talked over her is a misfire), and, in echo mode, whether
her voice did reach the microphone at the level asked (a check that proves nothing if it did not).

Each scenario also leaves `<name>.timeline.txt` (the clips, both directions of the socket, where she sounded and annai's trace, in
time order from the session's open, with each user turn explained) and `<name>.json` (the record). That is the shape of
`.superpowers/evidence/voice-investigation/timeline.txt`, and where to look for a problem's trace lines.

## A control: the check can tell a broken build from a good one

Run against the build the iPhone trace of 2026-10-22 was taken on (`dd393c2`, before half-duplex), echo-loud **fails**: 28 turns and
cuts from her own echo in one session, and Gemini "hears" her words as the user's. On `a7134a5` it passes. Do this again after a change to
the detector or the half-duplex rules: `git archive dd393c2 | tar -x -C /tmp/old`, mount it at `/old`, `--only echo-loud --app /old`.
(An older build names Custom provider "Another address"; the setup accepts both.)

## When it breaks

- *"The microphone didn't start"*: the page's own words are in the report's notes. The harness's microphone is built in
  `scripts/realtime/page-mic.mjs`; a change to how annai opens its microphone or plays her voice (`src/plugins/voice-browser/`) is
  what to suspect first.
- *"Listening live" never shows*: the key (the closed session's `kind` in the trace), the quota (a 429 on every key), or
  the setup screens changed (the selectors are in `scripts/realtime/drive.mjs`, copied from the e2e tests' helpers). The report's
  notes hold the failing step.
- *Gemini's TTS gives 429*: its free tier is about 3 requests a minute and 10 a day for each key and model; the script moves to the next line.

## The classic gate

`node scripts/gate-check.mjs --keys-file <path> --lines 1-11 [--times 3] [--old <a gate.js>]` asks the gate's real small model (Gemini Flash Lite, on a free key) about synthetic lines shaped like what it got wrong on the second drive, and about clear chatter, through annai's own `gatePrompt`, `decide` and Gemini chat type. It needs no browser.
