# annai: design spec

- **Date:** 2026-10-15
- **Status:** approved in conversation, section by section; this document is awaiting review
- **Inputs:** [docs/vision.md](../../vision.md) (the brief and recorded decisions), UI mockups (draft 6, copied to [docs/mockups/ui-mockups-2026-10-15.html](../../mockups/ui-mockups-2026-10-15.html))
- **Scope:** the whole application. Each build milestone in §20 gets its own implementation plan.

---

## 1. What annai is

annai (案内, "guidance; showing someone around") is a free, open-source (AGPL-3.0), local-first travel guide agent that runs entirely in the browser, installed to the phone's Home Screen. Its guide is **Shiori**. She helps plan a trip, wakes up during the trip when time passes or the user moves, and helps recap the trip afterwards. Everything is stored on the user's device, and the user brings their own AI model.

- **Audience:** the public, worldwide, free of charge. It isn't marketed yet. The author's trips are the test bed, starting with Thanksgiving 2026 (Nov 26).
- **Main uses:** a companion on trails and at photo spots; a driving companion (planning, explaining, guiding, entertaining); a companion in museums and other indoor places.
- **Platforms:** iOS (Safari) and Android (Chrome) are both required. Modern browsers only. A feature may be platform-exclusive only because of a real platform limit.

### Non-goals

- Booking through annai, or integrating booking APIs. Shiori researches; the user books and then imports the confirmation.
- Turn-by-turn navigation or a map engine. annai opens the user's maps app.
- Accounts, logins, or user data stored on our servers.
- Real-time multi-device sync. Sharing and backup work through archives (§12).
- On-device models in v1. These are future plugins: Chrome's built-in model, WebGPU models.

## 2. Principles

1. **Local-first.** Data lives in the browser. The site serves the app; the only server component is the optional push relay (§11.6), which stores only encrypted, expiring messages.
2. **The user's own agent.** Like a coding agent: powerful tools, including fetching any URL. What the user imports or fetches is their responsibility. Every tool can be switched off, and every request and everything read is traceable.
3. **Minimal working parts.** Use platform APIs and small modules we write ourselves. Runtime dependencies: zero. Dev-only tooling is a separate, lower bar.
4. **Glance, tap or talk; never read.** No walls of text, never block the user, big targets. Spoken content isn't shown as text unless asked.
5. **The plan is a suggestion.** Detours, rest stops and whims are welcome. Shiori protects fixed commitments and helps the user enjoy each unplanned choice. (Saigyō: 吉野山 去年の枝折の 道かへて まだ見ぬかたの 花をたづねむ.)
6. **Data safety over convenience.** Install to Home Screen, request persistent storage, back up often (§12, and §17 rule 1).

## 3. Architecture

The core is small, runs on the page's main thread, and everything else is a plugin, including our built-ins.

```
page (main thread)
 ├─ core: storage · event log · plugin registry · trigger scheduler · agent loop · context builder
 └─ plugins (built-in, official on-demand, and third-party; one interface)
     ├─ sensors:   clock, GPS, visibility, connectivity, mic, camera, wake lock
     ├─ tools:     files, talk, web, places, time, go, self, mcp.*
     ├─ providers: chat, speech-in, speech-out, search, fetch-reader, quick decision
     ├─ triggers:  time, every, enter, leave, dwell, arrived, moved, activity, plan
     ├─ schemas:   path pattern → JSON Schema (+ card renderer)
     ├─ ui:        slots, card types, components, screens, themes, avatar art
     └─ storage:   backup/export targets
service worker: offline app shell · serves installed plugin files at /plugins/<id>/ · push → notification
push relay (optional, separate service): sends scheduled, client-encrypted notifications
```

- **Why the main thread:** GPS, the microphone, speech, the camera and the wake lock exist only there. The agent loop mostly waits on the network. Heavy one-off work (zipping, image resizing) may use a Worker without changing the design.
- **The core never touches the DOM.** It is testable in Node and could move into a Worker later.
- **Rejected alternatives:** the agent in a Worker (it needs a message layer for every sensor, and gains no lifetime); a service-worker-centric design (killed when idle, no GPS or audio).

## 4. Storage

### 4.1 Stores

One IndexedDB database:

| Store | Key | Holds |
|---|---|---|
| `blobs` | SHA-256 of content | all content: text, JSON, photos, PDFs, fetched pages, model responses. Deduplicated. Every blob is named by a file or a log entry (§4.9). |
| `files` | `[scope, path]` | current state: path → blob hash, plus metadata: type, size, author (`user` · `shiori` · `plugin:<id>`), source, created, modified. Photos also keep when and where they were taken, and their pixel size (§4.8). |
| `events` | `[scope, seq]` | append-only log: seq, time, type, actor, small data, blob refs |
| `secrets` | id | API keys and tokens. Never in Shiori's view, never in the trace, excluded from exports unless the user explicitly includes them in an encrypted backup. |
| `scopes` | id | the trip list plus `me`: kind, title, dates, status, data-format version |

Not OPFS: one engine lets a file change and its log entry commit in **one transaction**.

### 4.2 Write path

Every write goes through one function:
1. Compute the SHA-256 fingerprint *before* opening the transaction. IndexedDB commits a transaction early if code awaits anything else inside it.
2. In one transaction: put the blob, point the path at it, and append `file.write {path, old, new, author}`.

The result is version history and undo of any change (including Shiori's) for free. Deleting is the same: the path is removed, and the history keeps the blob. Removing a whole trip is different: it frees the space (§4.9).

### 4.3 What Shiori sees

```
/trip/                 the active trip
  trip.json            title, dates, places, time zones, travel party
  plan/*.json          plan items
  bookings/*.json      extracted records; each links to its original
  files/…              imports, and photos as ingested (§4.8)
  notes/*.md           anything Shiori decides to keep
  memory.md            trip memory
/me/
  profile.md           what to call the user, language, units, preferences
  memory.md            global memory
  personalities/<name>.md
```

App settings (providers, plugins, tool switches, budgets) live outside this view, so Shiori can't change her own setup. Personalities are the deliberate exception (§14).

The top-level folder `/.annai` is reserved inside every scope; archives keep their metadata there.

### 4.4 Records

- Structured records are JSON files with a JSON Schema tied to their path. Plugins can register schemas for their own paths. An invalid write is rejected, and the validation error comes back as the tool result.
- Times are stored as an ISO 8601 string with offset, plus an IANA time zone.
- Free text (notes, memory, personalities, profile) is Markdown.
- Schemas, in brief:
  - **trip.json:** `id, title, start, end, places[], timezones[], party[] {name, age?, interests[], driver?}`
  - **plan item:** `id, title, kind, fixed: bool, priority, start {at, tz}, end?, place? {name, lat, lng, address}, booking?, notes?`
  - **booking:** `id, kind (flight · lodging · car · rail · event · restaurant · other), status (unverified · confirmed), source (path of original), times, place, confirmation, cost {amount, currency}, fields{}`. New records must be `unverified`.
  - **watch** (stored as a record so it survives reloads): `id, owner, when {type, …}, repeat, fallback, expires`

### 4.5 Events

Types: `msg.user`, `out.speak`, `out.show`, `out.ask`, `model.turn`, `tool.call`, `tool.result`, `net.request`, `heard`, `decide`, `file.write`, `location`, `trigger.fired`, `wake`, `compaction`, `plugin.error`, `error`, `state` (live mode on/off, voice mode), `trip.remove` (§4.9).

- **Large content** (fetched pages, response bodies, audio clips if kept) goes in `blobs`. Events only reference it, by listing its fingerprint in `refs` (§4.9).
- **A model request is logged as a reference,** not a copy: the range of events in context, the prefix fingerprint, token counts, cost. Copying every context would grow storage quadratically.
- **Location points are thinned.** A point is kept only after moving about 20 m (or the GPS accuracy, if worse), or after 1 minute while moving. Until the phone reports a speed, it takes 100 m of movement: a parked phone's GPS jitter otherwise reads as walking.

### 4.6 Robustness

- **One running instance.** A Web Lock (`navigator.locks`) allows one instance per device. A second tab shows "annai is open elsewhere. Use it here?"
- **Reconnection.** On iOS, Safari's IndexedDB connection can drop after backgrounding. The storage layer reopens and retries transparently.
- **Format upgrades.** The data format is versioned, with ordered migrations in the IndexedDB `versionchange` transaction, which is all-or-nothing. A failed migration leaves the old version intact. Before a large migration, annai writes an automatic backup.
- **Persistent storage.** annai calls `navigator.storage.persist()` and shows usage in settings.

### 4.7 Formats for the model

- **Flat homogeneous lists** (listings, search results, `nearby`, hourly weather): TSV with a header row. Cells escape tabs, newlines and `<` with the `<sep>`, `<LF>`, `<CR>`, `<lt>` tokens from the TSVZ spec.
- **Single or nested objects:** JSON.
- **Prose:** plain text.

### 4.8 Photos

A photo is encoded at two points, each with its own settings: **ingest**, once, for what annai keeps, and **request**, for what a model is sent.

- **Ingest** covers photos from the camera, the file picker and the share sheet, and stores **one file per photo**. It never touches photos inside an imported archive, whose fingerprints must not change.
  1. Read the photo's metadata (EXIF) first: when and where it was taken, and its orientation. It is kept with the file, since re-encoding drops it.
  2. With **Keep originals** on, store the original as it is.
  3. With it off, the default, store the **ingest encoding**. The phone's photo library still has the original. By default the encoding uses quality 0.9, no size or edge limit, and the first format of the ingest format list that this device can encode; the default list is WebP, then JPEG.
     - The original bytes are stored anyway when their format is on the list, they are within the limits, and re-encoding wouldn't make them smaller.
     - A format that isn't on the list, such as HEIC, is always converted, even when that makes it larger, so the photo shows in every browser.
     - Browsers cap the size of a canvas; Safari has been reported at about 16.7 megapixels, which needs checking on real devices. Bigger photos are scaled down to fit, so a 24 or 48 MP photo keeps its full size only with Keep originals.
  - Either way, the stored file is **the photo**: what annai shows and backs up, and what request copies and crops are made from. A kept HEIC original shows only in Safari; a Share converts it (§12.2).
- **Request copies** are what Shiori is sent.
  - The source is the stored photo.
  - The limits are the stricter of two sets: the request settings (by default quality 0.9, longest edge 2000 px, 1 MiB, format list WebP then JPEG) and what the model accepts (§9.2).
  - A source within the limits is sent as it is. Otherwise a copy is made once, stored by its fingerprint, and reused on every later turn. The log entry of the turn that sends it names it in `refs` (§4.9). The bytes then stay the same, so the provider's cache stays warm.
  - The conversation shows the copy Shiori was sent, so she sees what the user sees. She is also told both sizes ("4032×3024, sent as 2000×1500"), so she knows when a closer look would help.
  - **A refused image is fixed and retried automatically** (§9.9). Rules recognize the usual error messages, and the utility model reads unfamiliar ones. The new copy replaces the refused one in the conversation, and the refused one is deleted. The lesson ("at most 5 MB") is saved on the model, so the same refusal doesn't happen twice.
  - **Provider uploads.** Where an endpoint can store files (Anthropic, OpenAI, Gemini and OpenRouter have files APIs), each request copy is uploaded once. Later requests refer to it by its id: a few bytes per turn instead of the photo.
    - It is on by default, since the photo goes to that provider anyway; a switch on the endpoint turns it off.
    - **Every upload expires after 48 hours.** Anthropic and OpenAI let annai set that, and Gemini always does it. So nothing annai uploads outlives its use for long, even when annai's own data is lost. An expired id is simply uploaded again.
    - **Where a provider can't expire uploads** (OpenRouter today), annai deletes its own, which it names `annai-…`. It deletes one when compaction drops the photo. At each start, it also deletes any of its uploads there that is more than 48 hours old, found by name and age, so this works even after annai's data is lost.
    - OpenRouter's documentation suggests uploading may need a management key, so uploads there are used only once the provider's Test shows they work (§9.8).
    - The Anthropic Messages and OpenAI Responses types upload.
    - Storing uploads costs nothing at Anthropic and Gemini; OpenAI lists no price for it (checked 2026-10-15, and again 2026-10-18).
- **A closer look.**
  - `read(path, region)` crops the source and sends the crop through the request settings (§7.2).
  - In the photo viewer, the user can crop what is on screen and send it to Shiori (§16.2).
  - Crops are kept in the conversation, never among the trip's files. Small request settings (1000 px, or 512 KiB for users watching their data) stay usable, because full detail is always one crop away.
- **Encoders.**
  - The browser's own encoders are built in: JPEG and PNG everywhere, WebP in Chrome and Firefox. annai finds them with a test encode, because a browser that can't make a format silently returns PNG.
  - Plugins add the formats a browser lacks, for example:
    - WebP for Safari;
    - AVIF, which current browsers show but none can encode;
    - JPEG XL.
  - A plugin may load its encoder only in browsers that need it.
  - If some browsers can't show a plugin's format, the plugin also brings a decoder, and Share exports convert such photos (§12.2).
  - Encoders built with WebAssembly need `'wasm-unsafe-eval'` in the security policy (§15).
- **Settings → Photos** holds Keep originals, plus quality, longest edge, size and format list for both ingest and request. Encoder plugins carry their own tuning.
  - Space-conscious users can give ingest the same settings as request. Each photo is then stored small and sent as it is.
  - The cost: a closer look shows no more detail, and backups hold only the small copy.

### 4.9 Removing a trip

Removing a trip deletes it from the device and frees its space at once. There is no recycle bin, and nothing is ever cleaned up automatically.

- **Where:** a Remove button on the trip's screen, for active and archived trips.
- **Asking first:**
  1. Always: "This removes everything in this trip from this device: its files, photos, notes and history. Remove it?"
  2. Only if the trip has changed since its last backup: "This trip hasn't been backed up since it last changed. Remove it anyway?"
- **Backed up** means a Backup with everything ticked (§12.2), of the trip or of everything, was saved after the trip's last change: the share sheet finished, or the download started. A Share doesn't count, since it leaves out the conversation and the history. annai records the time on the trip, and trip cards show it (§16.2).
- **What goes:** the trip's record, files and history, and all stored content nothing else uses. Content another trip also uses stays. What was heard in it and is still held in memory (its sound, or its words kept for a moment, §10.3) goes too. The system log records `trip.remove {title, bytes}`.
- **So everything stored must be named.** Removing any trip deletes all stored content that no file and no log entry names, wherever it came from. Whatever annai or a plugin keeps (request copies, trace bodies, audio clips) is a file, or is listed in the `refs` of the log entry that made it. A kept audio clip, now compressed (§10.6), is still named by its `heard` event.
- **Inside a trip, deleting keeps the history.** A deleted photo or file can be brought back from its history (§4.2), and its space comes back when the trip is removed.
- **Finding what nothing else uses reads every file and log entry on the device.** That is quick while logs are small. Before milestone 2 makes them large (trace bodies, request copies), log entries get an index of the content they point at, so removing a trip reads only what that trip used.

## 5. Plugin system

### 5.1 Kinds

- **Skills.** The open Agent Skills format: a folder with `SKILL.md`, plus optional `references/` and `assets/`.
  - Only `name` and `description` sit in Shiori's context. She loads the body with the `skill` tool.
  - The front matter is parsed by a small parser for the subset the standard uses: strings, plus a one-level `metadata` map.
  - `scripts/` are not run.
- **MCP servers.** Remote servers over HTTP. A built-in MCP client plugin registers each server's tools as `mcp_<server>_<tool>` (model providers refuse dots in tool names).
  - The server must allow browser access (CORS).
  - Auth is a URL plus headers or a bearer token. OAuth for MCP comes later.
- **Code plugins.** Full-trust ES modules with the same powers as built-ins. The install screen says so plainly: "This plugin gets full access to your trips and API keys."
- **Model providers** (provider plugins). One provider: its address, how its key is sent, its abilities (chat, transcription, voice, each through a protocol plugin's endpoint type), its models with prices and capabilities, the roles it suggests, its key page and notes. Most are data only, a `provider` description in the manifest and no `entry` (§9.1).
- **Data-only plugins** (a manifest with no `entry`: a provider, skills, personalities) can't run anything, so their install screen has no full-access warning. A provider's says where a key given to it is sent, by origin: "Keys you give this provider are sent to https://api.openai.com."

### 5.2 Package and manifest

A plugin is a folder, zip or URL containing `annai-plugin.json`:
- `id`, `name`, `version`, `description`, `author`, `homepage`
- `api`: the interface major version
- `entry`: an optional ES module
- `skills[]`, `personalities[]`
- `provider`: a model provider's description (§9.1)
- `requires`: the plugins it needs, `[{ id, version: "^N", homepage? }]` (at most 10); `^N` is the same major, which for a protocol plugin is its interface version. A package can't require itself.
- `category`: its kind in the catalog: `providers`, `speech`, `backup`, `tools`, `skills` or `developer`; derived when absent
- `keywords`: other names it is searched by, as shown ("LM Studio")
- `featured`: a sentence for the one-tap start (§9.8); it counts only in annai's own catalog, never from a third party's manifest
- `catchAll`: a provider for any address (Another address), listed after the others when browsing
- `replaces`: names it means to replace (a tool, a component such as `avatar`, a skill …), up to 20; the install screen asks (§5.6)
- `settings`: a JSON Schema, from which we render a settings form automatically
- `templates` (endpoint templates) is refused: "Endpoint templates were replaced by `provider`".

### 5.3 Installing and loading

- **Sources:** the official catalog (`annai.guide/catalog/plugins.json`), a URL, or a zip, all from one Add screen (§16.2). The catalog's entries carry each plugin's kind, abilities, keywords, whether it is free, local or code, and its size, so it is searched before anything is installed; an installed plugin's are read from its manifest the same way. annai lists only its own catalog and what is installed: no third party's entries hosted elsewhere.
- **Files are copied into storage.** They work offline, and they change only when the user accepts an update.
- **The service worker serves installed plugin files** from storage at `/plugins/<id>/…` on our own origin. Multi-file plugins can use relative imports, and the security policy stays `script-src 'self'`.
- **Official on-demand plugins** have a SHA-256 for every file in the catalog, and downloads are checked against it.
- **Updates are checked for, and offered.** annai compares the official plugins it has installed with its catalog at each start, when it comes back to the screen (at most every 15 minutes), once a day while it stays open, and on Check now in Settings → Updates. Plugins installed from a URL are checked at their address at each start, on coming back at most once a day (so a third party's server isn't asked at every return), and on Check now. Nothing is checked while offline. A newer version is offered on a card (once, not at every return), in Settings → Updates and in Settings → Plugins; nothing changes until the user taps Update, and new code that replaces code already running runs from the next start. Plugins installed from a file have nowhere to check.
- **Choosing an unavailable type installs its plugin.** When a user picks an endpoint type, search provider or speech provider whose plugin isn't installed, it installs automatically.
- **Plugins can add new types,** which become selectable once the plugin is installed.
- **What a plugin requires is installed with it.** Official requirements come from the catalog, hash-checked, with no question; a third-party one must be installed first, from its own address, and the install stops and names it (with its homepage). All or nothing: when a download fails or the connection drops, nothing stays half-installed. An update that changes `requires` resolves them when the user taps Update, and a protocol update to a major an installed plugin doesn't accept is refused, naming that plugin. A plugin the user switched off is never switched on by this: the install stops and says how to turn it on; one annai switched off after errors starts again only on the user's tap (§5.5).
- **Calls never install.** Only setting up does: adding a provider, turning an ability on, Test, Fetch model list, Try this model. A model whose protocol isn't running is skipped (§9.6).
- **Pruning.** Removing the last provider made from a provider plugin uninstalls that plugin, then every official protocol plugin that no installed plugin requires and no switched-on ability uses. A third-party protocol plugin stays.
- **annai's own names stay annai's.** A package from a file or an address can't take the id of an official plugin, and a copy that holds one is never used as annai's own; annai's own never installs over a package from elsewhere that holds its id either. Installing over an installed package from another place (another address, or a file over an address) says so, with Install, keep its settings and keys (they go to the new one, with the user's choices for its names) and Install fresh (they are removed first).
- **An update from an address whose provider would send keys to a new origin** (scheme, host and port) asks first, as new code does.

### 5.4 Interface

A module exports `activate(annai)`, which returns a cleanup function.

- **What plugins can add:**
  - `tools` (name, description, input JSON Schema, `run`)
  - `providers` (chat, speech-in, speech-out, search, fetch-reader, decision, and endpoint types), and a provider plugin's own setup (`providers.setup`, below)
  - `sensors`, `triggers`
  - `schemas`
  - `ui` (§16.4)
  - `hooks` (subscribe to log appends; read-only in v1)
  - `storage` (backup targets)
- **What plugins can use:**
  - `files`, `events` (an entry lists the stored content it keeps in `refs`)
  - `net.fetch` (traced)
  - `llm(role, request)`
  - their own `settings` and `secrets`
  - `wake(reason)`
  - `ui.card`, `ui.toast`
  - shared helpers: the streamed-response reader, the half-finished-JSON reader, retry with backoff, TSV, merge patch
- **A provider plugin with code has one setup** (`annai.providers.setup`, milestone 4 of the provider plan), the small contract for quirks that data can't carry:
  - `panel(ui, provider)`: its own part of the setup, drawn in the key's place on its provider's page. With provider null it is the plugin's own Add flow: Add on that provider opens it (`#/models/provider?new=<plugin>`), with Add by hand beside it (there whenever the plugin is running, also when its panel draws nothing), and the provider it adds opens its page; leaving with no provider made removes the plugin if Add's tap installed it; the featured one-tap start is that panel too (§9.8), as Another address's look at an address is. `keyField: false` leaves the standard key field out. What it throws counts against it (§5.5), and the standard screen draws without it.
  - `ui.add({ key, roles, … })` adds a provider of its own, installing what that needs; `ui.keep(providerId, key)` sets the key of one of its own providers. The key goes to annai's secrets for that provider alone (§9.9), never into the plugin's files; given as a function, it is asked for only once all else is in place, so no key is made that annai can't keep.
  - `ui.expectReturn()` then `returned(params, ui)`: the next load of annai's address with a query, within 15 minutes, goes to the plugin that expected it, once; any other query (or one past the 15 minutes) is removed from the address, and a card says the sign-in came back too late, to start it again from Settings → Models.
  - `classify(status, body, ability)` sharpens an error's kind before the protocol's; `headers(ability)` adds headers to an ability's requests, never one that carries the key (`authorization`, `x-api-key`, the provider's `keyHeader`); `list({ ability, endpoint, key, fetch, protocolList })` lists an ability's models in the protocol's place, through a fetch that reaches only the ability's address and never follows a redirect.
- **Content a plugin keeps is a file, or is named in a log entry's `refs`.** Anything stored another way is deleted the next time a trip is removed (§4.9). The plugin guide (`docs/plugins.md`) says so too.
- **Built-ins are plugins.** The core is storage, registry, scheduler, loop and context builder; everything else is a built-in plugin in the same format.
- **Switches and trace come from the registry,** so they cover third-party tools automatically.

### 5.5 Isolation and versioning

- Every call into a plugin is wrapped. An error becomes a `plugin.error` event.
- A plugin that keeps failing is disabled automatically, with a card saying why.
- A plugin built for an incompatible `api` major version is disabled cleanly.
- The interface scopes are for organization, not security.

### 5.6 Names and conflicts

- **A name has one owner.** Tool names, protocols (endpoint types), kinds of backup place, skill and personality names, card types, search providers and the replaceable components (§16.4) are names. Hooks and the slots that add things up (chips, Now sections, dock actions, tabs, settings pages, screens, themes) never clash. A provider's id is its plugin's id, unique by install, and a plugin registers only its own provider.
- **The fixed order decides,** so behaviour is repeatable: built-ins, then official plugins, then third-party plugins by when each was first installed (an update keeps its place), then by id. Plugins start in that order.
- **Built-ins and official plugins keep their names.** A third party's plugin with one of their names isn't used. annai's own components, and the skills it ships, are annai's even when no plugin draws them.
- **The user's choice decides, once made.** A plugin's page says "Not used: <name> is already provided by <owner>", with **Use this one instead**. The choice is stored (app settings, `uses`), holds while that plugin runs (switched off, the next in order is used), and is shown on both plugins' pages, "<name>: this one is used (your choice)", with **Undo**. Removing the plugin forgets it. Choosing never switches a plugin on.
- **`replaces`** (§5.2) is asked at install: "It replaces <name> from <owner>", with **Install and use it** and **Install, keep <owner>'s**. Nothing is chosen until one is tapped.
- **What no choice moves:** the agent loop's own tools (`speak`, `show`, `ask`, `wait`, `sleep`, `tell_koe`, `tell_kokoro`, and the rest of the loop's), which keep the loop whole; and protocols and kinds of backup place, which are handed the keys the user gives (a provider's, a place's): their owner is by order alone, so `replaces` can never hand a plugin someone else's key. When a type is needed, annai's own is installed even if a third party's has its name.
- **Upgrading:** at the first start with this rule where every plugin started, what the old rules used is recorded as the user's choice, so nothing in use stops being used: a component, the last plugin's to register it; any other name two plugins share, the first's.
- **A name annai's official plugin provides** (a protocol, a kind of backup place, kept with its record, and listed in the catalog annai ships with, `src/core/official-names.js`) is owned only by annai's own: while that plugin is off, switched off or not yet installed (offline, say), nobody has it, and calls say its plugin isn't running. `annai.register` refuses every kind with a call of its own, and a bug counts against the plugin that registered the thing, never an id it carries.

## 6. Agent loop

### 6.1 Wakes

Sources:
- the user: text, photo, or tap-to-talk
- a trigger firing
- the app returning to the screen (catch-up)
- a plugin calling `wake(reason)`
- a push notification being opened
- speech heard while she was thinking (§10.4)

All wakes go into one queue:
- Wakes that arrive mid-turn are delivered at the next model call ("meanwhile: …").
- Simultaneous triggers merge into one wake.
- User input goes ahead of triggers.
- If the queue isn't empty when a turn ends, the next turn starts immediately.

When Shiori is two halves (§6.8), each half has its own queue, so neither waits on the other. What the user types or says goes to Koe, which writes it into the conversation. A wake that isn't the user's (a trigger, a plugin, a new file) goes to both, checked against quiet hours and wakes per hour once (§6.6), its fallback reminders going with the half that talks. A wake that asks for her voice (the recap told aloud, §13) goes to Koe alone.

**Kokoro hears all and wakes on cue.** Everything heard, chatter included, and everything Koe says goes into Kokoro's transcript at once. Kokoro wakes when:
- the user types or sends a photo;
- Koe asks it something (a note). It doesn't, if Kokoro has told Koe since the user last typed or spoke: one question costs one Kokoro call;
- Koe answers what was heard. A reply in which Koe also asks Kokoro wakes it with the question instead;
- a trigger fires;
- a review comes due: as a new line comes, 3 minutes or more of conversation have gone by since Kokoro last read it. That catches a request Koe took for chatter while it still matters on a drive, costs at most 20 calls in a chatty hour, and reads a cached prefix. Silence costs nothing.

Kokoro doesn't wake for each passenger's sentence.

### 6.2 A turn

1. Build the context.
2. Stream the model call.
3. Run the tool calls in order. `sleep` always runs last.
4. Append the results and call the model again.

The turn ends when the model calls no tool (the convention), calls `sleep`, or hits a budget. **Sleeping means the microphone is off.**

### 6.3 Context order (for prompt caching)

1. Core instructions (how annai works; address the user only through output tools; safety rules), then the personality, then the definitions of enabled tools.
2. Profile, global memory, skill index, trip memory. These are snapshotted at wake, so edits made during a turn show up at the next wake.
3. Transcript: the latest compaction summary plus every event after it. It only grows at the end.
4. A **now block**, last:
   - local time and zone
   - place and coordinates
   - activity
   - voice mode
   - the next plan items, as TSV
   - connectivity
   - the wake reasons

**Each half's context (§6.8):**
- **Kokoro's** is the above. While Shiori is two halves, its system text gains the part about working behind Koe, and its tools `tell_koe`; both stay byte for byte the same whatever Koe does, so its cache holds. The conversation reads as labelled blocks: `[the user typed] "…"`, `[Koe said] "…"`, `[Koe showed] "…"`, `[Koe asked] "…"`, `[Koe asks] "…"`, `[Koe notes] "…"`, the words in them quoted, so a label or a new line inside can't pass for annai's. Koe's state changes (it can't speak, it speaks again, voice is on) arrive as `[annai] …` blocks in its messages, never as a change of system text or tools; its now block has a `koe:` line.
- **Koe's** is small, for speed: its own instructions and Shiori's personality, with the user's profile; its quick tools; a window of the conversation, its last 12 exchanges, whose start moves forward 6 at a time, so its cached prefix holds between moves; and, in its tail, the now block and `<today>`: today's and tomorrow's plan, the bookings of the next 48 hours and the next reminder, at most 2,000 characters. Kokoro's notes arrive inside `<from_kokoro id="…">`, with a nonce made fresh each time annai starts, given in Koe's tail (never its cached prefix); every other text Koe reads has its angle brackets escaped, so no other text can be a note.
- **A line that arrives while tool calls are open waits for their results,** and one the other half writes while a reply is being made follows that reply: the same rule live and from the log, so a reload sends the same messages.

The provider adapter places cache markers where the provider needs them (Anthropic) or relies on automatic caching (OpenAI, Gemini). OpenAI's automatic breakpoint goes at the end of the latest user message or tool results, so OpenAI Responses sends the now block last as a developer message of its own. The cached prefix then ends where Anthropic's marker would.

### 6.4 Cache lifetime awareness

Each model declares its cache TTL options and prices (§9.2). The core tracks, per model and prefix fingerprint, when the prefix was last sent, so it knows whether the cache is **warm or cold**.

- **The cache lasts an hour by default** (Settings → Models → Cache), or five minutes if the user chooses. An hour costs more to write, and pays off when the next message comes more than a few minutes later. A model that doesn't list the hour among its TTL options is asked for five minutes, and its warmth is counted that way.

- **Prefix rewrites happen only when the cache is cold or about to expire:** compaction, and refreshing the memory or plan snapshot. A rewrite just before expiry costs nothing extra, since the cache would be lost anyway. The one exception is when the next request would overflow: above 90% of the model's window, or above the maximum request size (§6.5).
- **The trace shows actual cache hits,** from the token counts each provider reports.
- **Plugins can read TTL and warmth,** and can schedule wakes (for example, "keep warm and catch up on the world"). Nothing like that is built in.

### 6.5 Compaction ("housekeeping")

- **Two limits trigger it,** and both work the same way. Housekeeping is due at a threshold (default 70%), and is forced when the next request would overflow (§6.4). The threshold and the maximum request size are set in Settings → Models → Housekeeping.
  - **The context window**, per model and editable.
  - **The maximum request size** (default 8 MiB).
    - Every turn sends the whole context again: caching lowers the cost, not the upload. On roaming data, a photo-heavy conversation could otherwise cost more to upload than the model call.
    - Photos count at their base64 size, a third more than the file. Photos uploaded to the provider count only as their id (§4.8).
- **There are two modes, and the cache decides which one runs:**
  - **Warm: Shiori compacts.**
    - Once housekeeping is due, it waits for a pause, then runs shortly before the cache would expire.
    - The model that holds the cache writes the summary, normally the main model. The request is the cached conversation plus a closing instruction, so it costs a cache read rather than the whole transcript at full price. Each provider caches per model, so only that model gets this price.
    - The next turn starts a new, shorter prefix, which would have been cold by then anyway.
  - **Cold: the utility model compacts.** The cache has already expired, for example because the app was closed or the conversation resumes after a long gap. Nothing is cheap to reuse, so the cheaper utility model writes the summary.
- **The older part becomes a `compaction` event.** The most recent part stays word for word, photos included: by default the last third of the threshold, and never fewer than the last three exchanges.
- **It compacts to well below the threshold,** so it happens rarely: each compaction rewrites the start of the request, which costs one cold cache.
- **It leaves pointers:**
  - **Each photo becomes a one-line stub** with its path, and its crop if it was one, plus what was said about it. For example: "/trip/files/2026-11-26-1904.webp: the Nepenthe menu, prices circled; read it to see it again." The stub is written from the conversation around the photo and its metadata, so the photo isn't sent again.
  - **Each summary names the event range it covers,** and `recall` brings back the exact words (§7.2).
- The full log is never altered.
- During housekeeping, Shiori may move lasting facts into memory files.

### 6.6 Budgets and safeguards

- **All budgets are opt-in, with no defaults:**
  - steps per wake
  - spend per day
  - trigger wakes per hour
  - quiet hours

  Hitting a budget ends the turn with a card. Spend per day is set in Settings → Models, with the requests it limits; the other three in Settings → Shiori, under "How often she acts on her own".
- **Cost is always visible** in the trace.
- **Stuck-loop detection is always on.** Three identical tool calls in a row with identical results end the turn with a card.

### 6.7 Failures

| Failure | Handling |
|---|---|
| A tool errors | The error is returned as the tool result; the model adapts. |
| The model errors | §9.6 fallback. When every model is exhausted, a card says "Shiori can't reach her model". |
| The user interrupts | Tapping the avatar cancels the stream. Partial output is logged. |
| Crash or reload mid-turn | At startup, every tool call without a result gets one ("interrupted by app restart"), then a catch-up wake runs. |
| Voice is off | `speak` becomes an on-screen bubble and doesn't listen. The now block tells Shiori the mode. |

### 6.8 Two halves: Koe and Kokoro

Design: docs/superpowers/specs/2026-10-19-koe-kokoro-design.md. Shiori can be two halves, as the user chooses:
- **Koe** (声, voice) talks with the user and answers at once, from what it knows and what annai holds on the device. It never states anything that changes (hours, prices, directions, schedules, weather, anything about today) unless annai's data or a note says it: it says it's checking, and asks Kokoro.
- **Kokoro** (心, heart and mind) is Shiori as she always was, on the main role, with all her tools. It hears everything, does the deep work, and talks only to Koe.

**The split is opt-in:** Shiori is two halves only while a Koe list holds a model (§9.6). Otherwise she is one, exactly as before, at one call per message. One personality is in both.

**Notes.** `tell_kokoro` (Koe's) and `tell_koe` (Kokoro's) return at once, after the note is written into the conversation. append reaches the other half before its next model call, or starts its turn; immediate also cuts its model call (or its speech). Both are always on. When Kokoro's turn ends in plain text, having told Koe nothing and never slept, that text goes to Koe as a note. A Koe waiting on Kokoro (`wait`) hears "Kokoro has nothing to add" when Kokoro is done with nothing to tell, or "Kokoro was stopped" after the sign's Stop.

**Two transcripts from one log.** Each half writes its own model turns, tool calls and results, marked as its own; each reads only its own, and the other's lines as above.

**Failures.**
- Kokoro's `speak`, `show` and `ask` while Koe talks aren't run: each becomes a note to Koe, and its result says to use `tell_koe`. Its `wait` is answered too: the microphone is Koe's. This is in code, not instructions alone.
- When Koe's whole list fails, it rests at least a minute; Kokoro gets "Koe can't speak right now; talk to the user directly" (and whether its last notes reached the user), its output tools run again, and what the user types goes to Kokoro alone until Koe answers again ("Koe is speaking again; use tell_koe"). No card: Kokoro answers.
- When Kokoro's whole list fails while Koe talks, and Koe waits for it (its question is out, or it is in `wait`), Koe is told once, and tells the user it couldn't check and offers to try again. No card. A check nobody waited for (Koe's own answer, a review, a typed question Koe answered itself) tells Koe nothing: the Trace has it.

**Voice** is Koe's while it works (§10.7).

## 7. Output model and tools

### 7.1 Talking to the user

Shiori addresses the user **only** through output tools. Any plain text the model writes is her internal transcript: hidden from the user, visible in the trace. (This follows the precedent of MemGPT/Letta's `send_message`.)

| Tool | Behaviour | Result |
|---|---|---|
| `speak(text)` | Plays sentence by sentence, then listens (§10). | What was heard, or where she was interrupted plus what was heard, or "heard nothing" after a silence timeout (default 8 s). |
| `show(card)` | A card: text, place, links, booking, image, or choice. | "shown" |
| `ask(question, options)` | Shows the question and buttons. Also spoken when voice is on. | The tap or the spoken answer. |
| `wait(seconds)` | Keeps listening. | What was heard. |
| `sleep()` | Ends the turn and turns the mic off. In the same response as `speak`, it stops `speak` from listening. | — |

While Shiori is two halves (§6.8), these are Koe's; Kokoro's are gated in code while Koe talks, and Kokoro reaches the user through `tell_koe`.

These rules make the loop work:
- The `speak` result *is* the follow-up call, so there's always one unless she chose to sleep.
- Every `speak` call gets a recorded result even if the loop ends without the main model seeing it, because both API styles reject an unmatched tool call.

### 7.2 Built-in tools

Every tool can be switched off, except `show`, `ask`, `wait`, `sleep`, `tell_koe` and `tell_kokoro`. Turning off `speak` means voice off. A tool switched off is off for both halves.

**Who has what, while Shiori is two halves (§6.8):** Kokoro has every tool, and `tell_koe`. Koe has its talk tools, the timers, `recall`, `list` and `read`, `nearby` and `guide` from the offline pack only (never the network), light changes, and `tell_kokoro`. A light change is one note in `/trip/notes/` (written or edited), a reminder set or cancelled, one flexible plan item's start, end, notes or priority, or one new flexible plan item: each is one file, undone from its history, and none touches a fixed commitment or money. Anything else (deleting, bookings, `trip.json`, memory, fixed items, importing, fetching, spending) is refused with "ask Kokoro". A photo reaches Koe only when every model of its list takes photos; otherwise Koe reads that Kokoro sees it.

| Group | Tools |
|---|---|
| Talk | `speak`, `show`, `ask`, `wait`, `sleep` |
| Files | `list(path)` → TSV · `read(path, region?)` → text / JSON / image / PDF-as-document; for a photo, `region` crops it (§4.8) · `write(path, text \| object)` · `edit(path, old, new)` (text files) · `patch(path, mergePatch)` (JSON files) · `search(query, path?)` → TSV · `delete(path)` |
| Web | `web_search(query)` → TSV (title, url, snippet) · `fetch(url)` → readable text |
| Places | `nearby(lat, lng, radius, kinds?)` → TSV (OpenStreetMap Overpass + Wikipedia geosearch) · `geocode(query)` · `reverse(lat, lng)` (Nominatim) · `weather(lat, lng, when)` (Open-Meteo, also returns the time zone) · `guide(place)` (Wikivoyage sections) |
| Time | `watch.set({when, fallback, repeat?, expires?})` · `watch.list` · `watch.cancel` |
| Go | `maps_link(destination, mode)` → Apple/Google Maps card · `search_link(kind, params)` → prefilled flight, hotel or car-rental search links |
| Self | `tune_personality(text, reason)` · `skill(name)` · `task(prompt, tools?, reasoning?)` (a subagent on the utility model, with its own loop and a subset of tools, returning its result) · `recall(query \| range)` → earlier conversation, word for word, from before a compaction (photos as stubs) |

- **Crop regions heal themselves.** A region is `[left, top, right, bottom]` as fractions of the photo (0 to 1).
  - Reversed edges are swapped.
  - Values outside the photo are clamped to its edges.
  - Values above 1 are read as pixels of the source.
  - A region too small to show anything is grown around its centre.
  - The result states the region that was actually used, so a mistake shows instead of failing.
- **Link formats.** `search_link` and `maps_link` build URLs from formats kept in the catalog (`annai.guide/catalog/links.json`). When a site changes its URL format, the catalog is updated without an app release.
- **Places data** comes from free services that accept direct browser calls (verified 2026-10-14). The tools read the offline pack first (§11.5). Nominatim's rate limit (1 request per second) is enforced on our side.
- **The fetch chain:**
  1. Fetch the URL directly, which works when the site allows browser access.
  2. Otherwise use the configured reader service, by default Jina Reader (r.jina.ai), which accepts browser calls.
  3. Otherwise use the model provider's own fetch tool, if one is enabled (§9.5).
  4. Otherwise return a clear error.

  The agent sees a single `fetch` tool. A self-hosted fetch relay is added only if real use shows gaps.
- **Search** goes to the search role's provider list (§9.6), or to the provider's own search tool, depending on the role's "search via" setting.
- **PDFs** go to the model as a document when it accepts PDFs. Otherwise Shiori asks for a screenshot; we don't add a PDF library.

### 7.3 Importing a booking

There's no special machinery:
1. The file is saved to `/trip/files/`.
2. Shiori is woken with "new file".
3. She `read`s it, `write`s an `unverified` booking, and `ask`s about only the fields she's unsure of.
4. The plan shows unconfirmed bookings as "Check this".

## 8. Planning

- **Order:** Shiori plans in the brief's order: getting there, getting around, where to stay, then the rest. She researches with web, places and guide tools, and hands over `search_link` cards for booking.
- **Plan items** are `fixed` (booked: flights, reservations, check-ins, last ferries) or `flexible`, each with a priority.
- **Calendar files:** importing `.ics` creates plan items. Exporting the plan as `.ics` uses the share sheet or a download.
- **Apple Wallet passes:** `.pkpass` files are zips containing `pass.json`, read by our own unzip. They become bookings.

## 9. Models and providers

### 9.1 Protocols and providers are plugins

**Protocol plugins** are the endpoint types: they know how to talk (request and reply formats, streaming, error kinds). **Provider plugins** describe one provider each, as data: its address, how its key is sent (`keyHeader` when not the protocol's way), its abilities, each with its kind (chat, transcription, voice, realtime), its protocol's type, its own address if it has one, tunables, extra fields, `modelDefaults` (what a model added by id or from a list starts with) and models; the roles it suggests (`recommended`, `free`); its key page and notes. annai's catalog has OpenRouter, Anthropic, OpenAI, Google Gemini, Groq, DeepSeek, Mistral, a local speech server, the scripted model and "Another address" (any other server: it looks for what the address offers, at no cost, §9.8), each requiring the protocol plugins its abilities need.

**Servers you run** have provider plugins of their own: llama.cpp (also for Unsloth Studio and KoboldCpp), vLLM, SGLang, Ollama and LM Studio. Each is marked `local`, and its quirks are data where they can be:
- its default address and port, and whether it takes a key (Ollama takes none);
- how its thinking is switched, as `modelDefaults.reasoning`: llama.cpp's `reasoning_effort` with `chat_template_kwargs.enable_thinking`, vLLM's and SGLang's `reasoning_effort` with `chat_template_kwargs` (`enable_thinking` and `thinking`), Ollama's `reasoning_effort: "none"` for off alone, its other levels empty (Ollama refuses a named level for a model that can't think), while a model whose capabilities list thinking gets low, medium and high from its list (below). Level off sends the switch, so a quick decision doesn't think. LM Studio doesn't document its switch, so it has none;
- forced tool calls: llama-server accepts a `tool_choice` naming a tool but doesn't force it, so llama.cpp's plugin turns on Chat Completions' `enforceToolCall` tunable, which sends `"required"` where the forced tool is the only one offered (the user, 2026-10-19). The user's Unsloth Studio server forced neither (2026-10-19); there the quick decision reads the letter the model writes. Ollama doesn't support `tool_choice`, so a quick decision may go to the main model;
- the reasoning field: the protocol's `auto` reads `reasoning_content` and `reasoning`, which covers them all;
- usage in the stream: the protocol asks for it (`stream_options`), which llama.cpp, vLLM, SGLang and Ollama answer (LM Studio doesn't say);
- the context window: vLLM's and SGLang's lists give it as `max_model_len`. llama.cpp's list gives only the training context, and Ollama's and LM Studio's give none, so their plugins have a little code (the user, 2026-10-18), their provider setup's `list` (§5.4): llama.cpp reads `/props` (the loaded model's context per conversation, and whether it reads images); Ollama a loaded model's context (`/api/ps`), else its Modelfile's `num_ctx`, never its training context, with its photos, tools and thinking from `/api/show`; LM Studio a loaded instance's context, with its vision and tool flags, from `/api/v1/models`. A model not loaded when the list was fetched has its context set on its page;
- notes in plain words: how to let annai's address in (Ollama's `OLLAMA_ORIGINS`, LM Studio's Enable CORS, llama.cpp's `--cors-origins` when `--tools` narrows it), the flags tool calls need (vLLM, SGLang), Ollama's small default context.

A server you run is reached at `http://localhost` (or `127.0.0.1`) on the device annai runs on, or at an `https://` address. A plain `http://` address on another computer is refused: browsers block it from annai's https page, and the security policy (§15) allows http only for localhost. From a phone, the server needs HTTPS in front of it, such as Tailscale Serve or a tunnel, and the words where an address is typed say so.

The core contains no protocol. These endpoint types are official on-demand plugins:
- Chat Completions
- Anthropic Messages
- OpenAI Responses. Nothing is kept on the server (`store: false`): the whole conversation goes each time, and the model's encrypted reasoning goes back with it.
- Gemini, not built yet. Until it is, Gemini's OpenAI-compatible endpoint works through Chat Completions.
- Gemini Live, a **realtime** type (Koe and Kokoro, K4): a voice conversation in one stream, both ways, over a WebSocket. annai opens the socket itself, only at the origin of its ability's address (`wss:` for an `https` address; `ws:` only for `localhost` and `127.0.0.1`), and the protocol drives it: setup, 16-bit PCM in and out, both transcripts, tool calls and their answers, resumption. Gemini takes the key only in the address (`?key=`), the one way a browser's WebSocket can give it: the address is never traced, and the key is blanked wherever it could show. Closes are read by their words as well as their codes (Gemini's 1007 is both a bad field and a bad key). Each turn's usage is priced by its text, audio, and image and video tokens (`audioIn`, `audioOut`, `image`) and counted in Spend per day; each session's opening, readiness, goaway and closing, with its data both ways, is a `live.session` entry in the Trace. Gemini's Live voice ability arrives switched off, and switching it on installs the protocol; a realtime model's Test opens a session that must say "OK" aloud. Realtime models go only in Koe's lists (§9.6); chat roles skip them.
- OpenAI Realtime, a second **realtime** type behind the same contract (K6), for OpenAI's Realtime voice ability and for any server that speaks it (Another address's Realtime voice): `…/realtime?model=<id>`, with the key as the subprotocol `openai-insecure-api-key.<key>` beside `realtime`, the one way a browser's WebSocket gives it (OpenAI's docs show only short-lived keys there, made by a server annai doesn't have; whether a standard key is taken from a browser is a device check). Turns are annai's (no server turn detection): its detector's cut commits the audio and asks for an answer. Speech goes in as G.711 μ-law by default, telephone audio at 8 kHz and a byte a sample, a sixth of the data of OpenAI's 24 kHz PCM for the same tokens (OpenAI counts the user's audio by time), and Koe's voice comes back as 24 kHz PCM; the ability's tunables `input` and `output` choose (`pcmu`, `pcma`, `pcm16`), annai's sessions speaking 16-bit PCM either way while the protocol codes G.711. A tool's answer starts no new answer when silent; a cut-in cancels the answer still being made and truncates what wasn't heard, where annai's player says it stopped, else by the clock from when its voice began; a `response.create` OpenAI refuses ends that turn with nothing said, and what waits behind it goes; a turn is complete when playing it would end; a refusal (an error before the session is ready) ends the session in OpenAI's own words and kind; OpenAI keeps no session past an hour and has no resume handle, so the protocol asks for a fresh one after 55 minutes. Cached audio and images are priced on their own (`cacheReadAudio`, `cacheReadImage`); what OpenAI's transcription model writes down is billed by OpenAI apart and not counted in Spend per day, as the ability's note says. Both abilities arrive switched off.

Chat Completions and OpenAI Responses also take a server that answers `stream: true` with one whole JSON reply, such as an LLM router that never streams. The wait for the first words then covers the whole reply, and Another address's note says which wait to raise.

Plugins can add further types.

The core provides:
- the provider contract: our message format in and out, streaming events, normalized usage, normalized errors
- role resolution and fallback
- cost accounting
- shared helpers: the streamed-response reader, the half-finished-JSON reader, retry

Search and speech providers work the same way, as on-demand plugins with their own quirk settings.

### 9.2 Provider, ability and model settings

| Provider: how to reach a server | Ability: one thing it offers | Model: what one model can do and costs |
|---|---|---|
| name, address | on or off (a new one in an update arrives off) | name (unique, chosen by the user; defaults to the provider's id) |
| **one API key** (in `secrets`), extra headers | its protocol's type, and its own address (empty: the provider's) | the provider's model id; free text or picked from the fetched list |
| | the type's tunables, e.g. `max_tokens` vs `max_completion_tokens`, `system` vs `developer`, usage in stream, image/PDF format | belongs to exactly one ability |
| | `extraBody` for all its models | capabilities: tools, images (formats, longest edge, size, count per request; from the description, then corrected by refusals, §4.8), PDFs, audio input |
| | provider tools offered ability-wide, through `modelDefaults` | context window, maximum output |
| | photo uploads through the provider's files API: on by default where the type supports it (§4.8) | prices: input, output, cache read, cache write per TTL, per-call tool fees; for a realtime model, audio in and out, and images and video in, and cached audio and images |
| | "fetch model list", Test | cache TTL options; reasoning map, provider tools it supports |
| | | its own tunables and `extraBody`, which override the ability's |

Tunables and extra fields are per ability because each protocol defines its own; the key and headers are how the server is reached, the same for every ability. **One key per provider**: two accounts are two providers made from one plugin, each with its own key, models and role entries (this replaces the "one key per endpoint" ruling, made when an endpoint was the unit).

Precedence: **user setting > description (template) > plugin default.** Roles reference models by stable internal id, so renames are safe.

### 9.3 Reasoning

- **Five abstract levels:** `off · low · medium · high · max`.
  - Each role has a default level the user can edit: main → medium, utility → low, quick decision → off.
  - The core overrides per kind of call: the "is this for me?" check is always `off`, and compaction is `low`. `task` may request a level.
- **Each model has a map from level → request patch.** The provider's description ships it, and the user can edit it.
- **A missing level uses the nearest one; on a tie, the cheaper one.**
- **Each endpoint type also declares where the reasoning text comes back:** `thinking` blocks, `reasoning_content`, `reasoning`, or OpenAI Responses' reasoning summaries. Reasoning is stored, never shown to the user, and visible in the trace.
- **The Test button can try each level** and record which ones work.

### 9.4 Patch format

Request patches use JSON Merge Patch (RFC 7396), plus one extension: a key ending in `+` appends to an array. This is how a provider tool is added to `tools` without replacing our own. It applies to `extraBody`, reasoning maps and provider tools. Record patches in §7.2 use plain RFC 7396.

### 9.5 Provider-side tools

- **What a model lists:** its built-in provider tools, such as Anthropic web search and fetch, Gemini Google Search and URL context, OpenRouter web search, and OpenAI web search. Each has a name, a switch, the patch that enables it, and a price per call.
- **They sit next to ours** in the tool list, with the same switches.
- **Each role chooses "search via"** (provider · search plugin · off) and "fetch via" the same way, so Shiori never sees two competing tools.
- **The trace records only what the provider reports back:** URLs and citations, not full pages.

### 9.6 Roles and fallback

**Roles:** main (required), Koe for talking, Koe for typing, utility, quick decision, speech-in, speech-out, search.

Each role is an **ordered list** of models, tried front to back:
- Empty chat roles fall back to the main list.
- **Koe's two lists** (§6.8) follow the voice setting (§10.5): voice on uses "for talking", voice off "for typing", and an empty one uses the other, never Main. Both empty: Shiori is one half. They're at level off, wait 8 s for the first words unless set, and are filled only by "Use the recommended models" on a provider's page, never when a provider is added: the split is opt-in.
- Speech-out ends with the browser voice by default. Speech-in ends with phone dictation where available.
- Users can reorder or remove these defaults.

| What happened | What we do |
|---|---|
| can't connect, blocked by browser, bad key, out of credit (402) | next model |
| rate-limited | wait if the provider asks for a short wait, otherwise next model |
| overloaded | two quick retries, then next model |
| no first output within a time limit (configurable; tighter for voice) | next model |
| request too long | compact first; skip models whose window is too small |
| the model answers, including declining | that's an answer: no fallback |
| its ability is switched off, or its protocol plugin isn't running | skipped ("off", "type-missing"); a call never installs one |

- **The list also handles capability gaps.** Models that lack a capability the request needs are skipped, for example image input or context size.
- **Benching.** A failed model is benched for a cooldown (what the provider asked for, otherwise a few minutes). Calls during the cooldown go straight to the next model.
- **Switching back.** Each provider caches separately, so the switch back to a preferred model happens when the backup's cache is cold.
- **The transcript stays portable.** It's stored in our own format. When the model changes:
  - tool-call ids are rewritten for the new provider
  - reasoning blocks signed for another model are dropped
  - what a provider wrote on a tool call to have back (Gemini 3's thought signature, `extra_content` in Chat Completions) goes back only to the model that wrote it. (Gemini also streams parallel tool calls without an index, each whole with its own id; Chat Completions tells them apart by id.) Gemini 3 refuses a call in the current turn without one, so Gemini's description gives Chat Completions the stand-in its docs name for calls another model wrote (`standInCallExtra`): a fallback mid-turn isn't refused (checked against Gemini, 2026-10-19)
- **A stream that breaks partway** is handled like an interruption. The next model gets "said so far: … ✂" and continues without repeating anything.
- **The trace records every attempt,** which model answered, and the cost of each attempt.

### 9.7 Quick decision

The interface is `decide({prompt, options[]}) → {optionId: probability}`.

- **Default implementation: a chat model.** Where the model reports token probabilities (logprobs), options are labelled A, B, C… and we request a one-token answer, which gives real probabilities. Otherwise it's a forced tool choice with confidence 1.0.
- **Dedicated decision models** that return calibrated probabilities over fixed outputs can be added as plugins, for example TypeSafe's Jev.
- **Below a confidence threshold, the main model decides.**

### 9.8 Providers and onboarding

- **Providers come from the catalog** (`annai.guide/catalog/plugins.json`): each provider plugin's description holds its models, capabilities, prices, TTLs, reasoning maps, provider tools and quirks. Adding one (Settings → Models → Add a provider, which opens the catalog on model providers, §16.2) installs it and what it requires, with no question for annai's own.
  - Users' settings are copies: the description is a provider's template layer. A provider plugin's update (new models, new prices) is offered like any plugin update (§5.3) and applies on the user's tap; then the user's own changes stay, new models join no role, and a new ability arrives switched off, said on the provider's page.
  - Its speech models join behind the free entries when it is added: transcription after phone dictation, voices after the browser voice (§10.1, §10.3). "Use the recommended models" on its page puts them first, on that tap only.
- **Default onboarding is "Sign in with OpenRouter"** (OAuth PKCE, with no client registration on our side). It makes one OpenRouter provider, with one key, and suggests models for each role.
  - **It is OpenRouter's plugin's own setup** (§5.4), and the core names no provider: annai's catalog marks OpenRouter `featured`, and the one-tap start is that provider's panel. It shows on Settings → Models while there is no provider, and the welcome's last step says the featured sentence.
  - **Its link exists before the tap.** An iPhone Home Screen app opens a page only from the tap itself, never after an await, so a screen offering the start installs the featured provider's plugin in the background as it opens (once the service worker controls the page; annai's own, hash-checked; never as a tap, so a plugin the user or annai switched off stays off). Until its panel is in, the start is a disabled "Getting the sign-in ready…", never a link without an address; offline, it says to connect. Adding another provider removes annai's own provider plugins no provider comes from, the start's among them, unless the user turned them off.
  - On a provider's page, its panel offers Sign in again, whose new key replaces the one saved.
  - OpenRouter's free models allow 50 requests per day (1,000 per day after $10 of lifetime purchases), enough to try annai. The chat roles get free models.
  - Its transcription and voices (OpenRouter's OpenAI-compatible audio API) are abilities of the same provider, on the same key. Their models go at the end of the speech lists, behind phone dictation and the browser voice, so trying annai stays free; using them first is the user's choice, by moving them up under Roles (the user, 2026-10-18).
  - Nothing that costs money goes ahead of something free. OpenRouter's free voice (Fish Audio's, in its default voice) comes first among its voices: each sentence it says uses one of the free requests a day that the free chat models use too (the user, 2026-10-18: free audio is worth having). OpenRouter has no free transcription model. The others need credits bought at OpenRouter.
  - The card that says sign-in finished says what it set up, that the free voice shares the free requests, and how to move them up.
  - The key OpenRouter makes is labelled "annai" in the user's OpenRouter keys. Back from OpenRouter, the address goes to the plugin that started the sign-in (§5.4), and Settings → Models shows at once and says the sign-in is being finished; a failure is said on a card. On an iPhone Home Screen app OpenRouter shows a code instead, which is pasted in its panel.
  - OpenRouter's free models used up for the day read as too many requests, not an account out of credit: its plugin's `classify`, not the protocol's.
  - Endpoints from before providers are removed at the next start, with their models, keys and uploads, and a card says to add providers again (no conversion; the user, 2026-10-18). A backup from before, restored later, is moved over again.
- **"Another address" looks for itself** (milestone 5 of the provider plan), at no cost. Add on it opens its plugin's own Add flow (§5.4):
  - **The user gives an address and, if it needs one, a key.** The address is one annai sends keys to (https, or http only for localhost and 127.0.0.1), alone: no name and password, query or fragment. One annai won't take is refused in words that don't repeat it, so a key pasted there by mistake isn't shown.
  - **"Look for what it offers"** asks for the model list (`GET /models`) and sends an empty request (no model and no input) to `/chat/completions`, `/responses`, `/audio/transcriptions` and `/audio/speech` at the address, and to `/v1/messages` at the address without its `/v1` (case aside), as Anthropic Messages builds its address, with that protocol's headers. A chat request carries only its output limit of one token (`max_tokens: 1`; `max_output_tokens: 1` for Responses): a lax server may run an empty chat all the same (KoboldCpp's messages default to none), and then makes one token at most; the others are `{}`. A strict server refuses them all for the missing model. A control request to a path that can't exist, sent each way, guards the reading.
  - **How the answers are read:**
    - bad request (400, 415, 422) or a key refused (401, 403) means the path is there; not found (404), method not allowed (405) or not implemented (501: llama.cpp's for transcription with a model that can't listen) means it isn't;
    - a 2xx web page is a web app's fallback, so the path isn't there;
    - an answer the control got too says nothing: a server with a key in front of every path answers 401 everywhere, so without the key nothing is found and the words say to give it. A list of models is a list, whatever the server answers elsewhere;
    - 429, other 5xx and a redirect are no telling;
    - a request the browser couldn't make is "blocked: it doesn't allow web apps" when a no-cors request reaches the server, and unreachable when it doesn't, as the Test button tells them apart.
  - **An address with no path** is looked at with `/v1` first, and as given only when `/v1` finds nothing there: the user's Unsloth Studio lists its models at both, but talks only at `/v1` (2026-10-19). Anthropic Messages, at the same address either way, is asked once.
  - **Where requests go.** Every request goes to that address's origin only, at most four at a time, each given 15 seconds from when it is sent; the key goes only in the header each protocol sends it in, and no request with the key follows a redirect. The no-cors check carries no key, body or cookies; browsers send a no-cors request only if it may follow a redirect. Each request is in the trace, without the key.
  - **The results** list the model list (with its number of models), Chat Completions, OpenAI Responses, Anthropic Messages, Transcription and Voice, each ✓, ✗ (not found, or blocked) or ? with its reason, under "Nothing here costs money; Test sends real requests." A speech path is answered for every model by some servers (Ollama's transcription path), so its ✓ says only that the path is there, and that Test says whether a model there can listen, or speak. Typing in the address or key after a look says it changed, to look again.
  - **Add with these** makes the provider, named by the address's host, with what was found switched on (Anthropic Messages at the address without `/v1`), installing only the protocol plugins those need, and opens its page, where each ability keeps its switch. A speech path found is switched on only where the model list names such a model (Whisper, a TTS model, Kokoro and the like), and otherwise added switched off, as its line says. Its key is kept by annai alone (§9.9). Nothing priced is sent until the user taps Test. Add by hand adds it with every ability off, to switch on there. Leaving the screen without adding takes Another address's plugin away again, if Add installed it for this.
- **The Test button** sends one tiny request with a small tool and a small image.
  - It verifies browser access, the key, tool calling and image input, and marks what works as verified.
  - Where the ability's protocol has a files API, it also uploads that small image, so annai knows whether photo uploads work with this key (§4.8).
  - Its requests ask at level off. Where Main (or else Utility) asks this model at a level whose patch is another than off's, one more tiny request asks at that level, and a refusal is said in plain words with what to change ("At Main's level (medium), this model refused: …"). A model that can't think, given a named level, would otherwise pass Test and fail every turn.
  - It explains failures in plain words: "this address blocks web apps" is a different message from "key rejected".

### 9.9 Usage, cost, errors, keys

- **Usage is normalized** to input, cache read, cache write, output and reasoning, and for a realtime model's turn its audio tokens in and out, its image and video tokens, and its cached audio and image tokens. Multiplied by the model's prices (these at the input and output prices when a model has none of its own), that gives cost per call, wake and trip.
- **Error kinds:**

  | Kind | Response |
  |---|---|
  | bad key | ask the user to fix the key |
  | rate-limited | wait as instructed, or fall back |
  | overloaded | retry, then fall back |
  | context too long | compact and retry |
  | image refused (format, size, longest edge, count) | make a copy within the new limit, retry, and save the limit on the model (§4.8). If no installed encoder can make a format the model accepts, the utility model searches the plugin catalog and a card offers the plugin; installing it always takes the user's tap. |
  | an uploaded photo's id expired or is unknown | upload the photo again and retry |
  | blocked by browser | explain that the endpoint doesn't allow web apps |
  | bad request | hint: check the ability's tunables |
  | network | retry with backoff |

  "Wait as instructed" reads a `retry-after` header, or a Google API error's RetryInfo (Gemini sends its errors as a list of one). Gemini's `RESOURCE_EXHAUSTED` on a 429, its free tier's limits included, is rate-limited, never "out of credit", though its words say "quota"; on a 402 (prepaid credit used up) it is out of credit (checked against Gemini, 2026-10-19). A rest of more than 10 minutes is said plainly, on the model's line in a card and to Koe: "its daily limit is used up; it rests until 07:30", not in the provider's billing words.
- **Keys** live only in `secrets`. They're never in context and are redacted from the trace.

## 10. Voice

### 10.1 Speaking

- **Sentence by sentence.** The text of `speak` streams in as the model generates it (read from partial tool arguments), and `Intl.Segmenter` cuts it into sentences.
- **Each sentence goes to the first working entry in the speech-out list.** The list is user-ordered; the browser voice sits last by default. A provider's voices join behind it when the provider is added (Sign in with OpenRouter's too, the free one first), until the user moves them up or taps "Use the recommended models" (§9.8).
- **No gaps.** With API voices, the next sentence's audio is fetched while the current one plays.
- **Mid-answer fallback.** If a voice fails partway through, the same sentence replays on the next voice in the list, and the failed voice is benched.
- **Audio unlock.** Playback goes through one audio player, unlocked by the first tap of each session (an iOS rule).
- **Audio session type:**
  - `playback` while speaking, so she's heard with the iPhone's silent switch on (WebKit mutes `transient` with it); the car's music pauses while she talks instead of ducking
  - `play-and-record` while listening
  - `playback` afterwards, to restore full-quality Bluetooth audio
- **The interruption point** is tracked by sentence plus elapsed fraction, or by word timings when the voice provides them.

### 10.2 Listening sessions

A speech-in provider implements a **listening session**: start, stop, and a stream of segments. Two kinds:

- **Record and transcribe.**
  1. The mic opens only for the listening window.
  2. An `AudioWorklet` captures PCM audio.
  3. Our end-of-sentence detector measures energy in the speech band against a background-noise floor that keeps adapting. Speech followed by a pause of about 700 ms (tunable) becomes a segment.
  4. The detector only cuts audio; it never decides to stop listening.
  5. A segment stays 16-bit PCM at 16 kHz in memory. It's encoded only when a receiver needs it, in the format §10.6 picks.
- **Phone dictation.** The browser's speech recognition produces the segments itself. It can't run alongside recording.

Privacy:
- Audio leaves the phone only when speech was detected, and only to the configured speech-in entry.
- Transcripts go into the log.
- Audio is discarded unless the user turns on "keep voice clips".
- A kept clip is stored compressed: the smallest format the phone both makes and plays (§10.6), Opus where it can. It's named by its `heard` event, as everything stored is (§4.9).

### 10.3 Speech-in list resolution

Entries:
- each configured transcription model
- one stand-in entry, **"Send audio to the model"**
- phone dictation, where available. The browser's own speech service hears it (Google on Chrome, Apple on Safari), unless it recognizes speech on the device (§11.7).

The default order is "Send audio to the model", then phone dictation. Transcription models come from providers' transcription abilities. One the user adds goes after "Send audio to the model"; a provider's join after phone dictation when it is added (§9.8). With no usable entry (for example, on iOS with a text-only model and no transcription model), the mic button explains what to add.

**The list is resolved again for each model attempt, against the model actually receiving the speech.** That applies to any role, including quick decision.
- "Send audio to the model" is used only if that model accepts audio. Otherwise it's skipped.
- Example: main = `M1 (audio) → M2 (text only) → M3 (audio)`, speech-in = `send audio → ASR-A → dictation`. The attempts go M1 with audio → M2 with ASR-A's transcript → M3 with audio again.

What makes this work:
- Each segment stays in memory until the turn that used it succeeds.
- Transcripts are cached per segment and per ASR model, so ASR-A runs once however many models need its transcript.
- A failed ASR model is benched like any other model.
- **Text versions are made lazily.** A segment sent as raw audio is transcribed only when something text-only first needs it: a later text-only model, compaction, or the trace. The first transcription-capable entry does it, and the result is cached. With no such entry, it's stored as "[audio, not transcribed]".
- **Dictation is exclusive.** If phone dictation is the first *usable* entry, segments arrive as text only, and audio-based entries can't apply to them. If dictation fails, listening switches to recording from the next segment.

### 10.4 Turn-taking

- **`speak` returns** when the first segment arrives, or after about 8 s of silence (tunable). Shiori can call `wait(seconds)` to listen longer.
- **During a listening window, the mic keeps recording while a model call runs.** New segments go into the wake queue as "heard while you were thinking: …". Nothing heard is lost: if the turn ends with `sleep` but speech arrived meanwhile, a new turn starts.
- **The quick-decision gate** sits between what was heard and the main model. It runs only when a quick-decision model is configured, because falling back to the main model would double the calls. Without one, what was heard goes straight to the main model, which can respond or sleep. When the gate runs:
  - meant for Shiori → main model
  - chatter → record it and sleep
  - unsure → main model

  Dismissed speech still goes into the transcript, so Shiori knows what was said.
- **Speaking and listening never overlap** (half-duplex). Tapping the avatar while she speaks stops her, records the cut-off point, and opens the mic. Tapping it while she sleeps starts listening.

### 10.5 Voice mode: Auto / On / Off

The setting is always one tap away. **Auto:**
- moving fast (driving or riding) → on
- headphones or car audio detected → on
- otherwise, on the phone speaker → off

Where the browser can't detect headphones, Auto falls back to the user's last explicit choice in that situation.

With a realtime model as Koe (§10.8), the mode decides whether a live session speaks and, at a tap, listens: voice off closes one, and a session for typing shows Koe's words.

### 10.6 Audio formats

The user: "use the most efficient codec each provider supports … to cut down data usage and increase reliability on trips". The Koe and Kokoro design (docs/superpowers/specs/2026-10-19-koe-kokoro-design.md, "Audio formats") has the measurements.

- **Each ability says what it takes and gives,** as tunables in the protocol plugin's defaults and the provider description (docs/plugins.md, "Audio formats"):
  - `audioIn`: what a transcription or a chat model takes;
  - `audioOut`: what a voice gives.

  Formats are named by file kind: `ogg` and `webm` (Opus), `mp4` and `aac` (AAC), `mp3`, `flac`, `wav`; `opus` is OpenAI's name for Ogg Opus. A model whose ability says nothing gets WAV, as before.
- **annai sends the smallest format both sides handle.** The order is by codec: Opus, then AAC, MP3, FLAC, and WAV last. Within a codec, the receiver's own order counts.
  - It's chosen again for each receiver: a transcription model, or a chat model for "Send audio to the model" (§10.3).
  - Each format is made once per segment and kept with it.
- **What the phone makes:**
  1. WebCodecs' `AudioEncoder`, at 16 kHz, with annai's own small Ogg, WebM, ADTS and FLAC files (no library). Each codec is tried once on a tenth of a second, with a time limit, since a browser may say it has one that then fails or hangs. An encoding that fails or runs past its limit falls to the next format, and its codec isn't used again until annai restarts.
  2. Where the encoder makes nothing a receiver takes, `MediaRecorder` records alongside. It's cut with each segment, and starts again every 2 s while nobody speaks.
  3. WAV, which annai always makes itself.

  The choice is made at run time, by trying, never by the browser's name.
- **Speech out:** a voice whose `format` is `auto` is asked for the smallest format it offers that the phone plays. A voice that refuses it (Speaches refuses Opus and AAC) is asked for MP3, then WAV, until annai restarts.
- **Reliability:**
  - A failed upload (network or server) is sent again twice, with the same bytes. A turn that's stopped stops them.
  - A transcription model that refuses any other format gets WAV at once (whisper.cpp's server says only "Invalid request"). A chat model gets it when its refusal names the audio or its format. If WAV works, that model gets WAV until annai restarts; if WAV is refused too, it fails as before.
- **The Trace** shows each clip's format and size: kept, sent to be written down, sent to a model, and what a voice sent back. Settings → Voice says what this phone makes and plays.

### 10.7 Two halves

While Shiori is two halves (§6.8), the one voice is Koe's:
- **Koe talks and listens** through everything above. Its list is "Koe for talking" while voice is on and "Koe for typing" while it's off, an empty one using the other (§9.6), so a typing model can talk too. Listening is judged against Koe's own models: whether they take audio for "Send audio to the model". When Koe heard the sound, its model writes it down.
- **Kokoro** never opens the microphone or speaks while Koe works; it speaks, as Shiori always did, only while Koe is down. One voice at a time: when Koe comes back while a Kokoro turn has the voice (or its tap's window is open), Kokoro keeps it to that turn's end, and Koe takes over after; when Koe goes down mid-turn, Kokoro's next step speaks aloud. The sign's Stop stops Kokoro, never Koe's voice. What was heard is written down once, after Koe's turn, and Kokoro reads it from there.
- **Koe's `speak` doesn't listen when its question to Kokoro or its `wait` follows it** in the same reply: they run at once. Followed by anything else (a card, say), it listens as Shiori's always did. With voice on, `wait` listens: it ends on Kokoro's note, the user speaking or typing, "Kokoro has nothing to add", or its time limit. Meanwhile the sign shows, and the user can keep talking.
- **A note from Kokoro ends Koe's listening,** so Kokoro's answer is said without dead air. While the user is speaking, their words come first, and the note with them. An immediate note also cuts Koe's speech where it is; its `speak` result says where, and Koe corrects itself. Cut while the reply still streamed in, what Koe had said aloud is written into the conversation, marked cut, and Koe hears "a note stopped you after: …".
- **Chatter** goes through the quick-decision gate (§10.4) as before. Dismissed, it still goes into both transcripts, labelled as not meant for Shiori even inside the result of Koe's listening, and wakes neither half.

### 10.8 Live sessions

When the first model of Koe's list that can answer is a realtime one (§9.1, Gemini Live), Koe talks in live sessions: one stream both ways, its own voice, both transcripts (the Koe and Kokoro design, "Realtime sessions"). Its pathway walks its list, then the other Koe list: a live model resting, off or without its protocol running is passed over.
- **Opening,** never by itself, so no microphone stays open between sessions:
  - a tap on Shiori, with voice on: the session and the microphone;
  - a typed message or a photo: a session without the microphone. With voice off, its reply is Koe's bubble (its transcript) and its sound is dropped; when voice comes on, the same session speaks, and a tap gives it the microphone;
  - a trigger, or a note from Kokoro, to say: a session that speaks, then, once a tap has unlocked sound, listens for an answer only as long as Shiori's speak does ("Listen for an answer", 8 s), the quiet spell holding once the user speaks, types or taps;
  - nothing from a page out of view, and nothing streams from one: what comes meanwhile waits, and is said when the page is back, without the microphone; a trigger's reminder shows at once, as annai's always do.
  - A message, note or wake no session can take goes to Koe's next model; with none left, a card says Koe's live voice couldn't start, and Kokoro answers directly at once.
- **Closing,** with the microphone, and full-quality playback back (§10.1): voice off; another conversation, or Erase, which forget its handle; the page going out of view or away; a tap while it listens; Spend per day reached (with its card, §6.6); and a quiet spell, "Close a live session after" in Settings → Voice, 30 seconds by default (10 to 300), with no speech either way, no tool call, and no question of Koe's that Kokoro is still working on. 30 s is longer than a pause in talk, short enough for the car's music to come back soon and the free tier not to be spent holding it.
- **Sound:** the microphone streams only speech, through annai's end-of-sentence detector and the API's manual turns (§10.6): nothing while nobody speaks. While Koe plays, a start needs 6 dB more ("Cut her off by speaking", on by default; off, only a tap does). Koe's voice plays from its first real word: a turn with none (markup, a pause, a sound) plays nothing and is logged as nothing. One voice and one microphone at a time: the speech pipeline lets go of both as a session takes them.
- **What is logged,** for both halves, per turn: what was heard and what Koe said, markup gone and every word escaped. A line cut off (by the user's voice, a tap, a note or a drop) is kept up to where it was heard, marked ✂. Words heard late are added. Speech the model leaves unanswered (Gemini's proactive audio) is heard, not meant for Shiori, and wakes nobody. Kept clips as §10.2.
- **Tools** are answered at once: `tell_kokoro` "sent", `show` and `ask` (whose tap comes as the next text turn) without more speech; reads and light changes with their result, escaped as a text Koe reads one. A live Koe has no `speak`, `wait` or `sleep`.
- **Notes** from Kokoro are text turns in `<from_kokoro id="…">`: an append once Koe's turn and voice have ended, an immediate one at once, cutting Koe off. Kokoro reads a block when a session opens, closes or drops, never a change of its system text or tools.
- **Going on:** at GoAway, annai reconnects with the resume handle at the next pause. A drop keeps the lines it cut and connects again, with the handle where the provider gives one (else a fresh session with the conversation's last lines), a tool call being worked out answered in the resumed session; three tries at most with no turn between them, each waiting longer. Failing that, the model rests, Kokoro is told, and Koe's next model (its list, then the other) finishes a cut answer through the speech pipeline, or Kokoro does while Koe is down. Handles are kept in memory only. A tap that stops Koe's voice tells the provider where it was heard (`cut`), as a spoken interruption or an immediate note does.
- **Its setup:** Koe's live instructions, Shiori's personality and the profile; the conversation's last 12 lines, every word quoted and escaped; the now block, `<today>` and the notes' nonce.

## 11. Triggers and live mode

### 11.1 Live mode

A switch. While it's on and annai is on screen:
- GPS tracking runs.
- Triggers are evaluated.
- The screen wake lock is the user's choice per situation (on the car charger, yes; walking, probably not).

When the phone locks, the app freezes, and catch-up (§11.4) covers the gap.

### 11.2 Sensors (built-in plugins)

| Sensor | Behaviour |
|---|---|
| Clock | One timer, set for the next due watch. Re-checked whenever the app becomes visible. |
| Location | `watchPosition`, thinned as in §4.5. |
| Activity | still / walking / moving fast, from GPS speed, with 30–60 s hysteresis. GPS can't tell driving from riding a bus, so voice Auto treats both the same and a passenger can switch voice off. |
| Visibility | the app going off and back on screen |
| Connectivity | online or offline |

### 11.3 Triggers and watches

| Type | Fires when |
|---|---|
| `time` | at a moment |
| `every` | at an interval |
| `enter`, `leave` | crossing a circle around a place, with a margin so GPS jitter at the edge doesn't refire it |
| `dwell` | inside a place longer than X |
| `arrived` | stopped somewhere new for N minutes |
| `moved` | X km travelled since the last wake |
| `activity` | an activity starts or stops |
| `plan` | a plan item is coming up, running late, or the user is off-plan |

Plugins can add types.

**Every watch has a fallback message.** When the watch fires and the model can't be reached, the fallback is shown or spoken directly. While Shiori is two halves, a firing wakes both (§6.1): Koe says what is simple at once and waits for Kokoro's note for anything that needs judgement, and the fallback goes with Koe's wake only, so it is said once.

**Plan items create their own watches.** The system sets these, so they don't depend on Shiori remembering:
- leave in X minutes
- arrived
- running late

The travel-time estimate is deliberately rough (straight-line distance × a detour factor ÷ a typical speed for the mode of travel), so reminders err early. The fallbacks are filled in from the plan data, for example "Flight UA123 departs 14:05, SFO T3".

### 11.4 Catch-up

When the app becomes visible:
- time watches that came due while frozen fire late, labelled "late by N min"
- arriving at and leaving places is inferred from the last known position versus the current one
- everything goes into one catch-up wake, with the elapsed time and distance

### 11.5 Replanning, narration, offline pack

- **Off-plan detection.** The user is far from the current item while it's scheduled, or lingers somewhere not on the plan. Either wakes Shiori, who:
  - welcomes the detour
  - says what it costs
  - reshuffles flexible items while protecting fixed ones

  Every replan is a set of patches to the plan files, so it can be undone.
- **Narration is a built-in skill, not code.** The driving-companion skill tells Shiori to set a `moved`/`every` watch when driving starts, and to check `nearby` along the road when it fires. Narration takes into account the travel party, preferences, personality and mood.
- **The offline pack.** Before the trip, or whenever the phone is on Wi-Fi, annai downloads data for each destination and along the planned route:
  - Wikivoyage sections
  - Wikipedia summaries of nearby places
  - OpenStreetMap points of interest

  The estimated size is shown before downloading. Sunrise, sunset and golden hour are computed on the phone.

### 11.6 Push relay (closed app)

- **Scope.** Only time watches are mirrored, and only when notifications are enabled. Location triggers never leave the phone.
- **Encryption.** The page encrypts each notification itself with the push subscription's keys (RFC 8291, `aes128gcm`, using WebCrypto's ECDH, HKDF and AES-GCM). The relay never sees the content.
- **The relay** holds the VAPID keypair and does three things:
  - stores `{push endpoint, ciphertext, sendAt, id, cancel token}`
  - sends at `sendAt`
  - deletes the record after sending or on expiry

  It learns only the push endpoint, the timing, and how many reminders there are.
- **API:**
  - `GET /v1/vapid`: the public key
  - `POST /v1/schedule`
  - `DELETE /v1/schedule/:id` (requires the cancel token)
- **Abuse limits** live on the relay: payloads up to 4 KB, at most 200 pending per subscription, at most 30 days ahead, and rate limits per IP.
- **Cancelling a watch** deletes it at the relay. **Opening a notification** starts a catch-up wake with "opened the reminder for X".
- **Deployment:** the relay is written as a Cloudflare Worker. Each push subscription gets its own Durable Object, which holds that subscription's pending messages and uses its alarm to fire at the next `sendAt`. The same code runs in Node (`relay/serve.mjs`, its storage in a file), and that is how `push.annai.guide` runs while annai is being tested: on the author's own machine behind a reverse proxy. It moves to a Cloudflare Worker once things settle. The source is published under `relay/` for self-hosting either way.

### 11.7 Privacy

- The Places tools send coordinates to OpenStreetMap, Wikipedia and Open-Meteo.
- Location otherwise goes only to the user's own model provider.
- With notifications on, the push relay gets each time reminder encrypted, and learns only the push endpoint, the timing and how many there are (§11.6).
- Speech goes only to the entries in the speech-in list. Phone dictation and the browser voice go to the browser's own speech service (Google on Chrome, Apple on Safari) unless they run on the device. Settings → Voice says where each one goes, and the trace notes it.

## 12. Import, export and backup

### 12.1 Archive format

A zip written and read by our own code: `CompressionStream` / `DecompressionStream` with `deflate-raw`, plus a CRC-32 of our own.

```
annai-archive.json                   manifest: format version, app version, kind (trip | everything),
                                     contents, SHA-256 of every entry, encrypted flag (written last)
me/<path>                            global files (only in "everything")
trips/<id>/<path>                    a trip's current files at readable paths
trips/<id>/.annai/events.jsonl       that trip's event log (when history is included)
system/settings/…, system/plugins/…  app settings and installed plugins (only in "everything")
system/log/.annai/events.jsonl       the system log (only in a "Backup" of everything)
blobs/<sha256>                       older versions the logs reference that aren't current files
system/secrets.json                  API keys (encrypted backups only, when chosen)
```

The archive is written as a stream, so photo-heavy trips don't need to fit in memory.

### 12.2 Export

- **Scope:** one trip, or everything.
- **Contents, as tickboxes with presets:**
  - **Backup:** everything.
  - **Share:** plan, bookings, files and notes. No conversation, trace, memory or location history unless ticked.
- **Photos:**
  - A Backup contains each photo as it is stored, so it has the originals when Keep originals is on (§4.8).
  - A Share contains only encoded photos. A kept original, and a photo in a format some browsers can't show, goes through the ingest encoding first.
  - "Include where photos were taken" is a tickbox, on by default: a trip's plan names its hotels anyway.
- **Keys** are included only in an encrypted Backup, and only when explicitly chosen.
- **Encryption (optional):** the whole zip is encrypted with a passphrase, using PBKDF2-SHA-256 to derive the key and AES-GCM to encrypt. It is sealed in 1 MiB chunks, each bound to its position and to whether it is the last, so neither side holds the whole file in memory and a dropped, moved or cut-off chunk is refused.
- **File names:** encrypted files end in `.annai`; plain ones end in `.annai.zip`.
- **Saving:** the share sheet on phones (Files, iCloud Drive, AirDrop…), a download on desktop.
- **Later: Share to GitHub.** Writes a Share to a repo the user picks, public repos allowed with a warning, and gives the `annai.guide/#import=<url>` link (§12.3). Backups stay refused on public repos (§12.4).

### 12.3 Import

- **Ways in:**
  - the file picker, or drag-and-drop
  - Android share target (installed web apps can receive shares on Android; iOS doesn't support it)
  - `annai.guide/#import=<url>`, for archives the sender hosts somewhere that allows browser access, such as GitHub raw files or Dropbox
- **Preview card:** name, dates, size, contents, exporter, format version.
- **Choice:** "Add as a new trip", or "Replace mine", which moves the existing copy to archived trips. Nothing is overwritten silently.
- **Checks:** fingerprints are verified and older formats are migrated. Files belonging to plugins that aren't installed are kept, inactive.
- **A trip archive never contains the sender's global memory.** The recipient's own Shiori, personality and memory pick up the trip.

### 12.4 Backup targets

- **Interface:** archive-level `put / get / list / delete`, via storage plugins.
- **Automatic backup:** daily or after changes, while on Wi-Fi with the app open. It runs alongside the install nudge, not instead of it.
  - **The pace after changes:** git targets (GitHub, Forgejo / Gitea) back up within the hour, since each backup sends only what changed. Targets that keep the whole archive file (S3, WebDAV) back up at most every 6 hours.
- **Git targets store the unpacked tree, not a zip.** One backup is one commit, and only changed files are uploaded. They are unencrypted, so public repositories are refused.
- **Single writer.** A newer remote backup from another device triggers a warning and an offer to import it as a copy.
- **First targets:**
  - **GitHub:** through its web API (the Git Data API), which accepts browser calls.
  - **Forgejo / Gitea**, such as the user's own server or Codeberg (which runs Forgejo): through its API, which accepts browser calls once the server allows annai's address. We show the lines to add to its app.ini.
    - Commits are made with ChangeFiles. Each update and delete names the file it replaces, so another device's backup made meanwhile is refused, never overwritten.
    - The user makes the private repository; the token needs only Repository: Read and write.
    - Owner and Repository may be left empty. Save and test then looks through the private repositories the token can change: it fills in the only one, or lists them for the user to pick. It never offers a public one, and keeps what it filled in.
    - **Large backups:** one request carries at most 8 MiB and 200 files. A larger backup goes as several commits: the parts first, then the commit with the new `annai-archive.json`, which is the only one listed or restored. A backup cut off half way carries on from its parts. A request the server, or a proxy in front of it, refuses as too large goes again in halves; a single file too large is named, with the limit to raise.
  - **S3-compatible:** the user configures the bucket's browser-access (CORS) rules; we show the exact JSON to paste.
  - **WebDAV:** where the server allows browser access.
- **Later targets:**
  - GitLab
  - Google Drive and Dropbox (each needs us to register an OAuth app)
  - the user's own git server without Forgejo or Gitea (needs browser-access headers in Apache, plus a small commit-and-push git client of our own)
- **iCloud** is manual only, through the share sheet.

## 13. After the trip

- **Recap.** The utility model summarizes the event log, notes and photos into a recap stored as `/trip/recap.md`. Shiori can tell it by voice (Koe, while she is two halves, §6.1).
- **Replay.** A timeline of the trip:
  - places, Shiori's cards, photos, and the user's messages
  - the route drawn as an SVG polyline from the location points, using a simple equirectangular projection and no map tiles
  - playback at adjustable speed
- **Stamps.** Each `arrived` event at a plan place or point of interest earns a stamp, shown on trip cards and in replay. Stamps are computed from the log, not stored.
- **Trip simulation.** Developer → "Simulate a trip" feeds a recorded or fake GPS track and clock through the same machinery. Replay and testing share it.

## 14. Personalities, memory, profile

### 14.1 Personalities

- **Every personality is a full Markdown file that Shiori can rewrite completely,** whether shipped or user-made.
- **Shipped originals stay read-only** for "reset to original". File history allows rollback to any version.
- **When we update an original:**
  - an unedited copy follows the update silently
  - an edited copy gets "a new version of the original is available", with compare, keep mine, or let Shiori merge
- **Settings → Shiori** holds them: how she looks in each state, the personalities (choose one; edit its text, saved with its button; make a new one from it), "Ask me before Shiori changes her personality", and how often she acts on her own (wakes per hour, quiet hours, steps per wake; §6.6). Spend per day, the cache and housekeeping are on Settings → Models.
- **Shiori changes a personality only through `tune_personality`.** The flow:
  1. The utility model reviews the change: is it about behaviour only (facts about the user go to memory)? Has it bloated? Does it contradict the base safety rules?
  2. An approved change applies at her next wake, never mid-conversation.
  3. A card reports it ("I adjusted: shorter answers while driving") with one-tap undo.
  4. Setting: "Ask me before Shiori changes her personality".
- Three presets ship with the app. Users can create their own, or ask Shiori to.
  - **Shiori:** the default. Warm, concise, and speaks up when something is worth it.
  - **Storyteller:** more narration, history and local stories, especially on drives.
  - **Quiet:** speaks only when asked, or for reminders and fixed commitments.

### 14.2 Memory and profile

- **Memory** is plain Markdown in `/me/memory.md` (global) and `/trip/memory.md` (per trip). Shiori writes it with the file tools and consolidates it during housekeeping.
- **The profile** (`/me/profile.md`) holds what to call the user, their language, units, and lasting preferences.
- **The travel party** lives in `trip.json`.

### 14.3 Language

- The UI ships in English. All strings live in one module, ready for translation.
- Shiori replies in the user's language.
- Dates, numbers, units and currency are formatted with `Intl` according to the profile.

## 15. Security and privacy

- **No third-party scripts.** A strict Content Security Policy (served via `_headers`):
  - `default-src 'self'`
  - `script-src 'self'`
  - `style-src 'self'`
  - `connect-src https: http://localhost:* http://127.0.0.1:* wss: ws://localhost:* ws://127.0.0.1:*` (user-configured endpoints; `wss:` for live voice sessions, plain `ws:` only on this device)
  - `img-src 'self' blob: data: https:`
  - `media-src 'self' blob:`
  - `worker-src 'self' blob:`
  - `frame-ancestors 'none'`
  - `object-src 'none'`
  - `'wasm-unsafe-eval'` joins `script-src` when the first WebAssembly encoder plugin does (§4.8). It allows compiling WebAssembly, not running text as JavaScript.
- **Model output never goes into `innerHTML`.** Our own small Markdown renderer builds DOM nodes and escapes everything else.
- **API keys:** stored in `secrets`, never in context, redacted from the trace, and excluded from exports by default. A key a realtime protocol gives as a subprotocol, as OpenAI Realtime's does, is held to the same origin rule as one in the address (below), and a refusal that says it back is blanked (K6).
- **The responsibility model (§2, principle 2):**
  - Imported and fetched content is the user's responsibility.
  - The trace makes everything the agent sent and read visible.
  - A request a protocol plugin builds is sent only to the origin of its provider ability's address, so a description's tunables can't send a key to another host while the install screen names the right one. A live voice session's WebSocket is held to the same rule (§9.1): annai opens it, never the protocol, and refuses any other origin before anything opens. A key a provider takes only in the address, as Gemini Live's, goes nowhere else, and is never traced.
  - **Listening live.** While a live session's microphone is open (§10.8), what the user says goes to the provider as it is said, only while someone speaks: the voice chip says "Listening live", and Settings → Voice names where it goes. Sessions close when the page goes out of view or away, and before Erase wipes anything; nothing opens or streams from a page out of view. The Trace records each session's opening, closing, data and cost, and its tool calls.
  - Third-party code plugins run with full trust, and their install screen says so. Data-only plugins (a provider, skills, personalities) can't run anything and get no such warning; a provider's install screen says where keys go, and an update that sends them to a new origin asks first (§5.3).
- **No telemetry.** "Copy diagnostics" produces a redacted report for the user to share if they choose.
- **Credits.** Every data source annai contacts is credited in Settings → About, with the attribution its licence or policy asks for:
  - OpenStreetMap: "© OpenStreetMap contributors", under the ODbL, linked to its copyright page; through Overpass, and Nominatim under its usage policy
  - Wikipedia and Wikivoyage: their contributors, under CC BY-SA 4.0
  - Open-Meteo: "Weather data by Open-Meteo.com", under CC BY 4.0
  - Jina Reader and Jina Search

  Where a licence asks for it next to the data, it is there too: the offline pack panel credits OpenStreetMap, Wikipedia and Wikivoyage, the weather tool's answer, which the Trace shows, starts with Open-Meteo's credit, and the guide tool's answer carries its Wikivoyage article's address, as nearby's Wikipedia rows do. annai draws no map tiles. A unit test fails when the code names a host that is neither credited nor listed with the reason it isn't a source.

## 16. UI

### 16.1 Principles

- Glance, tap or talk.
- One main thing per screen.
- Big targets.
- Short cards.
- Spoken words hidden unless asked.
- **System cards are not Shiori.** System problems appear as system cards, never in Shiori's voice.
- **Settings save as they change.** A quiet "Saved" shows by the field, not a toast, and an error shows by it too; a value that isn't valid isn't saved. Text and number fields save once committed or left, never at each keystroke. A Save button stays only for:
  - keys and passwords: a provider's key, the Jina key, a plugin's secret fields, a backup place's credentials and passphrase
  - connections that are tested or used as a whole when saved: a backup place ("Save and test"), the push relay's address, and a provider's address, key and extra headers (headers often carry a credential, and a half-typed connection should never be used)
  - long texts: a personality, the file editor

### 16.2 Layout and screens

Reference: mockups draft 6.

- **The dock** sits at the bottom of every screen: camera · Shiori · type. Voice layouts, such as driving, enlarge the dock; they never move it. While Kokoro works behind Koe (§6.8), a sign says "Kokoro is working", with Stop, which ends Kokoro's turn alone. While a live session's microphone is open (§10.8), the voice chip says "Listening live"; while one is open for typing, "· live".
- **One Shiori per screen.** Speech bubbles carry a "SHIORI" label instead of a second avatar.
- **The top bar** shows the trip name (tap to switch trips) and a menu: Plan, Conversation, Files, Trace, Settings.
- **Screens:**
  - **Now**, the home screen during a trip: current place, golden hour and other chips, the next items as a timetable, the latest card
  - **Driving:** route strip, "Show what she's saying", a maps card, big quick-ask buttons
  - **Camera / snap and ask**
  - **Photo viewer:** tap a photo to see the stored photo at full size, with pinch zoom. "Show Shiori this part" crops what is on screen and sends it (§4.8).
  - **Plan:** day tabs, a timetable with ● fixed and ○ flexible, drive legs between stops, and "Check this" chips
  - **Booking confirmation**
  - **Trips:** the install warning, trip cards with stamps, backup status (when each trip was last backed up), "Open a trip someone sent you"
  - **Conversation:** what the user said and what Shiori said, showed and asked. While she is two halves (§6.8), that is Koe's: Kokoro's wakes and errors, the notes between the halves, annai's blocks and the errors the other half told the user of stay out (a card still says what needs saying), until "Show what the halves tell each other" (at the foot, remembered on this device) shows the notes as quiet lines.
  - **Files**
  - **Trace:** filters plus tool switches. Model turns say whose they are (Koe, Kokoro or Shiori), notes and blocks have lines of their own, and a Halves kind shows them.
  - **Settings,** in the order a user reaches for them, most often first: Models, Voice, Notifications, Backup (with "Open an annai file"), Shiori, Photos, Tools, Plugins and the pages plugins add, Storage; then Updates, About, Diagnostics, Developer, Experimental, and Erase last. While an update waits, of annai or of a plugin, Updates comes first, with a line saying what waits.
    - **Models:** the one-tap start, the featured provider's sign-in, while there is no provider (§9.8), the providers (each with the abilities switched on and its number of models) and Add a provider (the catalog, on model providers), the roles (§9.6), Koe's two lists right after Main, chat roles taking chat models and speech roles transcription models or voices (each speech role with Add a provider: the catalog, on what has transcription, or a voice), then what Shiori's requests may cost and how large they grow: Spend per day (§6.6), the cache (§6.4) and housekeeping (§6.5). Each chat model's page has "Try this model": a short conversation with that model alone, with no fallback, showing each reply's tokens and cost, and keeping nothing but the trace. Speech models have their Test instead. A provider's page has its name; its key (written once, with Get a key), address and extra headers, saved together, with its plugin's own panel in the key's place where it has one (OpenRouter's Sign in again, §5.4); its note; the suggestion buttons; one panel per ability with its switch, its own address, tunables, extra fields, photo uploads, its models (Add a model by id, Fetch model list) and Test; and Remove, which takes its key, models and their places in roles, and its plugin when it is the last made from it.
    - **Add** (the catalog): one screen for everything a user can add, from model providers to skills. It lists annai's official catalog, everything installed (third-party plugins too, each as what it is: from its address's host, or a file), the fixed row An MCP server, and at its foot installing from an address or a file (the install screen first, §5.1). annai's built-in parts aren't listed: they are there already.
      - **Search** (a must) covers the name, then the plugin's `keywords`, then its description; an ability ("voice", "voices") and "free" match too. A name match ranks above a keyword match, so the more specific plugin comes first ("lm studio": LM Studio, then llama.cpp), and a row that matched on a keyword says why ("Also for: LM Studio"). Matching ignores case, spaces and punctuation ("lm studio" is "lmstudio"), and starts at a word (a capital after a small letter starts one, so "router" finds OpenRouter). A query with spaces that matches nowhere whole needs each word to match somewhere ("free voice"). Results rank by match, then featured, then official, then name. It is a few lines of annai's own, with no search library.
      - **With nothing typed** it is browsable, grouped by kind (Model providers, Voices and transcription, Backup places, Tools and MCP, Skills and personalities, Developer), showing only kinds with something in them; the catch-alls, Another address and An MCP server, come last in theirs.
      - **Chips** filter by kind, ability (Chat, Transcription, Voice), Free, Local, and Official or Third-party. A chip shows when it would keep some of the list and not all of it, or when it is on.
      - **Each row** shows the name, its abilities, Free and Local, where it comes from (Official, or from an address's host or a file), data only or has code, and its size, and what can be done: Add (a provider: its plugin and what it requires, then the provider's page, or the plugin's own Add flow where it has one, §5.4), Added with Add another once one is set up, Set up (a backup place, on Backups with its kind chosen; an MCP server, on its screen), Install (another official plugin), or Open (an installed plugin's page). A copy from elsewhere that holds an official plugin's id is never listed as annai's: annai's row says to remove that copy first.
      - **It opens filtered to where the user came from:** Models → Add a provider on Model providers; a speech role's Add a provider on Transcription or Voice; Plugins → Add on everything; Experimental's Remote trace on Developer. Its crumb goes back there, and the install screen's crumb and Cancel go back to Add. Offline, it says annai's catalog couldn't be loaded, and what is installed still lists.
    - **Plugins:** what is installed, each with its state, update and actions, searched and filtered as the catalog is, grouped by kind with nothing typed. Provider plugins are under Model providers, naming the providers made from them; protocol plugins name what needs them. Add opens the catalog.
    - **Shiori:** how she looks, her personality, and how often she acts on her own (§14.1).
    - **Updates:** annai's version and the build running; when annai last checked, and Check now, which checks annai and every plugin, those from an address too; a new version of annai that waits, with Restart now; each plugin update with its own Update. It says plainly when everything is up to date, when annai is offline, and what a check couldn't reach.
    - **About:** annai's version and the build of the service worker that runs it, with a link to Updates; the licence (AGPL-3.0, its text shipped and readable offline) and the source; where to report a problem; the privacy summary (what annai does with keys and data, and where that stops, in the welcome's words); the fine print; "Show the welcome again"; and the credits (§15), the fonts' licences and Shiori's art.
    - **Experimental:** features still being tried, each off until turned on. The first is swiping between tabs.
  - **Onboarding:**
    - **the welcome,** once per device, at annai's plain start (`/`): what annai is, what it can do, your keys and data, the fine print, then the install guide where annai isn't installed and Settings → Models with the featured provider's sign-in, whose sentence it says (§9.8). It is in annai's voice, not Shiori's, and its steps can be skipped. A link that opens a screen (a shared trip, a share, the sign-in coming back) is never interrupted; the welcome waits for the next plain start. It is noted in the app's settings, so Erase brings it back, as on a new device.
    - the install guide, the featured provider's sign-in, profile
  - **Import preview**
  - **Recap and Replay**
- **Swiping sideways between the top bar's tabs** is experimental and off by default (Settings → Experimental). On, swiping into a tab brings back the screen last open in it, where you were on it.
- **Visual identity:**
  - vermilion accent
  - cool, plain paper neutrals
  - Zen Maru Gothic for display text, Zen Kaku Gothic New for body text, IBM Plex Mono for data
  - timetable rows like a trip booklet's schedule page
  - the 枝折戸 diamond-lattice pattern as a quiet texture
  - station-stamp marks for visited places
  - light and dark themes

  Fonts are self-hosted, since the security policy allows only `'self'`.

### 16.3 Shiori, the character

- **Design:** a white fox (白狐, Inari's messenger) in a vermilion scarf. Her 枝折り hairpin is a twig with a strip of pink trail tape tied on, worn at her left ear.
  - Eyes only.
  - Her tail shows in two states only: asleep (curled across her front) and working (its tip, as she leaves the frame).
  - The Inari foxes hold a token in their mouths; Shiori's token is the hairpin.
- **Her art** comes from the user's art kit, whose master picture decides every visible shape, position and colour (soft curved fur, sloping shoulders, dark outlines).
  - A dev-time tool (`scripts/shiori-art/`) traces the master into parts that move on their own, like a puppet's: body, ears, head, the hairpin, and the tape's tail on it. The kit's other parts fill what the master can't show: her ears folded flat or angled out, her head turned three-quarters (from the kit's turned master), her head asleep and her tail wrapped round her (from the kit's asleep masters), her tail's tip, and her trail marker in its grass.
  - The parts are one SVG file, `assets/shiori.svg`, which the service worker keeps for offline use.
  - States move the parts with transforms and transitions. Each upright ear leans from its base, which stays put, so the seam with her head never opens; the hairpin moves with her left ear. A pose past what a lean can do (an ear folded or angled out, her head asleep) is its own drawing, which takes over halfway through the move. Her head turns to the side (Thinking) in the middle of a blink, which hides the cut.
  - The pink tape streamer is drawn live too, as a path that waves: from her hairpin's bow while she talks, and from her marker's knot while she works.
  - Her eyes are drawn live as SVG shapes, measured from the masters, so blinks, glances and narrowing change smoothly: open, wide, drowsy (a lid whose edge curves with the eye), sad (half-lidded, the lids sloping down toward the outer corners, never flat), closed (a thick ‿, as on the app icon), and the turned head's own pair.
  - Her seat is pale tea green, a darker tea in dark mode, with a dark ring. On the dark seat, her trail marker's twig is lighter. The app icon stays vermilion.
  - The expression sheet in the user's art kit is the target for how each state looks.
- **Her gaze carries the state:**

| State | Look | Dock label |
|---|---|---|
| Asleep | eyes closed, ears folded flat, her head dipped and resting on her tail, which is wrapped round her; slow breathing lifts her, and her tail with it (a loop) | Tap to talk |
| Listening | facing you, ears up | Listening |
| Hearing you | ears leaning in, eyes wide; the seat glow (grey) follows your voice level | Hearing you |
| Thinking | head turned to the side (mid-blink), looking up and away | Thinking |
| Talking | facing you, open eyes; her head, the seat glow (vermilion) and the streamer, which waves and swings out, follow her voice level | Tap to interrupt |
| Your turn | facing you, leaning, head tilted, her left ear angled out | Waiting for your OK |
| Working | stepped out of her seat, leaving her trail marker in its grass, its streamer waving, paw prints, and her tail's tip, wagging gently (loops); tap it to see what she's doing | Working on … |
| Offline | present, grey and dim, sad half-lidded eyes with no highlight, ears folded flat | Offline · reminders still work |

- **Movement is driven by events and transitions:** blinks at random intervals, a glance toward a newly appearing card, ears reacting, the streamer following her voice. The only loops: her breathing while asleep, and while she works, her tail's tip wagging and her marker's streamer waving.
- **Reduced-motion preference:** no glances, no transitions, no waving and no loops. Her voice still swings the streamer, as a still pose.
- **Out of sight** (scrolled away, or off the page), nothing of hers moves or redraws until she is seen again.
- **The glow follows the real audio level,** read from Web Audio analysers on output and input.
- **The avatar is a named component** with this interface:
  - `setState(state)`
  - `setLevel(0..1)`
  - `glance(dx, dy)`
  - `blink()`

  Plugins and personality packs can replace the art.


### 16.4 UI extension

- **Slots:** status chips, Now-card sections, dock actions, trip tabs, settings pages.
- **Card types:** renderers, often paired with a schema.
- **Named components that plugins can replace:** avatar, now-card, dock, plan-row, and others. They are names like any other (§5.6): annai's own is used until the user chooses a plugin's, at its install (`replaces`) or on its page.
- **Whole screens:** a new tab, or the home screen for a mode such as hiking.
- **Themes:** all colors, type and spacing are CSS variables.
- **Only slots, components and variables are stable across updates.**

### 16.5 Accessibility

- semantic HTML
- labelled controls
- large targets
- visible focus
- the reduced-motion preference respected

Eyes-free voice mode also serves users with low vision.

## 17. Error handling

1. **Never lose data.**
   - Writes are transactional (§4.2).
   - "Storage full" shows a card with real options: export a backup, remove a trip (§4.9), delete trace bodies or cached photo copies, or free up space on the device.
   - The IndexedDB connection reconnects automatically.
   - Migrations are atomic, with a backup first.
2. **Degrade, don't die.**

   | What's missing | What still works |
   |---|---|
   | a connection | reminders with fallback messages, the offline pack, the plan; wakes queue up |
   | every model | the same reminders with their fallbacks, plus a card |
   | the mic | typing |
   | GPS or location permission | time triggers, and a manual place |
   | a plugin (crashed) | the plugin is disabled; everything else runs |

3. **Plain errors with a next step.** Denied permissions get instructions specific to iPhone or Android.
4. **A global catch.** `error` and `unhandledrejection` are recorded as `error` events with a small card, and the app keeps running. "Copy diagnostics" produces a redacted report.
5. **Updates never land mid-trip.** The service worker installs new versions in the background. They activate on the next start, and never during a turn. Checking isn't installing: annai asks the browser to look for a new version when it comes back to the screen (at most every 15 minutes, never offline; an iPhone Home Screen app that resumes from the background is otherwise never checked) and on Check now, and what it finds waits for the next start or for Restart now. Restart now, tapped during Shiori's turn, waits for the turn to end and says so.

## 18. Testing

- **Unit tests** (`node:test`) for the core and the pure modules:
  - event log and registry
  - scheduler and trigger math
  - context builder
  - merge patch (with `+` append), TSV, schema checks
  - zip, CRC-32, archive encryption
  - streamed-response reader and half-finished-JSON reader
  - fallback ordering and benching
  - cost accounting
  - speech-in list resolution
  - end-of-sentence detector, run on recorded PCM fixtures
- **Storage contract tests:** one suite, run against an in-memory store in Node and against real IndexedDB in a browser.
- **Provider adapters:** recorded fixtures (streams, tool calls, errors, quirks) for every endpoint type. An opt-in live suite uses the developer's own keys and never runs in CI.
- **Stand-in model servers** (`test/fakes/model-server.js`): real HTTP servers on a port of their own, one flavour each for llama.cpp, vLLM, SGLang, Ollama, LM Studio and a router that never streams. Each answers as its documents say, and llama.cpp's as a real one was measured to: its model list's shape, its reasoning field, a tool call in pieces, usage when asked, its CORS. Modes stand in for a key, auth in front of every path, and a web app's fallback page. Each refuses an empty request on a route it has, as the real ones do, so Another address's look (§9.8) is tested against all of them, and against servers that answer JSON for anything, 429 or 5xx, redirect elsewhere, block web apps, or aren't there. Unit tests reach them with a fetch that keeps a browser's CORS rules; end-to-end tests reach them from the page.
- **Stand-in realtime server** (`test/fakes/realtime-server.js`): a WebSocket server of annai's own (no dependencies) on a port of its own, speaking Gemini Live as it was measured to: JSON in binary frames, the setup and its refusals (a wrong key, an unknown model, a field only v1alpha has), turns on `activityEnd` or a text turn, audio in a burst with both transcripts, a tool call, `interrupted` and the cut turn's own end, a resume handle, goAway and usage. Its `openai` flavour speaks OpenAI Realtime as OpenAI's docs describe it (no OpenAI key was at hand): the key as a subprotocol, `session.created` and `session.update`, turns by hand, responses in a burst and `response.done` when made, a tool call twice over, `response.cancel` and `conversation.item.truncate` within the audio, the errors for a second response, an empty commit and nothing to cancel, and a wrong key, an unknown model or a bad field refused with an error (then a close for the first two). It records what it got, and closes with a code and words when told. Unit tests reach it with Node's WebSocket; end-to-end tests from the page, through the security policy. Opt-in live suites (`test/live/gemini-live.test.js`, `test/live/openai-realtime.test.js`) check the same against the real APIs with the developer's own keys.
- **Scripted fake model:** a provider plugin that replies with predetermined text and tool calls, for deterministic, free end-to-end tests. Plugin authors can use it too.
- **Trip simulation:** a GPS track plus a fake clock at 10× speed, with assertions on which triggers fired and what Shiori did.
- **End-to-end (Playwright):** Chromium and WebKit, with simulated location, a fake microphone fed from a WAV file, pre-granted permissions, and phone-sized viewports.
- **Device checklist** (manual, on a real iPhone and Android phone):
  - car Bluetooth quality while the mic is open; whether music resumes by itself after she speaks
  - built-in voice needing a first tap; word timings
  - dictation in the installed app on iOS
  - headphone or car-audio detection
  - steering-wheel media buttons as a talk button (experiment)
  - CarPlay and Android Auto flows; split screen with Maps on Android
  - installing to the Home Screen; storage persistence
  - wake lock in the installed app
  - push notifications on iOS
  - catch-up after locking the phone
  - airplane-mode offline use
  - import and export through the share sheet
- **CI (GitHub Actions):**
  - `tsc --checkJs` type-checking
  - unit tests
  - end-to-end tests
  - a total-JavaScript-size check
  - deployment on `main`
- **Dogfooding:** the Thanksgiving trip. The trip's log is the bug report.

## 19. Tech stack, hosting, repository

- **Code:**
  - native ES modules with no build step
  - plain DOM plus small components of our own
  - JSDoc types checked by `tsc --checkJs`
  - **zero runtime dependencies**
  - dev dependencies: TypeScript (type-checking only), Playwright
  - Node 26 for tooling
- **Hosting:**
  - while annai is being tested (2026), `annai.guide` and `push.annai.guide` are served from the author's own machine behind a reverse proxy: the static files by `scripts/serve.mjs` from a release of the repository, with the `_headers` rules applied, and the relay by `relay/serve.mjs`
  - once things settle: static files on Cloudflare Pages at `annai.guide`, so the site stays up when that machine doesn't, and the push relay as a Cloudflare Worker at `push.annai.guide` (Workers Paid if the Free plan's daily caps are reached)
  - `anai.guide` is a 301 redirect only, never shown as the name
  - the domain is registered at Porkbun, with its DNS there; a transfer to Cloudflare is possible later
- **Repository layout:**

```
index.html  manifest.webmanifest  sw.js  _headers
src/core/          storage, events, registry, scheduler, loop, context, patch, tsv, zip, crypto, schema
src/plugins/       built-ins: files, talk, web, places, time, go, self, mcp, sensors, voice-browser, ui-*
src/ui/            components, screens, tokens.css, i18n
plugins-official/  on-demand: chat-completions, anthropic-messages, openai-responses, speech-*, search-*, storage-*, provider-* (model providers, data only)
catalog/           plugins.json (each plugin's kind, abilities, keywords, size, requirements and file hashes), links.json
skills/            built-in skills (driving companion, …)
relay/             push relay (Cloudflare Worker)
test/              unit, contract, e2e, fixtures
docs/              vision, specs, plans, mockups
```

## 20. Build order

Each milestone gets its own implementation plan. The plugin interface exists from milestone 1. The target is to build everything before November; the Thanksgiving trip (Nov 25–29) is the field test.

| # | Milestone | Done when |
|---|---|---|
| 1 | **Foundation:** app shell, service worker, install and data-loss warnings, `persist()`, storage (§4), event log, registry and plugin loading (§5), settings, archive export and import (§12.1–12.3), trace viewer | A trip can be created, edited as files, exported, wiped and imported back intact on iOS and Android. |
| 1b | **Photos in:** ingest with the browser's encoders, photo metadata, Keep originals, the photo viewer with zoom, the Share photo options (§4.8, §12.2) | A 12 MP iPhone photo and an Android photo are each added, shown in both browsers, and exported and imported back. |
| 1c | **Removing trips:** the Remove button and its two questions, the backup time on trips, freeing content nothing else uses, the storage-full card's options (§4.9, §17) | On both phones, removing a trip full of photos gives its space back, and the backup warning shows exactly when the trip changed after its last Backup. |
| 2 | **Shiori core:** provider contract, the Chat Completions and Anthropic Messages plugins, catalog and templates, OpenRouter sign-in, roles and fallback (§9), agent loop and context (§6), output and built-in tools (§7), dock and avatar, conversation, personalities and memory (§14), the scripted fake model; for photos: request copies, refusal repair and learned limits, `read` with a region, "Show Shiori this part", the request-size limit and `recall` (§4.8, §6.5) | A text-and-photo conversation with tool use works with fallback across two providers, and the trace shows everything. A refused photo is repaired without the user doing anything. |
| 3 | **Voice:** speaking, listening sessions, speech-in resolution, turn-taking and gate, voice modes (§10), speech provider plugins | A hands-free spoken back-and-forth works in a car on both phones. |
| 4 | **Planning and bookings:** schemas, plan screen, import and confirmation flow, link catalog, `.ics` / `.pkpass` (§7.3, §8) | The real Thanksgiving trip is planned and its bookings imported. |
| 5 | **Live mode:** sensors, triggers and watches, catch-up, replanning, the driving skill, offline pack (§11.1–11.5) | A simulated Big Sur drive produces the expected wakes, and a real local drive works. |
| 6 | **Push relay** (§11.6) | A reminder arrives on a locked iPhone and opens a catch-up wake. |
| 7 | **After the trip:** recap, replay, stamps, trip simulation UI (§13) | The Thanksgiving trip can be replayed and recapped. |
| 8 | **Extensions:** skills, MCP client, code-plugin install UX, UI slots (§5, §16.4) | A third-party skill, an MCP server and a code plugin can each be installed and used. |
| 9 | **Backup targets:** GitHub, S3-compatible, WebDAV (§12.4) | Automatic backup and restore to GitHub works. |

Remaining official plugins (Gemini, more speech and search providers, and photo encoders such as WebP for Safari or AVIF) are added during milestones 2 and 3 as needed. OpenAI Responses joined on 2026-10-18.

**Providers as plugins** (docs/superpowers/specs/2026-10-18-provider-plugins-design.md, six milestones): providers and abilities with one key, `requires` and data-only provider plugins (M1); servers you run (M2); one catalog with search (M3); OpenRouter as a code provider (M4); "Another address" looks for itself (M5); conflicts made explicit (M6).
