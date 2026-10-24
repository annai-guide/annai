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
> confirmations, Wallet passes, calendar files and shares, which you confirm; the Plan, day by day; and
> search and directions links. And voice: Shiori speaks (OpenAI-compatible voices, or the phone's own) and listens
> (recording with an end-of-sentence detector, a transcription model or the model itself, or phone dictation), with interruptions,
> a quick check that talk is meant for her, and Auto, On and Off. And backups to GitHub, Forgejo or Gitea, S3-compatible storage and WebDAV
> (milestone 9). And live mode (milestone 5; its real-drive checklist is next): watches Shiori sets, the
> plan's own reminders (leave in time, arrived, running late, off plan), catch-up after the phone was locked, and reminders annai
> shows and says by itself when no model can be reached, tested by a simulated Big Sur drive; on the phone, GPS in live mode (called GPS on and off in the app), the GPS chip (the screen kept on as
> you choose, and where you are without GPS), and the Now and Driving screens. And the offline pack: OpenStreetMap places, Wikipedia summaries and Wikivoyage guides along the plan, which Shiori's tools read first, kept up to date on Wi-Fi. And after the trip (milestone 7): stamps for the places you arrived at, shown on trip cards; a recap written by your utility model from the trip, which Shiori can tell aloud; a replay of the timeline and the route on a flat map; and Settings → Developer → Simulate a trip. And notifications (milestone 6; its device checklist is next): reminders reach a closed annai through a small push relay, encrypted on the phone, and opening one starts a catch-up. And extensions (milestone 8; its device checklist is next): skills, MCP servers and code plugins, installed from a file, an address or annai's catalog, and what plugins add to annai's screens. Not deployed yet. See [docs/vision.md](docs/vision.md) and the
> [design](docs/superpowers/specs/2026-10-15-annai-design.md).

## Models

- A server you run has a provider of its own: llama.cpp (also for Unsloth Studio and KoboldCpp), vLLM, SGLang, Ollama or LM Studio. Each knows its usual address, and its page says what the server needs to let annai in. llama.cpp's, vLLM's, SGLang's and Ollama's also switch thinking off for quick decisions; LM Studio doesn't document how, so give a model that thinks its Reasoning levels on its page. llama.cpp's, Ollama's and LM Studio's Fetch model list also reads the context the server gives a loaded model, and whether it reads images, so Shiori knows how long a conversation can get. annai reaches a server at `localhost` on the device it runs on; from a phone, the server needs an HTTPS address, such as Tailscale Serve or a tunnel puts in front of it.
- A server that never streams, such as an LLM router that sends each answer whole, works through Chat Completions or OpenAI Responses. annai sees nothing of an answer until all of it has come, so the wait for her first words must cover the whole answer: with voice on, Settings → Voice → Wait for her first words (15 seconds unless changed); otherwise the role's "Wait for the first words" in Settings → Models (30 seconds unless changed). Raise it if long answers stop with "No output started in time."

## Plan and bookings

- Add confirmations to a trip: PDFs, Apple Wallet passes, screenshots, calendar files, or text shared from another app (Android). annai keeps the files; Shiori reads them and writes each booking as unverified.
- The Plan shows the trip day by day: ● fixed, ○ flexible, the distance between stops with directions, and "Check this" on every booking you haven't confirmed. "Add to calendar" saves the plan as an .ics file.
- Shiori researches and hands you search links for flights, hotels and cars. You book; annai never books for you.

## Voice

- Tap Shiori and talk. With voice on she answers aloud, sentence by sentence as she writes, then listens for your answer; tap her while she speaks to cut her off.
- Voices and transcription are lists you order in Settings → Models: the voices and transcription of the providers you add (OpenRouter, OpenAI, Groq, a local speech server, or another address), "Send audio to the model" for models that take audio, phone dictation, and the browser's own voice. A provider's speech models join behind the phone's own, so nothing that costs money comes first unless you move it up.
- The voice chip on the dock: Auto (on in the car or with headphones), On or Off. What the microphone hears leaves the phone only when someone spoke, only to the entry you chose, and the sound is let go once written down unless you keep voice clips. Phone dictation and some browser voices are the browser's own services (Google's on Chrome, Apple's on Safari): Settings → Voice → Where your voice goes says where each entry sends it. To keep your voice on the phone, type with your keyboard's microphone key instead: iPhone and most Android keyboards can dictate on the phone itself.

## After the trip

- Stamps: each place you arrived at on the plan, or a named place the offline pack knows, earns a station stamp, shown on the trip's card. They come from the trip's log; nothing extra is stored.
- Recap: your utility model writes `/trip/recap.md` from where you stayed and went (in words: never the GPS track itself), the stamps, what you and Shiori said, your notes and up to six photos. Shiori can tell it aloud.
- Replay: the trip's timeline, the route drawn on a flat map with no map tiles, playback at a minute, ten minutes or an hour a second, a scrubber, and a day at a time.
- Settings → Developer → Simulate a trip: the Big Sur sample, an itinerary file, or a trip's recorded track, played through live mode and Shiori in a new trip of its own, so the replay and the recap can be tried before a real trip.

## Backups

- Back up everything automatically to a private GitHub repository, a private repository on a Forgejo or Gitea server (your own, or Codeberg), an S3-compatible bucket (AWS, Cloudflare R2, Backblaze B2 …) or a WebDAV folder: after changes or once a day, on Wi-Fi, while annai is open. On GitHub, Forgejo and Gitea each backup is one commit of your files, and only what changed is uploaded; a bucket or a folder keeps each backup as one file, encrypted if you like.
- Restore any backup onto a new or wiped phone from Settings → Automatic backups.
- A newer backup from your other phone is never overwritten: annai pauses, and offers to import it as a copy.
- The sign-ins for those places (the GitHub or Forgejo token, the bucket's keys, the WebDAV password) stay on the device and are never in a backup. API keys go into a backup only when you choose, and only into an encrypted one.

## Notifications

- Turn on Settings → Notifications, and Shiori's reminders for a time, and the plan's "coming up" and "leave soon", reach you as notifications while annai is closed. Tapping one opens annai, and Shiori catches up.
- They go through a small relay, `push.annai.guide` (its code is in [`relay/`](relay/README.md), to run your own). annai encrypts each reminder on the phone and pads it to one size: the relay learns only the phone's push address, when each reminder is due and how many are waiting. Reminders about places never leave the phone.
- With annai open on screen, annai says a reminder itself and the relay's copy is called off, so it never comes twice.

## Skills, MCP servers and plugins

- **One catalog:** everything you can add, from model providers and voices to backup places, tools and skills, is on one Add screen: annai's own catalog and what you have installed, searched by name, other names ("lmstudio" finds LM Studio, then llama.cpp, "Also for: LM Studio") and what it does ("free voice"), or browsed by kind with filters. Models → Add a provider opens it on model providers, a speech role's on what has transcription or a voice, and Settings → Plugins → Add on everything. Settings → Plugins searches and filters what is installed the same way.
- **Skills** in the open [Agent Skills](https://agentskills.io/specification) format teach Shiori a kind of situation: install one from a zip, a `SKILL.md` file or its address, at the foot of the Add screen. Only its name and description sit in her context until she loads it; annai never runs anything in it. annai's own skills (`skills/`) are in the same format.
- **MCP servers** give Shiori tools of their own: Settings → Tools → MCP servers takes a name, the server's address and a bearer token or headers, which stay on this device. Each tool can be switched off, and every request to the server is in the trace. The server must let web apps call it (CORS). For testing, `node scripts/mcp-stand-in.mjs --port <port>` runs annai's own stand-in server.
- **Code plugins** run with full access to your trips and keys, and the install screen says so. They can add tools, endpoint types, backup places, status chips, Now sections, dock actions, trip tabs, settings pages, card types, screens and themes ([docs/plugins.md](docs/plugins.md)).
- **Model providers** are plugins too, usually data only: a description of the provider's address, abilities and models, and the protocol plugins it requires, which come with it. Data-only plugins can't run anything, so they get no full-access warning; their install screen says where keys go.
- A package installed from an address is checked there for updates, which change nothing until you tap Update; one that would bring new code or skills says so first. Removing a plugin, skill or server removes everything it stored.

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
npm run stamp      # after changing any shipped file: re-stamps sw.js
```

On Linux without WebKit's system libraries, run the browser tests in Playwright's image
(its tag must match `@playwright/test` in package.json):

```bash
docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test
```

The photos in `test/fixtures/photos/` are built by `node scripts/make-photo-fixtures.mjs`, which needs
ImageMagick 7 with HEIC and WebP support. They're committed; rebuild them only to change them.

**Deploying.** `sw.js` names its offline cache after a hash of every file it ships
(`BUILD`, written by `npm run stamp`), so installed copies update whenever anything
changes. annai looks for a new `sw.js` when it starts, when it comes back to the screen (at most
every 15 minutes) and on Settings → Updates → Check now; the new version runs from the next start,
or at once with Restart now. CI fails when the stamp is stale; the Cloudflare Pages build command should be
`node scripts/stamp.mjs`, so the deployed `sw.js` is always current.

While annai is being tested, annai.guide is served from a machine of the author's: a release
(`scripts/release.sh [commit]`) is `git archive <commit>` unpacked into a folder of its own, with a brotli
and a gzip form of each text file annai fetches written beside it (`node scripts/build-release.mjs <dir>`),
served by `node scripts/serve.mjs --port <port>` (which sends `x.br` or `x.gz` when the browser takes it, and
applies the `_headers` rules as Cloudflare Pages does: a header two rules set is joined, and `! Name`
detaches one) behind an HTTPS reverse proxy, and a `current` link is switched
to it. The push relay runs there too, as [relay/README.md](relay/README.md) describes.

`docs/testing/device-checklist-*.md`, one for each milestone, list what to verify by hand on real phones.

**Plugins.** [docs/plugins.md](docs/plugins.md) is the guide to writing one.
