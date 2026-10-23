# Vision

The original brief for annai, organized but not yet designed. Nothing here is
a technical decision; it is the input to the design phase.

## What it is

A web-page agent harness that acts as a personal tour guide. It runs on the
user's smartphone first, as a fully featured app delivered as a web page so
people can load it instantly and skip app-store approval.

- Uses as many local (on-device, in-browser) resources as possible.
- Persistent: data is stored in the browser.
- Open source.
- The user supplies their own LLM API endpoint(s).
- Targets only modern, capable devices and browsers.
- Needs as little user interaction as possible for the agent to be useful.

## Core model

- **A trip is a project**, in the coding-agent sense. Each trip holds:
  transcripts; whatever the agent decides to store or writes intentionally;
  files and photos the user ingested; extracted booking records.
- **Memory** at two levels: per-trip, and global (e.g. user preferences that
  carry across trips).
- **User profile**: what the agent should call the user, preferences, etc. No
  username/password credentials.
- **Tools**: the agent acts through tool calls: interacting with the
  application and its storage, running searches, and so on.
- **Automation**: the agent can set up hooks, background tasks and
  notifications.

## Before the trip: planning

Request-driven: the user interacts, the agent runs its loop.

1. Collect the user's information.
2. Plan in order, roughly: getting there (flights etc.) → getting around
   (car rental or other options) → lodging → and so on.
3. **Import existing bookings**: the user imports files or images of bookings
   they already have; the agent extracts the information and keeps it on
   record.

## During the trip: GPS on (live mode)

While the user keeps the app open, a mode loops automatically. The agent is
woken by triggers and then analyses the current situation and responds.

- **Triggers**: time passing, GPS location change, arriving at a place, or
  other triggers firing.
- **Outputs**: insights about the location, reminders of what to do, live
  replanning (missed something, stayed too long, change of plan, …),
  suggestions for next actions.
- **Manual wake**: the user can wake the agent with text, images (photos), and
  ideally voice.

## After the trip

- Summarize memories and recap the trip.
- Export the trip as an archive.
- Replay the trip.

## Data and hosting

- The website only serves the application and keeps minimal user information.
- Almost everything is stored in the user's browser.
- Export and import of all data, so a user can move to another device (e.g.
  from phone to computer).

## Decisions from brainstorming (2026-10-15)

- **Audience:** public, global and free to use; not marketed yet. The author's
  own trips are the test bed, not the spec. Thanksgiving 2026 is the first
  real trip.
- **Platforms:** iOS and Android are both required (both available for
  testing). A feature may be platform-exclusive only for a real platform
  limit, never for a convenience reason.
- **Main uses:** companion on trails and at photo spots; driving companion
  (planning, explaining, guiding, entertaining); companion in museums and
  other indoor places.
- **Driving:** must work hands-free and ideally eyes-free. annai does not
  replace navigation; it opens the user's maps app (or CarPlay / Android
  Auto) with links and stays on the phone screen.
- **Voice in and out:** preferred.
- **Models:** users add their own API endpoints and model configs. Endpoints
  that claim OpenAI/Anthropic compatibility still differ, so per-endpoint
  settings are needed. Ship templates that prefill known providers.
- **Responsibility model:** the agent is the user's own, like a coding agent.
  It does not go through our server. Provide powerful tools, including
  search and fetch-any-URL. Content the user imports or fetches is the
  user's responsibility. Every built-in tool can be switched on or off, and
  every request the agent sends and everything it reads is traceable.
- **Personalities:** several presets, plus user-made ones; the agent (or a
  side agent) can generate or modify a personality. The default guide gets
  its own name.
- **Sharing:** only by exporting/importing archives (one trip or all data).
  No permanent user data on our server. Importing must be easy enough that a
  recipient can open the archive and continue, recap or review the trip.
  Remote backup/sync targets (git, WebDAV, S3, Google Drive, iCloud, SFTP …)
  are to be designed with storage.
- **Relay:** we run an official relay for **push notifications only** (waking
  a closed app). No official fetch or protocol relay. Fetch works through a
  chain (direct → reader service → the model provider's own fetch/search
  tools). A self-hostable fetch relay is added only if real use shows gaps.
- **Plugins, layered:** skills (Markdown, no code), MCP servers (remote
  tools), and full-trust code plugins. The built-in features register
  through the same interface.
- **On-device models:** out of scope for now; later as plugins (Chrome's
  built-in model, WebGPU models).
- **Model onboarding:** "Sign in with OpenRouter" is the default path for the
  public. Templates for other common providers serve savvy users. Templates
  are served from annai.guide and refresh when online, so provider changes
  and new providers reach users without an app update.
- **Interaction principle:** as painless as possible everywhere: glance, tap
  or talk; no walls of text; never block the user. Driving barely changes
  the UI: speech output and follow-up listening default on. Passengers often
  operate the phone.
- **Museums and indoors:** camera-first. The user snaps a photo in annai;
  Shiori works out what they want to know and explains it the right way.
- **Speech output is essentially required:** the browser's built-in voice,
  plus user-configured voice APIs.
- **Replanning embraces spontaneity:** detours, rest stops and going
  off-plan on a whim are welcome. Shiori keeps the user from getting lost,
  protects fixed commitments, and helps them enjoy each unplanned choice.
- **Default guide name:** Shiori (しおり): a Japanese trip booklet, and
  originally a trail marker of snapped twigs.
- **Voice conversation loop:** Shiori narrates on her own when the context
  calls for it (landscape, culture, stories, history), tailored to the
  group's interests, preferences, personality and mood. The agent loop
  works like a coding agent's: after tool calls it continues by default, and
  it ends only when she calls no tool (the convention) or calls an explicit
  `sleep` tool. `sleep` can go in the same response as `speak`/`show`, so
  "reply and go to sleep" costs no extra model call. `speak` needs no
  "expecting a reply" flag: it plays her speech and then listens, and its
  tool result is what was heard (or where she was interrupted, plus what was
  heard). That result is the follow-up call, so one always happens unless
  she chose to sleep. A `wait` tool keeps listening a while longer. A local
  end-of-sentence gate only cuts the audio; it never decides to stop.
  Recording does not stop while a model call runs. Sleeping means the
  microphone is off.
- **Interruptions:** when the user cuts Shiori off, the point where she was
  interrupted is recorded and sent to the model, so it knows what she
  actually said and what she didn't.
- **Model roles:** besides the main model, users can configure a utility
  model (subagent-style simpler tasks) and optionally a fast "quick
  decision" model (e.g. "is this meant for me?"). Optional, not required;
  an unset role falls back to the main model. The quick-decision role is
  "choose one of these options, with probabilities", so a chat model can
  fill it, and so can a dedicated decision model such as TypeSafe's Jev
  (returns calibrated probabilities over predefined outputs, 70–500 ms; early
  access) as a possible plugin.
- **One mainline path:** the core assumes a main model with tool calling and
  image input; most 2026 models have both. Workarounds for weaker models
  (e.g. a helper model that describes images) are possible later plugins,
  not mainline. Whether to use on-device dictation or send audio to a model
  depends on configured capabilities.
- **What the user sees vs. Shiori's inner work:** Shiori addresses the user
  only by calling output tools (speak, show a short bubble/card). Everything
  else (what she heard, read and did, her notes and tool calls) is her
  internal transcript: hidden by default, visible in the trace. The screen
  stays short; spoken content isn't shown as text unless asked for.
- **Avatar:** a light on-screen avatar shows Shiori's state: sleeping,
  listening, thinking, speaking, working in the background, housekeeping
  (e.g. compacting memory). By default it's a small set of images or
  animated images, one per state.
- **Shiori's look (2026-10-15):** a white fox (白狐, Inari's messenger)
  with a vermilion scarf, wearing her 枝折り as a hairpin: a twig with a
  strip of pink trail tape tied on. Eyes only. No tail beside the face. The
  app accent is vermilion. Her **gaze carries the state**: facing you = ready
  for you (listening, talking, waiting for your answer); looking away =
  working out a reply; stepped out with her trail marker left in her seat =
  working in the background; eyes closed = asleep, mic off. A glow around
  her seat follows real sound levels. She moves on events and transitions
  (random blinks, glancing at new content), not on fast loops; the only loop
  is slow breathing while asleep. Exactly one Shiori per screen, in the dock
  at the bottom.
- **Timeline:** the whole app is expected to be built before November, so
  no phased cut for Thanksgiving. Official plugins come after that.

## Known constraint: browser storage can be evicted

Safari on iOS deletes a site's script-writable storage after about 7 days of
Safari use without visiting that site, unless the site has been added to the
Home Screen. Any browser may also evict data under storage pressure. Trips are
planned weeks ahead, so this would silently lose data.

Decided:

- Prompt the user to install annai to the Home Screen (PWA).
- When not running as an installed PWA, warn clearly that data can be lost
  forever.
- Request persistent storage from the browser.
- Make export/backup easy to do often.
