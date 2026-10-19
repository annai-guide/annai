# Providers as plugins, one catalog, and plugin conflicts: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every model provider becomes a plugin with one address, one key and many abilities. Providers are added from one searchable catalog, and what they `requires` is installed with them. "Another address" finds out at no cost what a server offers. Local servers get plugins of their own, and a name two plugins both claim is settled in the open.

**Architecture:**
- **Two layers.** Protocol plugins are today's endpoint-type plugins, and their contract doesn't change. Provider plugins are mostly data: an `annai-plugin.json` with a `provider` description and no `entry`.
- **A configured provider** (`/llm/providers/<id>.json`) holds one key (`llm:<id>`) and its abilities, and each model belongs to one ability. At call time a model resolves to its provider's ability, in the same `endpoint` shape protocol plugins get today.
- **Dependencies.** `src/core/requires.js` resolves `requires` on install and update. Removing a plugin's last provider uninstalls that plugin, then every official protocol plugin nothing needs any more.
- **Code providers.** A small contract, `annai.providers.setup`, lets one draw its own setup panel, hand annai a key, take annai's address coming back from a sign-in, and adjust error kinds, headers and model lists. OpenRouter and "Another address" use it.
- **Names.** A one-owner rule in the registry settles every clash. `replaces` and the user's choice can change the owner.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3 (`npm run typecheck`).
- Tests: `node:test` (Node 26), and Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15).

**Spec:** `docs/superpowers/specs/2026-10-18-provider-plugins-design.md` is the design to build from (approved). Its rules sit inside the main spec, `docs/superpowers/specs/2026-10-15-annai-design.md`. Executors read both. The first mockups (the search screen, a provider's page, the probe screen) are in the main checkout's git-ignored `.superpowers/brainstorm/`. They are wireframes, read-only.

**Starts from:**
- main after updates-page merges. Its Settings → Updates flow is the one provider plugin updates use. storage-forgejo and settings-tidy are merged already.
- small-fixes may merge before or alongside. It stays out of `src/core/llm` and the Models screens, but it touches `src/app/main.js`, `src/ui/screens/backups.js`, `src/core/voice/voice.js` and `scripts/size.mjs`. Rebase onto main before each milestone.

## Global Constraints

- **Platform, from the design's Constraints:** "annai stays local-first and browser-only: native ES modules, no build step, JSDoc types checked by tsc, and the size budget (scripts/size.mjs)."
- **Spec rules that hold:**
  - §4.9: removing means removing, and everything stored is named;
  - §15: keys never in files, events or the trace;
  - §5.3: official plugins are hash-checked, and updates apply only on the user's tap;
  - §17 rule 5: nothing lands mid-trip.
- **No imports across plugins.** "One plugin can't import another's files." Dependencies work only through what plugins register at runtime.
- **Connection:** "The catalog is served from annai.guide. Installing needs a connection; using what's installed doesn't."
- **Public repo:** "The repo is public: no machine or tailnet addresses in it." That covers plans, tests, fixtures, notes and commit messages. The user's servers are named, never addressed.
- **Anti-goals.** Each of these is a failure even if it works:
  - downloading a protocol plugin the first time it's used;
  - a data-only provider asking for full trust, or able to run code;
  - silent conflicts;
  - a key stored more than once for one provider;
  - anything priced placed ahead of a free path by default;
  - probing that costs money without the user tapping Test.
- **Security policy.** The CSP in `_headers` holds: no `innerHTML`, no `style` attributes, and `connect-src https: http://localhost:* http://127.0.0.1:*`.
- **Writes:** every write is one transaction (§4.2). Fingerprints are computed before the transaction opens.
- **Shipped files:**
  - Every file under `src/` and `assets/` is listed in `sw.js` `SHELL`, and a unit test checks this.
  - After any shipped file changes, run `npm run stamp`.
  - `plugins-official/` and `catalog/` are not in the shell.
- **Settings save as they change** (§16.1). Save buttons stay only for keys and connections: a provider's address, key and extra headers are saved together.
- **Copy:** plain words, and every error says what happened and what to do next.
- **Ports and the user's machines:**
  - Stand-in servers listen on `127.0.0.1` port 0.
  - Never bind 8765, 8790–8799, 18010–18014, 3000, 3300, 8470–8473 or 8481 on the host.
  - Never touch the containers `annai-android` or `forgejo`.
  - E2e runs only in Docker, in its own network: never `--network host`.
- **Process** (annai's milestone process):
  - Each milestone is built on its own branch from main, with a git-ignored ledger at `.superpowers/sdd/providers-m<N>/progress.md` in its worktree.
  - Each milestone ends with `npm run stamp && npm run check`, the full Docker e2e, and the size line in the ledger.
  - The coordinator merges. Pushing and releasing wait for the user's OK.
  - Commits end with the attribution lines the session gives.

## Review Focus

These are the five inputs the design implies but no feature test would meet by itself, most likely first. Each is pinned by a test in the task that owns the code.

1. **Two providers from one plugin** (two OpenAI accounts):
   - each keeps its own key, models and role entries;
   - removing one keeps the plugin and the other whole;
   - their models get names of their own.

   Pinned in M1 Task 3 and Task 5.
2. **A provider plugin update over the user's own changes.** These all stay:
   - a renamed model, a changed price, a deleted header;
   - an ability switched off, a changed address.

   New models arrive outside every role, and a new ability arrives switched off. Pinned in M1 Task 3.
3. **Adding a provider when a requirement's download fails halfway, or the connection drops.** Nothing is half-installed, the words are plain, and the next tap works. Pinned in M1 Task 4.
4. **A backup from before this change, restored after it.** Its endpoints, models and keys come back, are removed again at the next start, and the card says so. Pinned in M1 Task 8.
5. **"Another address" behind auth or a web app.** Some servers answer 401 to every path without a key; others answer 200 with a web page for any path. In both cases nothing is reported as found that isn't there, and nothing costs money. Pinned in M5 Task 1.

---

## The milestones

| # | Milestone | Done when | On the iPhone |
|---|---|---|---|
| 1 | **Providers and abilities:**<br>• configured providers with one key<br>• `requires` installed at add time<br>• the data-only provider plugins for today's 22 templates<br>• the standard provider screen<br>• "Another address" with its abilities chosen by hand<br>• moving over<br>• removing and pruning<br>• provider updates through Settings → Updates | Adding OpenAI from Models installs it and what it needs, with no question. One key serves its chat, transcription and voice. Removing it takes the key, the models, their role entries, the plugin, and the protocol plugins nothing else needs. Sign in with OpenRouter makes one provider with one key. | Add OpenAI and Test it. Sign in with OpenRouter (paste the code): one OpenRouter provider. The moving-over card. Remove a provider. Airplane mode: an added provider still answers. |
| 2 | **Servers you run:**<br>• the llama.cpp, vLLM, SGLang, Ollama and LM Studio provider plugins, their quirks as data<br>• replies that don't stream (the user's maiGo)<br>• context windows read from vLLM's and SGLang's lists | A llama.cpp stand-in streams reasoning, text and a tool call through its plugin. A server that answers one whole JSON reply passes Test and talks. | The llama.cpp (Unsloth) server through its plugin: Fetch model list, Test, Try this model streams, the quick decision doesn't think. maiGo through Another address: Test, Try this model answers. |
| 3 | **One catalog:**<br>• the Add screen with search, browsing by kind and filter chips<br>• opened filtered from Models, a speech role and Plugins<br>• installing from an address moves there<br>• the Plugins page's search and filters | "unsloth" finds llama.cpp, saying "Also for: Unsloth". "lmstudio" lists LM Studio first, then llama.cpp. Each opening screen lands on its filter. | Search "unsloth", "lm studio", "free voice". Models → Add a provider shows only providers. A speech role's Add shows providers with transcription or voice. Plugins search. |
| 4 | **OpenRouter as a code provider:**<br>• the provider contract and setup slot<br>• the featured one-tap start, installed in the background<br>• return routing<br>• `src/ui/openrouter.js` and Chat Completions' OpenRouter code leave the core | `src/` names no provider. On an iPhone Home Screen app, Models with no providers shows Sign in with OpenRouter as a link that already has its address. | After Erase: the welcome's last step names the sign-in. Models' first tap opens OpenRouter in Safari; paste the code, and one provider appears. OpenRouter's plugin page says it has code. |
| 5 | **"Another address" looks for itself:**<br>• the probe at no cost<br>• the results list<br>• adding with what was found, installing only what that needs | A stand-in server's abilities are found, and blocked, unreachable and unknown are told apart. No request can generate. | maiGo: model list, Chat Completions and Responses found, the rest not; Add with these; Test. The llama.cpp server: what it offers. |
| 6 | **Conflicts made explicit:**<br>• one owner per name, by fixed rank or the user's choice<br>• `replaces` asked at install<br>• "Not used" with a switch<br>• components under the same rule<br>• skills under the same rule<br>• the plugin-id gaps closed | Two plugins giving one tool: one is used, the other's page says "Not used: … is already provided by …", and the switch swaps them, stored and undoable. | Install a test plugin by its address that gives a taken tool name: its page says Not used; switch, and Shiori uses it. An avatar plugin asks "It replaces how Shiori looks"; choose, see it, undo. |

**Why this order:**
- The design's own order is kept, with "Servers you run" put second.
- Milestone 1 retires today's local-server template, and "Another address" (chosen by hand) covers any server at once.
- The five local-server plugins get their facts and their real-server check before the catalog makes them searchable.
- maiGo can't talk to annai today (see M2), and that fix belongs with servers the user runs.

---

## Decisions this plan makes

The design leaves these to the builder. Each line says why.

1. **Moving over: a one-time card, not conversion.**
   - At start, today's endpoint records go, with their models, their role entries, their keys (`llm:<endpoint id>`), their uploads and the cached `/llm/catalog/templates.json`.
   - A card names the endpoints removed and says to add providers again.
   - Why: no merging code (size), and the user said so ("even if it does not migrate it is fine"). Keys are deleted (§4.9), and nothing fails silently.
2. **A data-only provider is one file.**
   - The description sits inline in `annai-plugin.json` as `provider`, which replaces the manifest's `templates`. A manifest that still has `templates` is refused, in words that point to `provider`.
   - Why: one file to write, fetch and hash, and the catalog script reads its facts from it.
3. **What is per provider and what is per ability.**
   - Per provider: the name, the address, extra headers and the one key.
   - Per ability: on or off, its protocol type, its own address (empty means the provider's), its tunables, its extra request fields and the photo-uploads switch (a tunable).
   - Why: tunables and extra fields are defined by each protocol and can't be shared across protocols. Headers and the key are how the server is reached, which is the same for every ability.
4. **The template layer is copied, and refreshed when its plugin's version changes.**
   - `syncProviders` runs once the plugins have started, and on each registry change after that.
   - It replaces each provider's and model's template layer, adds models that are new to the description, and leaves user layers alone (§9.2: user > template > plugin default). Models gone from the description stay as they were.
   - Why: records stay plain (so `modelOf` and every reader stay as they are), and this covers updates and restored backups alike.
5. **What an update brings is never put to use by itself.**
   - An ability new in an update arrives switched off, offered on the provider's page.
   - A model new in an update joins no role.
   - Why: §9.8, "It is never added silently."
6. **A provider's speech models join behind the free entries when it is added.**
   - Its transcription models go after phone dictation, and its voices after the browser voice (`speechBehind`), as Sign in with OpenRouter's do today. The provider page's "Use the recommended models" puts them first, on that tap only.
   - Why: the anti-goal "anything priced placed ahead of a free path by default". Adding OpenAI to chat must not make a priced voice speak first.
   - It changes §10.1 and §10.3, which say "a voice a template adds goes ahead of it". Templates are gone, and the closest thing, a provider's abilities, follows the anti-goal.
7. **What `requires` looks like.**
   - It is a list: `[{ "id": "chat-completions", "version": "^0" }, { "id": "acme-proto", "version": "^2", "homepage": "https://…" }]`.
   - A range is `^N`, meaning the same semver major. The major is the protocol's interface version, and today's protocol plugins are 0.x, so official providers ask for `^0`.
   - Why: the smallest syntax there is, and no forced protocol updates or restarts on release day.
8. **`requires` covers the abilities that start switched on.**
   - An ability that starts off (OpenAI's Chat Completions ability, or any ability of Another address) brings its official protocol plugin when it is turned on, and stops there if that protocol isn't official.
   - Why: "annai installs only the protocol plugins those need."
9. **Calls never install.**
   - At call time, a model whose protocol type isn't running is skipped as `type-missing`. The fallback's next model answers, and the provider's page offers Install.
   - Only setup actions may install: adding, turning an ability on, Test, Fetch model list, and Try this model. Today `service.resolve` installs for speech calls; that stops.
   - Why: anti-goal 1.
10. **Pruning removes official protocol plugins only.**
    - Those are the official plugins that provide `endpoint-type`, and they go when no installed plugin requires them and no configured ability uses their types.
    - A third-party protocol plugin stays.
    - Why: official code comes back from the catalog, while a third-party one would need its address again.
11. **An update from an address that sends keys somewhere new asks first.**
    - It asks when the update's provider description names a host its installed description didn't (`descHosts`), with the same "asks first" flow as new code or skills.
    - Why: a description decides where a key the user gives it is sent (today's install screen says so of templates).
12. **Plugin ids are `provider-<name>`.**
    - Why: one id space is shared with skills and every other package.
13. **Kinds are six manifest categories.**
    - The manifest's `category` is one of `providers`, `speech`, `backup`, `tools`, `skills`, `developer`. The screen calls them Model providers, Voices and transcription, Backup places, Tools and MCP, Skills and personalities, and Developer.
    - When `category` is absent, it is derived:
      - a provider with a chat ability is `providers`, one with speech abilities only is `speech`;
      - a plugin providing `storage-type` is `backup`, and one providing `endpoint-type` is `developer`;
      - skills or personalities without code are `skills`;
      - other code is `tools`.
    - Goal 3's "kind, category and ability" becomes one Kind chip row of these six, plus the ability chips.
    - Why: it fits a phone's width, and the user's "type / category" is answered by the groups. Protocol plugins, the scripted model and Remote trace sit under Developer.
14. **Keywords are written as they are shown** ("LM Studio"), and matching ignores case.
    - Why: a match reads "Also for: LM Studio". The design's example `["unsloth", "lm studio", "koboldcpp"]` becomes `["Unsloth", "LM Studio", "KoboldCpp"]`.
15. **The provider contract is `annai.providers.setup({ panel, keyField, returned, classify, headers, list })`.**
    - `panel(ui, null)` is three things at once: the plugin's own Add flow, the featured one-tap start, and Another address's probe screen.
    - The design asks for "headers, error kinds, model lists": those are `headers`, `classify` and `list`.
    - Why: one small shape covers sign-in, probing and the quirks the design names.
16. **A sign-in coming back is routed by a marker.**
    - `ui.expectReturn()` stores `{ plugin, at }` in localStorage under `annai.return`.
    - The next load of annai's address with a query within 15 minutes goes to that plugin's `returned()`. Any other query is removed from the address and ignored.
    - Why: it is explicit, the core names no provider, and today's sign-in already lives with 15 minutes.
17. **The one-tap start shows on Models with no providers** (M4), as the design says.
    - Today it shows until an OpenRouter endpoint exists. In M1 it keeps that rule, rewritten as "until an OpenRouter provider exists".
18. **How the probe reads answers.** The design's rule is kept, and made safe:
    - a control request to a path that can't exist tells whether 401 or 403 says anything;
    - a 2xx answer that isn't JSON is a web page, so the path is absent;
    - 429 and 5xx are unknown;
    - an address with no path is also tried with `/v1`;
    - Anthropic Messages is probed at the address without its `/v1`, which is how that protocol builds its URL.

    Why: auth middleware and web-app fallbacks would otherwise make false finds, and no request can still generate (none has a model or an input).
19. **Who owns a name.**
    - The owner is the user's stored choice if that plugin is running and registers the name. Otherwise it is the lowest rank: built-ins, then official plugins, then third-party plugins by install time, then id.
    - annai's own components (avatar, dock, now-card, plan-row) are owners with no registry entry.
    - The agent loop's own tools are reserved: no plugin replaces them.
    - Why: it is fixed and repeatable. A plugin replacing the loop's own tools could break the loop.
20. **At M6's first start, a third-party component that the old rule ("the last registered wins") was using is recorded as the user's choice.**
    - Why: "a plugin's contribution quietly not used" must not happen on upgrade.
21. **Skills join the one-owner rule.**
    - A taken skill name no longer stops an install. The skill is Not used, with the switch.
    - Why: the design names skill names, and `replaces` must work for them.
22. **The local-server plugins start data only, then get a little code** (the user's answer, 2026-10-18: "yes add the code for reading context windows").
    - That code reads the context window the server really serves: llama.cpp's `/props`, Ollama's `/api/show`, and LM Studio's `/api/v1/models` with its vision and tool flags.
    - It uses the provider contract's `list` hook, so it's built in Milestone 4 once the contract exists. Milestone 2 ships them data only, with the context window set by hand until then.
    - They're official, so there's no install question; their plugin pages show the has-code note.
    - Ollama's hook can also give a model whose `/api/show` capabilities include `thinking` the full named map (`reasoning_effort` low, medium, high). Milestone 2 leaves those levels empty, as Ollama refuses a named level for a model that can't think (M2 fix pass, 2026-10-19).
23. **Chat Completions and OpenAI Responses read a whole JSON reply** when a server ignores `stream: true`.
    - Why: maiGo drops `stream` and answers `application/json` (its server writes the whole completion). Today annai's SSE reader finds nothing in that reply and says "The reply stopped before it finished".
24. **OpenRouter's speech list paths stay data.**
    - They are the speech protocol's generic `listPath` tunable, set in OpenRouter's description. The protocol's comment stops naming OpenRouter.
    - Only its sign-in and its free-limit rule are code.
    - Why: "Each is data first". `listPath` is not about one provider: any server may list its speech models elsewhere.
25. **How a provider's key is sent is the protocol's way, unless the description says `keyHeader`.**
    - With a `keyHeader`, annai puts the key in that header and passes the protocol no key, so the protocol contract doesn't change.
    - Why: the design lists "how its key is sent" in a provider's description. None of today's providers needs it, but a provider like Azure's (`api-key`) would.
26. **Provider tools are offered ability-wide through `modelDefaults.providerTools`.**
    - OpenRouter's chat gives every model added from its list OpenRouter web search, and Anthropic's gives Anthropic web search.
    - Why: §9.2's table has "provider tools offered endpoint-wide", which today exists only per template model.

---

## Shapes

### The manifest (`annai-plugin.json`): new fields

| Field | Milestone | Shape and rule |
|---|---|---|
| `provider` | M1 | A provider description, below. Data only when `entry` is absent. |
| `requires` | M1 | `[{ id, version: "^N", homepage? }]`, at most 10 entries. Each `id` is a plugin id, `homepage` is an https URL (shown when the requirement is missing). |
| `category` | M1 | `providers` · `speech` · `backup` · `tools` · `skills` · `developer`. |
| `keywords` | M1 | Strings of 1 to 40 characters, at most 20, written as shown. |
| `featured` | M4 | A sentence of at most 200 characters, for the welcome's last step. It counts only in annai's own catalog. |
| `replaces` | M6 | Names the plugin registers and means to replace, such as `["weather", "avatar"]`. Bare names, as the design writes them; each is looked up across the kinds below. |
| `templates` | removed | Refused: "Endpoint templates were replaced by `provider` (see docs/plugins.md)". |

### The provider description (`manifest.provider`)

```js
/** @typedef {{
 *   baseUrl: string,                         // '' when the user must give one
 *   key: 'required' | 'optional' | 'none',   // none: no key field (the scripted model)
 *   keyHeader?: string,                      // send the key as this header instead of the protocol's way (Decision 25)
 *   keyUrl?: string, note?: string,
 *   headers?: Record<string, string>,        // sent with every ability's requests
 *   local?: boolean,                          // a server the user runs: the Local chip
 *   abilities: Record<string, AbilityDesc>,  // ids /^[a-z][a-z0-9-]{0,30}$/, in the order shown
 *   roles?: Record<string, Record<string, string[]>>, // "recommended" | "free" → role → provider model ids
 * }} ProviderDesc
 * @typedef {{
 *   kind: 'chat' | 'transcription' | 'voice',
 *   type: string,                            // the protocol's endpoint type id
 *   name?: string,                           // "Chat (Responses)"; else the kind's name and the type's
 *   on?: boolean,                            // default true
 *   baseUrl?: string,                        // its own address; default the provider's
 *   tunables?: Record<string, any>, extraBody?: Record<string, any>, note?: string,
 *   modelDefaults?: import('../src/core/llm/config.js').ModelValues, // what a model added by id or from a list starts with
 *   models?: (ModelValues & { providerId: string })[],
 * }} AbilityDesc */
```

- `roles` entries are resolved among the models of the abilities whose kind fits the role, first match in ability order:
  - `main`, `utility` and `decide` take chat models;
  - `speech-in` takes transcription models;
  - `speech-out` takes voice models.
- `checkProviderDesc` refuses a role entry that matches nothing.

### A configured provider and its models (sys:settings)

```js
/** @typedef {{ id: string,                    // newId('pv')
 *   plugin: string,                          // the provider plugin's id; 'provider-another-address' for Another address
 *   template: { version: string, values: ProviderValues } | null,   // the description as of that plugin version
 *   user: ProviderValues, created: number }} ProviderRecord          // /llm/providers/<id>.json
 * @typedef {{ name?: string, baseUrl?: string, headers?: Record<string, string | null>,
 *   abilities?: Record<string, AbilityValues> }} ProviderValues
 * @typedef {{ on?: boolean, kind?: string, type?: string, name?: string, baseUrl?: string,
 *   tunables?: Record<string, any>, extraBody?: Record<string, any> }} AbilityValues
 * @typedef {{ id: string, provider: string, ability: string,
 *   template: { id: string, version: string, values: ModelValues } | null, user: ModelValues,
 *   verified?: Record<string, any>, created: number }} ModelRecord   // /llm/models/<id>.json
 *   template.id: '<plugin>/<ability>/<providerModelId>' from a description, 'list/<providerModelId>' from a list (version '') */
```

- **The key** is the secret `llm:<provider id>`, one per provider.
- **Roles** (`/llm/roles.json`) don't change.
- **Uploads** (`/llm/uploads.json`) are keyed by `<provider id>/<ability id>`, because file ids belong to one protocol's files API.
- **What a call sees** (`endpointOf`, the `endpoint` protocol plugins receive) is `{ id: '<provider>/<ability>', provider, ability, type, name, baseUrl, headers, tunables, extraBody }`. Protocol plugins keep reading `endpoint.baseUrl`, `.headers`, `.tunables` and `.extraBody` as today.

### A catalog entry (`catalog/plugins.json`, written by `scripts/catalog.mjs`)

```js
{ id, name, version, description, category, keywords, abilities /* kinds, in order */, free, local, code, size /* bytes */,
  featured /* M4 */, requires, provides, files /* name → SHA-256 */ }
```

- `free`: some model of the description has all its prices at 0.
- `local`: from the description.
- `code`: an `entry` is present.
- `catalogFacts(manifest, { size })` (`src/core/catalog-facts.js`) computes the same facts for an installed third-party plugin, so the catalog screen and the Plugins page read one shape.

### The provider contract and its setup slot (M4)

```js
annai.providers.setup({
  panel(ui, provider) { … },   // → Element | null. provider null: this plugin's own Add flow (and the featured start);
                               //   else the configured provider's page, drawn in the key's place
  keyField: true,              // default true: the standard key field still follows the panel
  async returned(params, ui) { … },   // annai's address came back with a query after ui.expectReturn()
  classify(status, body, abilityId) { … },   // → ErrorKind | null, asked before the protocol's own
  headers(abilityId) { … },    // → Record<string, string>: extra headers for that ability's requests
  async list({ ability, endpoint, key, fetch }) { … },  // → ListedModel[]: in place of the protocol's model list
});
/** @typedef {{ h, go, toast, card, render,
 *   returnsElsewhere: boolean,  // a page annai opens comes back to Safari, not here (an iPhone Home Screen app)
 *   add(o?: { key?: string, roles?: 'recommended' | 'free' | null, name?: string, baseUrl?: string,
 *             abilities?: Record<string, { on: boolean, baseUrl?: string }> }): Promise<string>,  // the provider's id
 *   keep(providerId: string, key: string | null): Promise<void>,  // only providers of this plugin
 *   expectReturn(): void }} SetupUi */
```

- There is one setup per plugin, in the registry kind `provider-setup`.
- What a panel throws counts against its plugin through `made()` (`src/ui/slots.js`), and the standard screen draws without it.

### Name owners and choices (M6)

- **Named kinds**, each with the field that is its name:

  | Kind | Name field |
  |---|---|
  | `tool` | `name` |
  | `endpoint-type` | `type` |
  | `storage-type` | `type` |
  | `skill` | `name` |
  | `personality` | `name` |
  | `ui:component` | `name` |
  | `ui:card-type` | `type` |
  | `search` | `id` |

  Hooks and the adding slots (chips, Now sections, dock actions, tabs, settings pages, screens, themes) never clash.
- **The user's choices** are stored in the app settings as `uses: { "<kind>:<name>": "<plugin id>" }`.
- **Rank:** built-in 0, official 1, third-party 2, then the plugin's `installed` time, then its id.
- **Provider ids** are plugin ids. Ids are unique by install, and M6 Task 4 closes the gaps where annai's own and a third party's could replace each other.
- **`registry.clashes(pluginId)`** gives `[{ kind, name, owner: '<plugin id>' | 'annai', used: boolean, reserved: boolean, chosen: boolean }]`.

---

## The provider list

### From today's 22 templates (M1, data only; OpenRouter gains code in M4, Another address in M5)

| Plugin | Name · category | Abilities: kind via type, models | requires | Key · notes |
|---|---|---|---|---|
| `provider-openrouter` | OpenRouter · providers | **chat**: chat via `chat-completions`, today's 5 models, provider headers `HTTP-Referer` and `X-Title`, tunable `reasoningField: "reasoning"`, `modelDefaults.providerTools`: OpenRouter web search (Decision 26).<br>**transcription**: `openai-transcription`, 4 models, `listPath: "/models?output_modalities=transcription"`.<br>**voice**: `openai-speech`, 4 models, `listPath: "/models?output_modalities=speech"`. Roles: `free` and `recommended` (chat), `recommended` (speech). | chat-completions ^0, speech-openai ^0 | Required, `keyUrl`, today's three notes merged. M4: `entry` (sign-in, free-limit `classify`), and `featured`. |
| `provider-anthropic` | Anthropic · providers | **chat**: `anthropic-messages`, 3 models, `modelDefaults: { cacheTtls: ["5m","1h"], providerTools: [Anthropic web search] }` (today's `START` table leaves the core). | anthropic-messages ^0 | Required. The browser-access header is already the protocol's `browserAccess` tunable, so Anthropic needs no code. |
| `provider-openai` | OpenAI · providers | **chat**: `openai-responses`, 3 models, today's note.<br>**chat-completions** (off): `chat-completions`, tunables `maxTokensField: "max_completion_tokens"`, `systemRole: "developer"`, today's note.<br>**transcription**: 3 models. **voice**: 3 models. | openai-responses ^0, speech-openai ^0 (chat-completions comes when that ability is turned on) | Required. |
| `provider-gemini` | Google Gemini · providers | **chat**: `chat-completions`, address `…/v1beta/openai`. | chat-completions ^0 | Required, today's note. |
| `provider-groq` | Groq · providers | **chat**: `chat-completions`. **transcription**: 2 models. | chat-completions ^0, speech-openai ^0 | Required. |
| `provider-deepseek` | DeepSeek · providers | **chat**: `chat-completions`, `reasoningField: "reasoning_content"`. | chat-completions ^0 | Required. |
| `provider-mistral` | Mistral · providers | **chat**: `chat-completions`. | chat-completions ^0 | Required. |
| `provider-local-speech` | Local speech server · speech | **transcription**: at `http://localhost:8000/v1` (the provider's address). **voice**: its own address, `http://localhost:8880/v1`. | speech-openai ^0 | Optional, `local: true`, keywords Speaches, whisper.cpp, Kokoro; today's HTTPS note. |
| `provider-scripted` | Scripted model (for testing) · developer | **chat**: `scripted`, 1 model. | scripted-model ^0 | None. |
| `provider-another-address` | Another address · providers | **chat-completions**, **responses**, **messages** (`anthropic-messages`, `modelDefaults` with both cache lifetimes, a note to give its address without `/v1`), **transcription**, **voice**: all off. | none (types come when an ability is turned on) | Optional. Keywords OpenAI-compatible, router, proxy, self-hosted; today's HTTPS note. M5: `entry` (the probe). |

Where each of today's templates goes:
- `openrouter`, `openrouter-transcription`, `openrouter-speech` → OpenRouter.
- `anthropic` → Anthropic. `custom-anthropic` → Another address, or Anthropic with its address changed.
- `openai-responses`, `openai`, `openai-transcription`, `openai-speech` → OpenAI.
- `gemini`, `groq`, `groq-transcription`, `deepseek`, `mistral` → their own plugins.
- `local` → the local-server plugins (M2), and until then Another address.
- `local-transcription`, `local-speech` → Local speech server.
- `custom-chat-completions`, `custom-openai-responses`, `custom-transcription`, `custom-speech` → Another address.
- `scripted` → Scripted model.

The plugins get versions `1.0.0`, and their data is copied from `catalog/templates.json` by hand. A throwaway script in the builder's scratch is fine; it isn't committed.

### Local servers (M2)

| Plugin | Address · key | Keywords | Ability, and quirks as data | Note (data) |
|---|---|---|---|---|
| `provider-llamacpp` | `http://localhost:9931/v1` · optional | Unsloth, LM Studio, KoboldCpp | **chat** via `chat-completions`. `modelDefaults.reasoning`: off `{ reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } }`; low, medium and high `{ reasoning_effort: <level>, chat_template_kwargs: { enable_thinking: true } }`. | Unsloth Studio serves at its own address (port 8888 unless changed) with an `sk-unsloth-` key from its Settings → API. Set the context window on each model's page to the server's `-c`. A phone needs an HTTPS address. |
| `provider-vllm` | `http://localhost:8000/v1` · optional | — | **chat** via `chat-completions`. `modelDefaults.reasoning`: off `{ chat_template_kwargs: { enable_thinking: false, thinking: false } }`; on levels `{ chat_template_kwargs: { enable_thinking: true, thinking: true } }`.<br>**transcription** (off): `openai-transcription`, for a Whisper model on its own vLLM. | Tool calls need `--enable-auto-tool-choice --tool-call-parser <name>`. A reasoning model needs `--reasoning-parser`. |
| `provider-sglang` | `http://localhost:30000/v1` · optional | — | **chat**, with the same `chat_template_kwargs` map as vLLM. | Tool calls need `--tool-call-parser`. Reasoning needs `--reasoning-parser`. |
| `provider-ollama` | `http://localhost:11434/v1` · none | — | **chat**. `modelDefaults.reasoning`: `{ reasoning_effort: "none" \| "low" \| "medium" \| "high" \| "max" }` by level. | Allow annai's address: `OLLAMA_ORIGINS=https://annai.guide`. Raise the context: `OLLAMA_CONTEXT_LENGTH=64000` (the default is 4K under 24 GiB of VRAM). Forced tool choice isn't supported, so quick decisions may fall back to the main model. |
| `provider-lmstudio` | `http://localhost:1234/v1` · optional | — | **chat**. No reasoning map yet (its request field isn't documented). | Turn on Enable CORS, and Serve on Local Network, in its server settings. Set Reasoning levels on a model's page if needed. |

The `reasoningField` tunable stays at the protocol's `auto`, which reads `reasoning_content` or `reasoning`. That covers every server below, and vLLM's rename, without data.

### Facts relied on (checked 2026-10-18)

Sources:
- **A:** llama.cpp `tools/server/README.md` (master).
- **B:** unsloth.ai/docs/basics/api.
- **C:** vLLM, from docs.vllm.ai (stable): `cli/serve`, `api/vllm/entrypoints/openai/cli_args`, `…/chat_completion/protocol`, `…/models/serving`. Also from the vllm repository: `docs/features/reasoning_outputs.md`, `tool_calling.md` and `serving/online_serving/README.md`.
- **D:** SGLang, from docs.sglang.io (`basic_usage/openai_api_completions`, `advanced_features/separate_reasoning`). Also from its repository: `srt/entrypoints/http_server.py`, `openai/serving_chat.py` and `openai/protocol.py`.
- **E:** Ollama, from its repository: `docs/api/openai-compatibility.mdx`, `faq.mdx`, `context-length.mdx` and `api/anthropic-compatibility.mdx`.
- **F:** lmstudio.ai/docs/developer, `openai-compat` and `rest/list`.

| | llama.cpp (A, B) | vLLM (C) | SGLang (D) | Ollama (E) | LM Studio (F) |
|---|---|---|---|---|---|
| **Default port** | 9931 (`--port`; the Docker examples use 8080). Unsloth Studio: its own port, 8888 for the UI by default (B). | 8000 | 30000 | 11434 | 1234 |
| **Key** | `--api-key`, Bearer; errors are OpenAI-shaped (401 `authentication_error`). Unsloth: Bearer `sk-unsloth-…`, 401 without. | `--api-key` | `--api-key` | none locally | Bearer token when authentication is on (`LM_API_TOKEN`) |
| **CORS** | Reflects any Origin by default. `--tools` or `--agent` turns the default to localhost; `--cors-origins` sets it. Unsloth: not documented. | `allowed_origins` default `["*"]` | `CORSMiddleware(allow_origins=["*"])` | Only 127.0.0.1 and 0.0.0.0 by default; `OLLAMA_ORIGINS` adds more | Off until Enable CORS (third-party guides; not in LM Studio's own pages) |
| **Reasoning field** | `reasoning_content` (`--reasoning-format`, default auto) | `reasoning` (renamed from `reasoning_content`) | `reasoning_content` (`separate_reasoning`) | not stated in the compat page; the plugin relies on `auto` | not documented |
| **Thinking switch** | `reasoning_effort: "none"` disables thinking, otherwise the value goes to the template. `chat_template_kwargs`, e.g. `{"enable_thinking": false}`. | `chat_template_kwargs`: `enable_thinking` (Qwen3, Granite 4.2, Gemma 4), `thinking` (Granite 3.2, DeepSeek-V3.1, Holo2). `reasoning_effort` `none`…`max` is accepted. | `chat_template_kwargs` (`enable_thinking` for Qwen3, `thinking` for others), `--default-chat-template-kwargs` | `reasoning_effort` and `reasoning.effort`; `"none"` asks for no thinking | `capabilities.reasoning.allowed_options` is listed, but the request field isn't documented |
| **Tools in the stream** | `--jinja` (on by default) | `--enable-auto-tool-choice` and `--tool-call-parser` | `--tool-call-parser` | Yes. `tool_choice` is not supported. | Yes (Tool Use page) |
| **Usage in the stream** | The final chunk has `usage` and `timings`; `stream_options` is not documented (check on the real server) | `stream_options.include_usage` (with `stream: true` only) | `include_usage` | `stream_options.include_usage` | not documented |
| **Prompt cache** | `cache_prompt` is on by default, so nothing is sent | automatic prefix caching on the server | RadixAttention, automatic | per server | per server |
| **Model list** | `/v1/models`: one entry, `architecture.input_modalities` (read today, so photos are found), `meta.n_ctx_train` (the training context, not the served one). The served context is in `/props`, under `default_generation_settings.n_ctx`. | `/v1/models` with `max_model_len` | `/v1/models` with `max_model_len` | ids only. `/api/show` has the context and capabilities. | ids only. `/api/v1/models` has `max_context_length`, `capabilities.vision`, `trained_for_tool_use`, `loaded_instances[].config.context_length`. |
| **Also offers** | `/v1/responses`, `/v1/messages` (Anthropic-compatible, tools need `--jinja`). Unsloth: `/v1/messages` and `/v1/chat/completions` on one port; SSE doesn't survive its `--secure` tunnel. | `/v1/responses`, `/v1/messages`, `/v1/audio/transcriptions` for ASR models | — | `/v1/responses`, Anthropic `/v1/messages` at the host's root | `/v1/responses`, Anthropic compatibility |

maiGo (the user's router, M2 and M5):
- **Routes:** `POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, and `GET /v1/models`.
- **Streaming:** it drops `stream` and `stream_options` and always answers `application/json`.
- **Errors:** a missing key is 401 `authentication_error`; an empty body with a key is 400 "missing required field: model"; an unknown path is 404 `text/plain`. CORS covers `/v1/*`.

### What is data and what needs code

- **Data** (built in M2):
  - addresses, keys and notes;
  - thinking switches, as `modelDefaults.reasoning` maps;
  - other abilities (vLLM's transcription);
  - the reasoning field (the protocol's `auto`);
  - usage in the stream (the protocol's `usageInStream`, on by default);
  - llama.cpp's prompt cache (on by default; nothing to send).
- **Shared protocol code** (built in M2): Chat Completions reads `max_model_len` (vLLM, SGLang), and Chat Completions and Responses read whole replies (maiGo).
- **Provider code** (the user said yes, 2026-10-18; built in M4 with the contract): the served context window from llama.cpp's `/props`, Ollama's `/api/show`, and LM Studio's `/api/v1/models` with its vision and tool flags. Each uses the contract's `list`.

---

## Testing

### Stand-ins (automated)

- **`test/fakes/model-server.js`** (M2) is a real Node HTTP server on `127.0.0.1` port 0, made by `startFakeServer(o)`. It answers like each server's documents say:
  - its flavours are `llamacpp`, `vllm`, `sglang`, `ollama`, `lmstudio` and `whole` (maiGo-like);
  - its modes are a key, CORS (`'*'`, a list of origins, or `false`), `spa` (200 `text/html` for any unknown path) and `authEverywhere` (401 for every `/v1` path without the key, real or not);
  - empty POSTs get 400 on real routes, 404 elsewhere, and 405 for GET on POST routes.

  Unit tests reach it with `test/fakes/browser-fetch.js` (`browserFetch('https://annai.guide')`), which keeps a browser's CORS rules. E2e tests reach it from the page, since the CSP allows `http://127.0.0.1:*`.
- **WebKit can't use `page.route`** for requests from a page a service worker controls. So every stand-in for the page's own requests runs on a port of its own, as `startModelServer` (helpers.js) does today. OpenRouter's fixed addresses can still be stood in for only in Chromium, plus the popup, which no service worker controls (`context.route`), as today.
- **The official catalog and plugins** come from the dev server in e2e, as real, hash-checked plugins.

### The user's own servers (by hand, never in automated tests)

Two servers are used: the user's llama.cpp (Unsloth) server on their home network, which streams for real, and their maiGo router, which doesn't stream.
- **Needs HTTPS in front.** A plain http address on the home network is refused twice: by mixed content on annai.guide, and by the CSP (`connect-src` allows https and http only for localhost and 127.0.0.1). The user put https in front of maiGo already; the llama.cpp server needs the same (the question below).
- **No addresses in the repo.** Checklists say "your llama.cpp server" and "your maiGo router".

Which checks need the real servers:
- **M2, the llama.cpp server:**
  - reasoning deltas stream and show while it thinks;
  - the quick decision's level-off patch stops thinking (Qwen3);
  - a tool call streams, and `stream_options` is accepted with usage arriving;
  - photos are found from `architecture.input_modalities`;
  - Unsloth's proxy passes `chat_template_kwargs` and `reasoning_effort` through.
- **M2, maiGo:** Test and Try this model answer from one whole reply. A long answer stays within the first-words limit, or that limit is raised.
- **M5, both:** the probe's findings match the facts above. On maiGo: list, Chat Completions and Responses found, the rest not. On llama.cpp: list, Chat Completions, Responses, and Messages at the root.

### Commands

- **Unit:** `node --test test/unit/<file>.test.js`. All: `npm test`.
- **Types:** `npm run typecheck`. **Everything:** `npm run stamp && npm run check`.
- **E2e, from the worktree:**

  ```bash
  docker run --rm --ipc=host -v "$PWD":/work -v "$(readlink -f node_modules)":"$(readlink -f node_modules)":ro -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --workers=4 [spec]
  ```

---

## Risks and open points

1. **The size budget.**
   - It is 1605 KiB, with almost no room. updates-page's fix pass makes it 1607, and small-fixes adds about 6.
   - Each milestone reads `npm run size` first, and raises `BUDGET` once at its end by what it added, with the reason appended to the comment, as the project does.
   - Expected changes:

     | Milestone | KiB |
     |---|---|
     | M1 | +8 to +12 (providers.js, requires.js, provider-desc.js, the provider screen; templates.js and the `START` table leave) |
     | M2 | about 0 (protocol code isn't in the shell) |
     | M3 | +10 to +14 (the Add screen, search) |
     | M4 | −8 to −12 (`src/ui/openrouter.js` and the sign-in section leave; the contract is about 4) |
     | M5 | +1 |
     | M6 | +5 to +8 (Skills' claim code goes, about −3) |

   - Moving M4 earlier would bank its saving sooner. Keep the order unless a budget raise is refused.
2. **WebKit in e2e.** `page.route` can't intercept a service-worker-controlled page's requests, so stand-ins listen on their own ports. A test that needs OpenRouter's real addresses is Chromium-only, with its WebKit side covered by the link-before-tap test and the unit tests (today's split).
3. **The iPhone rule: a sign-in link must exist before the tap.**
   - Safari opens a page only from the tap itself, never after an await.
   - In M1, the core's `codeSignIn()` keeps making the address while Models draws.
   - From M4:
     - a screen that offers the start (Models with no providers, the welcome's last step) installs the featured plugin in the background as soon as it opens, once the service worker controls the page;
     - until the plugin's panel is drawn, the button is disabled and says "Getting the sign-in ready…", never a link without an address;
     - the panel builds its `href` before it is shown.
4. **Real servers and https** (above). The real checks wait for an https address in front of the llama.cpp server.
5. **Protocol updates.** M2 and M4 change protocol code. Installed copies are offered the update in Settings → Updates, and code that already ran needs Restart annai. maiGo answers only once Chat Completions 0.4.0 is in use.
6. **Probing.**
   - Preflights carry `content-type` and the key's header. A server that allows only some headers answers the probe as the real calls would, which is the point.
   - The control path covers servers that answer 401 everywhere, and the 2xx-not-JSON rule covers web-app fallbacks.
   - A server that needs a valid model before it answers 400 still answers 4xx, which counts as found.
7. **Replies that don't stream** arrive only at the end, so a long answer from maiGo can pass the role's "Wait for the first words" (30 s). The Another address note says to raise it.
8. **Local servers' traps:**
   - Ollama's 4K default context and its missing `tool_choice`;
   - vLLM's tool flags;
   - LM Studio's CORS switch and its undocumented reasoning field;
   - llama.cpp with `--tools` or `--agent`, which narrows CORS to localhost.

   Notes in each plugin say what to do. None of these can be checked by a stand-in alone.
9. **Rebases.**
   - small-fixes touches `src/app/main.js` (M1's moving-over card, M4's return routing), `src/core/voice/voice.js` (`speechKind` keeps its signature for that reason), `src/ui/screens/backups.js` and `scripts/size.mjs`.
   - updates-page touches `src/ui/screens/plugins.js` and `plugin-install.js` (M1, M3, M6).
10. **E2e helper churn.** `addEndpoint` and `modelSetUp` are used by 16 specs. Change the helpers once per milestone (M1, M3, M5), not each spec.
11. **Moving over deletes keys.** The user adds providers again, and an old backup restored later triggers the card again (Review Focus 4), by design.
12. **M6 changes `registry.list()`** for named kinds, under every consumer: run the whole suite. Skills' install-time refusal tests become "Not used" tests.
13. **`featured` is trusted only from annai's own catalog.** A third-party manifest's `featured` is ignored everywhere.

### Questions only the user can answer (both answered 2026-10-18)

1. **Answered: yes, add the code** (decision 22; built in M4). **Code for context windows.** Should llama.cpp, Ollama and LM Studio get a little code to read the served context window, and LM Studio's vision and tool flags?
   - Shiori's housekeeping works from each model's context window, and Ollama's default of 4K is easy to miss.
   - Code makes those plugins "has code" (official, so no install question, but the full-access note on their pages).
   - The plan builds them data only and asks the user to set the context window by hand.
2. **Answered: https is in front of it on the tailnet,** and the user enters an API key from Unsloth Studio into annai on the phone, because Studio wants a key for proxied requests. Addresses stay out of the repo. **HTTPS for the llama.cpp server.** Can the user put https in front of their llama.cpp server, as for maiGo, for M2's and M5's checks from the iPhone? Without it, those checks can't run from the phone or from annai.guide at all.

---

# Milestone 1: Providers and abilities

## File structure

```
src/core/llm/provider-desc.js        new: ProviderDesc checks, descHosts, ABILITY_KINDS, CATEGORIES, ROLE_KIND
src/core/catalog-facts.js            new: catalogFacts(manifest, { size }), for scripts/catalog.mjs and the app
src/core/packages.js                 manifest: provider, requires, category, keywords; templates refused; Parts/Added: hosts
src/core/requires.js                 new: satisfies, checkRequires, installWith, addFromCatalog, prune, dependents
src/core/llm/config.js               providers, abilities, models by ability, one key per provider, endpointOf(rec, ability)
src/core/llm/providers.js            new (templates.js's successor): addProvider, syncProviders, useSuggestion, listed models, speech lists
src/core/llm/templates.js            deleted
src/core/llm/move-over.js            new: moveOver(ws, store)
src/core/llm/official.js             updateOfficial resolves requires
src/core/package-updates.js          updateFromAddress resolves requires; new hosts ask first
src/core/plugins.js                  registers a started plugin's provider description (kind 'provider'); templates go
src/core/llm/service.js              providers(), addProvider, removeProvider, setAbility, listModels(provider, ability); no install on calls
src/core/llm/fallback.js             endpointOf by ability; 'off' skip; key by provider
src/core/llm/call.js                 uploads keyed by endpoint.id (now provider/ability)
src/core/voice/where.js, src/core/voice/speaker.js   providers in place of endpoints
src/ui/screens/provider.js           new (endpoint.js's successor): the standard provider screen
src/ui/screens/endpoint.js           deleted
src/ui/screens/models.js             Providers section and Add a provider; roles by ability kind
src/ui/screens/model.js              back to its provider; its ability named
src/ui/openrouter.js                 one OpenRouter provider, one key (still core until M4)
src/ui/screens/plugin-install.js     data-only provider words; what it requires
src/ui/screens/plugins.js, plugin.js provider rows name their providers; Remove names providers and dependents
src/ui/router.js, src/app/main.js, sw.js   routes, moveOver at start, SHELL
plugins-official/provider-*/annai-plugin.json   the 10 providers from today's templates
catalog/templates.json               deleted
scripts/catalog.mjs                  catalog facts per entry; --check checks requires and ability types
test/unit/…                          provider-desc, packages, llm-config, llm-providers, requires, official-providers, move-over, llm-fallback, openrouter*, plugin-updates, credits
test/e2e/helpers.js, models.spec.js, openrouter.spec.js, providers.spec.js
docs/plugins.md, the main spec, README.md, docs/testing/device-checklist-providers.md, scripts/size.mjs
```

### Task 1: Provider descriptions in the manifest

**Files:**
- Create: `src/core/llm/provider-desc.js`
- Modify: `src/core/packages.js` (`PLUGIN_MANIFEST_SCHEMA`, `inspectPackage`, `pluginPackage`, `Parts`, `addedParts`, `addsAnything`, `agreedTo`, `addedWords`, `fetchPackage`'s file list)
- Test: `test/unit/provider-desc.test.js` (new), `test/unit/packages.test.js`, `test/unit/package-kit.js` (`trail-kit` carries a `provider` instead of `templates`)

**Interfaces:**
- Produces:
  - `ABILITY_KINDS = ['chat', 'transcription', 'voice']`
  - `CATEGORIES = ['providers', 'speech', 'backup', 'tools', 'skills', 'developer']`
  - `ROLE_KIND = { main: 'chat', utility: 'chat', decide: 'chat', 'speech-in': 'transcription', 'speech-out': 'voice' }`
  - `checkProviderDesc(desc: any): string[]`: errors such as `"$.abilities.chat.type: …"`, empty when valid.
  - `descHosts(desc: ProviderDesc): string[]`: the sorted, unique hosts of `baseUrl` and every ability's `baseUrl`.
  - `Package` gains `provider: ProviderDesc | null`, `requires: Requirement[]`, `category: string`, `keywords: string[]`, and loses `templates`.
  - `Parts` and `Added` lose `templates` and gain `hosts: string[]`.
  - `@typedef {{ id: string, version: string, homepage?: string }} Requirement`

- [ ] **Step 1: Write the failing tests**

```js
// test/unit/provider-desc.test.js
test('a provider description with abilities, models and roles is valid; each mistake is named', () => {
  assert.deepEqual(checkProviderDesc(OPENAI_LIKE), []);
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'chat', { kind: 'chat' })).join(), /abilities\.chat\.type/);
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'x', { kind: 'video', type: 'chat-completions' })).join(), /abilities\.x\.kind/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, key: 'maybe' }).join(), /\$\.key/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, roles: { recommended: { main: ['no-such-model'] } } }).join(), /roles\.recommended\.main/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, roles: { recommended: { 'speech-out': ['gpt-6-luna'] } } }).join(), /speech-out/); // a chat model can't be a voice
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'Bad Id', { kind: 'chat', type: 'x' })).join(), /ability id/);
});
test('descHosts lists every host a key may go to', () => {
  assert.deepEqual(descHosts(LOCAL_SPEECH), ['localhost:8000', 'localhost:8880']);
});
// test/unit/packages.test.js
test('a data-only provider package: provider, requires, keywords and category are read, and it has no code', async () => {
  const pkg = await inspectPackage(files({ provider: OPENAI_LIKE, requires: [{ id: 'openai-responses', version: '^0' }], keywords: ['GPT'], category: 'providers' }));
  assert.equal(pkg.code, false); assert.equal(pkg.provider.abilities.chat.type, 'openai-responses');
  assert.deepEqual(pkg.requires, [{ id: 'openai-responses', version: '^0' }]); assert.deepEqual(pkg.keywords, ['GPT']);
});
test("a manifest with templates is refused, pointing to provider; a provider that isn't valid is refused with its errors", async () => {
  await assert.rejects(inspectPackage(files({ templates: ['t.json'] })), /replaced by .provider./);
  await assert.rejects(inspectPackage(files({ provider: { abilities: {} } })), /provider .*baseUrl|key/);
});
test("requires: a range that isn't ^N, an id that isn't one, or a homepage that isn't https is refused", async () => { /* three rejects */ });
test('addedParts: a provider whose description names a host the installed one did not has hosts in Added', () => {
  const added = addedParts({ code: false, skills: [], personalities: [], hosts: ['api.a.test'] }, pkgWith({ baseUrl: 'https://api.b.test/v1' }));
  assert.deepEqual(added.hosts, ['api.b.test']); assert.equal(addsAnything(added), true);
  assert.match(addedWords(added), /sends keys to api\.b\.test/);
});
```

- [ ] **Step 2: Run them and see them fail.** Run `node --test test/unit/provider-desc.test.js test/unit/packages.test.js`. Expected: FAIL (`provider-desc.js` is missing; `templates` is still read).
- [ ] **Step 3: Implement**
  - `provider-desc.js`: a JSON Schema for `ProviderDesc` checked with `validate` (`src/core/schema.js`), plus the role check against `ROLE_KIND`.
  - `packages.js`:
    - the schema fields from "Shapes";
    - `pluginPackage` runs `checkProviderDesc` and throws `PluginError(id, 'its provider isn't valid: …')`;
    - `installedParts` (in `plugins.js`, Task 5) gives `hosts` from the stored description;
    - `fetchPackage` no longer asks for template files.
- [ ] **Step 4: Run the tests again.** Expected: PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit.** "Provider descriptions in the manifest: provider, requires, keywords and category; templates refused; a new host in an update counts as something new".

### Task 2: Configured providers, abilities and one key

**Files:**
- Modify: `src/core/llm/config.js` (types, schemas, `readConfig`, save and remove, keys, `endpointOf`, `speechKind`)
- Test: `test/unit/llm-config.test.js` (rewritten)

**Interfaces:**
- Consumes: `ROLE_KIND` (Task 1).
- Produces:
  - `newProvider(plugin: string, layers?: { template?, user? }, now?): ProviderRecord`, with an id from `newId('pv')`.
  - `providerOf(rec: ProviderRecord, tunablesFor: (type: string) => Record<string, any> = () => ({})): Provider`, where `Provider = { id, plugin, name, baseUrl, headers, abilities: Record<string, Ability> }` and `Ability = { id, kind, type, name, on, baseUrl, tunables, extraBody }`.
    - The ability's address is its own, else the provider's.
    - Its tunables are the type's defaults, then the template's, then the user's.
    - The name falls back to the plugin id.
  - `providerBase(rec, tunablesFor): Provider`: the same without the user layer, for `diffLayer`.
  - `endpointOf(rec: ProviderRecord, abilityId: string, tunableDefaults?: Record<string, any>): Endpoint`, with `Endpoint = { id: '<provider>/<ability>', provider, ability, type, name, baseUrl, headers, tunables, extraBody }`.
  - `readConfig(ws): Promise<{ providers: Record<string, ProviderRecord>, models: Record<string, ModelRecord>, roles: Roles }>`. A model is kept only if its provider exists and has its ability.
  - `saveProvider(ws, rec, models?: ModelRecord[])`, `saveModel(ws, rec)` (its provider and ability must exist; names unique, whatever their case), `saveRoles`, `removeModel`.
  - `removeProviderRecords(ws, store, id): Promise<string[]>`: the removed model ids. It writes the provider, its models and the roles in one transaction, then removes the key and the provider's entries in `/llm/uploads.json`.
  - `setKey(store, providerId, key | null)`, `getKey(store, providerId)`: the secret `llm:<providerId>`.
  - `abilityOf(cfg, modelId): Ability | null`.
  - `speechKind(cfg, types, id): 'in' | 'out' | null`. Same signature as today. It comes from the ability's kind, and is null when the ability is off or its type isn't running.
  - `sendKey(endpoint: Endpoint, key: string | null, keyHeader?: string): { endpoint: Endpoint, key: string | null }`: with a `keyHeader`, the key goes into `endpoint.headers[keyHeader]` and the protocol gets `key: null` (Decision 25). The fallback, speech calls and Test call it before the protocol. `providerOf` exposes `keyHeader` from the template values.
  - `newModel(provider: string, ability: string, layers?, now?): ModelRecord`. `diffLayer` is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test('a provider round-trips; each ability resolves type defaults < description < user, and its address defaults to the provider\'s', async () => {
  const rec = newProvider('provider-local-speech', { template: { version: '1.0.0', values: LOCAL_SPEECH_VALUES } });
  await saveProvider(ws, rec);
  const p = providerOf((await readConfig(ws)).providers[rec.id], () => ({ path: '/audio/speech' }));
  assert.equal(p.abilities.transcription.baseUrl, 'http://localhost:8000/v1');
  assert.equal(p.abilities.voice.baseUrl, 'http://localhost:8880/v1');
  assert.equal(endpointOf(rec, 'voice', { path: '/audio/speech' }).id, `${rec.id}/voice`);
});
test("a user's changes to one ability never touch another's, and headers belong to the provider", () => { … });
test('one key per provider, only in secrets (spec §9.9)', async () => {
  await setKey(store, rec.id, 'sk-one'); assert.equal(await getKey(store, rec.id), 'sk-one');
  assert.ok(!JSON.stringify(await allSettingsFiles(ws)).includes('sk-one'));
});
test('removing a provider removes its models, their places in roles, its key and its uploads, and nothing of another provider', async () => { … });
test('a model whose ability the provider no longer has is skipped on read; records that are not valid are refused on save and skipped on read', async () => { … });
test('speechKind comes from the ability: in for transcription, out for voice, null when the ability is off or its type is not running', () => { … });
test('a provider with keyHeader sends its key in that header and gives the protocol no key; without it the protocol gets the key', () => {
  assert.deepEqual(sendKey(EP, 'k1', 'api-key'), { endpoint: { ...EP, headers: { ...EP.headers, 'api-key': 'k1' } }, key: null });
  assert.deepEqual(sendKey(EP, 'k1'), { endpoint: EP, key: 'k1' });
});
// kept from today, adapted: diffLayer keeps only what changed; a deleted header stays deleted; model names are unique whatever their case; roles keep only models that exist and their own stand-ins
```

- [ ] **Step 2: Run** `node --test test/unit/llm-config.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the `config.js` interfaces above.** The `ENDPOINT_*` schemas become `PROVIDER_SCHEMA` (`required: id, plugin, template, user, created`) and `MODEL_SCHEMA` (`provider`, `ability`); the template's `version` is a string. The paths are `/llm/providers/<id>.json` and `/llm/models/<id>.json`.
- [ ] **Step 4: Run** the test file, then `npm run typecheck`. Callers fail to type-check until Task 5; fix them there.
- [ ] **Step 5: Commit.** "Configured providers: one address, one key, abilities each with its own type, address, tunables and fields; models belong to an ability".

### Task 3: Adding providers, and keeping them up to date

**Files:**
- Create: `src/core/llm/providers.js`
- Delete: `src/core/llm/templates.js`, `test/unit/llm-templates.test.js`
- Test: `test/unit/llm-providers.test.js` (new; the template tests ported)

**Interfaces:**
- Consumes: Task 2's `newProvider`, `newModel`, `saveProvider`, `saveRoles`, `setKey`, `readConfig`, `modelOf`, `SPEECH_ROLES`, `SPEECH_DEFAULTS`, `STAND_INS`; Task 1's `ROLE_KIND`.
- Produces:
  - `@typedef {{ plugin: string, name: string, version: string, provider: ProviderDesc }} ProviderSource`: what a started provider plugin registers (Task 5).
  - `addProvider({ ws, store }, src: ProviderSource, o?: { key?, roles?: 'recommended' | 'free' | null, name?, baseUrl?, abilities?: Record<string, { on: boolean, baseUrl?: string }> }): Promise<string>`.
    - It makes one provider and the models of every ability, each under a name no other model has: "Name (2)".
    - It sets the key once.
    - The suggestion fills the chat roles that are still empty. Speech models go behind everything in their lists (`speechBehind`), and a list the user emptied stays empty.
    - The default for `roles` is `'recommended'`.
  - `syncProviders({ ws }, sources: ProviderSource[]): Promise<number>`: the providers refreshed.
    - For each provider whose plugin's version differs from `template.version`: new template values for the provider and its existing models; new models added; an ability new to the description added with `user.abilities[id].on = false`.
    - User layers are never touched.
  - `useSuggestion({ ws }, providerId, src, which)`: the tap. Chat roles are replaced, and speech models go where `withSpeech` puts them (ahead of the stand-ins), as today's suggestions panel says.
  - `addListedModel({ ws }, providerId, abilityId, listed): Promise<string>` and `addModelById({ ws }, providerId, abilityId, providerModelId)`: both start from the ability's `modelDefaults` (the effective one).
  - `withSpeech`, `speechAdd`, `speechBehind`: moved from `templates.js` unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test('adding a provider: abilities and their models, one key, recommended chat models in empty roles, speech models behind the free entries', async () => {
  const id = await addProvider(ctx, OPENAI_SRC, { key: 'sk-o' });
  const cfg = await readConfig(ws);
  assert.deepEqual(Object.keys(cfg.providers), [id]);
  assert.equal(await getKey(store, id), 'sk-o');
  assert.deepEqual(names(cfg, 'main'), ['GPT-6.1 Sol']);
  assert.deepEqual(names(cfg, 'speech-out'), ['browser-voice', 'OpenAI: GPT-4o mini TTS (Marin)']); // behind, never ahead (anti-goal)
  assert.deepEqual(names(cfg, 'speech-in'), ['send-audio', 'dictation', 'OpenAI: GPT Transcribe']);
});
test('two providers from one plugin: two keys, models named apart; removing one keeps the other whole (Review Focus 1)', async () => {
  const a = await addProvider(ctx, OPENAI_SRC, { key: 'sk-a', name: 'OpenAI (work)' });
  const b = await addProvider(ctx, OPENAI_SRC, { key: 'sk-b', name: 'OpenAI (home)' });
  assert.ok(modelNames(await readConfig(ws)).includes('GPT-6 Luna (2)'));
  await removeProviderRecords(ws, store, a);
  const cfg = await readConfig(ws);
  assert.equal(await getKey(store, b), 'sk-b'); assert.equal(await getKey(store, a), null);
  assert.ok(Object.values(cfg.models).every((m) => m.provider === b));
});
test("a newer plugin version refreshes its providers: the user's renames, prices, deleted headers, switched-off abilities and address stay; new models arrive in no role; a new ability arrives off (Review Focus 2)", async () => { … });
test('Use the recommended models replaces the chat roles and puts speech models ahead of the stand-ins, on the tap only', async () => { … });
test('a model added by id or from a list starts with its ability\'s modelDefaults: an Anthropic model takes both cache lifetimes, so it gets the hour', async () => { … });
test('Another address: abilities start off; an ability added on with its own address keeps it', async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/llm-providers.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `providers.js`.**
  - A provider's template values are built from the description: `{ name: src.name, baseUrl, headers, abilities: { id: { kind, type, name, on, baseUrl, tunables, extraBody } } }`. Notes, `keyUrl` and models stay in the description (read through the registry).
  - A model's template is `{ id: '<plugin>/<ability>/<providerId>', version: src.version, values }`.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit.** "Adding providers from their plugins' descriptions, refreshed when the plugin updates, keeping the user's changes; speech models behind the free path".

### Task 4: `requires`: resolving, installing and pruning

**Files:**
- Create: `src/core/requires.js`
- Modify: `src/core/llm/official.js` (`updateOfficial`), `src/core/package-updates.js` (`updateFromAddress`)
- Test: `test/unit/requires.test.js` (new), `test/unit/plugin-updates.test.js`

**Interfaces:**
- Consumes: `officialPlugins`, `download` (export it from `official.js`), `PluginHost.inspect`, `install`, `start`, `uninstall`, `installed`, `verifyOfficial`.
- Produces:
  - `satisfies(version: string, range: string): boolean`, with ranges of the form `^N` only.
  - `checkRequires(host, requires: Requirement[], catalog: CatalogPlugin[]): Promise<CatalogPlugin[]>`.
    - It returns the official plugins to install or update first, in order, and changes nothing.
    - It throws a `PluginError` that names the requirement in each of these cases:
      - a third-party requirement that isn't installed (with its `homepage` when the manifest gives one);
      - one installed out of range that annai can't update;
      - no catalog version in range;
      - an official id that a non-official package holds.
    - It also refuses an update of a protocol plugin to a major that an installed plugin doesn't accept, naming that plugin.
  - `installWith(host, files: Map<string, Uint8Array>, opts: { source, file?, url? }, env: { fetch?, base?, catalog? }): Promise<any>`, returning the manifest.
    - It inspects, plans, downloads and checks every requirement first (hash-checked), installs the requirements and then the package, and starts them.
    - When anything fails, it uninstalls whatever this call newly installed and rethrows.
  - `addFromCatalog(host, id, env): Promise<any>`: `installWith` for an official catalog entry, unless it is installed and current (then it starts it).
  - `prune(host, inUseTypes: Set<string>): Promise<string[]>`: the ids removed (Decision 10).
  - `dependents(host, id): Promise<{ id: string, name: string }[]>`.

- [ ] **Step 1: Write the failing tests** (a `PluginHost` on the in-memory store, with a stand-in catalog fetch, as in `llm-plugins.test.js`)

```js
test('satisfies: ^N is the same major', () => {
  assert.equal(satisfies('0.3.1', '^0'), true); assert.equal(satisfies('1.0.0', '^0'), false); assert.equal(satisfies('2.4.0', '^2'), true);
});
test('an official requirement is installed from the catalog, hash-checked, with no question; one installed in range is left alone', async () => { … });
test('a third-party requirement that is not installed stops the install and names it, with its homepage; nothing is installed', async () => {
  await assert.rejects(installWith(host, files(ACME_PROVIDER), { source: 'url', url: U }, env), /needs acme-proto.*https:\/\/acme\.example\/annai/s);
  assert.deepEqual(Object.keys(await host.installed()), []);
});
test('a requirement whose download fails halfway, or a catalog that cannot be reached: plain words, nothing half-installed, and the next try works (Review Focus 3)', async () => {
  failNext('/plugins-official/speech-openai/index.js');
  await assert.rejects(addFromCatalog(host, 'provider-openai', env), /couldn't be downloaded/);
  assert.deepEqual(Object.keys(await host.installed()), []);
  await addFromCatalog(host, 'provider-openai', env);
  assert.ok((await host.installed())['provider-openai'] && (await host.installed())['openai-responses']);
});
test('no version in range: the install stops and says which and what annai has', async () => { … });
test("an update that changes requires installs what it needs on Update; an update of a protocol to a major an installed plugin doesn't accept stops and names that plugin", async () => { … });
test('prune removes official protocol plugins nothing requires and no ability uses; a third-party protocol plugin stays', async () => { … });
test("dependents names the installed plugins that require one; an official install over a third-party package with that id is refused, saying so", async () => { … });
// plugin-updates.test.js
test('an update from an address whose provider sends keys to a new host asks first, and changes nothing until agreed', async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/requires.test.js test/unit/plugin-updates.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `updateOfficial(host, entry, opts)` calls `checkRequires(host, entry.requires ?? [], catalog)` and installs those first. Its returns stay `'started' | 'restart'`.
  - `updateFromAddress` does the same before `host.install`.
- [ ] **Step 4: Run.** Expected: PASS. Then run `node --test test/unit/llm-plugins.test.js`, which must still pass.
- [ ] **Step 5: Commit.** "requires: installed with a package from annai's catalog, all or nothing; a missing third-party requirement named with its homepage; updates resolve them; protocol plugins nothing needs are pruned".

### Task 5: The host and the model service use providers

**Files:**
- Modify:
  - `src/core/plugins.js`: `#content` registers `'provider'`; `installedParts` gives `hosts`; `describe()` rows gain `provider: boolean` and `requires`.
  - `src/core/llm/service.js`, `src/core/llm/fallback.js`, `src/core/llm/call.js`, `src/core/llm/check.js` (Test's `type.build` probe call takes the endpoint), `src/core/llm/speech.js`.
  - `src/core/voice/where.js`, `src/core/voice/speaker.js`, `src/core/llm/trace.js` (the `endpoint` field keeps its name and holds the provider's name).
- Test: `test/unit/llm-providers.test.js` (the service), `test/unit/llm-fallback.test.js`, `test/unit/plugin-packages.test.js`, `test/unit/voice-where.test.js` (or wherever `whereHeard` is tested)

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces, on `createLlm(…)`'s service:
  - `providers(): ProviderSource[]`: the started plugins' registry `'provider'` items, `{ plugin, name, version, provider }`.
  - `addProvider(plugin: string, o?): Promise<string>`.
    - For an official plugin, `addFromCatalog`. For a third-party one, it must be installed.
    - Then `ensureType` for each ability that starts on, then `providers.addProvider`.
  - `removeProvider(id): Promise<{ plugin: string | null, protocols: string[] }>`.
    - It runs `removeProviderRecords`.
    - If no other provider comes from that plugin, it runs `plugins.uninstall(plugin)`. Then it prunes with the types still in use.
  - `setAbility(providerId, abilityId, on: boolean)`: turning one on ensures its type first (official only); offline, it says so and stays off.
  - `listModels(providerId, abilityId)`, `keyFor(providerId)`, `unbench(providerId)`.
  - `test`, `testLevels`, `callModel` may install (setup). `call`, `transcribe`, `synthesize` never install.
  - Once ready, and after each registry change, `syncProviders(…)` runs with `providers()`. It is debounced, and writes only when a version differs.
- Fallback outcomes gain `'off'` (an ability switched off). `src/ui/format.js`'s `outcomeText('off')` says "its ability is switched off".

- [ ] **Step 1: Write the failing tests**

```js
test('the service adds a provider from a catalog plugin with what it requires, and a role call goes through its ability', async () => { … });
test('a call never installs a protocol plugin: a model whose type is missing is skipped as type-missing, and the next one answers (anti-goal 1)', async () => {
  await plugins.uninstall('chat-completions');
  const r = await llm.call({ role: 'main', request: HI });
  assert.equal(r.attempts[0].outcome, 'type-missing'); assert.equal(fetched('/plugins-official/chat-completions/'), 0);
});
test('removing the last provider of a plugin removes the plugin and the protocol plugins nothing else needs; removing one of two keeps both', async () => { … });
test('turning an ability on installs its official protocol plugin; offline it says so and stays off', async () => { … });
test('a started data-only provider plugin registers its description, and a newer version refreshes the providers made from it', async () => { … });
// llm-fallback.test.js
test('a model of a switched-off ability is skipped as off, and the next model answers', async () => { … });
// voice where
test('where your voice goes names the provider and the host of its ability\'s own address', () => { … });
```

- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
  - `#content` no longer registers templates, and the `'template'` registry kind is gone.
  - Every `cfg.endpoints[...]` site becomes `cfg.providers[model.provider]` with `endpointOf(rec, model.ability, type.tunables)`. `grep -rn "endpoints\[" src` comes back empty.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS, except the UI tests that Task 7 fixes.
- [ ] **Step 5: Commit.** "The model service talks to providers' abilities; calls never install; adding installs what a provider requires; removing the last provider of a plugin removes it and what nothing needs".

### Task 6: The official provider plugins and the catalog

**Files:**
- Create: `plugins-official/provider-{openrouter,anthropic,openai,gemini,groq,deepseek,mistral,local-speech,scripted,another-address}/annai-plugin.json` (the provider list above).
- Create: `src/core/catalog-facts.js`.
- Modify: `scripts/catalog.mjs` (facts per entry; `--check` also checks requires and types), `catalog/plugins.json` (`npm run catalog`).
- Modify: the protocol plugins' manifests get `category: "developer"` (and so does `scripted-model`); `remote-trace` gets `developer`, the `storage-*` plugins `backup`.
- Delete: `catalog/templates.json`.
- Test: `test/unit/official-providers.test.js` (new). Port into it the content checks that read `templates.json` today: `llm-check.test.js`, `llm-openai-responses.test.js`, `speech-openai.test.js`, `credits.test.js` (its host scan reads the provider manifests), `llm-templates.test.js`'s catalog test.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `catalogFacts(manifest, { size = 0 } = {}): { id, name, version, description, category, keywords, abilities: string[], free: boolean, local: boolean, code: boolean, size: number, requires: Requirement[], featured?: string }`, with `category` derived as in Decision 13.
  - Catalog entries in the "Shapes" form.

- [ ] **Step 1: Write the failing tests**

```js
test('every official provider is valid, its id is provider-*, and its requires cover the abilities that start on, in range of the catalog', async () => {
  for (const m of await officialManifests()) if (m.provider) {
    assert.deepEqual(checkProviderDesc(m.provider), [], m.id);
    for (const [, a] of onAbilities(m.provider)) assert.ok(providedBy(catalog, a.type, m.requires), `${m.id}: ${a.type}`);
  }
});
test("today's 22 templates are all somewhere: models, prices, notes and roles kept (OpenRouter's three in one provider)", async () => { … });
test('Anthropic, OpenRouter and OpenAI chat models list their web tools; Responses models carry their reasoning maps (spec §9.3, §9.5)', async () => { … });
test("OpenRouter's and Anthropic's chat abilities offer web search to every model added from their lists (modelDefaults, §9.2)", async () => { … });
test("OpenRouter's speech abilities list their models by what they put out (listPath), with annai's attribution headers", async () => { … });
test('catalogFacts: abilities in order, free from zero prices, local, code, the category derived when it is absent', () => { … });
test('every host the provider manifests name is credited or listed with its reason (spec §15)', async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/official-providers.test.js`. Expected: FAIL.
- [ ] **Step 3: Write the ten manifests** from `catalog/templates.json` (values copied as they are, notes merged where three templates become one), and `catalogFacts`. Then `npm run catalog`.
- [ ] **Step 4: Run** the test file and `node scripts/catalog.mjs --check`. Expected: PASS and "catalog/plugins.json is current".
- [ ] **Step 5: Commit.** "Today's 22 templates as ten provider plugins, data only; the catalog lists each plugin's kind, abilities, keywords, size and requirements; templates.json goes".

### Task 7: The provider screen, Models and the plugin screens

**Files:**
- Create: `src/ui/screens/provider.js`.
- Delete: `src/ui/screens/endpoint.js`.
- Modify:
  - `src/ui/screens/models.js`, `src/ui/screens/model.js`, `src/ui/openrouter.js`;
  - `src/ui/screens/plugin-install.js`, `src/ui/screens/plugins.js`, `src/ui/screens/plugin.js`;
  - `src/ui/screens/settings.js` (Models' line: "The providers and models Shiori uses, …");
  - `src/ui/router.js` (`#/models/provider?id=`), `sw.js`.
- Test:
  - `test/unit/openrouter.test.js`, `test/unit/openrouter-voice.test.js`: one provider, one key; the voice panel's test goes.
  - `test/e2e/helpers.js`: `addProvider` replaces `addEndpoint`, and `modelSetUp` uses Another address with its Anthropic Messages ability.
  - `test/e2e/models.spec.js`, `test/e2e/openrouter.spec.js`, and new `test/e2e/providers.spec.js`.

**Interfaces:**
- Consumes: Task 5's service.
- Produces:
  - `renderProvider(ctx, id)`. The standard screen, top to bottom:
    - the name, saved as it changes;
    - the key: written once, with the "Get a key" link from `keyUrl`; no key field when `key: 'none'`;
    - the address and extra headers, saved together with the key by one Save (§16.1);
    - the description's note.
  - One panel per ability:
    - its name and protocol, its switch (saved as it changes, through `setAbility`), its own address, tunables and extra fields;
    - the photo-uploads switch, where the protocol uploads;
    - "Install it" when its type isn't running;
    - its models, Add a model by id, Fetch model list, and Test (the first model of that ability; `speechTestPanel` for speech);
    - the ability's note;
    - "New in the last update" for an ability that arrived off.
  - The suggestion buttons (`roles`), as today.
  - Remove, two-step: "Removes its key, its models and their places in roles", plus ", and the OpenAI plugin" when it is the last of its plugin.
    - For a third-party plugin, the confirmation also says "To add it back, you'll need its address again", with the address as `sourceLine` shows it.
    - The Plugins page's Remove of a provider plugin names the providers made from it ("Removes OpenAI (work) and OpenAI (home), with their keys and models"), and the installed plugins that require it (`dependents`).
  - `renderModels` gets a **Providers** section:
    - rows show the name, the abilities that are on, and the number of models;
    - **Add a provider** is a select listing the official catalog's provider entries (`catalogFacts.abilities.length`), the installed third-party provider plugins, and "Another address".
  - In `openrouter.js`, `connectOpenRouter(ctx, key)` calls `ctx.llm.addProvider('provider-openrouter', { key, roles: 'free' })`, and `readyForSignIn` adds that plugin (with its requirements) before any key exists. `VOICE_TEMPLATES`, `voiceMissing` and `addOpenRouterVoice` go.

- [ ] **Step 1: Write the failing e2e tests**, in both browsers unless noted

```js
// providers.spec.js
test('adding OpenAI installs it and what it needs with no question; its page shows the key once, its abilities and their models; Remove takes the key, models, role entries, the plugin and the protocol plugins nothing else needs', async ({ page }) => { … });
test('two OpenAI providers keep a key each; removing one keeps the other and the plugin', async ({ page }) => { … });
test("a third-party data-only provider from an address: the install screen says it can't run anything and where keys go, without the full-access words; one needing a third-party protocol that isn't installed can't be installed and names it", async ({ page }) => { … });
test('the Plugins page names the providers made from a provider plugin, and its Remove confirmation names them and what needs it', async ({ page }) => { … });
// models.spec.js: today's tests on providers (keys never shown, a model on its own page, Test, fallback across two providers, Try this model, uploads switch, photo limits, a Responses ability)
// openrouter.spec.js: Sign in with OpenRouter makes ONE provider with chat, transcription and voice and one key; speech models behind the phone's own; their Tests reach the stand-in audio API
```

- [ ] **Step 2: Run** `…playwright test test/e2e/providers.spec.js test/e2e/models.spec.js test/e2e/openrouter.spec.js` in Docker. Expected: FAIL.
- [ ] **Step 3: Implement the screens.**
  - `plugin-install.js`:
    - a package with a `provider` and no code shows "A model provider · data only" and "It can't run anything. It decides where a key you give it is sent: <descHosts>", with no full-access words;
    - "It needs: Chat Completions (from annai, installed with it)" for official requirements;
    - a third-party requirement that isn't installed says it is needed, with its homepage, and Install stays disabled.
  - `plugins.js`: the top note reads "A plugin with code gets full access to your trips and API keys. Data-only plugins can't run anything. Only install plugins you trust."
- [ ] **Step 4: Run** the specs again (both browsers), then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** "Settings → Models lists providers; one screen per provider with its abilities; Sign in with OpenRouter makes one provider with one key; the install screen says what a data-only provider can and can't do".

### Task 8: Moving over

**Files:**
- Create: `src/core/llm/move-over.js`.
- Modify: `src/app/main.js` (run it after the workspace opens and before the shell's first Models draw; then the card).
- Test: `test/unit/move-over.test.js` (new), `test/e2e/providers.spec.js`.

**Interfaces:**
- Produces: `moveOver(ws, store): Promise<{ names: string[] } | null>`.
  - It runs when `/llm/endpoints/` holds anything. It forgets those files and their history, the models whose record has an `endpoint` field, `/llm/catalog/templates.json`, the secrets `llm:<old endpoint id>` and the old entries in `/llm/uploads.json`, and it rewrites the roles without the removed models.
  - It logs `llm.moved` with `{ endpoints: n, models: m }` (names never go in the log).
  - It returns the endpoints' names for the card, or null when there was nothing.
  - The card: "Settings → Models changed" / "annai now sets up providers: one address and one key for all a provider offers. Your endpoints (A, B, C) and their keys were removed. Add them again in Settings → Models." It has the action Open Models.

- [ ] **Step 1: Write the failing tests**

```js
test('moving over: old endpoints, their models, keys, uploads, the templates cache and their history are gone; roles keep only the stand-ins; the card names them', async () => { … });
test('nothing old: nothing changes and no card', async () => { … });
test('a backup from before the change, restored after it, is moved over again at the next start, its keys deleted (Review Focus 4)', async () => { … });
// e2e: seed old records with writeRecords-style page.evaluate (Workspace + a secret), reload, see the card, Models empty, no secret left
```

- [ ] **Step 2: Run** `node --test test/unit/move-over.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** with `forget` (`src/core/forget.js`), as uninstall does: files and their history in one pass.
- [ ] **Step 4: Run** the unit test and the e2e case. Expected: PASS.
- [ ] **Step 5: Commit.** "Moving over: endpoints from before providers are removed with their keys, and a card says to add providers again".

### Task 9: The spec, the docs, the size, the checklist

- [ ] **Spec** (`2026-10-15-annai-design.md`):
  - §5.1: kinds now include provider plugins, mostly data. Data-only plugins can't run code and get no trust warning.
  - §5.2: the manifest gains `provider`, `requires`, `category` and `keywords`; `templates` goes.
  - §5.3: adding a provider installs what it `requires`. Official requirements come without a question; a third-party one must be installed first. All or nothing. Updates resolve requirements. Calls never install. Pruning.
  - §9 (title "Models and providers"):
    - §9.1: protocol plugins (today's endpoint types) and provider plugins.
    - §9.2: the table becomes provider · ability · model, with the per-ability rule (Decision 3). "Provider tools offered endpoint-wide" becomes ability-wide through `modelDefaults` (Decision 26).
    - One key per provider: it replaces "one key per endpoint".
  - §16.1: the Save buttons are for "a provider's key" and "a provider's address, key and extra headers".
  - §9.6: the `off` outcome.
  - §9.8: providers from the catalog in place of templates. Sign in with OpenRouter makes one provider. Updates arrive as plugin updates, and new abilities come off.
  - §10.1 and §10.3: speech models come from providers' abilities, behind the free entries until "Use the recommended models" (Decision 6).
  - §15: data-only plugins need no trust warning.
  - §16.2: Models lists providers.
  - §19: `plugins-official/` holds `provider-*`, and `catalog/` no longer holds templates.json.
  - §20: a row for "Providers as plugins" (M1–M6).
- [ ] **docs/plugins.md:**
  - "The package": the new fields, and `templates` refused.
  - A new section "Model providers": how a data-only provider is written (one `annai-plugin.json`; abilities, `modelDefaults`, `roles`, `key`, `local`), with OpenAI's manifest trimmed as the example.
  - "Endpoint types" is renamed "Protocols (endpoint types)": `endpoint` is now the provider's ability; `requires` with `^N`; the major is the interface.
  - "Installing, updating, removing": with requirements, pruning, and new hosts asking first.
- [ ] **README.md:** the status line and the Models paragraph say providers.
- [ ] **`docs/testing/device-checklist-providers.md`:** the "Milestone 1" section, from the iPhone column above.
- [ ] **Size:** `npm run size`, then raise `BUDGET` with the reason ("…; <n> for providers as plugins, milestone 1: providers with abilities, requires, the provider screen"). Then `npm run stamp && npm run check` and the full Docker e2e.
- [ ] **Commit.** "Providers as plugins, milestone 1: spec, plugin guide, README, device checklist; size budget <old> -> <new> KiB".

---

# Milestone 2: Servers you run

## File structure

```
plugins-official/chat-completions/{index.js,annai-plugin.json}   whole replies; max_model_len; 0.4.0
plugins-official/openai-responses/{index.js,annai-plugin.json}   whole replies; 0.2.0
plugins-official/provider-{llamacpp,vllm,sglang,ollama,lmstudio}/annai-plugin.json
plugins-official/provider-another-address/annai-plugin.json      note: replies that don't stream, and the first-words limit
test/fakes/model-server.js           new: startFakeServer
test/fixtures/llm/chat-completions/whole.json, test/fixtures/llm/openai-responses/whole.json, test/fixtures/llm/local/*.json|*.sse
test/unit/fake-model-server.test.js, llm-chat-completions.test.js, llm-openai-responses.test.js, local-servers.test.js
test/e2e/local-servers.spec.js
```

### Task 1: The stand-in model servers

**Files:**
- Create: `test/fakes/model-server.js`
- Test: `test/unit/fake-model-server.test.js`

**Interfaces:**
- Produces: `startFakeServer(o: { flavour: 'llamacpp' | 'vllm' | 'sglang' | 'ollama' | 'lmstudio' | 'whole', key?: string, cors?: '*' | string[] | false, spa?: boolean, authEverywhere?: boolean, models?: object[], replies?: object[] }): Promise<{ origin: string, requests: { method, path, headers, body }[], stop(): Promise<void> }>`.
  - A reply is `{ text?, reasoning?, calls?, usage? }`. It streams in the flavour's wire shape, or comes whole for `whole`.

- [ ] **Step 1: Write the failing tests:** each flavour answers as the facts table says.

```js
test('llamacpp: /v1/models has one entry with architecture.input_modalities; a stream carries reasoning_content, a tool call in pieces, then usage and timings', async () => { … });
test('vllm and sglang list max_model_len; vllm streams reasoning, sglang reasoning_content', async () => { … });
test("ollama allows only its own origins unless told: annai's page is blocked; with cors ['https://annai.guide'] it reads", async () => {
  await assert.rejects(browserFetch('https://annai.guide')(`${s.origin}/v1/models`), TypeError);
});
test('whole ignores stream: true and answers one application/json chat.completion', async () => { … });
test('an empty POST is 400 on a route it has, 404 elsewhere, 405 for GET on a POST route; authEverywhere answers 401 on any /v1 path without the key; spa answers 200 text/html for any unknown path', async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/fake-model-server.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** It uses `node:http` and `listen(0, '127.0.0.1')`. CORS: answer the preflight per the `cors` option; `'*'` reflects as llama.cpp does.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Stand-in model servers for llama.cpp, vLLM, SGLang, Ollama, LM Studio and a router that doesn't stream".

### Task 2: Whole replies, and context windows from lists

**Files:**
- Modify: `plugins-official/chat-completions/index.js` (`read`: a non-SSE `application/json` answer; `readList`: `max_model_len`), and its manifest (0.4.0).
- Modify: `plugins-official/openai-responses/index.js` (`read`: a whole `response` object), and its manifest (0.2.0).
- Modify: `catalog/plugins.json`.
- Test: `test/unit/llm-chat-completions.test.js`, `test/unit/llm-openai-responses.test.js`.

**Interfaces:**
- Produces, unchanged in name: `read(res, c)` yields the same events from a whole reply:
  - reasoning (one whole block, from `message.reasoning_content` or `message.reasoning`);
  - text;
  - each tool call;
  - usage;
  - stop.

  A whole error object raises `ProviderError` with the same kinds as a stream's.
- `readList` sets `contextWindow` from `context_length ?? max_model_len ?? top_provider.context_length`.

- [ ] **Step 1: Write the failing tests**

```js
test('a server that ignores stream: true and answers one JSON reply is read whole: reasoning, text, tool calls, usage, stop', async () => {
  const events = await collect(read(jsonResponse(WHOLE), spec));
  assert.deepEqual(events.map((e) => e.type), ['reasoning', 'text', 'tool_call', 'usage', 'stop']);
});
test('a whole error object is a ProviderError of its kind', async () => { … });
test('a model list with max_model_len gives the context window (vLLM, SGLang)', () => {
  assert.equal(readList(VLLM_MODELS)[0].contextWindow, 32768);
});
// llm-openai-responses.test.js
test('a whole Responses reply (application/json) is read as the stream would be', async () => { … });
```

- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** In `read`, branch on `res.headers.get('content-type')` starting with `application/json`. Then `npm run catalog`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Chat Completions and Responses read a whole reply from a server that doesn't stream; Chat Completions reads max_model_len as the context window".

### Task 3: The five local-server plugins

**Files:**
- Create: `plugins-official/provider-{llamacpp,vllm,sglang,ollama,lmstudio}/annai-plugin.json` (the Local servers table).
- Modify: `plugins-official/provider-another-address/annai-plugin.json` (version 1.1.0, its note), `catalog/plugins.json`.
- Test: `test/unit/local-servers.test.js` (new), `test/unit/official-providers.test.js`.

**Interfaces:**
- Consumes: Task 1's `startFakeServer`, Task 2's protocol, M1's `addProvider`, `addListedModel`, `callOnce`.
- Produces: no new code. The manifests carry the shapes from M1.

- [ ] **Step 1: Write the failing tests**

```js
test('llama.cpp: keywords Unsloth, LM Studio and KoboldCpp; its default address on port 9931; a listed model that reads images takes photos', async () => { … });
test("each local server's off level sends its own thinking switch: llama.cpp reasoning_effort none and enable_thinking false; vLLM and SGLang chat_template_kwargs; Ollama reasoning_effort none", async () => {
  for (const [plugin, flavour, want] of CASES) {
    const s = await startFakeServer({ flavour, cors: '*' });
    /* add the provider at s.origin, list, add the model, call at level 'off' */
    assert.deepEqual(pick(s.requests.at(-1).body, Object.keys(want)), want, plugin);
  }
});
test("a streamed reply's reasoning shows as reasoning_delta and ends as one reasoning block, through each local plugin", async () => { … });
test("Ollama's and LM Studio's notes say how to let annai's address in; vLLM's says which flags tool calls need", () => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Write the manifests**, then `npm run catalog`.
- [ ] **Step 4: Run** the test files and `node scripts/catalog.mjs --check`. Expected: PASS.
- [ ] **Step 5: Commit.** "Provider plugins for llama.cpp, vLLM, SGLang, Ollama and LM Studio: addresses, keys, thinking switches and notes as data".

### Task 4: E2e, the docs and the real servers

- [ ] **Write `test/e2e/local-servers.spec.js`**, in both browsers, with stand-ins from `startFakeServer` on their own ports:
  - llama.cpp against the `llamacpp` stand-in: Add a provider, its address, Fetch model list, Add. The model takes photos. Test passes, and Try this model streams.
  - Another address, with Chat Completions on, against the `whole` stand-in: Test passes, and Try this model answers.
- [ ] **Run them in Docker.** Expected: PASS.
- [ ] **Spec:** §9.1 (local-server providers; replies that don't stream) and §18 (the stand-in servers).
- [ ] **docs/plugins.md:** under Protocols, "read a whole JSON reply when a server ignores `stream`"; under Model providers, the reasoning maps of the local servers as the example of quirks as data.
- [ ] **Device checklist:** the "Milestone 2" section, with the real-server checks from "Testing", by name only.
- [ ] **Finish:** size, `npm run stamp && npm run check`, the full Docker e2e.
- [ ] **Commit.** "Servers you run, milestone 2: …; size budget …".

---

# Milestone 3: One catalog

## File structure

```
src/core/search.js                   new: squash, matchAt, rankEntry, searchCatalog
src/ui/screens/add.js                new: the Add screen (#/add?kind=&ability=)
src/ui/screens/plugins.js            the installed list's search and filters; Add; install from a file or an address moves to add.js
src/ui/screens/models.js             Add a provider → #/add?kind=providers; speech roles' "Add a provider" → #/add?ability=transcription|voice
src/ui/screens/backups.js            #/backups?add=<type> preselects that kind of place (small-fixes touches this file: rebase first)
src/ui/router.js, sw.js
test/unit/search.test.js, test/unit/add-rows.test.js
test/e2e/catalog.spec.js; helpers.js's addProvider through the Add screen; plugins.spec.js, extensions.spec.js
```

### Task 1: Search

**Files:**
- Create: `src/core/search.js`
- Test: `test/unit/search.test.js`

**Interfaces:**
- Consumes: `catalogFacts` (M1).
- Produces:
  - `squash(s: string): { text: string, starts: Set<number> }`: lower case, letters and digits only (`\p{L}\p{N}`), and where each word began.
  - `matchAt(query: string, field: string): boolean`: the squashed query found at a word start of the squashed field.
  - `rankEntry(e: CatalogFacts, query: string): { score: 0 | 1 | 2 | 3, why?: string }`.
    - 3 is the name. 2 is a keyword, and `why` is that keyword as written. 1 is the description, an ability ("chat", "transcription", "voice", "voices"), or "free".
    - A query with spaces that matches nowhere whole is split into words, and each word must match somewhere. The score is then the lowest of the words' scores.
  - `searchCatalog(entries, query, filters: { kind?, ability?, free?, local?, source?: 'official' | 'third-party' }): { entry, score, why? }[]`.
    - The order: score, then featured, then official, then name.
    - An empty query keeps every entry that the filters keep.

- [ ] **Step 1: Write the failing tests**

```js
test('"lm studio", "lmstudio" and "LMStudio" are one query; matching starts at a word: "studio" matches LM Studio, "tudio" does not', () => { … });
test('a name match comes before a keyword match: "lm studio" lists LM Studio first, then llama.cpp, saying "Also for: LM Studio"', () => {
  const r = searchCatalog(ENTRIES, 'lm studio', {});
  assert.deepEqual(r.map((x) => x.entry.id).slice(0, 2), ['provider-lmstudio', 'provider-llamacpp']);
  assert.equal(r[1].why, 'LM Studio');
});
test('"unsloth" finds llama.cpp by its keyword, saying why; "ollama" lists Ollama alone', () => { … });
test('"free voice" needs both words: OpenRouter yes (a free voice), OpenAI no; "llamacpp" and "llama cpp" both find llama.cpp', () => { … });
test('filters: kind, ability, free, local, official or third-party; an empty query lists all the filters keep', () => { … });
test('letters of any script match: a Japanese name is found by its start', () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/search.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** It is a few lines of annai's own code, with no search library (the design says so).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Catalog search: names, then keywords, then descriptions, abilities and free; case, spaces and punctuation ignored; from the start of a word".

### Task 2: The Add screen

**Files:**
- Create: `src/ui/screens/add.js`.
- Modify: `src/ui/screens/models.js`, `src/ui/router.js`, `sw.js`.
- Test: `test/unit/add-rows.test.js`, `test/e2e/catalog.spec.js`, `test/e2e/helpers.js`.

**Interfaces:**
- Consumes: Task 1; M1's `addProvider`, `addFromCatalog`, `catalogFacts`, `officialPlugins`.
- Produces:
  - `addRows(catalog: CatalogFacts[], installed: CatalogFacts[] & { source }[], configured: Record<string, number>): Row[]`, with `Row = { facts, official: boolean, added: number, action: 'add' | 'add-another' | 'install' | 'set-up' | 'open' }`.
    - An installed third-party plugin joins the rows with `official: false`. The official catalog's own entry wins on the same id.
    - Fixed rows: "Another address…", and "An MCP server", which goes to `#/mcp`. "Install from an address or a file" is a section at the foot.
  - `renderAdd(ctx, route)` at `#/add`, with `?kind=providers` (from Models → Add a provider), `?ability=transcription` or `?ability=voice` (from a speech role), and nothing from Plugins → Add.
    - It has a search box (`aria-label` "Search the catalog") and chips for Kind, Chat, Transcription, Voice, Free, Local, Official and Third-party.
    - With nothing typed it groups by kind, showing only kinds that have something in them.
    - Each row shows the name, ability badges, "free", "official" or "from <host>", "data only" or "has code", the size (`bytes(n)` in `src/ui/format.js`), and "Also for: …" when it matched on a keyword.
    - Actions:
      - **Add** installs with requirements, adds the provider and opens its page;
      - **Added · Add another** for a provider that is set up already;
      - **Set up** for a backup place goes to `#/backups?add=<type>`, which preselects that type;
      - **Install** for other plugins.
    - Offline, the official part says "annai's catalog couldn't be loaded", while installed items still list.

- [ ] **Step 1: Write the failing tests**

```js
// add-rows.test.js
test('a provider already set up is Added, with Add another; an official entry wins over an installed copy of the same id; fixed rows are there', () => { … });
// catalog.spec.js, both browsers
test('Models → Add a provider opens the catalog on model providers; "unsloth" finds llama.cpp saying "Also for: Unsloth"; Add installs it and opens its page', async ({ page }) => { … });
test("a speech role's Add opens on providers with transcription; Plugins → Add opens on everything, grouped by kind; the chips filter", async ({ page }) => { … });
test('installing from an address is on the Add screen and goes to the install screen first', async ({ page }) => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Change `addProvider` in `helpers.js` to go through the Add screen (search the name, tap Add), so the other specs follow without edits.
- [ ] **Step 4: Run** the specs and every spec that uses `addProvider` or `modelSetUp`. Expected: PASS.
- [ ] **Step 5: Commit.** "One Add screen for everything a user can add: search, browsing by kind, filter chips, opened where the user came from".

### Task 3: The Plugins page's search and filters

**Files:**
- Modify: `src/ui/screens/plugins.js` (the installed list as rows of `catalogFacts` from `describe()`, with the same search and chips; provider plugins under Model providers naming the providers made from them; the Add button goes to `#/add`; the file and address section leaves).
- Modify: `src/core/plugins.js` (`describe()` rows gain `size`, `category`, `keywords`, `abilities`).
- Test: `test/e2e/plugins.spec.js`, `test/e2e/extensions.spec.js` (installs start at the Add screen).

- [ ] **Step 1: Write the failing test.** "the installed list can be searched and filtered: provider plugins under Model providers name their providers; a skill under Skills and personalities".
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `plugins.spec.js`, `extensions.spec.js` and `ui-extension.spec.js`. Expected: PASS.
- [ ] **Step 5: Commit.** "The Plugins page searches and filters what is installed, by the catalog's rules".

### Task 4: Spec, docs, finish

- [ ] **Spec:** §16.2 (the Add screen, the Plugins page, where each opens filtered) and §5.3 (Sources: the catalog's Add screen).
- [ ] **docs/plugins.md:** `keywords` and `category`, and how a row matched on a keyword says why.
- [ ] **Device checklist:** the "Milestone 3" section.
- [ ] **Finish:** size, check, the full Docker e2e, commit.

---

# Milestone 4: OpenRouter as a code provider

## File structure

```
src/core/plugins.js                  annai.providers.setup → registry kind 'provider-setup' (one per plugin)
src/ui/provider-setup.js             new: setupUi(ctx, pluginId), drawPanel(ctx, pluginId, provider | null), featuredStart(ctx)
src/ui/returns.js                    new: expectReturn, returnFor
src/ui/screens/provider.js           draws the panel in the key's place; #/models/provider?new=<plugin> for a plugin's own Add flow
src/ui/screens/models.js             "The quickest start": the featured plugin's panel when there are no providers
src/ui/screens/welcome.js            the last step's words from the featured entry; background install
src/core/llm/call.js, service.js, fallback.js   setup.classify, setup.headers, setup.list
src/app/main.js                      returnFor at start in place of finishSignIn
plugins-official/provider-openrouter/{annai-plugin.json,index.js}   entry, featured, 2.0.0
plugins-official/chat-completions/{index.js,annai-plugin.json}      the OpenRouter free-limit classify goes; 0.5.0
src/ui/openrouter.js                 deleted
test/unit/provider-setup.test.js, returns.test.js, provider-openrouter.test.js (from openrouter*.test.js), no-provider-names.test.js
test/e2e/openrouter.spec.js, models.spec.js (iPhone link), welcome.spec.js
```

### Task 1: The provider contract in the core

**Files:**
- Modify: `src/core/plugins.js` (`providers.setup`, checked; one per plugin), `src/core/llm/call.js` (`headers` merged after the ability's own; `classify` asked first), `src/core/llm/service.js` (`list`).
- Create: `src/ui/provider-setup.js`.
- Modify: `src/ui/screens/provider.js`.
- Test: `test/unit/provider-setup.test.js`.

**Interfaces:**
- Produces: the contract in "Shapes".
  - `setupUi(ctx, pluginId): SetupUi`.
  - `drawPanel(ctx, pluginId, provider): HTMLElement | null`, through `made()`.
  - `ui.add` calls `ctx.llm.addProvider(pluginId, o)`, which installs the protocol plugins that the abilities turned on need.
  - `ui.keep` refuses a provider that doesn't come from `pluginId`.
  - `ui.returnsElsewhere` is `platform() === 'ios' && isStandalone()`.

- [ ] **Step 1: Write the failing tests**

```js
test("a plugin's panel is drawn in the key's place; what it throws counts against its plugin and the standard screen still draws; keyField false leaves the key field out", async () => { … });
test('ui.keep stores the key under the provider\'s one secret, only for providers made from this plugin', async () => { … });
test('ui.add makes a provider from this plugin\'s description, its key kept by annai, installing only the protocols of the abilities turned on', async () => { … });
test("classify sharpens an error's kind before the protocol's; headers join the ability's requests; list stands in for the protocol's model list", async () => { … });
test('a second setup from one plugin is refused', () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/provider-setup.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "The provider contract: a code provider's own setup panel, its key kept by annai, and its error kinds, headers and model lists".

### Task 2: Coming back to annai's address

**Files:**
- Create: `src/ui/returns.js`.
- Modify: `src/app/main.js`.
- Test: `test/unit/returns.test.js`.

**Interfaces:**
- Produces:
  - `expectReturn(pluginId, { storage = localStorage, now = Date.now() } = {})`.
  - `returnFor(search: string, { storage, now }): { plugin: string, params: URLSearchParams } | null`. The marker is used once, and lasts at most 15 minutes.
  - At start, main.js reads the query:
    - it takes the query out of the address (to `#/models`), draws Models with "Finishing the sign-in with <plugin's name>…", waits for the plugins to start, and calls that plugin's `returned(params, ui)`;
    - a failure goes on a card titled "Signing in with <name> didn't finish", with the plugin's words;
    - a query with no marker is removed and ignored.

- [ ] **Step 1: Write the failing tests**

```js
test('a return goes to the plugin that expected it, once, within 15 minutes; the query leaves the address', () => { … });
test('a ?code= nobody expected, or one past 15 minutes, goes to no plugin and is removed', () => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "A sign-in coming back to annai's address goes to the plugin that started it".

### Task 3: OpenRouter moves into its plugin

**Files:**
- Create: `plugins-official/provider-openrouter/index.js`.
  - It is the code of `src/ui/openrouter.js`: PKCE, `signInUrl`, `codeSignIn`, `tapCode`, `exchange`, the paste box and the card words.
  - The sign-in becomes `panel(ui, null)`. The provider's page gets `panel(ui, provider)`: "Sign in again" replaces the key.
  - `classify` carries the free-limit rule (`/free-models-per-(day|min)/` is `rate`).
- Modify: its manifest (`entry`, `featured: "Sign in with OpenRouter is the quickest way, and it starts you on free models."`, 2.0.0).
- Modify: `plugins-official/chat-completions/index.js` (the regex goes; 0.5.0), `catalog/plugins.json`.
- Delete: `src/ui/openrouter.js`. `sw.js` drops it.
- Test:
  - `test/unit/provider-openrouter.test.js`: today's tests from `openrouter.test.js` and `openrouter-voice.test.js`, importing the plugin module.
  - `test/unit/llm-chat-completions.test.js`: the free-limit case goes to the plugin's test.
  - `test/unit/no-provider-names.test.js`: `src/` contains no `/openrouter/i` and no provider plugin id.

- [ ] **Step 1: Write the failing tests:** the moved tests against `plugins-official/provider-openrouter/index.js`, plus `test('the core names no provider', …)`, which greps `src/`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Move the code.** The plugin keeps its own localStorage slot, `annai.openrouter`, because `tapCode` must be synchronous.
- [ ] **Step 4: Run** the tests and `npm run catalog`. Expected: PASS.
- [ ] **Step 5: Commit.** "Sign in with OpenRouter is OpenRouter's plugin's own setup; its free-limit rule leaves Chat Completions; the core names no provider".

### Task 4: The featured one-tap start

**Files:**
- Modify: `src/ui/provider-setup.js` (`featuredStart`), `src/ui/screens/models.js`, `src/ui/screens/welcome.js`.
- Test: `test/e2e/models.spec.js`, `test/e2e/openrouter.spec.js`, `test/e2e/welcome.spec.js`.

**Interfaces:**
- `featuredStart(ctx): HTMLElement`.
  - It reads the catalog's featured entry. If that plugin isn't installed, it calls `addFromCatalog` at once, in the background, once the service worker controls the page.
  - Until the plugin's panel is ready, a disabled button says "Getting the sign-in ready…".
  - Once ready, it draws `panel(ui, null)`.
  - Offline: "Connect to the internet to sign in."
  - Models draws it only when no provider exists.
  - The welcome's last step shows the `featured` sentence, or "Connect a model, so Shiori can think." without a catalog, and starts the same background install.

- [ ] **Step 1: Write the failing e2e tests**

```js
test('on an iPhone Home Screen app, Models with no providers draws Sign in with OpenRouter from its plugin, installed in the background: the link has its address before the tap, opens OpenRouter for a code, and the paste box waits, also after annai reopens', async ({ page, context, browserName }) => { … }); // today's test, now through the plugin (WebKit)
test('while the featured plugin installs, the start is a disabled button, never a link without an address', async ({ page }) => { … });
test("the welcome's last step names the featured provider's sign-in from the catalog", async ({ page }) => { … });
// openrouter.spec.js (Chromium): the callback comes back to annai's address and is routed to the plugin; one provider, one key
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the specs (both browsers). Expected: PASS.
- [ ] **Step 5: Commit.** "The one-tap start is the featured provider's: installed in the background as the screen opens, so its link exists before the tap".

### Task 5: Spec, docs, finish

- [ ] **Spec:** §9.8 (OpenRouter's sign-in is its plugin's setup; the catalog marks it featured; the core names no provider) and §16.2 (Models: the featured start when there are no providers; onboarding).
- [ ] **docs/plugins.md:** a new section "Model providers with code": `annai.providers.setup`, SetupUi, a minimal example, and that `featured` counts only in annai's catalog.
- [ ] **Device checklist:** the "Milestone 4" section.
- [ ] **Finish:** size (it should go down: lower `BUDGET` by what left), check, the full Docker e2e, commit.

---

# Milestone 5: "Another address" looks for itself

### Task 1: The probe

**Files:**
- Create: `plugins-official/provider-another-address/probe.js`.
- Test: `test/unit/probe.test.js`, which imports the plugin's module against `startFakeServer` through `browserFetch`.

**Interfaces:**
- Produces: `probe(address: string, key: string | null, io: { fetch, reach: (url: string) => Promise<boolean> }): Promise<{ base: string, root: string, list: Finding & { count?: number }, abilities: Record<'chat-completions' | 'responses' | 'messages' | 'transcription' | 'voice', Finding> }>`.
  - `Finding = { state: 'found' | 'absent' | 'blocked' | 'unreachable' | 'unknown', status?: number, why?: string }`.
  - `reach` is the no-cors check, as `createLlm`'s `probe` does it.
  - The requests:
    - `GET <base>/models`;
    - `POST {}` to `<base>/chat/completions`, `/responses`, `/audio/transcriptions` and `/audio/speech`, and to `<root>/v1/messages` with Anthropic's headers;
    - a control `POST {}` to `<base>/annai-probe-<8 random>`.
  - The reading rules are in Decision 18.
  - When the address has no path and nothing is found, `/v1` is tried as the base. `root` is the base without a trailing `/v1`.

- [ ] **Step 1: Write the failing tests**

```js
test('a router like maiGo: the list, Chat Completions and Responses are found; Messages and the audio paths are absent', async () => { … });
test('llama.cpp: the list, Chat Completions, Responses and Messages at the root are found', async () => { … });
test('a server that answers 401 on every path without a key reports unknown, never found, and says to give the key; with the key it finds what it has (Review Focus 5)', async () => { … });
test('a web app that answers 200 with a page for any path finds nothing (Review Focus 5)', async () => { … });
test("a server that doesn't allow web apps is blocked, told apart from one that isn't there (unreachable)", async () => { … });
test('an address without /v1 is also tried with it; 429 and 5xx are unknown', async () => { … });
test("no request carries a model or an input, so nothing can generate; the key goes only in its header and is in no trace entry or file", async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/probe.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Requests go through `annai.net.fetch`, so each is in the trace.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Another address looks for what a server offers, at no cost: a model list and an empty request to each known path".

### Task 2: The probe screen, and adding with what was found

**Files:**
- Create: `plugins-official/provider-another-address/index.js` (`activate`: `setup({ panel })`).
- Modify: the plugin's manifest (`entry`, `files: ["probe.js"]`, 2.0.0), `catalog/plugins.json`.
- Test: `test/unit/probe.test.js` (the panel's add call).

**Interfaces:**
- The panel with `provider === null` holds: Address, Key (optional), Look for what it offers, and the results list.
- The results list is in the mockup's order: Model list (n models), Chat Completions, Responses, Anthropic Messages, Transcription, Voice. Each is ✓, ✕, "blocked: it doesn't allow web apps", or "?" with its reason. Under them: "annai only asked for the model list and sent an empty request to each known path. Nothing here costs money; Test sends real requests."
- **Add with these** calls `ui.add({ name: host, baseUrl: base, key, abilities })`, with each found ability on, and Messages at `root`.
- For an existing provider the panel returns null: the standard screen's switches remain.

- [ ] **Step 1: Write the failing test.** "Add with these turns on what was found, Messages at the root address, and only the protocol plugins those need are installed".
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** "Another address's screen: what the address offers, then a provider with those abilities".

### Task 3: E2e, spec, docs, finish

- [ ] **Write `test/e2e/another-address.spec.js`**, in both browsers, with stand-ins on their own ports:
  - a `whole` stand-in with a key: found, Add with these, Test;
  - a `cors: false` stand-in: blocked, in words;
  - an `authEverywhere` stand-in without a key: unknown, and give the key.
- [ ] **Change `addProvider` in `helpers.js`** for Another address to Look and Add.
- [ ] **Spec:** §9.8 (Another address), §18.
- [ ] **docs/plugins.md:** the probe as an example of `panel(ui, null)`.
- [ ] **Device checklist:** the "Milestone 5" section, with maiGo and the llama.cpp server by name.
- [ ] **Finish:** size, check, the full Docker e2e, commit.

---

# Milestone 6: Conflicts made explicit

## File structure

```
src/core/registry.js                 NAMED kinds; setRules({ rank, choice, reserved }); list/entries give owners; clashes(pluginId)
src/core/plugins.js                  ranks from installed.json; choices from app settings (uses); fixed start order; choose(); skill claims go; ids gaps
src/core/agent/tools.js              toolList: the loop's tools reserved; owners from the registry
src/core/llm/contract.js, src/core/storage-types.js, src/ui/slots.js, src/ui/screens/shiori.js, src/ui/cards.js, src/core/agent/loop.js   owners only
src/ui/screens/plugin.js             "Not used: …" with "Use this one instead"; "Uses this one's … (your choice) · Undo" on both pages
src/ui/screens/plugin-install.js     replaces: "It replaces <thing> from <owner>", and the choice
test/unit/owners.test.js, agent-tools.test.js, ui-slots.test.js, plugin-packages.test.js, test/e2e/conflicts.spec.js
test/fixtures/extensions/{clash-tool,avatar-replaces}/   new fixture packages
```

### Task 1: One owner per name

**Files:**
- Modify: `src/core/registry.js`.
- Test: `test/unit/owners.test.js`.

**Interfaces:**
- Produces:
  - `NAMED: Record<string, (item: any) => string>` (the kinds in "Shapes").
  - `registry.setRules({ rank: (pluginId) => [number, number, string], choice: (kind, name) => string | undefined, reserved: (kind, name) => 'annai' | null })`.
  - `list(kind)` and `entries(kind)` give one entry per name for named kinds, the owner. `entries(kind, { all: true })` also gives those not used and those of plugins switched off.
  - `owner(kind, name): { pluginId: string | 'annai', chosen: boolean } | null`.
  - `clashes(pluginId)` (the shape in "Shapes").

- [ ] **Step 1: Write the failing tests**

```js
test('a name has one owner: the lowest rank (built-in, official, third-party by install time), whatever order they started in', () => { … });
test("the user's choice owns the name while that plugin runs and registers it; switched off, the next by rank owns it", () => { … });
test("a reserved name (the loop's own tools, annai's components) belongs to annai, and no plugin owns it", () => { … });
test('clashes lists what a plugin registers that it does not own, and who does', () => { … });
test('hooks and adding slots never clash', () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/owners.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before `setRules` is called, the rank is the registration order (unit tests elsewhere stay green).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "A name has one owner: by fixed rank, or by the user's choice".

### Task 2: Every consumer uses owners; ranks, choices and the start order

**Files:**
- Modify:
  - `src/core/plugins.js`: `setRules` from `installed.json` and `readAppSettings(...).uses`; `startInstalled` in rank order; `choose(kind, name, pluginId | null)` writes `uses`; the skill claim code (`#claims`, `#skillHolder`, `#mayRegisterSkill`, the skill refusals in `inspect`) goes.
  - `src/core/agent/tools.js`, `src/core/llm/contract.js` (`endpointTypes`), `src/core/storage-types.js`, `src/ui/slots.js` (`component`: the chosen plugin's entry, else null), `src/ui/screens/shiori.js` (personalities), `src/ui/cards.js` and `src/core/agent/loop.js` (card types), the search order in `#api`.
- Test: `test/unit/agent-tools.test.js`, `test/unit/ui-slots.test.js`, `test/unit/plugin-packages.test.js` (the skill-clash tests become "Not used" tests), `test/browser/suites/ui-slots.js`.

- [ ] **Step 1: Write the failing tests**

```js
test("a third-party tool with a built-in's name is not used, and the built-in answers; chosen, the plugin's answers; the loop's own tool names can't be taken", () => { … });
test("a component plugin is used only when chosen; annai's own avatar otherwise", () => { … });
test("a skill whose name Shiori has already installs, isn't used, and shows on its page as Not used; chosen, Shiori loads it", async () => { … });
test('an endpoint type, a storage type, a personality, a card type or a search provider whose name is taken is not used until chosen', async () => { … });
test('plugins start in rank order: built-ins, official, third-party by install time', async () => { … });
```

- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** "Every name plugins register follows one rule: one owner, by rank or by the user's choice; skills too".

### Task 3: The plugin page, and the install screen's `replaces`

**Files:**
- Modify: `src/ui/screens/plugin.js`, `src/ui/screens/plugin-install.js`, `src/core/packages.js` (the `replaces` field).
- Create: a fixture package, `test/fixtures/extensions/clash-tool/` (a tool named `weather`, without `replaces`).
- Modify: `test/fixtures/extensions/trail-look/annai-plugin.json` gains `replaces: ["avatar", "now-card", "dock"]`. `test/e2e/ui-extension.spec.js` installs it with "Install and use it", since without a choice its components are Not used now.
- Test: `test/e2e/conflicts.spec.js`, `test/e2e/ui-extension.spec.js`.

**Interfaces:**
- **Plugin page:** for each clash, "Not used: <name> is already provided by <owner>", with a **Use this one instead** switch (calls `choose`). On the chosen plugin's page and on the owner's page: "<name>: this one is used (your choice) · Undo".
- **Words for components:** avatar is "how Shiori looks", dock is "the dock", now-card is "the Now card", plan-row is "how the plan's rows look".
- **Install screen,** for each name in `replaces` that has an owner now: "It replaces <thing> from <owner>", with two buttons, **Install and use it** and **Install, keep <owner>'s**. The choice is stored at install, and nothing is chosen until one is tapped.

- [ ] **Step 1: Write the failing e2e tests**

```js
test('a plugin whose tool name is taken: its page says Not used, naming who provides it; Use this one instead swaps them, shown on both pages and undone there', async ({ page }) => { … });
test('a plugin that replaces the avatar asks "It replaces how Shiori looks" at install; chosen, the dock shows it; Undo brings annai\'s back', async ({ page }) => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them**, both browsers, plus `ui-extension.spec.js`. Expected: PASS.
- [ ] **Step 5: Commit.** "Conflicts in the open: Not used, with a switch; replaces asked at install; the choice shown and undone on both plugins' pages".

### Task 4: Plugin ids, and the upgrade

**Files:**
- Modify: `src/core/llm/official.js` (`ensureNow` refuses to install over a non-official package of the same id, naming its source), `src/ui/screens/plugin-install.js` (a third-party package over an official one: "This replaces annai's own <name> with the one from <address>", with the full-access words if it has code), `src/core/plugins.js` (at the first start with this version, a third-party component in use under the old rule is recorded as the user's choice; marked done in the app settings).
- Test: `test/unit/plugin-packages.test.js`, `test/unit/llm-plugins.test.js`.

- [ ] **Step 1: Write the failing tests:**
  - "an official install never overwrites a third-party package with its id: it stops and says so";
  - "installing a third-party package over an official one says it replaces annai's own";
  - "after the upgrade, an avatar plugin that was in use is still used, recorded as the user's choice".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "Plugin ids: annai's own and a third party's never replace each other silently; components in use stay in use after the upgrade".

### Task 5: Spec, docs, finish

- [ ] **Spec:** §5.2 (`replaces`); §5.5 or a new §5.6, "Names and conflicts" (one owner, the fixed load order, the choice decides, Not used, `replaces`, built-ins and official names); §16.4 (components follow the same rule).
- [ ] **docs/plugins.md:** a new section, "Names and conflicts". The Components paragraph ("the last plugin to register one wins") is rewritten. The Skills section: a taken name is Not used, not refused.
- [ ] **Device checklist:** the "Milestone 6" section.
- [ ] **Finish:** size, check, the full Docker e2e, commit.
