# Remote trace (for developers) — Implementation Plan

**Asked for by the user on 2026-10-18:** an official, optional plugin that sends annai's trace to a server the user chooses, so a developer can watch a real iPhone's traces, requests and errors as they happen; and a tiny server that receives it. Brief: `.superpowers/briefs/remote-trace.md`.

## Choices this plan makes

1. **The second secret guard is annai's own `withoutSecretsIn`,** imported by the plugin as `../../src/core/agent/net.js` and given `annai.files.store`. The relative path is the same module in both places the plugin runs: `/plugins/remote-trace/index.js` in the browser (it resolves to `/src/core/agent/net.js`, the module annai itself loaded) and `plugins-official/remote-trace/index.js` in the repository's tests. So every secret annai keeps (endpoint keys, every plugin's secrets, this plugin's token, keys in package addresses) and anything shaped like a credential is blanked in every string of every entry, and a string that could still show one is replaced, exactly as annai's own cards and errors are. The plugin API has no such helper. Adding one (`annai.secrets.blank(value)`, three lines in `src/core/plugins.js`) is the cleaner design, but it changes the core, whose shipped size is at its budget to the byte (1533.0 of 1533 KiB); the brief says the core shouldn't change. If you'd rather the plugin keep to the documented API, that is the alternative, with a 1 KiB budget raise.
2. **What one entry is:** the log entry as stored, which is what an opened row of the Trace screen shows: `{ scope, seq, ts, type, actor, data, refs }`. The stored content behind `refs` is not sent: texts over 2,000 characters (model replies and reasoning among them), photos and other bytes. Their names (`data.stored`) and hashes are. An entry whose JSON is over 64 KiB is sent with its `data` replaced by `{ cut: "<n> bytes, more than one entry may send" }`.
3. **Location:** entries of type `location` (live mode's points, about one a second on a drive) are left out unless "Send location points" is on; turning it off also drops the ones waiting. Other entries can still name a place, as the Trace shows them (a weather request's address, a tool's input); the setting's description says so plainly.
4. **The body:** `{ app, build, device, dropped, entries }`.
   - `app` is `"annai <version>"` and `build` the build stamp, both read from the name of the offline copy annai's service worker keeps (`annai-shell-<version>-<build>`, sw.js); the oldest such copy when there are two, the one running while an update waits. Without one (no service worker), `app` is `"annai"` and `build` null. A unit test pins sw.js's cache name, so a change there fails the test, not the plugin.
   - `dropped` counts the entries dropped since the last batch the server took.
5. **The device id:** 16 hex digits from `crypto.getRandomValues`, made at the first send and saved as `device` in the plugin's settings file. It is not a form field. Reset and Remove clear it with the file, and a new one is made at the next send.
6. **Batching:** one request at a time. A batch goes when 100 entries wait, or 3 s after the oldest waiting entry arrived, whichever is first. A batch is at most 100 entries and 512 KiB of JSON, half of the sink's body cap.
7. **Offline and errors:**
   - At most 2,000 entries are kept, waiting and in flight together; the oldest go first, and are counted in `dropped`.
   - After a failed try the next waits 3 s, doubling up to 60 s; a batch that gets through starts again at 3 s.
   - A refusal is any answer that isn't 2xx. After 3 in a row, one card says so plainly (with "the token may be wrong" for 401 and 403), and no more until a batch gets through or the settings change.
   - A server that can't be reached (the phone is offline) gives no card: on a phone that is normal. The chip's name says what is waiting and why.
8. **When it is on:** Send is on and the server address is `https://…`, or `http://` on `localhost` or `127.0.0.1` (what annai's CSP allows).
   - The schema has no `pattern`: the form would show the regular expression as its error. The plugin checks the address itself, and when Send is saved on with one it can't use, one card says what to change.
   - The token is read at each send, because the form saves it just after the settings file. Send on without a token gives one card and sends nothing.
9. **Following its own settings:** its hook sees the user's write of `/plugin-settings/remote-trace.json` in `sys:settings`, and a `plugin.reset` of `remote-trace`. It holds any new batch, reads its settings again, and applies them. **Off** (Send off, Reset, Turn off, Remove) clears the timer, aborts the request under way, drops what waits, and takes the chip away at once. Nothing collected while it was on is sent after it goes off, and nothing is collected while it is off.
10. **The dock chip** is registered only while it is on. A hidden chip would leave the row's separator line behind. It reads "Trace", about 53 px wide; its name and title are "Sending trace", plus what waits and why when it is stuck. It is a `role="button"` with Enter and Space, and a tap opens `#/plugins/remote-trace`. The card for refusals has an "Open Remote trace" action when the chip has been drawn.
11. **The sink** (`scripts/trace-sink.mjs`, no dependencies):
    - It binds 127.0.0.1 only, and `tailscale serve` (or any https proxy) puts https in front of it.
    - Every path takes a POST. A GET answers "annai trace sink is running", so the address can be checked from a phone's browser.
    - It answers CORS for `https://annai.guide` and each `--origin`, on errors too, so the plugin sees a 401 as a 401. It sends `Access-Control-Allow-Private-Network` when asked. A POST from any other Origin is refused (403).
    - The token is at least 16 characters, compared by SHA-256 with `timingSafeEqual`. The body is capped at 1 MiB (413). Ports 8765, 8790–8792, 8796, 8797 and 18010–18014 are refused. Port 0 is allowed, for tests.
    - Each entry is appended as one line `{ received, device, build, ...entry }`, the sink's fields first and never overwritten by an entry's. A batch that reports drops writes one `{ received, device, build, dropped }` line first. One line per batch goes to stdout.
12. **Docs:** a "Remote trace (for developers)" section in docs/plugins.md: what it sends and never sends, and how to run the sink. The manifest's `homepage` links there, so the plugin's page does too.
13. **Not changed:** the hooks' limit of 1,000 entries in 10 s applies to this plugin as to any. An import that logs more than that (a trip of over 1,000 files) switches it off with annai's card. That is core behaviour; the report notes it.
14. **Ledger** in the worktree's own git-ignored `.superpowers/sdd/remote-trace/progress.md`.

## Tasks (test-first)

1. **The sink:** `scripts/trace-sink.mjs` exporting `startSink({ port, token, out, origins })`, then the command line. `test/unit/trace-sink.test.js`:
   - the token is checked (missing or wrong: 401, nothing written);
   - CORS preflight and POST, for annai.guide, a given origin, and another origin (refused);
   - the body cap, by Content-Length and by a body that keeps coming;
   - the JSONL lines, with device, build, time received and the drop line;
   - the command line refuses the reserved ports, a short token and missing arguments, and prints the `tailscale serve` hint without a machine name.
2. **The plugin:** `plugins-official/remote-trace/{annai-plugin.json,index.js}`, exporting `activate` and `start(annai, { timers, now })`. `test/unit/remote-trace.test.js`, on a virtual clock:
   - batches at 3 s and at 100;
   - the 2,000 cap and the drop count;
   - backoff, and one card for repeated refusals;
   - location left out by default;
   - no key or token in any posted body (planted endpoint key and token, typed into a message, and a Bearer shape);
   - its own requests never reach its hook (real PluginHost);
   - off stops at once (Send off, Turn off), and Remove clears its settings and token;
   - the address check;
   - the sw.js cache name.
3. **Catalog:** `npm run catalog` adds its entry.
4. **e2e** `test/e2e/remote-trace.spec.js`, both browsers:
   - a sink on port 0, and a stand-in model;
   - install from the catalog, configure, a short conversation with the token and the endpoint key typed into it;
   - the entries arrive in the sink's file, with neither secret in it;
   - the chip shows while it is on (40–64 px wide), and goes when it is off.
5. **Docs** in docs/plugins.md.
6. `npm run stamp && npm run check`, the full Docker e2e, size.
