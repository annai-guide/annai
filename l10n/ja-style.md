# Writing annai's Japanese

The user, 2026-11-14: "the japanese words seems bit 不自然 feels like english translated to japanese not native
japanese from feedback. Can you help make it more natual and how people will actually say?"

Write each line the way a Japanese app (iOS's own screens, LINE, a Japanese travel app) would say it, not as a
translation of the English. Read the English for what it means, then say that in Japanese from scratch. Every draft
in `ja.tsv` follows this page and the glossary (`glossary.tsv`).

## Rules

1. **Meaning first, word order never.** Keep every fact, condition and warning of the English. Change the sentence
   shape freely: put the reason or condition first and the point last, join two short English sentences into one, or
   split a long one. Never weaken what a line says about lost data, money spent, privacy or what is sent where.
2. **No pronouns.** No あなた, あなたの, 私. Drop the subject when it is obvious. "Your trips" is 旅, not あなたの旅.
   "What you said" is 話した内容.
3. **annai and Shiori as subjects only when they matter.** "annai couldn't reach {0}" is 「{0}に接続できませんでした」.
   Name Shiori when the line is about what she does, as opposed to what the app does: 「Shioriが考えています」.
4. **Register by role.** Read the code at `where` when the role isn't clear.
   - Buttons, menu items, tabs, switches, section titles: short nouns or plain verbs, no です・ます: 保存, 削除,
     もう一度試す, 写真を追加, 通知.
   - Status chips and progress: 〜中 or a short plain phrase: 接続中, 聞き取り中, ダウンロード中…
   - Messages, explanations, errors: です・ます, plain and polite like iOS, never stiff keigo (no 〜いたします,
     〜でございます). Errors say what happened, then what to do: 「保存できませんでした。空き容量を確認してください。」
   - Shiori's own lines (what she says aloud or writes as herself): natural spoken です・ます, warm and short, the
     way a Japanese guide would talk to a traveller. Things read aloud get no symbols a voice reads badly (→, ·, /).
5. **The words Japanese apps use.** Prefer the word a Japanese screen uses over a literal one: 接続 for reach or
   connect, 更新を確認 for check for updates, 再試行 or もう一度試す for try again, 空き容量 for storage space,
   通信 for data or network, 停まる for a car that has stopped, 立ち寄り先 for a stop. Use katakana only where Japanese
   apps do (アップデート, ダウンロード, リクエスト, モデル, プロバイダー).
6. **Counters.** The right counter for the thing: 件 (messages, results, items), 個 (models, things), 回 (times),
   枚 (photos, cards), か所 (places), 分/秒 (time). 「#件のモデル」 or 「モデル#個」, never a bare number.
7. **Punctuation and spacing (Apple's Japanese style).** Full-width 、。：（）「」. No space between Japanese and
   Latin text or a placeholder: 「Safariの設定」, 「{0}に接続」, 「annaiは」. Keep a space between two Latin words
   ("Messages API"). Three exceptions keep the space: inline code, flags, URLs and key names
   (「`--tool-call-parser <name>` が必要です」, so a URL never runs into the Japanese); a brand's own spaced name
   (Google 検索); and a chip's label and its value (「日の出 {0}」). UI names in 「」 when the line points at them:
   「保存」をタップ; a path of screens in one pair: 「設定 → モデル → 1日の利用額」.
8. **Length.** About as wide as the English on a phone, or narrower. Buttons and chips as short as they can be.
9. **Keep exactly:** every placeholder ({0}, {1}) and the plural `#`, any markup, code, flags, URLs and key names
   (`--tool-call-parser <name>`), the glossary's terms, and the "never" names (annai, Shiori, Koe, Kokoro, brands).
10. **When the glossary's term reads wrong in a sentence,** reword the sentence around it. If the term itself is wrong,
   propose a change (with the reason) instead of using another word.

## Words fixed across the app (2026-11-14 pass)

- This phone: この端末, the same in every row. "This phone, iPad or computer" lists say スマートフォン, iPad, パソコン.
- Check for updates (the act): 更新を確認. The Updates screen and its button: アップデート (glossary).
- Try again, in a message: もう一度お試しください. annai trying by itself: あとで自動的に再試行します.
- "You" as a label (who wrote, who spoke): 自分 for files and history; ユーザー in the Trace.
- annai's own plugin: annai公式.
- watch (a reminder that watches for something): 見守り.
- turn (one exchange with Shiori): やり取り where a traveller reads it; ターン only in the Trace and developer screens.
- Flag: フラグ.

## Examples (from the drafts as they were)

| English | Before | After |
|---|---|---|
| Features still being tried, such as swiping between tabs. Each is off until you turn it on. | タブ間のスワイプなど、まだ試している機能。どれもオンにするまでオフです。 | タブのスワイプ切り替えなど、開発中の機能です。オンにするまで、どれも使われません。 |
| It asks for a key. | キーを求めています。 | キーが必要です。 |
| Everything works. | すべて動作します。 | すべて正常に動作しています。 |
| annai couldn't reach {0}. Check the address and your connection. | annai は {0} に接続できませんでした。アドレスと接続を確認してください。 | {0}に接続できませんでした。アドレスとネットワーク接続を確認してください。 |
| wasn't installed from an address, so annai has nowhere to look for an update | アドレスからインストールされていないため、annai には更新を探す場所がありません | アドレスからインストールしたものではないため、更新を確認できません |
| History holds where you were, so it needs places. | 履歴にはあなたがいた場所が含まれるため、場所を含める設定が必要です。 | 履歴には訪れた場所が含まれるため、場所も含める必要があります。 |
| Shiori is one half right now, so this is all of her: … | いまの Shiori は1つの半身だけなので、これが Shiori のすべてです。… | いまのShioriは一人で動いているので、これがすべてです。… |
| Shiori was in the middle of something. She picks it up when you come back. | Shiori は作業の途中でした。戻ってきたら続きをします。 | Shioriは作業の途中でした。戻ったら続きから再開します。 |
