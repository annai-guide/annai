# annai

**[annai.guide](https://annai.guide) — an AI guide for your trips.**

*annai* (案内) is Japanese for "guidance; showing someone around". It is an
open-source, local-first travel agent that runs entirely in your browser:
plan a trip before you go, get woken-up help while you travel, and keep the
memories afterwards.

> **Status:** milestones 1 to 4 are built: trips with
> versioned files, export and import (optionally encrypted), plugins, offline use and the trace;
> photos; removing trips; and models (endpoints from templates or Sign in with OpenRouter, roles
> with fallback, the Test button, and every request in the trace); and Shiori herself: the dock and
> her avatar, a conversation through her output tools, file, web and places tools that can each be
> switched off, personalities and memory, budgets, and housekeeping for long conversations. Shiori sees
> photos: request copies within each model's limits, closer looks at a part, repair when a model refuses a
> photo, and uploads to the provider where it can store files. And planning: bookings brought in from
> confirmations, Wallet passes, calendar files and shares, which you confirm; the Plan, day by day; and
> search and directions links. And voice: Shiori speaks (OpenAI-compatible voices, or the phone's own) and listens
> (recording with an end-of-sentence detector, a transcription model or the model itself, or phone dictation), with interruptions,
> a quick check that talk is meant for her, and Auto, On and Off. Not deployed yet. See [docs/vision.md](docs/vision.md) and the
> [design](docs/superpowers/specs/2026-10-15-annai-design.md).

## Plan and bookings

- Add confirmations to a trip: PDFs, Apple Wallet passes, screenshots, calendar files, or text shared from another app (Android). annai keeps the files; Shiori reads them and writes each booking as unverified.
- The Plan shows the trip day by day: ● fixed, ○ flexible, the distance between stops with directions, and "Check this" on every booking you haven't confirmed. "Add to calendar" saves the plan as an .ics file.
- Shiori researches and hands you search links for flights, hotels and cars. You book; annai never books for you.

## Voice

- Tap Shiori and talk. With voice on she answers aloud, sentence by sentence as she writes, then listens for your answer; tap her while she speaks to cut her off.
- Voices and transcription are lists you order in Settings → Models: OpenAI-compatible voices and transcription (OpenAI, Groq, local servers), "Send audio to the model" for models that take audio, phone dictation, and the browser's own voice.
- The voice chip on the dock: Auto (on in the car or with headphones), On or Off. What the microphone hears leaves the phone only when someone spoke, only to the entry you chose, and the sound is let go once written down unless you keep voice clips. Phone dictation and some browser voices are the browser's own services (Google's on Chrome, Apple's on Safari): Settings → Voice → Where your voice goes says where each entry sends it.

## Principles

- **Just a web page.** Installable to the Home Screen; no app store. Targets
  modern devices and browsers only.
- **Local-first.** Trips, files and memory live in your browser. The site
  serves the app and stores as little about you as possible: no accounts, no
  passwords.
- **Bring your own model.** You point annai at your own LLM API endpoint.
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
changes. CI fails when the stamp is stale; the Cloudflare Pages build command should be
`node scripts/stamp.mjs`, so the deployed `sw.js` is always current.

`docs/testing/device-checklist-m1.md`, `-m1b.md`, `-m1c.md` and `-m3.md` list what to verify by hand on real phones.

**Plugins.** [docs/plugins.md](docs/plugins.md) is the guide to writing one.
