# annai

**[annai.guide](https://annai.guide) — an AI guide for your trips.**

*annai* (案内) is Japanese for "guidance; showing someone around". It is an
open-source, local-first travel agent that runs entirely in your browser:
plan a trip before you go, get woken-up help while you travel, and keep the
memories afterwards.

> **Status:** idea / pre-design. Nothing to run yet. See [docs/vision.md](docs/vision.md).

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
npm run check      # type-check, unit tests, size budget
npm run e2e        # Playwright: Chromium as a Pixel 7, WebKit as an iPhone 15
```

`docs/testing/device-checklist-m1.md` lists what to verify by hand on real phones.
