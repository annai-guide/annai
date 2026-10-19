# A Forgejo / Gitea backup place: plan

**Goal:** a new kind of backup place, "Forgejo / Gitea", for a private repository on the user's own Forgejo server, on Gitea, or on Codeberg (which runs Forgejo). It sits next to the GitHub place and behaves the same way (spec §12.4): the archive's files, unpacked, one backup per commit, only changed files uploaded, public repositories refused, single writer, restore through the import screen.

**Architecture:**
- **`plugins-official/storage-forgejo/`:** an official on-demand plugin, installed when the user first adds such a place (spec §5.3).
  - `index.js`: the storage type `forgejo`.
  - `git.js`: the GitHub place's `git.js`, copied as it is. Plugins are installed one by one, each from its own files, so one can't import another's. A unit test keeps the two copies identical.
- **`test/fakes/forgejo.js`:** a stand-in for the part of Forgejo's API the place uses, with Forgejo's status codes, messages and CORS behaviour as measured against Forgejo 16.0.6 (below). It hashes git objects with its own code (node:crypto), for SHA-1 and SHA-256 repositories.
- **No core change.** The backups screen lists every storage type the catalog offers (`offeredTypes('storage-type')`), so the catalog entry is all it needs. `stores: 'tree'` gives it the git places' pace and the hold logic the GitHub place has.

## The API facts relied on

Checked 2026-10-18 against the current API descriptions (codeberg.org/swagger.v1.json, Forgejo 16.0.0-dev; gitea.com/swagger.v1.json), the current source (codeberg.org/forgejo/forgejo, branch forgejo; github.com/go-gitea/gitea, branch main), and throwaway Forgejo 16.0.6 (the version the user runs) and Gitea 28.2.0 containers. "Probe" means what those containers answered.

| Fact | Source |
|---|---|
| The API is at `<server>/api/v1`. A token goes in `Authorization: token <t>`; `Bearer <t>` works too. | swagger `securityDefinitions.AuthorizationHeaderToken`; Forgejo `routers/api/shared/middleware.go` (`PermitBearer: true`); probe |
| A token with only `write:repository` can read and commit; creating a repository also needs `write:user`. annai never creates one. | probe; the user's server (via the coordinator) |
| `GET /repos/{o}/{r}` gives `full_name`, `private`, `empty`, `archived`, `default_branch`, `permissions.push` and `object_format_name` (`sha1` or `sha256`). | swagger `Repository`; probe |
| `GET /repos/{o}/{r}/branches/{b}` gives `commit.id`, `commit.message` and `commit.timestamp`; 404 when there is no such branch, including in an empty repository. | swagger `Branch`, `PayloadCommit`; probe |
| `GET /repos/{o}/{r}/git/trees/{sha}?recursive=true&page=&per_page=` takes a commit's id. It pages: at most `[api] DEFAULT_GIT_TREES_PER_PAGE` entries (1000) a page, with `total_count`. **Forgejo sets `truncated: true` on every page once there is more than one page, the last included; past the end `tree` is `null`.** Gitea sets it only while more follow. So annai pages by `total_count`. | Forgejo and Gitea `services/repository/files/tree.go`; probe |
| `GET /repos/{o}/{r}/git/blobs/{sha}` leaves out the content of blobs over `[api] DEFAULT_MAX_BLOB_SIZE` (10 MiB): Forgejo answers `content: ""`, Gitea `content: null`. So annai reads files with `GET /repos/{o}/{r}/media/{path}?ref=<commit>`, which also follows Git LFS. | `modules/setting/api.go`; probe (11 MiB and 30 MB blobs) |
| `GET /repos/{o}/{r}/git/commits/{sha}?stat=false&verification=false&files=false` gives `commit.message`; 404 for an unknown id. annai reads it before a restore, to refuse a part. | swagger; probe |
| `GET /repos/{o}/{r}/commits?sha=<branch>&limit=&page=&stat=false&verification=false&files=false` lists commits, at most `[api] MAX_RESPONSE_ITEMS` (50) a page; 409 "Git Repository is empty." for an empty repository. | swagger; probe |
| **ChangeFiles**, `POST /repos/{o}/{r}/contents` with `{ branch, message, files: [{ operation: create \| update \| delete, path, content (base64), sha }] }`, makes one commit on top of the branch's head at that moment. There is no top-level `sha` or base commit in the request. It works on an empty repository (no first commit needed); there, the first commit on any branch makes that branch the repository's default. | swagger `ChangeFilesOptions`, `ChangeFileOperation`; `services/repository/files/update.go`; probe |
| **The guard against a stale base:** an `update` or `delete` names the file's current blob id, checked against the branch head at that moment: a stale one is 409 on Forgejo ("sha does not match"), 422 on Gitea. Forgejo refuses an update without the id (422); Gitea takes one, checking it against the head as it is then, so annai always sends the id. `create` of a file that exists is 422; an update or delete of a file that isn't there is 500 on Forgejo, 404 on Gitea. Every backup changes `annai-archive.json` (it holds the time it was made), so a backup another device made meanwhile always fails this check. | `handleCheckErrors` and `handleCreateOrUpdateFileError` (Forgejo), `handleChangeRepoFilesError` (Gitea); probe |
| **Two at the very same moment:** both pass the checks against the same head, and the commit is pushed without force, so only one lands. The other is refused with **403**: Forgejo's "PushRejected … ! [remote rejected] … (incorrect old value provided)", Gitea's "cannot lock ref 'refs/heads/main': is at … but expected …". So annai reads the branch again after any refusal, whatever its status: if it moved, that is another device's backup. | probe (two requests released together, five times on each server) |
| Within one request the checks run against the head, not the request: a `create` under a file the same request deletes is refused (422 "a file exists where you're trying to create a subdirectory"). annai deletes such files in an earlier commit. | `handleCheckErrors`; probe |
| ChangeFiles' answer repeats each file's content in base64, up to 10 MiB a file (larger: `""` on Forgejo, `null` on Gitea). | `GetFilesResponseFromCommit`; probe |
| No limit on the request's size in Forgejo itself (a 30 MB request worked). A proxy in front often has one (nginx: 1 MB unless `client_max_body_size` is raised). Forgejo's quota answers 413 `{"message":"quota exceeded"}`, checked before the request against what is already used. | probe; `context.EnforceQuotaAPI` in Forgejo's `routers/api/v1/api.go` |
| An archived repository answers 423. | swagger; probe |
| **Git LFS:** on a server that runs LFS (`[server] LFS_START_SERVER = true`), ChangeFiles commits a file `.gitattributes` gives `filter=lfs` as an LFS pointer (`version https://git-lfs.github.com/spec/v1`, `oid sha256:<content's SHA-256>`, `size <n>`, about 130 bytes), and keeps the content in LFS. Forgejo reads the attributes from the branch as it was; Gitea also from a `.gitattributes` in the same request. `/media` gives the content, `/raw` the pointer (Gitea). So annai compares such a file by its pointer's id: a photo kept in LFS isn't sent again with every backup. | probe (2026-10-18, both servers with LFS on; annai's put twice: the photo went once) |
| CORS: `[cors] ENABLED = true` and `ALLOW_DOMAIN = <origin>` in app.ini. `Authorization` is always allowed; `HEADERS` adds to it (default `Content-Type`, `User-Agent`). The default methods cover GET and POST. Error answers carry the CORS headers too. Without it, a preflight gets 405 and answers carry none. Codeberg allows every origin. The user's server allows `Authorization`, `Content-Type` and `Accept` only, so annai sends no other header. | `modules/setting/cors.go`, Forgejo `routers/api/shared/middleware.go`, Gitea `routers/api/v1/api.go`; probe; codeberg.org; the coordinator |

## Owner and repository left empty (the user's ask, 2026-10-18)

Measured on throwaway Forgejo 16.0.6-rootless and Gitea 28.2.0 containers, with tokens made inside them. A user `me` with private repositories (one archived), a public one, a private repository of another user where `me` is a collaborator with write, one where `me` may only read, and an organization's private repository where `me` is a collaborator with write.

| Fact | Probe |
|---|---|
| `GET /api/v1/user` (and `/user/repos`, `/users/{u}/repos`) need `read:user`. A token with only `write:repository` gets **403** "token does not have at least one of required scope(s): [read:user]" on both. | both servers |
| `GET /api/v1/repos/search` needs only `read:repository` (so `write:repository` works); a token with only `read:user` gets 403. A token the server doesn't know gets 401. | both servers |
| The search lists every repository the user may see: their own, ones shared with them, organizations', and public ones. `is_private=true` keeps only private ones and `archived=false` leaves out archived ones; `private=true` doesn't filter. `q` matches part of the name. Each comes with `private`, `archived`, `mirror`, `owner.login`, `name` and `permissions.push`. Answers are `{ ok, data }`, sorted by name, at most 50 a page, with `X-Total-Count`. | both servers |
| `permissions.push` is the user's permission on the repository, not the token's: a `read:repository` token shows `push: true` too (its ChangeFiles is refused with 403, as before). A collaborator who may only read gets `push: false`. | both servers |
| `owner.type` ("User", "Organization") is there on Gitea only. | both servers |

So annai finds an empty owner or repository with the search (`is_private=true&archived=false`, page by page until a page is short, since browsers can read `X-Total-Count` only when the server exposes it), keeping those with `push`, not a mirror, and matching what the user typed. It asks `GET /user` first: with `read:user` the token's own account comes first; without it (the usual token), the 403 is passed over. One found is filled in and kept as the place's settings; several are listed for the user to pick (at most 20 shown); none says to create a private repository, `annai-backup` for example.

The core change it needs: a storage type's `check` may return `config` (what it filled in), which annai keeps as the place's settings, and a `TargetError` may carry `choices`, which the place's screen shows as buttons.

## Decisions

- **Pace: the git places', after changes within the hour** (`stores: 'tree'`), not S3's and WebDAV's six hours. A backup here sends only what changed, like GitHub's, and a self-hosted server has no rate limit to stay under. The six hours exist for places that take a whole archive file each time.
- **Large files and large backups.** One request carries at most 8 MiB of files and 200 files (the server runs git once or twice per file); a larger backup goes as several commits.
  - Only the last commit holds the new `annai-archive.json`, and only its message starts "annai backup". The ones before it say "Part of an annai backup from …", so they are never listed as backups or restored.
  - A backup cut off half way leaves its parts on the branch. The backups listed are still whole ones, and the next try builds on the parts, sending only what is still missing.
  - A 413 from the server or a proxy, or a request the browser couldn't make while the server still answers, is sent again in halves. A single file that still can't go stops the backup with its name, its size and what to raise.
  - Files over 100 MB are refused, as on GitHub.
- **Share or duplicate:** `git.js` is copied, not shared (see Architecture). index.js shares no code with the GitHub place: its requests, paging, commits and errors all differ.
- **Repository:** the user makes it in the web UI first; a token with Repository: Read and write is all annai asks for. A branch that doesn't exist yet is made only in an empty repository, and then becomes its default branch.
- **Finding the newest backup:** annai looks through the branch's last 2,000 commits, past parts and commits made by hand, so a very large backup cut off half way (more than 250 parts) doesn't hide the one before it. A part is never listed, and a restore refuses one.

## Tests (test-first)

- `test/unit/fake-forgejo.test.js`: the stand-in answers as Forgejo does.
- `test/unit/storage-forgejo.test.js`: the first backup, an incremental one, a restore, paging, another device, public refused, 401/403/404/409/413/423, no CORS, the token in nothing posted or kept, large backups in parts.
- `test/e2e/backups-forgejo.spec.js`: in both browsers, set up, back up, change, back up, erase, restore.
- By hand: the same plugin against a throwaway Forgejo 16.0.6 container.
