# annai

**[annai.guide](https://annai.guide) — an AI guide for your trips.**

*annai* (案内) is Japanese for "guidance; showing someone around". It is an
open-source, local-first travel agent that runs entirely in your browser:
plan a trip before you go, get woken-up help while you travel, and keep the
memories afterwards.

> **Status:** milestones 1 to 4 are built: trips with
> versioned files, export and import (optionally encrypted), plugins, offline use and the trace;
> photos; removing trips; and models (providers such as OpenRouter, Anthropic or OpenAI, each one address and one key for its chat, transcription and voice, added from annai's searchable catalog or by Sign in with OpenRouter, through Chat Completions, Anthropic Messages and OpenAI Responses; roles
> with fallback, the Test button, and every request in the trace); and Shiori herself: the dock and
> her avatar, a conversation through her output tools, file, web and places tools that can each be
> switched off, personalities and memory, budgets, and housekeeping for long conversations. Shiori sees
> photos: request copies within each model's limits, closer looks at a part, repair when a model refuses a
> photo, and uploads to the provider where it can store files. And planning: bookings brought in from
> confirmations, Wallet passes, calendar files and shares, which you confirm; the Itinerary, day by day; and
> search and directions links. And voice: Shiori speaks (OpenAI-compatible voices, or the phone's own) and listens
> (recording with an end-of-sentence detector, a transcription model or the model itself, or phone dictation), with interruptions,
> a quick check that talk is meant for her, and voice on or off in one tap. And backups to GitHub, Forgejo or Gitea, S3-compatible storage and WebDAV
> (milestone 9). And live mode (milestone 5; its real-drive checklist is next): watches Shiori sets, the
> itinerary's own reminders (leave in time, arrived, running late, off plan), catch-up after the phone was locked, and reminders annai
> shows and says by itself when no model can be reached, tested by a simulated Big Sur drive; on the phone, GPS in live mode (called GPS on and off in the app), the GPS chip (the screen kept on as
> you choose, and where you are without GPS), and the top of today's itinerary and the Driving screen. And the offline pack: OpenStreetMap places, Wikipedia summaries and Wikivoyage guides along the itinerary, which Shiori's tools read first, kept up to date on Wi-Fi. And after the trip (milestone 7): stamps for the places you arrived at, shown on trip cards; a recap written by your utility model from the trip, which Shiori can tell aloud; a replay of the timeline and the route on a flat map; and Settings → Developer → Simulate a trip. And notifications (milestone 6; its device checklist is next): reminders reach a closed annai through a small push relay, encrypted on the phone, and opening one starts a catch-up. And extensions (milestone 8; its device checklist is next): skills, MCP servers and code plugins, installed from a file, an address or annai's catalog, and what plugins add to annai's screens. Not deployed yet. See [docs/vision.md](docs/vision.md) and the
> [design](docs/superpowers/specs/2026-10-15-annai-design.md).

## Models

- A server you run has a provider of its own: llama.cpp (also for Unsloth Studio and KoboldCpp), vLLM, SGLang, Ollama or LM Studio. Each knows its usual address, and its page says what the server needs to let annai in. llama.cpp's, vLLM's, SGLang's and Ollama's also switch thinking off for quick decisions; LM Studio doesn't document how, so give a model that thinks its Reasoning levels on its page. llama.cpp's, Ollama's and LM Studio's Fetch model list also reads the context the server gives a loaded model, and whether it reads images, so Shiori knows how long a conversation can get. annai reaches a server at `localhost` on the device it runs on; from a phone, the server needs an HTTPS address, such as Tailscale Serve or a tunnel puts in front of it.
- A server that never streams, such as an LLM router that sends each answer whole, works through Chat Completions or OpenAI Responses. annai sees nothing of an answer until all of it has come, so the wait for her first words must cover the whole answer: with voice on, Settings → Voice → Wait for her first words (15 seconds unless changed); otherwise the role's "Wait for the first words" in Settings → Models (30 seconds unless changed). Raise it if long answers stop with "No output started in time."
- Photos sent through OpenRouter are uploaded to your OpenRouter workspace once and then sent by id, which saves data on every later turn. annai deletes each 48 hours after its upload, the next time it starts, comes online or makes its daily check while open, so one can stay longer until then, or for good if annai can't reach OpenRouter as you remove it, or if Erase has more of them than its 10 seconds can delete ([docs/limitations.md](docs/limitations.md)). The switch on OpenRouter's page sends them in each request instead.

## Itinerary and bookings

- Add confirmations to a trip: PDFs, Apple Wallet passes, screenshots, calendar files, or text shared from another app (Android). annai keeps the files; Shiori reads them (or a model that can, for a model that can't; with the PDF pages plugin, a model that sees photos reads a PDF's first 10 pages) and writes each booking as unverified. A long share that stops partway (storage full) or a page closed while it adds can leave its files in two conversations, or kept twice (docs/limitations.md).
- The Itinerary shows the trip day by day: ● fixed and ○ flexible as Shiori's plan items say (a booking's own row, such as a check-out no plan item ends at, shows neither), a booked flight, train, ferry, bus or coach as its departure and its arrival, the distance between stops with directions, and "Check # details" on a booking with details Shiori isn't sure of (one saved before details were marked one by one, and not confirmed, has each detail it has marked). "Add to calendar" saves the plan as an .ics file.
- A flight, train, ferry, bus or coach the Itinerary can't split into its departure and its arrival (no arrival time, a plan item that ends the same day with no booking that has times, a ride on another kind of booking, or another plan item on the same booking) stays at the place it leaves from: the Itinerary counts the distance to the next stop from there ([docs/limitations.md](docs/limitations.md)).
- After a flight, train, ferry, bus or coach leaves, the Next line shows its "Arrive" until half an hour after it lands, and Driving's list of next stops drops its airport, station or port at the planned time, even when it is delayed ([docs/limitations.md](docs/limitations.md)).
- A booking's detail named like a line the details already show (a second confirmation code, another departure time) is kept for Shiori but not shown; a booking saved before 2026-11-17 keeps what the older annai wrote (a ferry, bus or coach saved as "other", a stay's check-in and check-out swapped when written as Arrival and Departure, a flight's arrival in its departure's time zone): tell Shiori the right kind or time ([docs/limitations.md](docs/limitations.md)).
- Shiori researches and hands you search links for flights, hotels and cars. You book; annai never books for you.
- A trip removed somewhere other than its own screen (in a second annai tab, say), when annai opened on Trips and only Trips came before it, leaves one more Trips behind Back before annai closes.

## Voice

- Tap Shiori and talk. With voice on she answers aloud, sentence by sentence as she writes, then listens for your answer; tap her while she speaks to cut her off.
- Before Shiori reads another of your trips, or takes you into one, annai asks with a card (Allow, Not now). With voice on it says the question aloud, and you answer it with a tap, in the car too: a spoken yes doesn't answer it (a spoken no still declines when a microphone hears it).
- Voices and transcription are lists you order in Settings → Models: the voices and transcription of the providers you add (OpenRouter, OpenAI, Groq, a local speech server, or another address), "Send audio to the model" for models that take audio, phone dictation, and the browser's own voice. A provider's speech models join behind the phone's own, so nothing that costs money comes first unless you move it up.
- The voice chip on the dock: one tap on or off, on by itself while driving with GPS on, and off when a drive ends or headphones disconnect. A tap on Shiori always turns voice on until that exchange ends. The Live chip beside it switches Koe's live voice. What the microphone hears leaves the phone only when someone spoke, only to the entry you chose, and the sound is let go once written down unless you keep voice clips. Phone dictation and some browser voices are the browser's own services (Google's on Chrome, Apple's on Safari): Settings → Voice → Where your voice goes says where each entry sends it. To keep your voice on the phone, type with your keyboard's microphone key instead: iPhone and most Android keyboards can dictate on the phone itself.
- With two trips happening at once, only one reminds of its itinerary and location: the one you last talked in. The other's wait until you talk in it, and anything whose moment passes meanwhile doesn't come later. Time watches fire for both, and copies already at the relay still push. Answering a reminder of the one in play while the other is open puts your answer in the open one, and it becomes the one in play. A reminder already waiting at the relay for the other keeps its words if the language or the trip's name changes, and its time if a stop is added before a "leave soon" one, until you talk in it.
- A place, activity or "every" watch that Shiori set in the old conversation outside any trip, before every conversation belonged to a trip, no longer fires, and no screen lists or cancels it (its time reminders still do).
- annai can't tell one voice from another: a passenger talking near the phone counts as you, until Shiori's own judgement says otherwise (in live voice, music further away is told apart by how loud it is). In a loud room whose noise jumps, a voice session can send one short noise turn as it opens. Where annai doesn't hear while she speaks (the phone's speaker, a route it can't name, or headphones or the car with "Cut her off by speaking" off), a word begun in the quarter second before she speaks is talked over, as one said while she speaks is. In live voice Kokoro's notes go in one at a time, so a second waits until she has said the first (usually a few seconds); speaking in her pause after "Checking your notes." shows the note on a card, and she usually says it too; a note she says she already told is shown on a card as well. Those and the other known limits are in [docs/limitations.md](docs/limitations.md).

## After the trip

- Stamps: each place you arrived at on the itinerary, or a named place the offline pack knows, earns a station stamp, shown on the trip's card. They come from the trip's log; nothing extra is stored.
- Recap: your utility model writes `/trip/recap.md` from where you stayed and went (in words: never the GPS track itself), the stamps, what you and Shiori said, your notes and up to six photos. Shiori can tell it aloud.
- Replay: the trip's timeline, the route drawn on a flat map with no map tiles, playback at a minute, ten minutes or an hour a second, a scrubber, and a day at a time.
- Settings → Developer → Simulate a trip: the Big Sur sample, an itinerary file, or a trip's recorded track, played through live mode and Shiori in a new trip of its own, so the replay and the recap can be tried before a real trip.

## Backups

- Back up everything automatically to a private GitHub repository, a private repository on a Forgejo or Gitea server (your own, or Codeberg), an S3-compatible bucket (AWS, Cloudflare R2, Backblaze B2 …) or a WebDAV folder: after changes or once a day, while annai is open (each place's page says which connections it uses and what waits for your OK). On GitHub, Forgejo and Gitea each backup is one commit of your files, and only what changed is uploaded; a bucket or a folder keeps each backup as one file, encrypted if you like.
- Restore any backup onto a new or wiped phone from Settings → Automatic backups.
- A newer backup from your other phone is never overwritten: annai pauses, and offers to import it as a copy.
- The sign-ins for those places (the GitHub or Forgejo token, the bucket's keys, the WebDAV password) stay on the device and are never in a backup. API keys go into a backup only when you choose, and only into an encrypted one.

## Notifications

- Turn on Settings → Notifications, and Shiori's reminders for a time, and the itinerary's "coming up" and "leave soon", reach you as notifications while annai is closed. Tapping one opens annai, and Shiori catches up.
- They go through a small relay, `push.annai.guide` (its code is in [`relay/`](relay/README.md), to run your own). annai encrypts each reminder on the phone and pads it to one size: the relay learns only the phone's push address, when each reminder is due and how many are waiting. Reminders about places (arriving, leaving, nearby) never leave the phone. The itinerary's "leave soon" reminder goes to the relay, with its time.
- With annai open on screen, annai says a reminder itself and the relay's copy is called off, so it never comes twice.
- With another app in front (a navigation app while driving), annai only sends its time reminders, as notifications: no position, place reminders or voice until it is back on screen. On an iPhone, Driving Focus silences them too (it has no list of allowed apps): they come with no sound or banner until it ends. Driving Focus can be set to turn on by itself or only by hand ([docs/limitations.md](docs/limitations.md)).
- If the phone's storage fails to read and annai closes right after, an edit to a stop in any trip can miss its call-off, so the old words arrive until annai next opens, and a reminder you just set may not reach the relay, so it doesn't arrive while annai is closed. While reads are still failing, a stop deleted or changed just before can be said once, at its old time and in its old words. If annai's settings can't be read as it starts, Live starts with GPS off until a reload.
- "Leave soon" counts the drive from your position, or while annai is closed from where annai last saw you; with no position (GPS off), from the itinerary's stop before, or it comes half an hour before. "Running late" comes only while annai is on screen with your position. Either can be early, late or missing (after a train or bus into a flight, or more than 1000 km away): see [docs/limitations.md](docs/limitations.md).
- With no position, a check-in timed before you can get there makes the reminders after it early or late (time it for when you arrive), and a flight right after a flight says "Leave soon" as the first lands, even at a layover ([docs/limitations.md](docs/limitations.md)).

## Skills, MCP servers and plugins

- **One catalog:** everything you can add, from model providers and voices to backup places, tools and skills, is on one Add screen: annai's own catalog and what you have installed, searched by name, other names ("lmstudio" finds LM Studio, then llama.cpp, "Also for: LM Studio") and what it does ("free voice"), or browsed by kind with filters. Models → Add a provider opens it on model providers, a speech role's on what has transcription or a voice, and Settings → Plugins → Add on everything. Settings → Plugins searches and filters what is installed the same way.
- **Skills** in the open [Agent Skills](https://agentskills.io/specification) format teach Shiori a kind of situation: install one from a zip, a `SKILL.md` file or its address, at the foot of the Add screen. Only its name and description sit in her context until she loads it; annai never runs anything in it. annai's own skills (`skills/`) are in the same format.
- **MCP servers** give Shiori tools of their own: Settings → Tools → MCP servers takes a name, the server's address and a bearer token or headers, which stay on this device. Each tool can be switched off, and every request to the server is in the trace. The server must let web apps call it (CORS). For testing, `node scripts/mcp-stand-in.mjs --port <port>` runs annai's own stand-in server.
- **Code plugins** run with full access to your trips and keys, and the install screen says so. They can add tools, endpoint types, backup places, status chips, sections of today's itinerary, dock actions, trip tabs, settings pages, card types, screens and themes ([docs/plugins.md](docs/plugins.md)).
- **Model providers** are plugins too, usually data only: a description of the provider's address, abilities and models, and the protocol plugins it requires, which come with it. Data-only plugins can't run anything, so they get no full-access warning; their install screen says where keys go.
- Adding a provider or a plugin from annai's catalog stops with "couldn't be downloaded" after 20 seconds with nothing from annai's site, also on a connection that only stalls; tapping again goes on ([docs/limitations.md](docs/limitations.md)).
- A package installed from an address is checked there for updates, which change nothing until you tap Update; one that would bring new code or skills says so first. Getting a package from an address, its Update and its check stop with "… stopped answering" once its site has sent nothing for 20 seconds, and the updates and checks after it go on. Removing a plugin, skill or server removes everything it stored.

## Languages

- annai's screens are in English, Japanese, Chinese (Simplified) and Chinese (Traditional, with Taiwan's words), as your phone is set unless you choose one in Settings → Languages. Distances, beside it, are kilometres or miles by your phone's region unless you choose.
- Shiori answers in the language you speak to her, among those you list there, whatever the screens are in.
- The summary of a long conversation and a trip's recap come in the language most of your lines are in, among those you list (with none listed, your phone's and any your lines plainly show). A line counts for the language its writing shows: kana Japanese, a character only Chinese writes Chinese, Latin letters the one language you list that is written in them (with several listed in them, the one its small words name); a place's name in kanji alone counts with the Japanese or Chinese lines around it, and with none around it is the first of your languages written in Han. With two languages listed in the same letters and no small words for one of them (Turkish beside English, say), a line in either counts for neither: see [docs/limitations.md](docs/limitations.md).
- To translate, or to correct a translation: [docs/translating.md](docs/translating.md).

## Principles

- **Just a web page.** Installable to the Home Screen; no app store. Targets
  modern devices and browsers only.
- **Local-first.** Trips, files and memory live in your browser. The site
  serves the app and stores as little about you as possible: no accounts, no
  passwords.
- **Bring your own model.** You add the providers you have keys for, or point annai at your own server.
- **A trip is a project,** the way a repo is a project to a coding agent.
- **Your data is portable.** Export a trip or everything to an archive and
  import it on another device.

## Domains

- `annai.guide`: the only canonical domain; the app is hosted here.
- `anai.guide`: a 301 redirect to `annai.guide` and nothing else. Never show it
  as the name: in small type it reads as "anal".

## License

[AGPL-3.0](LICENSE). annai is a hosted web app, so anyone who serves a
modified version must publish their source too.

## Develop

annai has no build step and no runtime dependencies. Node 26 runs the tools.

```bash
npm install
npx playwright install chromium webkit
npm run serve      # http://127.0.0.1:8790 with the production CSP
npm run check      # type-check, unit tests, size budget, sw.js stamp
npm run e2e        # Playwright: Chromium as a Pixel 7, WebKit as an iPhone 15
npm run stamp      # after changing any shipped file: re-stamps sw.js and shell.json
```

On Linux without WebKit's system libraries, run the browser tests in Playwright's image
(its tag must match `@playwright/test` in package.json):

```bash
docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test
```

The photos in `test/fixtures/photos/` are built by `node scripts/make-photo-fixtures.mjs`, which needs
ImageMagick 7 with HEIC and WebP support. They're committed; rebuild them only to change them.

**Deploying.** `sw.js` names its offline cache after a hash of every file it ships and of
`_headers` (`BUILD`, written by `npm run stamp`), so installed copies update whenever anything
changes. Beside it, `shell.json` holds each of those files' hash, so an update downloads only the
files that changed and copies the rest from the version before. annai looks for a new `sw.js` when it starts, when it comes back to the screen (at most
every 15 minutes) and on Settings → Updates → Check now; the new version runs from the next start,
or at once with Restart now. CI fails when the stamp is stale; the Cloudflare Pages build command should be
`node scripts/stamp.mjs`, so the deployed `sw.js` and `shell.json` are always current.

While annai is being tested, annai.guide is served from a machine of the author's: a release
(`scripts/release.sh [commit]`) is `git archive <commit>` unpacked into a folder of its own, with a brotli
form of each text file annai fetches written beside it (`node scripts/build-release.mjs <dir>`),
served by `node scripts/serve.mjs --port <port>` (which sends `x.br` when the browser takes brotli, and
applies the `_headers` rules as Cloudflare Pages does: a header two rules set is joined, and `! Name`
detaches one) behind an HTTPS reverse proxy, and a `current` link is switched
to it. The push relay runs there too, as [relay/README.md](relay/README.md) describes.

`docs/testing/device-checklist-*.md`, one for each milestone, list what to verify by hand on real phones.

**Plugins.** [docs/plugins.md](docs/plugins.md) is the guide to writing one.

**Reasons.** [docs/superpowers/specs/2026-11-06-reasons-from-comments.md](docs/superpowers/specs/2026-11-06-reasons-from-comments.md) holds the longer reasons behind a few lines of code comments.
