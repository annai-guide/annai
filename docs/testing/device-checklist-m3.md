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
