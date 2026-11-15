# OpenRouter photo uploads: design and plan

Written 2026-11-14. The plan as spec-checked, with the main session's calls on the spec check and the builder's answers to its
questions. Spec §4.8 and §4.9 hold the result; `docs/limitations.md` holds the approved limitation.

## The goal, in the user's words

2026-10-16: "let's also make sure we support openrouter. I see they also have file api." 2026-11-14: "Check if it can work
(Recommended)", then "Run the test (Recommended)" ("If it works for the route annai uses, I plan the build; files never expire
there, so the plan includes deleting them"). The test passed (the Chat Completions `file` part). The user's picks on the plan:
"Now, beside the redesign (Recommended)"; the leftovers limitation "Accept it (Recommended)"; the switch "OpenRouter's page only
(Recommended)"; the Sign-in key "After release, you tap Test (Recommended)". Standing: "what I prefer is simple and robust
solutions"; every data-saving optimization on by default, and privacy trade-offs get a switch.

## Design

### 1. The route: Chat Completions, the `file` part

- **The Chat Completions type gets upload hooks.** Its tunables get `uploads: false`; OpenRouter's description sets
  `uploads: true` on its chat ability. The other servers this type reaches (Groq, DeepSeek, Mistral, local servers, OpenAI's
  chat-completions ability) stay off: whatever files APIs some of them have don't serve this route. The core's machinery
  (`withUploads` in src/core/llm/call.js, src/core/llm/uploads.js) is used unchanged: each request copy is uploaded once, named
  `annai-<16 hex>.<ext>`, and reused by id until an hour before its 48 hours.
  - `uploadRequest`: `POST {base}/files` with FormData `file` only, the one field OpenRouter's upload takes.
  - `readUpload(j)`: `{ id: j.id }`, with no expiry, so the core's 48 hours apply.
- **The part.** In `words()`, an image part with a `fileId` becomes `{ type: "file", file: { file_id } }`, the part the test
  passed with. An `image_url` holding the id is refused with a 400.
- **A dead id.** OpenRouter answers HTTP 400 `Invalid file_id: or_file_…`. The type's `classify` reads a message that names
  `file_id` **and** a word for a dead id (`invalid`, `not found`, `unknown`, `expired`, `does not exist`, `no such`) as kind
  `upload`, as openai-responses and gemini-api match theirs: a small rewording still matches, and a refusal of the part ("file_id
  is not supported") doesn't, so it can't make annai upload every photo again on every turn. The existing path does the rest
  (src/core/llm/fallback.js, spec §9.9): the endpoint's ids are forgotten, the photos uploaded again and the call retried once.

### 2. Deleting: OpenRouter's own list is the record

- **Lifetime: 48 hours after upload**, as at OpenAI, Anthropic and Gemini. Photos of a removed trip or conversation go within
  those 48 hours, as at the other providers. There is no record per trip.
- **No new record.** `GET /files` lists the workspace's files with `filename` and `created_at`. Every file annai makes carries
  its own name, `annai-<16 hex>.<ext>`, or `annai-test.png` from Test.
  - A **sweep** reads the list page by page (`limit=1000`, then `cursor`) until `has_more` is false or a cursor repeats.
  - It deletes every file whose name matches `^annai-([0-9a-f]{16}|test)\.[a-z0-9]+$` and whose `created_at` is over 48 hours
    old. The **all** form deletes them at any age. A file whose time can't be read goes only in the all form.
  - `/llm/uploads.json` stays the reuse cache.
  - Why no record (principle 2): a record would need guards for every way it can fail (a failed delete, an app closed for
    weeks, Erase while offline, a lost phone, `forget()` dropping ids after a dead one). With the list, the next sweep from any
    annai signed in to that workspace sees what is really there. An old page that uploads under the new plugin names its files
    the same way, so the new annai's first sweep deletes them: no host API bump.
- **When the sweep runs:**
  1. At start and on coming online, beside the kept-turn drain. `online` is not throttled: one list request of a few KB each.
  2. The all form, with the old key and address, as the key, the address or the provider goes (`releasing`: removal, a new key,
     a new address, Sign in again) and at Erase (`forgetAll`), beside the kept-turn deletions and within their 10 seconds. The
     10 seconds bound what the screen waits for; deletions not done by then go on in the background. Then the endpoint's ids
     are forgotten. Two paths that skipped `releasing` now take it: Sign in again (`ui.keep`, which now exchanges the sign-in's
     code first and then reconnects with the new key in hand) and an ability's own address, where the type deletes.
  3. The all form when the uploads switch goes off, in the background.
  - No hourly sweep after an upload: it fired only on new uploads, so it never delivered "after 48 hours" for a tab left open.
- **Where it runs:** every ability whose type lists and deletes, with a key, where uploads are on by default (the type's or
  the description's) or on now, whether or not the ability itself is switched on. The form follows the switch: age form when
  on, all form when off. A switched-off OpenRouter therefore gets an all sweep at each start until nothing is left, so a failed
  switch-off sweep is tried again while the key is there.
- **When the sweep fails:**
  - No answer, 429 or 5xx: it waits for the next trigger.
  - A 401 or 403, or a list annai can't read, at start or online: uploads go off at that endpoint until annai restarts, as after
    a failed upload, so annai never keeps making files it can't delete. Not while the key or address goes (a revoked old key
    says nothing about the new one).
  - A 404 on the list means no files API there: nothing to do.
  - A delete answered 2xx or 404 is done.
  - Every request goes to the endpoint's own origin, never follows a redirect, has a 15-second limit and is traced without ids,
    as kept-turn deletions are. Deletions go 6 at a time: a browser opens at most 6 connections to one host over HTTP/1.1, and
    OpenRouter states no rate limit for its files API.
- **Calls in flight.** Removal and Erase first turn uploads off at the provider's endpoints until restart, so a turn under way
  sends its photos in the request instead of leaving a new upload behind. After a key change or the switch going off, such an
  upload is deleted by the next sweep (the new key's, in the same workspace, or the all form while the switch is off).
- **Other devices** on the same workspace: a file over 48 hours old is past every device's reuse (47 hours). An all sweep
  deletes another device's live files; that device takes the dead-id path and uploads them once more.
- **The device's clock** against the server's `created_at`: a clock far ahead deletes live files early, which costs one
  re-upload.

### 3. On by default, with the switch that exists

- **On by default for OpenRouter** (the user's rule). Without it, every step of every turn sends each photo inline, up to about
  1.4 MB; with it, a photo already uploaded goes as about 70 bytes. Existing OpenRouter providers get it at the plugin update
  (`syncProviders` brings the description's new value).
- **The switch shows on OpenRouter's page only** (the user's pick), by one rule on the provider page: for a type whose files
  stay until annai deletes them (it lists and deletes), the switch shows only where uploads are on without the user's changes,
  that is where the provider's description turns them on, since annai reads only the files lists it knows. That puts it on
  OpenRouter's page and keeps it off every other Chat Completions page; the pages of types whose uploads expire by themselves
  (OpenAI Responses, Gemini API, Anthropic Messages, whose off switch a server that takes uploads turns on, spec §4.8) keep
  theirs. A Tunables JSON can still set `uploads`.
- **Its words promise only what the design does.** Where the type deletes: "Upload photos to this provider (annai deletes each
  once it is 48 hours old, the next time annai starts or comes online)". Elsewhere they stay "each expires after 48 hours".
- **OpenRouter's chat ability note:** photos are stored in the workspace's files until annai deletes them, and OpenRouter's Zero
  Data Retention doesn't cover stored files.
- **Test** uploads its tiny photo as today. Where the type deletes, it then finds it in the provider's list and deletes it, so
  Test shows that listing and deleting work with this key (the user taps Test on a Sign-in key after release). A key that can't
  sends photos in each request until restart.

## Plan for the builder

Every step comes with its unit tests. Stand-ins are built from the real answers and kept at least as messy (`_shape`,
`type: "file_deleted"`, the 400 and 404 bodies, a paged list with other apps' files in it), with made-up ids.

1. **Stand-in:** OpenRouter's files routes (upload, list with cursor and `has_more`, DELETE, a dead id answering 400 in a chat
   call), beside test/fakes/openrouter-claude.js.
2. **Chat Completions type** (minor version): `uploads: false`; `uploadRequest`, `readUpload`, `deleteUploadRequest`,
   `listUploadsRequest`, `readUploads` (throws on a shape it can't read); the `file` part; the two-word `file_id` rule; the
   typedefs in src/core/llm/contract.js and docs/plugins.md.
3. **OpenRouter's description** (minor version): `"uploads": true` on the chat ability, and its note.
4. **The sweep** in src/core/llm/uploads.js, with the name rule shared by call.js and check.js.
5. **Triggers** in src/core/llm/service.js: start and `online`; `releasing` and `forgetAll`; `forgetUploads(endpoint)` for the
   switch; `ui.keep` and an ability's own address through `reconnect`.
6. **Test** (src/core/llm/check.js): find and delete the test upload where the type deletes; the new words.
7. **Provider page:** the switch's rule and words; off calls `forgetUploads`. New words through the strings tool, with ja,
   zh-Hans and zh-Hant by the style guides.
8. **Docs:** spec §4.8, §4.9, §9.1, §9.2, §9.8; docs/plugins.md; the lessons entry (both files, one commit); docs/progress.md;
   the approved limitation in docs/limitations.md.
9. **Real checks** with the user's key (an opt-in case in test/live/providers.test.js and one opt-in e2e spec, both skipped
   without the key): a browser upload, list and delete in Chromium and WebKit; annai's file in the list; the free default models
   reading the `file` part; cache marks on a `file` part; cost by id against inline (stop and ask if the id costs more); a dead
   id end to end. A model that can't read the part gets `uploads: false` in its description entry, which needs `withUploads`
   to read model tunables (built only if one fails).

**Acceptance criteria.**
- A photo in a conversation with OpenRouter (uploads on) is uploaded once and sent as a `file` part by id on later steps and
  turns, until 47 hours.
- At the first start or coming online after 48 hours it is gone from `GET /files`.
- Removing the provider, a new key, Sign in again and Erase leave no `annai-` file in the workspace, when online.
- The switch off deletes them all, and a failed attempt is made again at the next start.
- A dead id costs one re-upload and the turn still answers.
- A 401 or 403 from the list or a delete (or a list annai can't read) sends photos inline until restart.
- Other Chat Completions providers send exactly what they send today, and their pages show no switch.

**Test command:** `npm run stamp && npm run check`; the e2e specs for providers, photos and uploads; then the opt-in checks with
`ANNAI_LIVE_OPENROUTER_KEY` set from the user's key file inside the command.

## Calls on the spec check

Taken: the host API bump dropped; the hourly after-upload sweep dropped; the switch-off sweep made again while the key is there;
the two-word dead-id rule; the switch on OpenRouter's page only, by the page rule; the switch's words; Question 2 settled by the
user's standing rule; the §4.9 sentence; request guards as kept-turn deletions'; the sweep joining the 10-second wait; sweeps
running whatever the off-state, with no off on a 401 while a key goes; the sign-in's code exchanged before the sweep; Test's
delete kept (it also lists, which proves the sweep's list with the key); made-up ids in stand-ins. Not taken: `requires
chat-completions ^0.12` in OpenRouter's manifest (harmless either way: an old type has no hooks, so nothing uploads).
