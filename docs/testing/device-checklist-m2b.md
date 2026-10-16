# Milestone 2b: device checklist (Shiori herself)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), with annai installed to the Home Screen and served over HTTPS (a deployed preview, or the dev server through `tailscale serve`). Set up a main model (and a utility model) first: Settings → Models.

## The dock and the conversation
- [ ] The dock is at the bottom of every screen: camera · Shiori · type. It stays clear of the Home indicator and the keyboard.
- [ ] Tap Type, write "What's near McWay Falls?", Send: the Conversation opens, Shiori thinks (she looks up and away; the dock says Thinking), then answers in a bubble labeled SHIORI.
- [ ] Tap Shiori while she is thinking: she stops, and the dock says "Tap to talk".
- [ ] Ask something she needs to ask back ("Book something for dinner?"): her question shows buttons. Tap one, or type an answer: she goes on.
- [ ] Write a second message while she is still thinking: she takes it into account in the same turn.
- [ ] Close annai while she thinks, open it again: she answers the message anyway.
- [ ] The camera button takes a photo into the open trip, and Shiori wakes to look at it.
- [ ] Turn on Reduce Motion: no blinks, glances or transitions; she still changes how she looks.
- [ ] Dark mode: her eyes and hairpin read well.
- [ ] Airplane mode with annai open: the dock says "Offline · reminders still work".

## Tools
- [ ] "What's the weather at McWay Falls on Thursday?": she uses weather; the answer has the local time zone.
- [ ] "What's near us?" with a real place: nearby answers from OpenStreetMap or Wikipedia.
- [ ] "Read https://www.nepenthe.com/": fetch reads it, directly or through Jina Reader. On your home Wi-Fi, without a Jina key, it says to add one; after adding the key in Settings → Tools, it works.
- [ ] Web search: with Anthropic or OpenRouter as the main model, her own search answers with sources; with search via Jina and a key, web_search answers.
- [ ] Switch fetch off in Settings → Tools: she says she can't read pages, or uses her model's own fetch if fetch via is set to it.
- [ ] Ask her to remember something about you: it lands in /me/memory.md.
- [ ] Ask her to change how she talks ("shorter, please"): a card says she adjusted her personality; Undo puts it back.

## Budgets, cost, housekeeping
- [ ] Set steps per wake to 2 and ask for something long: her turn ends with a card that says why.
- [ ] Trace → Conversation: each wake shows what it cost; Trace → Tools shows each tool call and what it read; no key appears anywhere.
- [ ] A long conversation (or a low housekeeping threshold): "Earlier conversation summarized" appears, and she still remembers the gist.

## Finish line
- [ ] Milestone 2b is done: a text conversation with tool use works with fallback across two providers, survives a reload mid-turn, and the trace shows every request and everything read.
