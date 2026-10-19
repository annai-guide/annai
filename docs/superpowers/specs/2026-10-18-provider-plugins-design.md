# Providers as plugins, one catalog, and plugin conflicts: design

Date: 2026-10-18. Status: approved by the user ("the plan looks good", 2026-10-18); the description to plan from.

## Why

Things the user ran into, in their words:
- The Models dropdown will get crowded: "there are many many LLM endpoint providers and even more routers … our drop down menu maybe will get crowded if we add more and more templates".
- One provider shouldn't mean many endpoints: "maybe we allow one endpoint to provide many endpoint capability (like chat completions, responses, files, embeddings etc) instead of needing to add them as separate endpoints? (case point: openrouter and openai)". Today Sign in with OpenRouter makes three endpoints (chat, transcription, voice), each holding its own copy of the same key, so removing one leaves the key in the other two.
- The plugins page has no search or filters: "shall we also add search and filter by type / category / provided feature".
- Conflicts: "how do we resolve loaded order and conflict for the plugins? if there is a plugin that overwrites the default plugin or other plugin's functionality, how do we resolve them?"

What the code shows:
- catalog/templates.json has 22 endpoint templates in one list. They come from about ten providers (OpenRouter, Anthropic, OpenAI, Gemini, Groq, DeepSeek, Mistral, Local), plus the "Other:" templates and the scripted test model. Every new provider adds more.
- Provider quirks live in the wrong places. OpenRouter's sign-in is in annai's core screens (src/ui/openrouter.js). Its "free models used up" message is handled in the generic Chat Completions plugin. Its speech model lists need a `listPath` tunable on the generic speech plugin.
- Name clashes are settled silently: the first to register wins. For tools, built-ins come first and a later plugin's tool with a taken name is dropped without a word (src/core/agent/tools.js `toolList`). For endpoint types, the first plugin to provide a type wins (src/core/llm/contract.js `endpointTypes`). Nothing tells the user.

## Goals
1. **Every provider is a plugin** (the user's choice). A provider is one address and one key, with several **abilities**: chat (through Chat Completions, OpenAI Responses or Anthropic Messages), transcription, voice, and the chat abilities annai has today (photo uploads, provider tools such as web search). The key is kept once per provider.
2. **One catalog** for everything a user can add: providers, plugins, backup places, voices, skills, personalities. It's **searchable** (a must) and **browsable**. It's annai's curated official list, plus third-party plugins installed from a URL, as today.
3. **The plugins page** gets search and filters by kind, category and ability.
4. **A known provider brings its own setup screen** where it has quirks (OpenRouter's sign-in). A provider without quirks gets the standard screen.
5. **"Another address"** (a custom OpenAI-compatible server, a router like the user's maiGo, a local server) finds out for itself, at no cost, what the address offers.
6. **Plugin conflicts are explicit and visible,** never silent.

## Non-goals
- A way to submit plugins to the official catalog. The user: "if there is interest maybe we'll setup something later … (but not now)".
- A server-side marketplace: ratings, accounts, payments.
- Moving existing setups over carefully. The user: "don't make too much effort on the moving over part. It is just me doing testings as of now so even if it does not migrate it is fine I can just add them back after the change."
- New protocols (Gemini's native API), on-device models, embeddings. Each can come later as a protocol plugin; this design must not block them.
- Changes to roles and fallback. Roles still list models from any provider, in order, as today (spec §9.6).

## Anti-goals (a failure even if it works)
- **Downloading a protocol plugin the first time it's used.** On the trip, that may be on a road with no signal. Everything a provider needs is in storage once it's added.
- **A data-only provider asking for full trust,** or able to run code. Data can't do anything, so it must not need the "full access to your trips and API keys" warning.
- **Silent conflicts:** a plugin's contribution quietly not used, or quietly replacing another's.
- **A key stored more than once for one provider.**
- **Anything priced placed ahead of a free path by default** (spec §9.8, kept from the OpenRouter voice work).
- **Probing that costs money** without the user tapping Test.

## Constraints
- annai stays local-first and browser-only: native ES modules, no build step, JSDoc types checked by tsc, and the size budget (scripts/size.mjs).
- Spec rules that hold:
  - §4.9: removing means removing;
  - §15: keys never in files, events or the trace;
  - §5.3: official plugins are hash-checked, and updates apply only on the user's tap;
  - §17 rule 5: nothing lands mid-trip.
- **One plugin can't import another's files.** The service worker serves `/plugins/<id>/…` only from that plugin's own stored files, and the catalog hashes each plugin separately (the storage-forgejo builder had to copy `git.js` for this reason). So dependencies work through what plugins register at runtime (endpoint types in the registry), never through module imports.
- The catalog is served from annai.guide. Installing needs a connection; using what's installed doesn't.
- The repo is public: no machine or tailnet addresses in it.

## What the user decided
- Every provider is a plugin, in one catalog with one search, which can also be browsed.
- The catalog is annai's curated list plus third-party URLs; official submissions come later.
- One provider has one address, one key and many abilities. A template already knows what its provider offers; a custom address gets probed.
- Known providers can have their own setup screen.
- The user agreed to this playback (2026-10-18, "looks right"):
  - **Data-only by default:** most provider plugins are data with no code, so they need no full-access warning. A provider plugin with code shows the warning, as code plugins do today.
  - **Two layers:** provider plugins depend straight on the shared protocol plugins. There is no "base provider" layer.
  - **Everything at add time:** what a known provider needs installs with it. Official parts install without an extra question; a third-party part asks.
  - **"Another address":** probe first, at no cost, then install only what was found.
  - **Updates:** a provider plugin's update (new models, new prices) is offered like any plugin update, and applies when the user taps.
  - **Removing:** removing a provider removes its key and models. Protocol plugins that nothing needs any more are removed too.

## The design

### Two kinds of plugin, two layers
- **Protocol plugins** are today's endpoint-type plugins: chat-completions, openai-responses, anthropic-messages, and speech-openai (transcription and voice). They know how to talk: request and reply formats, streaming, error kinds. They're official and shared. They should lose provider-specific code where a provider plugin can carry it instead, for example OpenRouter's free-limit message, if the provider contract gives a place for it.
- **Provider plugins** describe one provider: its name, address, how its key is sent, its abilities, its models with prices and capabilities, its recommended roles, its key page and notes, and what it `requires`.
  - **Data only,** with no `entry`, for most providers. The manifest already allows no entry and already carries `templates` (src/core/packages.js). The new provider description can grow from that.
  - **With code** only where the provider has real quirks:
    - **OpenRouter:** sign-in, its free models, its speech list paths and its free-limit message. This moves annai's OpenRouter code out of the core.
    - **Anthropic:** the browser-access header, if that can't be data.
    - **"Another address":** the probing.
  - **Local servers are separate provider plugins** (the user's suggestion, 2026-10-18: "maybe llama, vllm, SGLang etc can be separate plugins because maybe they are slightly different"). Candidates: llama.cpp (Unsloth Studio runs it), vLLM, SGLang, Ollama and LM Studio. Each is data first; their quirks are data where possible:
    - the reasoning field's name;
    - how thinking is switched (e.g. vLLM's and SGLang's `chat_template_kwargs`);
    - whether tool calls and usage in the stream are supported;
    - prompt-cache options such as llama.cpp's `cache_prompt`;
    - the model list's shape;
    - the default port.

    The user's own llama.cpp server streams for real, which makes it a good test of these (maiGo, their router, doesn't stream).
- **Dependencies are declared** in the manifest as `requires` (protocol plugin ids, with version ranges on the interface major version) and resolved when the plugin is installed or updated. Protocol plugins are small (today 4.6 to 16.1 KiB each, about 45 KiB for all four), so installing what a provider needs costs little.

### Provider plugins and configured providers (my call)
- **One installed provider plugin can back several configured providers.** For example, two OpenAI accounts with two keys, or several servers added through "Another address". On the Add screen, a provider that's already set up shows "Added", with "Add another".
- **Each ability may have its own address,** which defaults to the provider's. That way "Local server" is one provider even when chat, transcription and voice run on different ports, as today's three local templates do.
- **Provider plugins appear in the Plugins list** under the kind "Model providers", naming the providers configured from them.
- **Removing the last configured provider of a provider plugin uninstalls that plugin too,** then any protocol plugin nothing requires any more (removing means removing). An official one comes back from the catalog when needed. For a third-party one, the remove confirmation says its address will be needed again to add it back.

### Providers in the user's settings
- **A configured provider** replaces today's endpoint records. It holds: which provider plugin it comes from (or "another address"), its name, its address (where the user may change it), extra headers, **one key**, which of its abilities are on, and its models, each model belonging to one ability.
- **Roles still list models,** from any provider. Speech roles list transcription and voice models, plus the stand-ins (dictation, browser voice, send audio), as today.
- **The Test button** (spec §9.8) tests a provider's models per ability, as it now tests an endpoint's.
- **"Try this model"** (settings-tidy) stays on each chat model's page.
- **Settings that are per endpoint today** (tunables, extra request fields, uploads) become per ability, or per provider where they apply to all its abilities. The builder decides which is which.

### The catalog screen
- **What it lists** (from the user's "curated official list plus third-party URLs like plugins today"):
  - annai's official catalog;
  - everything already installed, third-party plugins included;
  - "Install from an address".

  It lists no third-party entries hosted elsewhere until official submissions exist. So "official or from a URL" describes installed items.
- **One "Add" screen** with a search box.
- **What search covers** (the user, 2026-10-18: someone searching "unsloth", "lmstudio" or "ollama" should find the llama.cpp plugin when no more specific plugin exists):
  - **The fields, ranked in this order:** the name, the plugin's `keywords`, then its description. Abilities and "free" also match.
  - **Keywords** are declared in the manifest, e.g. `keywords: ["unsloth", "lm studio", "koboldcpp"]` on the llama.cpp plugin. They aren't hidden: a row that matched on a keyword says why, e.g. "Also for: LM Studio".
  - **A more specific plugin wins** by ranking: a name match comes before a keyword match.
  - **Matching** ignores case, spaces and punctuation ("lm studio" = "lmstudio"), and matches from the start of a word. There's no search library; it's a few lines of annai's own code.
  - **Official plugins' keywords** are part of their catalog entries, so the official catalog can be searched before anything is installed.
- **When nothing is typed,** it's browsable, grouped by kind: model providers, voices and transcription, backup places, tools and MCP, skills and personalities, developer. Only kinds with something in them show.
- **Filter chips:** kind, abilities (chat, transcription, voice), free, local, official or third-party.
- **Each row shows:**
  - the name;
  - ability badges;
  - "free" where the provider has free models;
  - whether it's official or from a URL;
  - "data only" or "has code";
  - its size.
- **It opens already filtered to where the user came from:**
  - Models → Add a provider shows model providers;
  - a speech role's Add shows providers with transcription or voice;
  - Plugins → Add shows everything.
- **Installing from a URL** stays as it is: the install screen first, with the code warning unless the plugin is data only.
- **The plugins page's installed list** gets the same search and filters.
- The first mockups are kept in .superpowers/brainstorm/ (git-ignored): the search screen, a provider's page, and the probe screen.

### A provider's setup screen
- **The standard screen,** for a data-only provider, is drawn by annai from the provider description:
  - the key (written once, kept in secrets), with a link to where it's made;
  - the address, where it can be changed;
  - each ability with its models;
  - Fetch model lists, and Test;
  - Remove, which takes the key, the models and their role entries in one step.
- **A provider plugin with code can add to that screen:** its own setup panel, such as Sign in with OpenRouter in place of the key field. It can also obtain the key and hand it to annai to keep for that provider, through annai's secrets and never in its own files. And it can adjust how its abilities are called: headers, error kinds, model lists.

  This is the new part of the plugin interface. Its exact shape is left to the builder, but it must stay small, and it must be documented in docs/plugins.md.

### The one-tap start stays (my call)
- Sign in with OpenRouter stays a one-tap start wherever it's offered now (spec §9.8): the welcome's last step and the Models screen with no providers.
- **The core names no provider.** The catalog marks one provider as featured (OpenRouter).
- **The link must exist before the tap.** On an iPhone Home Screen app, Safari opens a page only from the tap itself; after an await, nothing opens (found 2026-10-18). So a screen offering the one-tap start installs the featured provider's plugin in the background as soon as it opens. That plugin is official, hash-checked and small, so its sign-in link is ready before the tap.
- The sign-in's return to annai's address (with `?code=`) and the iPhone paste-the-code path are routed to that plugin.

### "Another address"
- **The user gives an address,** and optionally a key. "Look for what it offers" then runs, at no cost:
  1. ask for the model list;
  2. send an empty request to each known path (`/chat/completions`, `/responses`, `/v1/messages` for Anthropic, `/audio/transcriptions`, `/audio/speech`).
- **Reading the answers:**
  - "bad request" or an auth error means the path exists;
  - "not found" or "method not allowed" means it doesn't;
  - a browser block means the server doesn't allow web apps (CORS), told apart from "unreachable" the way the Test button does it now (src/core/llm/check.js).
- **The results** are shown in a list. The user adds the provider with the abilities found, and annai installs only the protocol plugins those need.
- **Nothing sends a real request** until the user taps Test.

### Install, update, remove
- **Installing a provider plugin installs its `requires`:**
  - official protocol plugins from the catalog, hash-checked, with no extra question;
  - a third-party dependency must already be installed, from its own address. If it isn't, the install stops and names it (with its homepage, if the manifest gives one), so the user can install it first and try again. annai never fetches from several sites in one install (my call: simple, all-or-nothing).
- **If a requirement can't be met** (no matching version, offline), the install stops with plain words and nothing half-installed.
- **An update** that changes `requires` resolves them when the user taps Update.
- **Removing:**
  - removing a configured provider removes its key, its models and their role entries;
  - uninstalling a provider plugin removes the providers configured from it, after a confirmation that names them;
  - a protocol plugin that no installed plugin requires any more is removed with it. It's official code, and can be reinstalled.

### Conflicts and load order (my call; the user hasn't ruled on the details)
- **A name has one owner.** This covers tool names, protocol (endpoint-type) ids, provider ids, backup-place types, skill and personality names, and anything else plugins register by name. Hooks and UI slots that add things up (chips, cards, panels) don't clash.
- **Replaceable UI components are names too:** the avatar, the dock, the now-card and the plan row (src/ui/slots.js `component`). Milestone 8b chose "the last registered wins". That becomes the same rule as everything else:
  - a plugin that replaces a component declares `replaces`;
  - its install screen says so plainly, for example "It replaces how Shiori looks";
  - with two plugins replacing the same component, the user picks on the plugin page;
  - an installed third-party component plugin without `replaces` shows "Not used", with the switch.

  docs/plugins.md changes with it.
- **Built-ins and official plugins keep their names.** A third-party plugin can't take one silently.
- **A plugin may declare `replaces: ["<name>", …]`** in its manifest. The install screen then says "It replaces <name> from <owner>", and the user chooses. The choice is stored, shown on both plugins' pages, and can be undone there.
- **A clash without `replaces`** isn't used. The plugin's page says "Not used: <name> is already provided by <owner>", with a "Use this one instead" switch.
- **Load order is fixed** (built-ins, then official plugins, then third-party plugins by install time), so behaviour is repeatable. Once the user has chosen, the choice decides, not the order.
- **Plugin ids:** the official catalog keeps them unique. Installing a third-party plugin whose id is already installed is an update or replace, with a confirmation, as installing over an existing package works today. The builder checks that flow and closes any gap.

### Moving over (the user: low effort)
- No merging logic. The builder picks the simplest honest path. Either:
  - each old endpoint becomes a provider with one ability; or
  - a one-time card says the model setup changed and to add providers again.
- Either way, keys of endpoints that are dropped are deleted (§4.9), and nothing fails silently.

## Spec changes
docs/superpowers/specs/2026-10-15-annai-design.md:
- **§5:** kinds (provider plugins, data-only plugins and their trust), the manifest (`requires`, `replaces`, `keywords`, the provider description), install and update with dependencies, and conflicts;
- **§9:** endpoint becomes provider, with abilities; one key per provider (this replaces the "one key per endpoint" ruling, which the user made when an endpoint was the unit);
- **§9.8:** onboarding, and OpenRouter's sign-in as its plugin's setup;
- **§10:** speech models come from providers' abilities;
- **§15:** data-only plugins need no trust warning;
- **§16:** the catalog screen and the plugins page.

docs/plugins.md: the provider contract, `requires`, `replaces`, and how a data-only provider is written.

## What it builds on (my call)
The plan starts from main after these merge: settings-tidy (it reworks the Models and endpoint screens, and adds "Try this model"), storage-forgejo, and updates-page (Settings → Updates, whose plugin update flow this design reuses for provider plugins). The small-fixes batch can run alongside where its files don't overlap.

## Left to the builder
- The exact data schema of a configured provider, the manifest field names, and the shape of the provider contract and setup-screen slot.
- How today's 36 templates become provider plugins. A script that generates them from templates.json is fine, as is the layout under plugins-official/ (or a providers/ folder) and the catalog entries.
- Which settings are per ability and which per provider.
- How to split the work into milestones and in what order. A sensible one:
  1. providers, abilities, `requires` and data-only provider plugins;
  2. the catalog screen and plugins-page search;
  3. OpenRouter as a code provider;
  4. "Another address";
  5. conflicts.
- Keeping the shipped core within a sensible size: the provider data moves out of the core, and the catalog screen comes in.
