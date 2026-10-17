# Device checklist: milestone 8 (extensions)

Milestone 8's "Done when": a third-party skill, an MCP server and a code plugin can each be
installed and used. This is that test, on an iPhone and an Android phone, with annai installed to
the Home Screen and served over HTTPS, and a model set up (a cheap one is fine).

## The stand-in, on the machine that serves annai

annai's own stand-in MCP server, which also serves the test packages (never an outside service).
The main session gives the port; it is never 8765, 8790–8792, 8796, 8797 or 18010–18014.

    node scripts/mcp-stand-in.mjs --port <port> --token <a long random token> --files test/fixtures/extensions
    tailscale serve --bg --https=<port + 1> http://127.0.0.1:<port>

Below, `<stand-in>` is `https://<machine>.<tailnet>.ts.net:<port + 1>`. Keep the token at hand to
type or paste on each phone.

## A skill (both phones)
- [ ] Settings → Plugins → Address of a plugin or skill: `<stand-in>/files/tide-pools/SKILL.md` → Get it.
- [ ] The install screen: "Install tide-pools?", "A skill · version 1.2 · by Example Trails", "From <machine>…/files/tide-pools/SKILL.md", what it brings ("Skill "tide-pools": …"), and the note that a skill is instructions Shiori follows and annai never runs anything in it. No full-access sentence.
- [ ] Install. Settings → Plugins lists "tide-pools 1.2", Skill, From <machine>….
- [ ] Ask Shiori: "Are the tide pools safe to visit now?" She answers using the skill (Trace → Tools: `skill` with `tide-pools`, then likely `references/safety.md`).
- [ ] Remove it (Remove, then Tap again to remove). It is gone from Settings → Plugins; ask again in a new conversation: Trace → Tools shows no `skill` call for it, and its name is not in the next request (Trace → Models, the request).

## An MCP server (both phones)
- [ ] Settings → Tools → MCP servers: Name `trail`, Address `<stand-in>/mcp`, Key: Bearer token, the token → Add server ("Checking…", then the card).
- [ ] The card: "A bearer token, kept on this device", six tools (`mcp_trail_echo`, `mcp_trail_add`, `mcp_trail_map`, `mcp_trail_whoami`, `mcp_trail_fail`, `mcp_trail_slow`). The token field is empty again and nothing on screen shows the token.
- [ ] Settings → Tools: a group "MCP: trail" with a switch for each.
- [ ] Ask Shiori: "Use the trail echo tool to say 'low tide at 5:40'." She answers with it (Trace → Tools: `mcp_trail_echo` and its result).
- [ ] Ask: "Ask the trail server who you are." The answer shows `Bearer «key»`, never the token.
- [ ] Ask: "Show me the trail map." A small image comes back (Trace → Tools: the result holds an image).
- [ ] Trace → Web: each request to `<machine>…/mcp` (status 200 or 202), under the tool's name; no token anywhere in them (open a few).
- [ ] Switch `mcp_trail_echo` off; ask for the echo again: she says she can't, or uses another way; Trace → Models: the request has no `mcp_trail_echo`.
- [ ] A wrong token: add a second server `wrong` with the same address and a wrong token: "refused annai's key", and nothing is added.
- [ ] A key in the address: add `zap` at `<stand-in>/api/s/abc123def456ghi789/mcp` (the stand-in answers any address ending in /mcp). Its card shows `…/api/s/«key»/mcp`; ask for its echo; Trace → Web shows `«key»` in its place, never `abc123def456ghi789`. Remove `zap`.
- [ ] An address with `name:password@` before the host is refused, and the screen says to use the Token or Headers field.
- [ ] Stop the stand-in for a moment; ask for the echo: she says the server can't be reached. Start it again: the next call works (a new session).
- [ ] Remove `trail`: its tools leave Settings → Tools; the stand-in's log shows a DELETE.

## A code plugin (both phones)
- [ ] Settings → Plugins → Address: `<stand-in>/files/tides/annai-plugin.json` → Get it.
- [ ] The install screen: "Install Tides?", "A plugin · version 1.0.0 · by annai tests", the homepage link, "Code that runs in annai", and, as its own paragraph, "This plugin gets full access to your trips and API keys." Cancel: nothing installed.
- [ ] Get it again → Install. The dock's chip row shows "Tide 1.0.0".
- [ ] Ask Shiori for today's tides: the answer has "low 05:40, high 11:52" (Trace → Tools: `tide_times`).
- [ ] Close annai fully (swipe it away) and open it again: the chip is back, and the tool still works.
- [ ] Open Tides's own page (tap its name in Settings → Plugins): its tool, its source, Turn off, Remove.
- [ ] Remove it: the chip goes, the tool goes from Settings → Tools; annai asks for a restart only if you install it again in the same session.
- [ ] iPhone: install the same plugin from a file: on the machine make a zip of `test/fixtures/extensions/tides/`, AirDrop or save it to Files, then Settings → Plugins → Install from a file. The same install screen.

## An update, only on Update (one phone is enough)
- [ ] With Tides installed from the address and annai closed, on the machine change `test/fixtures/extensions/tides/annai-plugin.json` and `lib.js` from 1.0.0 to 1.1.0.
- [ ] Open annai: a card "Plugin updates are ready: Tides 1.0.0 → 1.1.0"; the chip still says "Tide 1.0.0"; Settings → Plugins has "Update to 1.1.0".
- [ ] Tap Update: "Restart annai to use the new versions". Restart: the chip says "Tide 1.1.0".
- [ ] Put the two files back (`git checkout test/fixtures/extensions/tides`).

## Things only a phone shows
- [ ] The dock's chip row with a plugin's chip on a small screen (iPhone SE size, or the smallest phone at hand): nothing overlaps; the chips wrap.
- [ ] The install screen with the keyboard open after typing an address: the Install and Cancel buttons can be reached.
- [ ] Tapping a plugin's dock action (install `test/fixtures/extensions/trail-ui` as a zip for this): the button is big enough, and a finger's tap works (Playwright clicks with a mouse, so only a phone shows this).
- [ ] Android: share a plugin's `.zip` to annai from the Files app, and note what happens (it goes to the import screen, which is for annai's own files; plugins are installed from Settings → Plugins). If the words there would confuse someone, note them.

## Afterwards
- [ ] `tailscale serve --https=<port + 1> off`, and stop the stand-in.
