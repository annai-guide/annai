# The realtime check: real Gemini Live, real speech, annai's own code

The unit tests and the e2e tests of live mode use stand-ins: a fake realtime server, a tone for a voice. They show that annai's code
does what it means to. They cannot show that Gemini Live, spoken to by a person, answers the way annai expects. This check can: it
opens annai in Chromium, in Docker, sets it up as a user would, feeds its microphone real speech (made once by Gemini's text-to-speech)
on a schedule, and records what happens: each turn's start and end and why it ended, the time to the first sound back, whether
she was cut, what Gemini heard, the silences and the errors.

It is **opt-in and never part of `npm run check` or CI**: it needs a Gemini key and the internet, and a full run takes about ten minutes.

## What it does

1. **The clips** (`test/fixtures/realtime/`, 16 kHz mono WAV, 1.1 MB in all, committed, no key in them): seven short travel
   questions, a quick "yes", a sentence with a 1.5 s thinking pause inside it, a long question (about 13 s), and silence (only time;
   no file). `clips.json` lists each one's words, voice and length. They were made by Gemini TTS (`gemini-2.5-flash-preview-tts`, one
   call for each spoken part, 11 in all); later runs make no TTS calls.
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
   models", Gemini Live first in Koe), and then a note can take 30 to 80 s on a free key.
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
(some of them), `--kokoro stand-in|gemini`, `--room-db -60|off`, `--answer-timeout <s>` (default 40), `--max-sessions <n>` (default
10: the harness stops before a scenario that would pass it), `--app <folder>` (serve another build of annai, for a control run:
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
| talk-over | phone speaker | the same on the speaker, where annai hears nothing while she speaks, by design; then a question |
| echo-late (only by name) | phone speaker | two questions, her voice back at -6 dB, 400 ms late (a slow speaker, a car) |

## What the report says, and when it passes

For each scenario: each clip, with its turns (how long each sent, why it ended: `pause`, `cap`, `transcript`, `close`, `voice`,
`noise`), how long after the user stopped the turn ended, how long until her first audio frame and until sound at the speaker, the
tools she called first, what Gemini heard (with the share of the words), and what she said; then her cuts, the checks and notes.

A scenario **passes** when:
1. **answered**: every question gets audio back (a question begun over her voice, on the speaker, is not expected to: annai is deaf then, by design, and the report says so);
2. **no echo cut**: no turn began that nobody made while she sounded (her own echo), none began in silence, and no cut of hers followed one;
3. **turn ends in time**: each turn ended within 2 s of the user stopping;
4. **no errors**: no `error` entry in the trace, no socket closed with a kind annai did not ask for, no console error once she is listening;
5. barge-in only: **she is cut by the user**.

A sixth check, **whole sentences heard**, is a *warning* (`WARN`, "PASS (2 warnings)"): it fails when a question's turns carried less than
three quarters of its sound or Gemini's transcript has less than 60% of its words. It is what a sentence cut at a thinking pause, or a
question begun over her voice, shows, and it does not fail the scenario because annai does that by design; it is for people to read.

The notes are for people too: a transcript that is not what was said, a first sound later than 3 s, and, in echo mode, whether her
voice did reach the microphone at the level asked (a check that proves nothing if it did not).

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
