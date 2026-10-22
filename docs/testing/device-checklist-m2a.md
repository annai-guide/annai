# Milestone 2a: device checklist (talking to models)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), with annai installed to the Home Screen.
It must be served over HTTPS: a deployed preview, or the dev server through `tailscale serve`. A plain `http://100.x.x.x` address won't do, because browsers allow service workers and annai's encryption only over HTTPS.

## Sign in with OpenRouter
- [ ] Android, installed app: Settings → Models → Sign in with OpenRouter. OpenRouter opens. After you approve, annai shows "Signed in with OpenRouter", and the main role lists a free model.
- [ ] iPhone, installed app: the same button opens OpenRouter, and annai asks you to paste the code OpenRouter shows. Copy it, paste it, tap Connect: you're signed in.
- [ ] iPhone, in a Safari tab (not installed): the sign-in comes back to annai by itself.
- [ ] After either sign-in, a card says what was set up. Models lists OpenRouter, OpenRouter: transcription and OpenRouter: voice. Speech in reads Send audio to the model, Phone dictation, then OpenAI: Whisper Large V3 Turbo; Speech out reads Browser voice, Fish Audio: S2.1 Pro Free (free), then SpaceXAI: Grok Voice TTS 1.0 (Ara).
- [ ] Without credits: on OpenRouter: voice, open Fish Audio: S2.1 Pro Free and Play a sample. It speaks in one calm, warm woman's voice (Laura), the same each time you play it; the page has her Voice (a Fish Audio library id) and the Style, and the Trace shows the request. Emptying the Voice gives Laura back (the default, in grey). To hear what Fish Audio does with no voice, put `"voice": null` in Extra request fields and play a few times: another speaker each time; remove it again.
- [ ] With credits at OpenRouter: on OpenRouter: voice, open the Grok voice and Play a sample; on OpenRouter: transcription, open Whisper and Say something. Without credits, each says the account is out of credit.
- [ ] iPhone: wait more than 10 minutes before pasting a code: annai says the code works once, for 10 minutes, and a new tap gets a new one.

## Test, and talk
- [ ] On the OpenRouter endpoint, Test. Access and the key get ✓. A free model may fail tool calls or photos; the test says so in plain words.
- [ ] Add an Anthropic endpoint with a key. Test passes. Test reasoning levels lists each level with ✓ or ✗.
- [ ] Talk to your models: the reply streams in. The line under it says which model answered, the tokens, and the cost.
- [ ] Put a model with a wrong key first in the main role: the next model answers, and the line says "after 1 failed attempt (…: key rejected)".
- [ ] Turn on airplane mode in the middle of a reply: what was said stays. With no connection, the talk says no model answered (couldn't connect).
- [ ] Trace: model.turn and net.request entries are there. Open them and "Show what was stored": no key appears anywhere.

## Finish line
- [ ] Milestone 2a is done: a plain text conversation works with fallback across two providers, and the trace shows every request.
