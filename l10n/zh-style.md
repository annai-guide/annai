# Writing annai's Chinese (zh-Hans and zh-Hant)

The user, 2026-11-14, after asking for the Japanese to read native: "yeah proof read two chinese ones they also show
similar translated vibes".

Write each line the way a Chinese app would say it, not as a translation of the English: zh-Hans as iOS's own screens
in Simplified Chinese, WeChat or Gaode would; zh-Hant as iOS in Taiwan, LINE or a Taiwanese app would. Read the English
for what it means, then say that in Chinese from scratch. zh-Hant is written for Taiwan readers from the meaning, never
as zh-Hans run through a converter. Every draft in `zh-Hans.tsv` and `zh-Hant.tsv` follows this page and the glossary
(`glossary.tsv`).

## Rules

1. **Meaning first, word order never.** Keep every fact, condition and warning of the English. Change the sentence
   shape freely: the condition or reason first, the point last; join or split sentences as Chinese reads best. A
   mid-sentence English colon becomes 。 or ，, or a 所以 / 因此 only where the logic needs it. Never weaken what a line
   says about lost data, money spent, privacy or what is sent where.
2. **Few pronouns.** Drop 你 and 你的 wherever Chinese leaves them out (most places): "your trips" is 旅行, "what you
   typed" is 输入的内容 / 輸入的內容. Where one is needed, 你 (as iOS does), never 您 mixed in.
3. **annai and Shiori as subjects only when they matter.** "annai couldn't reach {0}" is “无法连接 {0}” /
   「無法連線到 {0}」. Name Shiori when the line is about what she does, as opposed to what the app does.
4. **Register by role.** Read the code at `where` when the role isn't clear.
   - Buttons, menu items, tabs, switches, section titles: short verbs or nouns: 保存 / 儲存, 删除 / 刪除, 重试 / 重試.
   - Status and progress: 正在…… or ……中: 正在连接… / 連線中…
   - Messages, explanations, errors: plain and polite, not stiff; errors say what happened, then what to do:
     “保存失败。请检查存储空间。” / 「無法儲存。請檢查儲存空間。」
   - Shiori's own lines (what she says aloud or writes as herself): natural spoken Chinese, warm and short, as a
     local guide would talk to a traveller. Things read aloud get no symbols a voice reads badly (→, ·, /).
5. **Each script's own words.** zh-Hans / zh-Hant: 文件 / 檔案, 设置 / 設定, 服务器 / 伺服器, 网络 / 網路, 消息 / 訊息 (a chat message, as WeChat and LINE say; 信息 / 資訊 is information),
   默认 / 預設, 登录 / 登入, 屏幕 / 螢幕, 软件 / 軟體, 链接 / 連結, 用户 / 使用者, 支持 / 支援, 菜单 / 選單, 打开 / 開啟,
   创建 / 建立, 撤销 / 復原, 搜索 / 搜尋, 上传 / 上傳, 程序 / 程式, 数据 / 資料 (mobile data is the glossary's 移动数据 / 行動數據),
   内存 / 記憶體, 视频 / 影片, 连接 / 連線,
   手机 / 手機, 缓存 / 快取, 账户 / 帳號, 地址 / 網址 (a web address). Use the word each region's apps use, not the
   other region's word in the other script.
6. **Counters.** The right one: 个 / 個, 张 / 張 (photos, cards), 条 / 則 or 筆 (messages, records), 次, 处 / 處 or
   个地点 / 個地點 (places), 项 / 項 (items, settings).
7. **Punctuation and spacing (Apple's Chinese style).** Full-width ，。：；？！（）. Quotes: zh-Hans “ ”, zh-Hant 「 」.
   A half-width space between Chinese and Latin letters, numbers or a placeholder: “打开 Safari”, “{0} MB”,
   “已删除 {0}”. No space next to full-width punctuation. A placeholder gets the space only when its value is Latin
   letters or a bare number (a name, a host, a size such as 5 MB, a count: “# 个”); none when the value is Chinese
   words, even ones that start with a digit: a relative time (“{0}已备份”, since it reads 2小时前 or 刚刚), a language or
   role name, or a sentence. A path of screens, with spaces only around the arrows: 在设置 → 模型中.
8. **Length.** About as wide as the English on a phone, or narrower. Buttons and chips as short as they can be.
9. **Keep exactly:** every placeholder ({0}, {1}) and the plural `#`, any markup, code, flags, URLs and key names, the
   glossary's terms, and the "never" names (annai, Shiori, Koe, Kokoro, brands).
10. **When the glossary's term reads wrong in a sentence,** reword the sentence around it. If the term itself is wrong,
   propose a change (with the reason) instead of using another word.

## Words fixed across the app (2026-11-14 pass)

| Meaning | zh-Hans | zh-Hant |
|---|---|---|
| annai tries again by itself | 稍后会自动重试 | 稍後會自動重試 |
| Phone dictation | 手机语音输入 | 手機語音輸入 |
| A secret (a plugin's) | 密钥 | 金鑰 |
| A live session | 实时会话 | 即時連線 |
| A private repository | 私有仓库 | 私人儲存庫 |
| This phone (counter) | 这部手机 | 這支手機 |
| Ignoring sound (her state) | 忽略背景音 | 忽略背景音 |
| A newer backup | 较新的备份 | 較新的備份 |
| Tap | 轻点 | 點一下 |
| Remove (from a list) / delete (a file) | 移除 / 删除 | 移除 / 刪除 |
| Where this stops (heading) | 注意事项 | 注意事項 |
| The Trace, named inside a sentence | “记录” | 「記錄」 |

## Examples (from the drafts as they were)

| English | Before (zh-Hans) | After (zh-Hans) | After (zh-Hant) |
|---|---|---|---|
| With annai open on screen, annai says a reminder itself, and the relay's copy is called off: you never get it twice. | annai 在屏幕上打开时，会自己说出提醒，中继那份会被取消：你永远不会收到两次。 | annai 在屏幕上打开时会直接说出提醒，并取消中继发送的那一条，所以不会重复收到。 | annai 在螢幕上開著時會直接說出提醒，並取消中繼傳送的那一則，所以不會重複收到。 |
| Undo what Shiori did with these files | 撤销 Shiori 对这些文件所做的事 | 撤销 Shiori 对这些文件的操作 | 復原 Shiori 對這些檔案的操作 |
| {0} holds other files ({1}), so annai won't back up into it. Make a new private repository for annai's backups. | {0} 中有其他文件（{1}），所以 annai 不会备份到这里。请为 annai 的备份新建一个私有仓库。 | {0} 里已有其他文件（{1}），不能用来备份。请为 annai 的备份新建一个私有仓库。 | {0} 裡已有其他檔案（{1}），無法用來備份。請為 annai 的備份建立一個私人儲存庫。 |
| The model refused a photo (it takes {0}), and annai couldn't make a copy it takes. | 模型拒收了一张照片（它接受：{0}），annai 也无法做出它能接受的副本。 | 模型不接受这张照片（它的要求：{0}），也无法转换成它能接受的照片。 | 模型不接受這張照片（它的要求：{0}），也無法轉換成它能接受的照片。 |
| Getting annai ready for offline use… This goes on by itself once it's ready. | 正在为离线使用准备 annai… 准备好后会自动继续。 | 正在准备离线使用… 准备好后会自动继续。 | 正在準備離線使用… 準備好後會自動繼續。 |
