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

## Milestone 2: servers you run

Your llama.cpp server here is the Unsloth Studio one, with HTTPS in front of it on your tailnet, and a key from Studio's Settings → API. Before you start, open Settings → Updates: if it offers Chat Completions 0.5.0 or Another address 1.1.0, update them.

- [ ] **The local servers are offered.** Models → Add a provider lists llama.cpp, LM Studio, Ollama, SGLang and vLLM.
- [ ] **Add llama.cpp.** Choose llama.cpp → **Add**: no question, its page opens. The address says `http://localhost:9931/v1`, and the note says a phone needs an HTTPS address. Type your server's plain `http://` address on your home network and **Save**: it's refused, saying a server on another computer needs HTTPS in front of it. Then give its HTTPS address (ending in `/v1`) and its key, **Save**: the key field says "saved".
- [ ] **Fetch model list.** In Chat, **Fetch model list**: your server's models. **Add** the one Studio has loaded. On its page, the context window is what Studio holds (correct it if not), and tick **Takes photos** if the model reads images: Studio's list doesn't say.
- [ ] **Test.** On llama.cpp's page, **Test**: "Everything works.", with "✓ Tool calls work." and "✓ Photos work: it saw the red square."
- [ ] **Try this model streams.** On the model's page, ask "Plan a morning in Big Sur": the words appear as they're written, with **Stop** showing until it ends, then its tokens.
- [ ] **She thinks, and shows it.** Put the model in Main and talk to Shiori: her thinking shows while she works, then her answer. Ask something that needs a tool ("what's the weather at Bixby Bridge?"): she calls it. Trace → Type contains `model.turn`: the turn has her reasoning, and tokens in and out.
- [ ] **The quick decision doesn't think.** Put the model in Quick decision too, and turn voice on. Say something to someone beside you, not to Shiori. Trace → Type contains `model.turn`: a `decide` turn at level off, with no reasoning in its reply, answered in a second or two.
- [ ] **maiGo through Another address.** Add a provider → **Another address** → **Add**. Name it maiGo, give its HTTPS address (ending in `/v1`) and its key, **Save**. Use Chat Completions, and add a model it routes by id. **Test**: "Everything works." On the model's page, **Try this model**: the answer comes in one piece. Ask for something long ("the history of Big Sur in 600 words"): if it stops with "No output started in time.", raise Main's "Wait for the first words" in Models (and Settings → Voice → Wait for her first words), as Another address's note says, and ask again.
