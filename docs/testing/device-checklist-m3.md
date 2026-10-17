# Device checklist: milestone 3 (voice)

On a real iPhone (Safari, and the installed app) and a real Android phone (Chrome, and the installed app). Each line: what to do, and what should happen. Note anything else that happens.

## Speaking and hearing (milestone 3a)

- [ ] **The first tap unlocks sound.** Open annai fresh. Without tapping anything, nothing plays. Tap anywhere once, then Settings → Voice → Test the voice: you hear it.
- [ ] **The first tap on iPhone, with a finger.** Close annai fully and open it from the Home Screen. Tap Shiori once with a finger (not a keyboard or a mouse) and ask something: does her voice play? A tap that came too early (before annai had started) is fine: the next tap tries again.
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
- [ ] **Silent switch.** Silent switch on, API voice: is she heard?
- [ ] **Music after she speaks.** Play music in a music app, then have a spoken exchange (the music pauses while she talks, §10.1). After the exchange, does the music app resume by itself, or does it stay paused?

## Voice modes and the car (milestone 3c)

- [ ] **Auto with headphones.** Voice chip on Auto. Connect AirPods (or any Bluetooth headphones), allow the microphone once (tap Shiori): the chip says "Voice on · headphones". Disconnect them: it says "Voice auto · off".
- [ ] **Auto in the car.** Connect the phone to the car by Bluetooth: the chip says "Voice on · car audio" (or "headphones": note which). Note the name the car shows in Settings → Voice → Test the microphone's device list if it's neither.
- [ ] **Auto can't tell.** Fresh install, microphone not allowed yet: the chip says "Voice auto · off". Choose On, then Auto: "Voice on · your last choice".
- [ ] **A hands-free exchange in the car** (the milestone's "Done when"), on both phones, phone in its holder, music playing: tap Shiori once and talk; she answers aloud and listens; answer her; go on for three or four turns without touching the phone. Note: does the music pause while she speaks, and come back after? Is the car's microphone used (car Bluetooth quality while the microphone is open)? Is she loud enough over road noise? Does the end of your sentence get cut off, or does she wait too long (Settings → Voice → the pause)?
- [ ] **CarPlay and Android Auto.** With Maps on the car's screen and annai on the phone: the exchange still works; directions keep speaking; note what the car shows while Shiori speaks (her clip as "now playing"?).
- [ ] **Split screen with Maps (Android).** annai and Maps side by side: tap Shiori, talk, and she answers.
- [ ] **Steering-wheel buttons (experiment).** With voice on and after she has spoken once, press play/pause (or next track) on the steering wheel or headset: does it tap Shiori (stop her, or start listening)? Note what each button does on each phone.
- [ ] **The first tap on iPhone.** Close annai fully and open it from the Home Screen. Before tapping anything else, let a reply come without a tap (a reminder, once milestone 5 has them; for now, send a message with the keyboard's return key): does she speak, or does a card ask for a tap?
- [ ] **Dictation in the installed app on iPhone.** Speech in: Phone dictation first, no transcription model. In Safari and in the installed app: does dictation hear you? If it fails, does recording take over (with a transcription model second)?
- [ ] **Interrupting and chatter in the car,** as in 3b's list, with road noise.
- [ ] **Show what she's saying.** While she speaks, a passenger taps "Show what she's saying": her words show above the dock.
