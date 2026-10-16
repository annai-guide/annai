# Device checklist: milestone 3 (voice)

On a real iPhone (Safari, and the installed app) and a real Android phone (Chrome, and the installed app). Each line: what to do, and what should happen. Note anything else that happens.

## Speaking and hearing (milestone 3a)

- [ ] **The first tap unlocks sound.** Open annai fresh. Without tapping anything, nothing plays. Tap anywhere once, then Settings → Voice → Test the voice: you hear it.
- [ ] **The browser voice.** Settings → Voice: the Voice list shows this phone's voices. Pick one, set the speed to 1.2, Save, Test the voice (with Browser voice first in Settings → Models → Speech out): it speaks with that voice, a little faster.
- [ ] **An API voice.** Add "OpenAI: voice" with your key. Test the voice: it speaks in Marin. Turn the phone's silent switch on (iPhone) and test again: note whether you still hear it.
- [ ] **Fallback.** Put a voice with a wrong key first in Speech out. Test the voice: the next voice speaks the whole sample; the Trace shows the failed request without the key.
- [ ] **The microphone.** Settings → Voice → Test the microphone, and say "Where should we stop for lunch?". The meter moves while you speak; it reports a few seconds of speech, and with a transcription model, the words.
- [ ] **A denied microphone.** Deny the microphone when asked (or turn it off in the phone's settings), then test again: the message says what happened and the steps for this phone.
- [ ] **Road noise.** In a moving car with the windows up, test the microphone without speaking for 15 seconds: "Nothing was heard". Then speak: it hears you.

## Talking with Shiori (milestone 3b)

- [ ] **A spoken exchange.** Settings → Voice → On. Tap Shiori and ask "Where should we eat?". The dock says Listening, then Hearing you while you speak (the glow follows your voice), then Thinking; she answers aloud (the glow follows hers) and listens; answer her; she replies and sleeps (Tap to talk). The microphone indicator is off whenever she sleeps.
- [ ] **Interrupting.** While she speaks, tap her: she stops at once and listens; what you say next is her answer. In the Trace, her speak result says where you stopped her.
- [ ] **Talking over her thinking.** After you answer, add a second thought while she is still thinking: her reply covers both.
- [ ] **Chatter.** With a quick-decision model set, while she listens after speaking, talk to someone else ("can you pass the water?"): she doesn't answer, and goes to sleep; the conversation shows "Heard, not for Shiori".
- [ ] **Phone dictation.** With Speech in set to Phone dictation first and no transcription model: a spoken exchange works (Android Chrome; and note what iPhone does, in Safari and in the installed app).
- [ ] **Send audio to the model.** With an audio model (Gemini through OpenRouter, say) as main and "Send audio to the model" first: a spoken exchange works without a transcription model; in the conversation your words appear after her reply.
- [ ] **No way to hear.** With a text-only main model and only "Send audio to the model" in Speech in, tap Shiori: a card says what to add.
- [ ] **Silent switch.** iPhone silent switch on: does she still speak? (§10.1's "transient" session is muted by it; write down what happens.)
