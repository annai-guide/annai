# Lessons: full entries

Why this project's APIs, formats and agreed behaviours had to change. `lessons.md` has one line per
entry: read that first, and look entries up here by date and name rather than reading this whole. New
entries go last, in the same commit as the change:

```markdown
## YYYY-MM-DD <short name>
- Changed: ...
- Why we had to change: ...
- Original design was wrong because: ...
- Lesson: ...
```

## 2026-10-23 annai's translation TSV: a note part for the translator
- Changed: `l10n/<tag>.tsv`'s note column keeps a translator's part (`Note: …`) after the part the strings script writes. Before, the script rewrote the whole column from the code on every run.
- Why we had to change: the first translator's reasons (why a sentence became "label: value", why "she" became "Shiori") were wiped by the next `npm run strings`.
- Original design was wrong because: one column was meant for both the script and people, but only the script could write it.
- Lesson: when a file is written by a tool and by people, give each writer a part the other never touches.

## 2026-10-26 annai: modules pass data, and words are made at display
- Changed: while annai's screens were localized, several interfaces between its UI modules changed:
  - `restoreFrom()`'s `say` gets a `progress` flag instead of callers matching "Getting files";
  - `readForm()` reports `schema: true`;
  - `removalWords()` returns parts;
  - `thingWords()` takes a sentence-start noun instead of a capital made in code;
  - `downloadedWhen()` has no leading space;
  - the stored "Shiori's answer" title and the author ids ("user", "shiori", "system") are mapped to words at display;
  - plugin pages stopped matching "Providers: ".
- Why we had to change: a translation can't be glued from English fragments, capitalised in code, or matched by its English text. Each of these broke as soon as the words were Japanese.
- Original design was wrong because: modules passed English phrases to each other, and some code tested those phrases, so the words were the data.
- Lesson: pass data between modules (kinds, flags, values, ids), and make whole sentences only where they are shown. Never match on words a person reads.

## 2026-10-27 annai: plain fields are English, `shown` holds the screen's words
- Changed: annai's built-in search providers had put the screen's words in `name` and `why` and English in a new `en` field, while MCP errors did the reverse (English `message`, screen `shown`). Both now follow one rule: plain fields are English, for Shiori and logs, and an optional `shown` holds the screen's words. This covers search providers' `name`/`why`, McpError, and what L7 adds for plugins.
- Why we had to change: with `en`, a plugin that translated its `why` and didn't know about `en` would silently send Shiori Japanese. The failure was invisible.
- Original design was wrong because: the safe default (English to the model) depended on a plugin remembering an extra field.
- Lesson: when one value has two audiences, make the field the machine or model reads the default, and the human-facing one the optional extra. A forgotten extra then shows up as English on screen, where people notice it, instead of leaking.

## 2026-10-27 annai: a new record always writes the field that tells it from an old one
- Changed: annai's backup holds (why backups to a place stopped) gained `said`, what the failure was, so screens make its words. A hold from a place's or a plugin's own refusal had no `said`, and a hold from before the change had none either. Now every new hold writes `said`, `null` when the words are the place's own, and an old hold is one with no `said` key at all.
- Why we had to change: the screens told old holds from new ones by a missing `said`. A plugin's refusal kept today looked old, so its reason was dropped and its words were marked as annai's English.
- Original design was wrong because: "absent" meant both "written before this field existed" and "nothing to say", two states with one look.
- Lesson: when later code must tell old records from new ones, write the field on every new record, with `null` for empty, and test for the key (`'said' in h`), not its value.

## 2026-10-27 annai: an error's optional parts go in one options object from the start
- Changed: annai's `PluginError(pluginId, message, cause)` became `PluginError(pluginId, message, { cause, shown })` when its errors gained the screen's words (`shown`). `ProviderError` already took a `more` object and only grew `said` inside it.
- Why we had to change: a second optional part had nowhere to go but a fourth position, or a change to what the third one meant. Every caller that passed `cause` had to be found and changed.
- Original design was wrong because: an optional argument was given its own position. The first optional part set the shape for every later one.
- Lesson: after the required arguments, anything optional goes in one options object, even when there is only one so far. A new optional part then changes no caller.

## 2026-10-27 annai: a choice keeps its value and its words apart
- Changed: the settings form's `Field.options` (src/ui/settings-form.js) went from values (`['basic', 'advanced']`) to `[value, words]` pairs, when plugins' settings gained translatable choices (JSON Schema `oneOf` with `const` and `title`).
- Why we had to change: the form showed an `enum`'s values as its words, but a translated screen needs words for a choice that differ from the value it saves.
- Original design was wrong because: one string was both what is stored and what a person reads, so the words could never be anything but the stored value.
- Lesson: give a choice two parts from the start, the value the code keeps and the words a person reads, even while they are the same.

## 2026-10-27 annai: an error carries which of its words are a developer's English
- Changed: annai's errors gained `en`: `true` when all of their words are annai's own developer English, or a string, the part of their `shown` words that is. `PluginError` takes it in its options object (`{ cause, shown, en }`; with neither `shown` nor `cause` it is `true`), and `EnglishError` is a plain Error with it set. `showError` and the notice card (`errors: [e]`) read it and mark the words `lang="en"` where they stand. Five package checks that put the screens' words in `message` now keep English there and the screens' words in `shown`.
- Why we had to change: a Japanese screen reader voiced about 40 plugin checks and Simulate's itinerary errors with a Japanese voice, and no screen could tell an English message from a translated one.
- Original design was wrong because: whether words were English was only a `/* en */` comment at the source. The error a screen got said nothing about it.
- Lesson: when the language of a value matters to whoever shows it, the value carries that fact (a flag, or the part that differs), set where it is made. A comment in the source reaches no reader.

## 2026-10-27 annai: a plugin's `api` is the oldest host it needs, not an exact match
- Changed: annai's plugin manifest `api` had to equal annai's own `API_VERSION` (1). It now means the API a plugin needs: annai accepts any `api` up to its own (2), and refuses a newer one in words ("…supports API 2 and older"). Plugins that use `annai.l10n` say `api: 2`.
- Why we had to change: official plugins started using `annai.l10n`. A page still running the older annai would install their new versions, and they then failed to start. With an exact match, raising the API would have refused every existing plugin instead.
- Original design was wrong because: one number meant both "what this plugin needs" and "what this host has". Any addition to the API then broke every plugin, so the number was never raised, and so it protected nothing.
- Lesson: a version a component declares about its host is the minimum it needs. The host accepts anything at or below its own, and the number is raised only when the component starts using something an older host lacks.

## 2026-10-27 annai: a name the screens show is read from what is stored, not from what happens to be running
- Changed: annai's `pluginName` (which names an official plugin in the screens' words) became async. It reads the installed plugin's own words from the device, where it used to read a cache filled only while the plugin runs, and before that a catalog fetch that each screen awaited.
- Why we had to change: the cache named a switched-off plugin in English, and the catalog fetch made provider pages wait on the network (20 s on a stalled connection). Each fix to one source broke a case the other had covered.
- Original design was wrong because: the words came from wherever was handy (a runtime cache, a network file), not from the one place that always holds them, the installed package.
- Lesson: read what a screen shows from the stored source of truth, even if that makes the call async. A cache or a network copy is only for when nothing is stored.

## 2026-10-28 annai: an official plugin's translations are not files of its package
- Changed: annai's official plugins stopped shipping `l10n/<tag>.json` and listing `l10n`. Each one's words in each language are `catalog/l10n/<tag>/<id>.json`, hashed in `catalog/l10n/<tag>.json` (`translations`). Each phone fetches only its screens' language and keeps it at the plugin's `l10n/<tag>.json`. `verifyOfficial` counts only the package's files, an official install keeps the stored words, and `annai.l10n` reads the current words.
- Why we had to change: with three languages, translations were a third of the plugins' bytes, mostly in languages a phone never shows. A fix to one language's words was a plugin update for every user.
- Original design was wrong because: content each user needs one of (one language of N) sat inside the unit that is versioned and verified whole (the package). So every language, and every change to any of them, cost everyone.
- Lesson: when a unit you version and verify whole carries parts each user needs only one of, or parts that change on their own schedule, give those parts their own hash and fetch path from the first version, keyed by what selects them.

## 2026-10-28 annai: what a model makes of a stored file is kept beside it, and an explicit ask redoes it
- Changed: a reading made for a model that can't take a photo or PDF (a description, or the PDF's pages as pictures) went into the one request that first needed it. It is now a `reading` log entry in the conversation, keyed by the file's content hash, with its page pictures as the entry's blobs. Every later request where a model meets the file gets the kept reading. An explicit `read` reads it afresh, and the newest reading of each kind wins.
- Why we had to change: the next step and the next turn lost what the file said, or paid to read it again. Then, once kept, a refusal or a misreading could never be corrected ("that's wrong, read it again" got the same text).
- Original design was wrong because: it attached derived content to the request that first needed it, not to the thing it was derived from. The first fix then made the kept copy final.
- Lesson: keep derived content that later requests need with its owner, named by what it was made from (a content hash), and let an explicit ask redo it, newest wins.

## 2026-10-29 annai: mark both ends of a move on their records
- Changed: Shiori's `move_file` and the trip tools moved a file as a delete in one place and a write in another, each logged on its own. Both entries now carry `data.moved` (`{ to, path }` on the delete, `{ from, path }` on the write), and Undo's own writes carry `data.undo`.
- Why we had to change: Undo of each side undid only its own half, so after Undo a file sat in two trips, or in a trip and in Waiting. Later rounds then judged "the user's own work" by those writes and either kept trips that should go or removed a trip with someone else's file in it.
- Original design was wrong because: it recorded one operation as two unrelated records, so nothing could tell a move from a deletion plus a new file, nor whose work a moved file was.
- Lesson: when one operation spans two records, write the relation on both, so either side can reverse the whole thing. Mark what an undo itself writes, so later decisions never mistake it for the user's own work.

## 2026-10-29 annai: keep a reading's uncertainty per field, where the user acts on it
- Changed: a booking Shiori read stopped waiting to be confirmed whole (`status: 'unverified'` until the user tapped Looks right). It now lists the fields she isn't sure of in `unsure: string[]`, and only those get a light "check" mark. `status` stays and marks bookings from before; a change she makes to one the user confirmed keeps it confirmed.
- Why we had to change: the user found the separate confirming step "bit extra" and wanted fewer taps ("No step; she asks only when unsure"). With one flag, the only way to clear it was to check every field.
- Original design was wrong because: one flag stood for both "Shiori read this" and "any field may be wrong", so clearing it meant checking everything, and any change she made set the whole booking back to unchecked.
- Lesson: record a model's uncertainty at the level the user acts on (here the field), not as one flag over the whole record. Require the field on every new write, so a record without it can only be an old one.

## 2026-10-30 annai: a provider's reply is kept as it came, beside annai's reading of it
- Changed: annai's provider contract gained a native reply: what the provider returned (Anthropic's content array, OpenRouter's reasoning_details), kept for one turn beside annai's parts and sent back where it can be read. Before, a signed `reasoning` part per thinking block was meant to carry what the provider needed.
- Why we had to change: Claude 5.5 binds each thinking block to everything sent before it, the earlier blocks of its own reply included. annai rebuilt replies from its own parts (text joined across blocks, citations and empty thinking blocks dropped), and changed earlier content between steps (each step's now block, each half's instructions), so every step after the first got a 400 on the phone.
- Original design was wrong because: it modelled a provider's reply as annai's parts and expected the provider to take those parts back, when the provider checks what it gets back against what it sent.
- Lesson: when a provider checks what is sent back, keep its reply exactly as it came, beside annai's own reading of it, and make the requests of one exchange append-only; annai's parts are for annai and for other models.

## 2026-10-30 annai: a native reply goes to the models that can read it, and a refusal is read by status
- Changed: a native is kept for an endpoint plus a scope its endpoint type gives each model (`nativeScope`; Chat Completions: the model's maker prefix), and a native counts toward size limits for what it adds (`covers` on its event). `reasoning` is made by the core from any 400 on a request that sent natives, no longer by each plugin matching the provider's words.
- Why we had to change: one OpenRouter endpoint serves every maker's models, so a native kept "for the endpoint" went to GPT on a fallback; matching Anthropic's wording in two plugins would break silently when the wording changes, and OpenRouter's error shape wasn't known.
- Original design was wrong because: it took the endpoint for the unit that can read a provider's reply, and the provider's words for the signal that it was refused.
- Lesson: scope what a provider returns to who can read it, not to where it was fetched; act on a request's status and on what was sent, not on an error's text.

## 2026-11-01 annai: a log's last number never goes back
- Changed: `forget` (src/core/forget.js) writes one `forget` entry after any removal, numbered after every entry it removed, and keeps only the newest such entry per scope. `forget`'s `history` matcher also gets the entry (`history(path, e)`), and `Match.mustFree` lets a caller free a path's content only when nothing else names it, rolling the whole transaction back otherwise (`kept: 'here' | 'history' | 'elsewhere'`).
- Why we had to change: Delete in Files frees a file by removing its history, which is the scope's newest entries, so the next entry took their numbers again; `changedSince` and `backupState` compare the last number, so a backup made before the Delete read as current and kept the deleted file.
- Original design was wrong because: the last sequence number served as the scope's change counter, while removing entries could lower it; nothing removed the newest entries until Delete did.
- Lesson: when anything compares a position in a log, removing entries must still move the position forward; give removal its own entry rather than rewinding.

## 2026-11-02 annai: live Koe gets `sleep` back (plan decision 29 reversed)
- Changed: the live voice half (Koe in a realtime session) has a `sleep` tool again, used only when the user asks or a note from Kokoro says so; it closes the session like a tap. Before, live Koe had no `sleep` and only the user's tap or a quiet spell closed a session.
- Why we had to change: on a drive with music over the car stereo the session never went quiet, so it never closed; the user asked whether Shiori could put herself to sleep, and chose "when I ask, or kokoro tells koe to go to sleep. often kokoro is much more capable than realtime models."
- Original design was wrong because: it assumed silence would always come, so a timer alone could end a session; in a car, sound never stops, and the only thing that can tell music from the user is a model reading what was heard.
- Lesson: an end condition built on the absence of a signal (silence, no fixes, no events) needs a second way out that doesn't wait for that absence: a decision by whoever can judge, or an explicit command.

## 2026-11-04 annai: a "moved" watch counts from when it was set, not from Shiori's last wake
- Changed: annai's `moved {km}` watch (`km0`) no longer starts its count again at every wake of hers. It counts from when the watch was set, or annai's last start (`km0` is memory only), and with `repeat` from its last firing. Its summary and firing text say so: "you have travelled 5.2 km since this watch started counting", no longer "since your last wake".
- Why we had to change: on a test drive a 3 km watch never fired after about 8 km. With live voice every spoken turn is a wake, so the count kept going back to zero.
- Original design was wrong because: it tied a promise made to one watch ("after this far") to an event that belongs to something else (Shiori waking), written when wakes were rare. It also made the watch mean "this far with nothing else happening", which nobody setting a distance asks for, and when voice made wakes frequent nothing failed visibly: the watch just stayed silent.
- Lesson: a watch or timer counts from its own start, and resets only on its own firing. Don't reset it from an unrelated event because that event seems to make it redundant: how often that event happens will change.

## 2026-11-05 annai: screen-on is one setting, and a tap in Auto holds voice for that exchange

- **Changed:** the setting `live.keepScreenOn` replaces the per-situation `live.awake`, and `Voice.hold`/`release` keeps voice on for one exchange after a tap in Auto.
- **Why:** the per-situation choice lived in a menu that one-tap GPS removed, and a tap in Auto opened a text box when the user expected to talk.
- **Original design was wrong because:** it gave each situation its own choice, when the user only ever wanted one answer, and it let "Auto" decide what a direct tap on the talk button meant.
- **Lesson:** a direct action outranks an automatic mode. An automatic setting decides what happens when the user does nothing, never what their tap means.

## 2026-11-05 annai: all a reload needs is one overwritten record

- **Changed:** the odometer, the place it counts from, the activity and when moving fast ended moved from `state` entries read back at start, and the open trip's last point, to one localStorage record through an injected `keep`. A `moved` watch records its odometer reading when set and at each firing.
- **Why:** an iPhone reloads a Home Screen web app often, and three review rounds each found another disagreement among those sources. A count rebuilt from logged points skipped the odometer's own filters.
- **Original design was wrong because:** one fact lived in several places, and an append-only log doubled as state.
- **Lesson:** state a restart needs is one record written from one method, with values that must agree written together. A log is evidence, not state. A count that must survive is kept as a counter, and each consumer records its own reading of it. Anything that wipes state stops its writers first.

## 2026-11-05 annai: voice, four changes from the second drive

- **Changed:** a learned voice level is the second-loudest of the last 5 answered turns (`voiceDb`), not a falling maximum. A provider's end of turn after a silent tool answer is awaited with a 2 s bound, and a late one is that turn's. `LiveKoe.send` became `write` then `send`. `armUnlock` stays armed, and a tap after a stall makes a new AudioContext.
- **Why:** a drive with music on had lyrics answered, and a stretch of silence with notes unsaid because the sound never played.
- **Original design was wrong because:** one reading was taken as truth; a wait depended on an event the other side may not send; one call both recorded in order and could wait on something slow; "unlocked once" was treated as permanent.
- **Lesson:** a threshold learned from outside sound never takes one sample as truth. Never let a wait depend on an event the other side may not send: bound it, and say what a late one means. Recording and sending are separate steps. "It worked once" isn't a state: sound can get stuck later, so keep the way back armed. And test a real tool call before shipping a model: a clean open proves nothing (Gemini 3.8 Live Extended Thinking opened, and never made a call).

## 2026-11-05 annai: a gate reads the conversation, not one line

- **Changed:** `gatePrompt(lastSaid)` became `gatePrompt(lines)`, the last few lines of the conversation.
- **Why:** real comments right after she spoke were marked chatter on a drive, and an answer to a question she had just asked aloud could be lost.
- **Original design was wrong because:** one line can't show that speech follows from what was just said.
- **Lesson:** give a classifier the context a person would need. And give it a way to be wrong cheaply: here a wrong "for her" costs a short reply, while a wrong "not for her" loses what the user said.

## 2026-11-05 annai: Auto voice removed; voice and Live are each one tap

- **Changed:** the setting is on or off, and a saved `auto` reads as off. `lastChoices` and the `voiceMode` route inputs are gone. Realtime and Classic became a Live chip, with `koeMode`'s stored values unchanged. Voice turns itself off when a drive ends and when the mic's own input disappears.
- **Why:** the user couldn't predict it ("do you think user will understand what it does?"), and the chip's reason took the whole line. In the trace the iPhone's audio read only as unknown or speaker; a car was never detected.
- **Original design was wrong because:** it decided from audio-device names that a phone's browser rarely gives, then fell back to a remembered choice per activity, so the same situation could give different answers and nobody could say why.
- **Lesson:** an automatic setting must rest on a signal seen working on the real device, and be sayable in one sentence. Keep one measured rule (driving, from GPS) and make the rest a switch the user owns. A change of state is an event told once from its source, not worked out again from a value that can change for other reasons.

## 2026-11-05 annai: a model its plugin dropped leaves Koe's Realtime list at the update
- Changed: `syncProviders` takes a model out of Koe · Realtime's saved list at the update whose description dropped it: the previous description named it and this one doesn't. A model the user puts back stays. A description that lists no models for that ability is partial and leaves the list alone. A drop that would empty the list puts in the description's recommended model for that ability (its first with a record, if it recommends none), so an id swapped by an update keeps Live working. The list goes in the same write as the provider (`saveProvider` takes the roles). The rest of the list keeps its order, and everything else stays: the model's record, Kokoro's picks, Koe · Classic, and models added by hand or from a list.
- Why we had to change: taking Gemini's Extended Thinking out of the plugin left it in saved lists, so each session after its 3-minute rest opened a refused session first, and a list holding only it said "Live is resting" at every use. The user had picked "no refused sessions". The first fix then took out any model the description didn't name at every update, so one the user put back left again, a description with an empty list cleared Koe's Live, and a swapped id left no Live at all.
- Original design was wrong because: "models gone from the description stay as they are" was written for chat models, where a dropped model may well still answer. It treated every list as the user's own choice, even when the entry only named something the source had since withdrawn. The first fix read "not named now" as "dropped now", when a drop is a change between two versions of the source.
- Lesson: removing something from a catalog isn't finished until you've read what saved settings do with it. List what names it, then decide each one's fate, and test through the update path, not only on fresh data. When two saves must go together and the store has a transaction, use it: there's then no order to get right. A rule that reacts to an update can't ship with that update: a page on the old code may apply it first, so the rule goes out a release ahead.

## 2026-11-05 annai: one path for a gap in GPS evidence
- Changed: the drive record gains a `stale` field ('owed', 'told' or null; an older record has none, and reads the same), and `ActivityTracker.restore` a fourth argument, `old`. A record too old to restore now goes through the same tracker path as a reload or an unlock, with Live showing unknown and voice not held until a reading decides, and no time bound. A change found on a stale record tells the triggers when it happened, and one from before a watch was set doesn't fire it. A reading worse than 100 m says nothing about the activity, and a bound's end is dated at the bound, not from the last fix. `#wasFast`, `#stopOwed`, `#changeHeard` and `#late === 'fast'` went from Live; `#late` is now a plain flag for the one late end that stays.
- Why we had to change: a reload, an unlock and a kill each judged "is this the same drive?" in their own way, in the tracker and again in Live. Every patch round left a route where they disagreed: false stops, doubled ends, a stop lost across a reload.
- Original design was wrong because: it treated an old record as a different case from a gap, so Live re-judged what the tracker had already decided, with flags to remember what it had decided.
- Lesson: one question, one place that answers it. When fixes keep finding another disagreement between two places, take one away instead of syncing them. Cases that look different often decide the same way and differ in a few things you can name. Here an old record differs in what shows, in voice, in having no time bound, and in one rule for a fast speed on a slow way. And a straight-line way can prove a drive went on, never that it ended: a city, a winding road and an errand loop all look slow, so a slow way ends nothing out loud. A fuzz with one road speed couldn't see that: give a model the variety the real thing has.

## 2026-11-06 annai: a hold's date is in the drive record, and goes with its hold
- Changed: the drive record gains `heldEnd`: the date a stale record's hold will end with, `null` when there is none (an older record has no such key and reads the same; a page on older code ignores it). `ActivityTracker.restore`'s optional arguments became one options object, `{ from, old, heldEnd }`, and the tracker gains a `heldEnd` getter. Live writes the record whenever the date comes or goes.
- Why we had to change: the date lived only in the tracker's memory, so a reload or a second kill in the minute after a parked reopening lost it. The same-drive rule then swallowed a true "starts" for 5 minutes, and a "when I stop" set in that minute was spent at the hold's end.
- Original design was wrong because: the date was treated as part of a moment that would soon pass, but a hold lasts a minute and a reload can land in it. "All a reload needs is one record" (2026-11-05) already said so; the date was left out to keep a fix pass small.
- Lesson: state that lasts past one event belongs in the record a restart reads from the start. A saved value that something can cancel is written when it is cancelled, not only when it is set: here a green light cancels the hold without any other reason to write, and a date left in the record would come back after a reload and lose a reminder at the real stop. A copy that outlives what it belongs to is worse than none.

## 2026-11-06 annai: what only tests call is unused
- Changed: `KoeWay` loses `using` and `koe`; `Live.pushNews`, `PluginHost.installZip`, `scaledClock`, `wavSeconds` and `announcement` are gone. `way.path` says what `using` said, `newsArrived` is the real way news comes in, a plugin zip is read by the Add screen before `install`, and `PlayClock` does what `scaledClock` did.
- Why we had to change: nothing shipped called them, and with no build step each line is sent to every phone. `pushNews` had the same body as `newsArrived`, so the tests proved a copy.
- Original design was wrong because: each began as the real path or a convenience, the real path moved, and the tests kept the old one alive, so nothing showed it was dead.
- Lesson: a member kept for tests is shipped code that no operator runs. Tests go through the real path, or keep their helper to themselves. A test seam stays only when it resets module state or is the one way into logic that does ship.
