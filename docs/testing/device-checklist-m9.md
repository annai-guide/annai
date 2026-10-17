# Device checklist: milestone 9a (backups to GitHub)

The done criterion is that automatic backup and restore to GitHub work on an iPhone and an Android phone, in the app installed to the Home Screen, with your own private repository and tokens. Open annai over HTTPS at the address you will travel with: each address keeps its own data.

## Before you start, on github.com

- [ ] **New repository:** name it, for example, `annai-backup`; choose **Private**; a README is fine. Nothing else goes in it.
- [ ] **One token per phone,** so you can revoke one without the other: your picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
  - **Name:** "annai on iPhone". **Expiration:** your choice; when GitHub stops accepting it, annai shows a card.
  - **Repository access:** Only select repositories → `annai-backup`.
  - **Permissions** → Repository permissions → **Contents: Read and write** (Metadata: Read-only comes with it).
  - **Generate token**, and copy it.

## The first phone (iPhone)

- [ ] Settings → **Automatic backups** → "Add a place to back up to": **GitHub** → **Add**. The first time, this installs annai's GitHub plugin, which needs a connection.
- [ ] Repository `you/annai-backup`, the token, **Save and test**: "Works: annai can reach you/annai-backup, a private repository."
- [ ] Within a few minutes, on Wi-Fi with annai open: "Last backup just now". On github.com, the repository has a commit "annai backup from iPhone", with `annai-archive.json` and the folders `me`, `trips` and `system`. A trip's notes are readable there.
- [ ] Trips: each trip card says "backed up … ago".
- [ ] Add a note, then wait about an hour with annai open: a new commit. On GitHub, its changed files are the note, the logs and `annai-archive.json`; no photo was sent again.
- [ ] Add 10 or more photos away from Wi-Fi. Safari can't tell annai whether it is on Wi-Fi, so when the backup would upload more than 25 MB, a card says "A large backup is waiting". **Back up now** sends it.
- [ ] Trace → Kind **Web**: each request to GitHub is a line `plugin:storage-github · …`. Kind **Backups**: a line for each backup. Settings → **Copy diagnostics**, paste it into a note, and search for your token: it isn't there.

## The second phone (Android)

- [ ] The same steps with the second token. After **Save and test**: "A backup is already here. An iPhone backed up to you/annai-backup …". **Import it as a copy** → the import preview → **Import**: the iPhone's trips are here.
- [ ] Turn Wi-Fi off and change something: no new commit appears. Turn Wi-Fi on: one does, within a few minutes.
- [ ] Turn on **Also over mobile data** on the GitHub place: changes are backed up on mobile data too.

## Two phones, one repository

- [ ] On the Android phone, change something; a commit "annai backup from Android phone" appears.
- [ ] On the iPhone, change something. Within a few minutes, a card: "A newer backup is on GitHub. An Android phone backed up to you/annai-backup … after this phone's last backup." No commit from the iPhone appears.
- [ ] **Import it as a copy:** each trip you have shows "You already have …", with "Replace mine". After importing, the iPhone's next backup goes on top of the Android phone's.
- [ ] Or, the next time, **Back up this phone over it:** a commit from the iPhone, and the Android phone's commit is still in the repository's history.

## Restore onto a wiped phone

- [ ] First, Settings → **Export everything** (a second copy, just in case). Then Settings → Erase → type ERASE → **Erase now**.
- [ ] Settings → Automatic backups → GitHub → repository and token → **Save and test** → "A backup is already here" → **Import it as a copy**. "Replace my profile and memory" and "Replace my settings" are already ticked. **Import.**
- [ ] Every trip is back: notes with their history, photos, plan and bookings. The models are back too; type their API keys again, since keys are never in a backup.
- [ ] Restart annai, as the import screen asks. The next commit's parent is the one you restored from.
- [ ] Backups → GitHub → **Show the backups here** → an older one → **Open**: the import preview shows that day's trips.

## What should fail kindly

- [ ] A public repository: **Save and test** says it is public, and how to make it private.
- [ ] A wrong or expired token: "GitHub didn't accept the access token …", and a card once when an automatic backup meets it.
- [ ] A repository with code in it: "… holds other files (…), so annai won't back up into it."
- [ ] Airplane mode: no pile of cards. Backups show that the last try failed, and carry on by themselves later.
