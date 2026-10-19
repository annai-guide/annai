# Device checklist: providers as plugins

The design is docs/superpowers/specs/2026-10-18-provider-plugins-design.md, built in six milestones. Each section is checked on an iPhone, in annai installed to the Home Screen, at the address you travel with. Your own servers (your llama.cpp server, your maiGo router) are named here, never addressed.

## Milestone 1: providers and abilities

Before you update, have at least one endpoint set up the old way (Sign in with OpenRouter, or a key), so the moving over can be seen.

- [ ] **The moving-over card.** After the update, at annai's next start: a card "Settings → Models changed" names your old endpoints and says their keys were removed. **Open Models**: no providers, and the roles hold only the phone's dictation and the browser voice. Restart annai: the card doesn't come again.
- [ ] **Sign in with OpenRouter** (paste the code): Models → Sign in with OpenRouter opens OpenRouter in Safari; sign in, copy the code, come back, paste it, **Connect**. A card "Signed in with OpenRouter". Models lists **one** provider, OpenRouter, with "Chat, Transcription, Voice". Main has Gemma 4 31B (free); speech in ends with OpenRouter's Whisper, after phone dictation; speech out has the browser voice first, then Fish Audio's free voice.
- [ ] **Add OpenAI and Test it.** Models → Add a provider → **OpenAI** → **Add**: no question, its page opens. Settings → Plugins lists OpenAI, OpenAI Responses and OpenAI-compatible speech. On OpenAI's page, give your key, **Save**: the key field says "saved", and the key is never shown again. Its abilities: Chat (Responses), Chat (Chat Completions) switched off, Transcription, Voice. In Chat (Responses), **Test** the first model: "Everything works." In Voice, open a voice, **Play a sample**.
- [ ] **One key:** Settings → Copy diagnostics, paste it into a note, search for your OpenAI key: it isn't there.
- [ ] **Airplane mode:** an added provider still works without annai's site. Turn on Airplane mode, then Wi-Fi only (or any network where annai.guide isn't needed): talk to Shiori. She answers through OpenRouter or OpenAI. Trace → Kind **Web** shows no download of a plugin; with no network at all, her turn fails in words, and nothing asks to install anything.
- [ ] **Remove a provider:** OpenAI's page → **Remove provider**: the line above it says it removes its key, its models and their places in roles, and the OpenAI plugin. Tap twice. Models no longer lists it, its models are gone from the roles, and Settings → Plugins no longer lists OpenAI or OpenAI Responses; Chat Completions and OpenAI-compatible speech stay, as OpenRouter needs them.
