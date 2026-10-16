# Milestone 2a: device checklist (talking to models)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), with annai installed to the Home Screen.
It must be served over HTTPS: a deployed preview, or the dev server through `tailscale serve`. A plain `http://100.x.x.x` address won't do, because browsers allow service workers and annai's encryption only over HTTPS.

## Sign in with OpenRouter
- [ ] Android, installed app: Settings → Models → Sign in with OpenRouter. OpenRouter opens. After you approve, annai shows "Signed in with OpenRouter", and the main role lists a free model.
- [ ] iPhone, installed app: the same button opens OpenRouter, and annai asks you to paste the code OpenRouter shows. Copy it, paste it, tap Connect: you're signed in.
- [ ] iPhone, in a Safari tab (not installed): the sign-in comes back to annai by itself.

## Test, and talk
- [ ] On the OpenRouter endpoint, Test. Access and the key get ✓. A free model may fail tool calls or photos; the test says so in plain words.
- [ ] Add an Anthropic endpoint with a key. Test passes. Test reasoning levels lists each level with ✓ or ✗.
- [ ] Talk to your models: the reply streams in. The line under it says which model answered, the tokens, and the cost.
- [ ] Put a model with a wrong key first in the main role: the next model answers, and the line says "after 1 failed attempt (…: key rejected)".
- [ ] Turn on airplane mode in the middle of a reply: what was said stays. With no connection, the talk says no model answered (couldn't connect).
- [ ] Trace: model.turn and net.request entries are there. Open them and "Show what was stored": no key appears anywhere.

## Finish line
- [ ] Milestone 2a is done: a plain text conversation works with fallback across two providers, and the trace shows every request.
