# Koe and Kokoro: Shiori as two halves, design

Date: 2026-10-19. Status: agreed with the user in chat ("looks right"), with the builder check's questions answered on 2026-10-19. This document is the description to plan from.

## Why
- **Shiori is slow to answer when she does real work.** The user's friend, travelling with another agent of the user's in a group chat, "complained about my agent's slowness in responding. although the slowness was necessary for doing rounds of grounding and searching to ensure the correctness of information provided." The user: "if we can immediately give some response while keeping the deep thinking intelligence behind, maybe user will be happier with the experience."
- **Realtime voice models fit hands-free driving well.** Gemini Live (free on AI Studio), OpenAI's Realtime API and others hear and speak in one continuous stream, let you cut in, and answer fast. Used as a plain voice or transcription engine, they lose everything that makes them good.
- **The user's picture:** "similar to a human brain, when only half of the brain speaks, but both listen and see." A quick half that talks and a deep half that thinks, with exchanges between them that the user doesn't need to see.
- The user: "I feel like this can be the puzzle piece that is missing for shiori."

## The names (the user's choice)
- **Koe** (声, voice): the half that talks with the user.
- **Kokoro** (心, heart and mind): the half that thinks and works behind it.

In code and the spec they're Koe and Kokoro.

## Goals
1. **The user always talks to Koe,** by voice, text or photos. Koe answers right away from what it knows, and never states what it doesn't concretely know.
2. **Kokoro hears and sees everything too, but talks only to Koe.** It does the deep work: search, planning, bigger changes, the story behind a photo. It hands Koe answers, steers it, and corrects it with facts and reasons.
3. **The conversation never stalls.** Neither half ever waits on the other. Koe can say "I'm checking on …" and keep talking; a clarification from the user reaches Kokoro mid-task.
4. **The same split for text and voice.** A realtime voice model is just one way Koe can talk.
5. **Any realtime voice model,** not one vendor. Gemini Live is the first, and the user will use it; OpenAI Realtime and others follow as plugins.

## Non-goals
- Continuous camera video to a realtime model. Photos only, as they're taken. Live audio-and-video sessions are capped at 2 minutes, and video isn't needed for the trip.
- Changing what Shiori can do. Her tools, memory, planning and recap stay; they're split between the halves.
- Group chats and other channels. annai's own conversation only.
- On-device models.

## Anti-goals (a failure even if it works)
- **Koe stating facts, times, prices or directions it doesn't concretely know.** Honesty comes before staying in character: Koe apologises for a mistake.
- **The inner debate leaking into the conversation.** The halves' exchanges are hidden from the user by default. They stay visible in the Trace, like everything annai sends.
- **A stall:** silence while one half waits on the other.
- **Breaking the prompt cache:** changing tool definitions or the system instructions when modes change.
- **Losing words:** anything the user said, or Koe said aloud, missing from the conversation, the trip record or the recap.
- **Costs that grow without the user seeing why.** Both halves' calls show in the Trace and count toward Spend per day.

## Constraints
- annai stays browser-only and local-first. A realtime session connects straight from the phone with the user's own key, kept in secrets. There's no server to mint ephemeral tokens; this matches how annai already sends keys straight to providers.
- iPhone audio rules hold: sound starts only after a tap (the unlock), and the Home Screen app's background limits stay.
- The spec's rules hold:
  - §4.9: removing means removing;
  - §6.3: the context order for caching;
  - §7.1: Shiori talks to the user only through output tools, and her plain text is internal;
  - §15: keys and security;
  - §17: updates never land mid-trip.
- The provider redesign (docs/superpowers/specs/2026-10-18-provider-plugins-design.md) is the base. Realtime models arrive as protocol plugins with a "realtime voice" ability on their provider. The provider-security rules apply to their connections: the same origin, no redirects, the key only to the provider.
- The size budget (scripts/size.mjs) is tight.

## What the user decided
- **Both halves get everything,** at the same time: voice, typed text, photos, and triggers firing. Typed text goes to both.
- **Koe** talks with the user.
  - It answers at once from what it knows; for anything it doesn't concretely know, it says it's checking and leaves it to Kokoro.
  - It values honesty over staying in character.
  - Its tools: speak (when not realtime), show, ask, wait, timers, self, and quick reads on the device (plan, bookings, notes, files, places and the map from the offline pack). It also makes **light changes** (the user: "koe can make light changes").
- **Kokoro** never speaks to the user while Koe works. It has the rest of Shiori's tools, and sleep.
- **One tool each, "tell the other half",** non-blocking: it returns as soon as the message is recorded or sent. Two modes:
  - **append** (the default): added after the other half's current step or turn, interrupting nothing;
  - **immediate:** interrupts the other half's current turn and delivers now. Both halves are told to use it only when something really should be cut off.
- **No stalls on Koe's side.** A realtime model's tool call to Kokoro is answered at once with "sent", and the user hears "I'm checking…" rather than silence.
- **Triggers** (a reminder, an arrival): both halves get them. Kokoro decides what matters, and Koe tells the user. If it's something Koe can simply say, it says it right away; otherwise it waits for Kokoro's context.
- **"Realtime" means any realtime voice model,** with Gemini Live as the free first one. A model's abilities decide the pathway, not a special mode.
- **The Koe role is one ordered list, like Main** (changed on 2026-10-19; it had a "for talking" list and a "for typing" list, picked by the voice setting). Its first model that can answer decides the pathway; annai's voice setting (§10.5: Auto, On, Off) decides whether Koe talks aloud or in text, and with voice off a text model that can answer comes before a realtime one.
  - Every model can do both: a muted realtime model shows its transcript, and a text model can speak through the speech pipeline.
  - The user asked whether this should be a manual mode; we agreed that following the voice setting is enough.
  - **Why one list (the user, 2026-10-19):** "currently the two settings looks exactly the same lol and I think we are building it so live or not the koe still functions right? then no problem." A realtime model as Koe already worked with voice off, and a text model already talked through the speech pipeline. The second list's only real job was the fallback when a live session can't go on, and the one list's own fallback does that. A stored config's two lists became one: the talking list's models, then the typing list's.
  - **With voice off, a text model comes before a realtime one** (2026-10-19, the user's standing rule: take data-saving optimizations by default). Gemini Live's setup asks for audio replies only (`responseModalities: ['AUDIO']`), so a typed conversation through it downloads about 65 KB a second of reply as 24 kHz PCM in base64 and never plays it, where a text model's reply is a few KB. So with the list [Gemini 3.8 Live, gemini-3.5-flash-lite], voice off uses flash-lite in the loop and voice on Gemini Live. A realtime model runs muted, its transcript the reply, only when no text model in the list can answer now (there is none, or all rest). With voice on, the list is walked in order.
  - **Koe thinks at "low" unless the user sets another level** (the user, 2026-10-19: "should we set the default thinking level for koe low or off? many model now does not support off and maybe low will be slightly less garbo out?"). It was off. A model whose map lacks low uses the nearest it has.
    - Measured on 2026-10-19 with Koe on gemini-3.5-flash-lite through Gemini's OpenAI-compatible endpoint, with the K2 honesty replay (a coffee note, an hours note, chatter, 5 runs each) and a fresh "Is Nepenthe open right now?", 20 calls at each level. That endpoint refuses `reasoning_effort: "none"` for this model ("Request contains an invalid argument"), so off went as `"minimal"`. Koe's first spoken word: median 691 ms at off and 659 ms at low (15 calls that spoke at each); 4 at off took 3.6–9.0 s and 1 at low 3.6 s, the free tier's spread. Honesty: low passed 20 of 20; off 19 of 20, its miss saying "down by Rio Road" for the note's "near" (no place, name, number or time added). Neither reported reasoning tokens, and both wrote the same output tokens: on this model the two levels behave alike. gemini-3.8-flash took off as `"none"` (first word in 2.2 s), then its free day's limit was used up, so low wasn't measured there.
    - Gemini's chat models are added by id with no reasoning map, so their level sends nothing until one is set on the model's page; a live session (Gemini Live, OpenAI Realtime) doesn't take Koe's level either, though both APIs have a setting for it (Gemini Live's `thinkingConfig.thinkingLevel`, OpenAI's `reasoning.effort`).
- **Cache:** Kokoro's tool list never changes. When a realtime session opens or closes, annai adds an instruction block as a message.
- **Kokoro's user-facing tools, when Koe fails:** enforced in code, not by instructions alone (see "Failures").
- **The rest of the playback the user agreed to** ("looks right"):
  - Koe's compact context;
  - one personality across both halves;
  - session lifetimes;
  - Spend per day covering both halves.

## The design

### The halves and their models
- **Kokoro is the main role** (spec §9.6): Shiori's deep model, unchanged in its tools.
- **Koe is a new role:** one ordered list, taking text and realtime models, which falls back down its models as roles do today.
- **The split is opt-in** (my call, from the user's "both can do both"):
  - Shiori is two halves only when the Koe role has at least one model. With no Koe model, she works exactly as today: one half, the main model, talking through output tools. That's also the failure path.
  - That keeps a new user's free start (OpenRouter's 50 free requests a day) at one call per message.
  - **Voice on or off, Koe uses the same list.** With Gemini Live first and voice off, a text model after it answers; with none that can, Koe uses Gemini Live in text: a realtime model's transcript is the reply. With a text model first and voice on, Koe talks with it through the speech pipeline.
  - So the split never flips with the voice setting. Kokoro's instructions always include the Koe-aware part while any Koe model is set.
- **The pathway comes from the model's abilities:**
  - **A text model as Koe:** typed and transcribed text in, text out. When voice is on, speech-in and speech-out work as today: dictation, Whisper, send audio, browser voice, TTS.
  - **A realtime voice model as Koe:** a live session. Audio streams both ways, typed text and photos go in, and audio comes out with transcripts of both sides. In a typing conversation, a realtime model's reply is shown as its transcript, and the audio is played only when voice is on.
- **One personality** (Shiori's) is in both halves' instructions. Koe carries her voice and manner. Kokoro gets the same personality, plus how to work behind Koe.

### Koe's context (compact, for speed)
- Koe's instructions: the personality, the honesty rule, what it knows versus what it must leave to Kokoro, how to use "tell Kokoro", and that notes from Kokoro are never read out word for word or mentioned as such.
- **What Koe knows:**
  - a compact view of the trip: today's plan, bookings, where the user is, the time, the next reminder;
  - the recent conversation;
  - Kokoro's recent notes.
- It stays small, so Koe is fast and cheap, and so a realtime session's setup fits.
- Its quick tools read the device directly for anything not in that view.

### The channel between the halves
- **Koe's tool `tell_kokoro(text, mode)`** and **Kokoro's tool `tell_koe(text, mode)`.** The mode is `append` (the default) or `immediate`. Both return at once with "sent" or "recorded".
- **To Kokoro:**
  - **append:** the note goes into Kokoro's conversation before its next model call (between tool steps), or starts a turn if it's idle;
  - **immediate:** it stops Kokoro's current model call (the interrupt path annai already has), and Kokoro's turn continues with the note.
- **To a text Koe:** append goes before Koe's next model call, or starts a Koe turn if it's idle; immediate stops Koe's current call and starts again with the note.
- **To a realtime Koe**, the note is wrapped in markers (e.g. `<from_kokoro>…</from_kokoro>`) and sent into the live session as a text turn:
  - **append:** sent once Koe's current spoken turn ends;
  - **immediate:** sent at once, ending the turn, which interrupts Koe mid-sentence (the Live API supports this) so it can correct itself.
- **Marker hygiene:** annai strips these markers from anything the user types, so they can't be faked.
- **Kokoro's plain text stays its private work log,** as §7.1 has it today. One addition: **when Kokoro ends a turn with plain text and called neither `tell_koe` nor `sleep`,** annai passes that final text to Koe as an append, since models sometimes answer in text out of habit. Text written alongside tool calls is never passed.
- **Two transcripts.** The conversation is what the user sees: what they said, and what Koe said, showed and asked. Kokoro's work log holds its reasoning text, tool calls and results, and the notes between the halves. Both are kept, and both are in the Trace. The halves' exchanges stay out of the conversation view by default.

### What Koe may say from its own knowledge (the user's choice: "stable facts yes, live facts no")
- **Stable, general knowledge it may use at once:** what a landmark is, a dish, a town's history, the story behind a photo. Kokoro checks Koe's spoken claims in the background, and corrects it with an immediate note when needed. Koe then corrects itself and apologises.
- **Things that change always come from Kokoro or annai's data, never from the model's own memory:** opening hours, prices, directions, schedules, availability, weather, anything about today.

### What each half sees
- **Kokoro's context:** today's context (§6.3) plus the conversation as it happens, in special blocks: "heard: …", "Koe said aloud: …", "Koe showed: …", "the user typed: …", "photo: …". Notes from Koe arrive as "Koe asks: …" or "Koe notes: …". A realtime session opening or closing is an instruction block, never a tool or system change.
- **Koe's context:** as above. Kokoro's notes arrive as notes, never in the conversation.

### Tools: who has what
- **Koe:**
  - talking: `speak` (not on a realtime model, which speaks natively), `show`, `ask`, `wait`;
  - its own `sleep`;
  - `watch.*` (timers);
  - the self tools that are light (`recall`; `tune_personality` stays with Kokoro);
  - reads: `list` and `read` on the trip's files, plan and bookings; places and map reads from the offline pack (no network);
  - light changes, meaning a note, a reminder, a small plan tweak. The builder draws the exact line and says why; anything that removes, imports, books, spends money or changes many things belongs to Kokoro;
  - `tell_kokoro`.
- **Kokoro:** every tool it has today, which keeps the cache intact, plus `tell_koe`.
- **Koe's `wait`** means "Kokoro is working": the user sees a small sign and can keep talking. When Kokoro goes to sleep without telling Koe anything, Koe stops waiting too.

### Failures
- **Kokoro's speak, show and ask while Koe works:** annai doesn't run them. It turns them into a `tell_koe` append, so nothing is lost, and the tool result says "Koe is speaking for you; use tell_koe." This is enforced in code, because instructions alone leak.
- **When every model in Koe's list has failed,** annai adds a message block, "Koe can't speak right now; talk to the user directly", and lets Kokoro's output tools run. The user still gets an answer, as Shiori answers today. When Koe works again, a block says so.
- **When Kokoro's models all fail,** Koe tells the user it couldn't check, in plain words, and offers to try again.
- **A realtime session that drops** (a connection limit, a network change) resumes with its handle. If it can't, Koe goes on with the next model down its list (a text model through the speech pipeline) for that turn, and says so only if the user would notice.

### Triggers and wakes (§6.1)
- **Kokoro hears all, and wakes on cue** (the user's choice). Every heard sentence, everything Koe says, and every typed message and photo goes into Kokoro's transcript at once.
- **Kokoro runs when:**
  - Koe asks it something;
  - Koe answers the user (a sentence meant for Shiori);
  - the user types or sends a photo;
  - a trigger fires;
  - a periodic review comes due: every few minutes of conversation that hasn't woken it. That catches a request Koe took for chatter. The builder picks the interval and says why.

  Kokoro doesn't run on every passenger's sentence, so a long drive stays affordable.
- Every trigger goes to both halves.
- **Koe** says simple things at once ("your train leaves in 20 minutes"). For anything that needs judgement, it waits for Kokoro's note.
- **Kokoro** decides what matters, and tells Koe what to say, if anything.
- **Chatter** in the car, speech not meant for Shiori: Koe may stay silent, using the realtime model's own choice (Gemini's proactive audio) or the quick-decision gate (§10.4) for text pathways. It still goes into both transcripts, as dismissed speech does today.

### Realtime sessions
- **Opening:** a session opens when voice turns on with a realtime model first in Koe's list. It needs the user's tap for audio, as voice does today. The setup carries Koe's instructions, compact context and tools.
- **Closing:** it closes when voice turns off, or after a quiet spell (the builder picks the length and says why), so the free limits aren't wasted.
- **Reopening while voice is on** (the user's choice: "tap or a reminder"), as Shiori wakes today:
  - a tap on Shiori;
  - a trigger or a note from Kokoro that Koe should say, which opens a session, speaks, then listens.

  annai doesn't keep the microphone open between sessions. That way the car's Bluetooth returns to full-quality playback (§10.1).
- **Long sessions:** they use the provider's resumption (Gemini: resume handles valid for 2 hours; context-window compression on). A new connection after GoAway carries on the same conversation.
- **Privacy:** while a session is open, audio streams continuously to the provider. The voice chip shows it plainly (e.g. "listening live"), and the Trace records the session's opening, closing and tool calls.
- **Cost:** realtime usage is recorded per session where the provider reports it, and counts toward Spend per day.

### Audio formats: the most efficient each provider supports (the user, 2026-10-19)
The user: "maybe let's try to use the most efficient codec each provider supports? this is to cut down data usage and increase reliability on trips".

- **Today:** every recording goes out as WAV, 16 kHz mono (`src/core/voice/recorder.js`, `pcm.js`): about 256 kbps, or 1.9 MB a minute, for every provider. Speech coming back is MP3 by default (speech-openai's `format` tunable).
- **Each speech ability declares the formats it accepts and returns,** in order of preference. These go in the protocol plugin's defaults and the provider description, since providers differ. For example:
  - OpenAI's transcription takes webm, ogg, mp4/m4a, mp3 and wav;
  - Groq adds flac;
  - Gemini's audio input takes ogg, aac, mp3, flac and wav;
  - OpenAI's chat `input_audio` takes only wav and mp3;
  - Gemini Live takes raw 16-bit PCM at 16 kHz only;
  - OpenAI Realtime takes pcm16 or G.711.
- **annai picks the smallest format both the device can make and the provider accepts:** Opus, then AAC, then MP3, then FLAC, then WAV as the last resort.
  - It records with what the browser offers: MediaRecorder's `audio/webm;codecs=opus` on Chrome and Android, `audio/mp4` (AAC) on iPhone Safari, or WebCodecs' AudioEncoder where it encodes Opus.
  - It asks for the smallest output the device can play: Opus where it plays, otherwise AAC or MP3.
  - Check each format against the provider's current docs and a real call where possible.
- **Realtime sessions can't choose a codec on Gemini Live** (PCM in, PCM out). Their saving is to stream no silence: a local voice detector sends audio only while someone speaks, using the API's manual activity signals (`activityStart` / `activityEnd`, automatic detection off) or `audioStreamEnd`. Sessions also close after the quiet spell. On OpenAI Realtime, prefer G.711 where its quality is good enough for speech recognition, and say why.
- **Reliability:** a smaller upload is less likely to fail on a weak signal. Whatever the format, a failed upload retries with the same bytes. The clip kept in the trip record (§10) stays in its compressed form, which also saves storage.
- **The Trace** shows each clip's format and size.

### Spending and the Trace
- Both halves' model calls count toward Spend per day. The Trace shows each call, which half made it, and the notes between them.
- Settings → Models shows the Koe role, one list, right after Main.

## Spec changes
docs/superpowers/specs/2026-10-15-annai-design.md:
- §6: wakes to both halves, Kokoro's work log, the notes, the final-text rule;
- §6.3: the context for each half, with the instruction blocks as messages;
- §7.1–7.2: output tools by half, the code gate, `tell_koe` and `tell_kokoro`, and the tool split;
- §9.6: the Koe role, one list;
- §10: the pathways, and realtime sessions within voice mode (§10.5);
- §11: triggers to both halves;
- §15: realtime connections and their keys, and the "listening live" disclosure;
- §16: the "Kokoro is working" sign, and the conversation view without the halves' exchanges.

docs/plugins.md: the realtime-voice ability, and the protocol contract for a live session (connect, send audio, text and images, receive audio, transcripts and tool calls, resume).

## A spike first, as the first build step
The user wants this built right after the design is approved, without waiting on them ("let's have it done tonight after design is approved"). So the spike is the builders' first step, not a stop for the user. It runs on desktop browsers and stand-in servers, and against the real Gemini Live API only if a test key is provided (in a root-only file, never in context). Its findings go into the plan's first milestone. The iPhone-only checks become device checks the user runs.

The questions it answers:
1. **Gemini Live from the iPhone Home Screen app:** a WebSocket with the user's key; audio in and out after the unlock tap; latency; how the session behaves when the screen locks.
2. **Notes into a live session:** a text turn added while it talks (immediate interrupts, append waits). Does Koe follow the marker rules and the honesty rule?
3. **Tool calls on the current live model:** the builder check found that Google's docs now make non-blocking function calls the default on gemini-3.8-live. Answering at once with "sent" stays the rule either way.
4. **A text Koe with a fast model,** and Kokoro behind it on the real main model: time to first words, and how often Koe guesses instead of deferring.

The spike's findings go to the user in the morning report.

## Left to the builder
- Exact prompt wording, block formats, marker names, and the line for "light changes".
- How the loop runs two halves: two loops sharing the wake queue, or one coordinator. Say why.
- The protocol contract for realtime sessions, and how the provider redesign's milestones are extended for it.
- The quiet-spell length that closes a session.
- The order of building after the spike. Everything agreed goes in: no part is held for later, OpenAI Realtime included (the user: "everything we have planned so far goes in"). Run work in parallel where files don't collide, alongside the provider redesign's remaining milestones. A sensible order:
  1. the text split (Koe role, channel, code gate);
  2. voice through the speech pipeline;
  3. the Gemini Live plugin and realtime sessions;
  4. OpenAI Realtime.
