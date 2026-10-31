# Source control and folder checkpoints

**Plan:** `2026-10-27-git-source-control-and-checkpoints`. Two features share one
right rail and two pure engines; this document is the architecture reference for
both. The user-facing guide is [`../guide/git-and-checkpoints.md`](../guide/git-and-checkpoints.md).

## The two engines

| Module               | Job                                                                                                       | Depends on                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/git/**`         | Read a repository (`repo`, `status`, `diff`) and run one validated action from a closed union (`service`) | an injected `GitRunner`; nothing else                          |
| `src/checkpoints/**` | Snapshot an arbitrary folder into a **shadow** repository, list/restore/prune it                          | an injected `GitRunner`, a `CheckpointFs`, a `CheckpointTrash` |

Neither imports `electron` (`tests/architecture/no-electron-in-core.test.ts` adds
both to `CORE_DIRS`), neither reads `node:fs` directly (the Node adapters live in
`src/git/runner.ts` and `src/checkpoints/fs.ts`), and neither is allowed to throw
across the IPC boundary: a failure is a **value** with a code and a fix sentence.

Two services sit above them in main and are equally Electron-free, because
everything platform-shaped arrives as a port:

| Service                          | Ports it needs                                                           |
| -------------------------------- | ------------------------------------------------------------------------ |
| `src/main/git-service.ts`        | `isFocused()` — polling pauses while the window is unfocused             |
| `src/main/checkpoint-service.ts` | `attachedPanes()`, `tabs()`, `safeMode()`, `fingerprint()`, `onChange()` |

`src/main/index.ts` is the only place those ports are implemented
(`BrowserWindow.isFocused`, the live Office registry, the tab table,
`window-all-closed` teardown).

## Never touch the project's `.git`

A checkpoint is a commit in a **bare repository under the Pi profile**:

```text
<profileDir>/checkpoints/<basename>-<8 hex>/     a bare git repo
<profileDir>/checkpoints/config.json             the projected settings
```

Every invocation is `git --git-dir=<shadow> --work-tree=<project> …`, so:

- a folder **with no repository at all** can be checkpointed (an Office folder, a
  pile of images) — there is no `.gitignore` to read and nothing to initialise;
- a folder **with** a repository is never written to by this feature: no index, no
  ref, no `info/exclude`, no hook.

`info/exclude` in the shadow repo carries the defaults — `~$*` (Office lock
files), `.~lock.*#`, `node_modules/`, `dist/`, `.DS_Store`, `*.tmp` — plus the
user's extra patterns from Settings. A non-git folder has no ignore file, so
without these a Word lock file would create a new "change" every snapshot.

### The work-tree sidecar

The shadow repo holds a `pi-work-tree` file naming the folder it snapshots. A
profile copied to another machine, or a folder renamed, would otherwise let a
restore check one project's commits out over another's files. `ensure()` refuses
to snapshot or restore when the sidecar disagrees with the folder, and the rail
states that reason (`work_tree_mismatch`) rather than showing an empty timeline.

## The private-index recipe

Two sessions in the same project snapshot the same shadow repo. A shared
`.git/index` would race, and a lock-and-wait would serialise the whole app, so a
snapshot never uses `git commit`:

```text
GIT_INDEX_FILE=<shadow>/pi-index-<token>
  read-tree <parent>                        (seed the index from the last commit)
  add -A --pathspec-from-file=- --pathspec-file-nul < <bounded scan>
  write-tree                                → tree sha
  commit-tree <tree> [-p <parent>] -m <metadata>
  update-ref refs/heads/main <new> <old>    (compare-and-swap)
```

`--pathspec-file-nul` keeps a path with a space, a quote or a newline intact;
the scan is bounded, so a 200k-file folder degrades instead of hanging.

**On CAS loss, the retry rebuilds.** Replaying `update-ref` with the same old
value cannot succeed, and a commit built against the stale parent would drop the
winner's tree. The retry re-reads the ref and re-commits the _same_ tree against
the new parent.

"Nothing changed" is decided by comparing the new tree with the parent's, never
from a commit exit code — a no-op commit is worse than no commit, because it
makes the timeline lie about how many snapshots exist.

## `git log` is the manifest

Each commit's message is a one-line JSON header:

```json
{
  "v": 1,
  "id": "<tree sha>",
  "kind": "run|manual|pre-op|pre-restore",
  "label": "…",
  "entryId": "…",
  "sessionId": "…",
  "files": 12,
  "skipped": 0,
  "note": null
}
```

That is what makes two writers safe: the host-side extension (run snapshots) and
main (manual, pre-op, pre-restore) append to the same log and both read it the
same way. `decodeCommitMetadata` returns `null` for anything that is not our
header, so a foreign commit, or a future format, is **skipped** rather than
crashing the timeline.

## Restore is never destructive

Restoring overwrites the working tree. Zed's issue #28676 is the cautionary
tale — a checkpoint restore with no undo of the undo. Three rules prevent it:

1. **A `pre-restore` snapshot is taken first**, and a restore whose safety
   snapshot fails is **aborted**. The rail receives that ref and turns it into a
   one-click **Undo restore**.
2. **A preview is mandatory.** The dialog groups _Will change_ / _Will be
   removed_ / _Untouched but open in Office_ before anything is written.
3. **Removing added files is opt-in.** Off by default, and when it is on, the
   files go to the OS trash (`shell.trashItem` through the injected port), never
   a bare delete.

`removeAdded` and `checkout-index` report **per-file** failures — a `.docx` held
open by Word cannot be written — and the restore continues, naming what it could
not do.

## Prune, and the suffix invariant

Three limits, oldest first: `maxPerSession` (default 100), `retentionDays`
(30) and `maxBytesPerProject` (2 GB). The newest checkpoint is never dropped,
even when it alone exceeds the budget.

`planPrune` orders candidates by `createdAt` **and then by log position**.
`createdAt` comes from git's `%ct`, which has one-second resolution, and a burst
of runs easily lands two snapshots in the same second — sorting on the timestamp
alone would then be free to drop the newest one. The log position is the real
chronology, so the store passes it.

Because the retained set is always a **suffix** of the log, dropping the oldest
commits needs nothing but moving the branch tip to the newest retained commit
(compare-and-swap, retried once on loss). Reachability then ends at that tip, and
`git gc --prune=now` reclaims the bytes. There is no `git replace` and no history
rewriting.

## Capture triggers

| Trigger       | Who                                             | When                                                                                                                                                       |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`         | the checkpoint extension, inside the agent loop | once per user prompt at Pi's `input` event (steer/follow-up included), before the prompt is processed; a Pi <1.4 host falls back to the first `turn_start` |
| `manual`      | the rail's _Snapshot now_                       | on click                                                                                                                                                   |
| `pre-op`      | the git engine's `preOpSnapshot` port           | immediately before a discard or a branch switch; a failure aborts the action                                                                               |
| `pre-restore` | the checkpoint service                          | immediately before a restore, or a `/rewind`                                                                                                               |
| idle scan     | `src/main/checkpoint-service.ts`                | while an Office pane is attached, **in the Office host session's folder**, that folder is idle, its fingerprint changed, and `scanIntervalMs` has elapsed  |

The idle scan exists because a tool hook cannot see Word save a document. Its
fingerprint is a bounded `stat` walk (count, max mtime, total bytes), not a
content hash: noticing the change must cost milliseconds on a 40 MB `.docx`.

**Its target is the Office host's folder only** (`officeHostProjectPath`, wired
in `src/main/index.ts` from the `office` tab that is not stopped). The bridge
publishes a document name and a `url_sha256:` id, never a path, so there is no
honest way to attribute a save to an arbitrary project. Scanning every folder the
rail had ever looked at meant that opening one workbook started collecting
"Office documents changed" checkpoints in unrelated projects. A folder is scanned
only when the host works in it _and_ the rail has asked about it (`interested`);
manual, pre-op and run snapshots are unaffected because their caller scopes them.

## The Source Control menu's three blocks

The menu body is three vertically stacked blocks, VS Code's shape, each owning
its own `overflow-y-auto`:

```text
┌ source-control-block   branch row · commit composer · collapsible Stashes
├─────────────── rail-splitter-top
├ changes-block          [pinned] Changes · [pinned] Staged Changes / Changes
├─────────────── rail-splitter-middle
└ history-block          [pinned] Commit History · the log
```

Three scrollers instead of one pinned header over one list, because a long change
list used to push the commit log off the bottom — scrolling to a commit scrolled
the changed files away. Neither list can now evict the other.

**Block headers are pinned** (2026-10-30 rail-headers plan). Each block's header
is the first child of its scroller, `sticky top-0` with an opaque `bg-surface`
and a `border-b` hairline, so the block's name, count and its one block-wide
control (_Refresh_) stay visible while the list scrolls. Both blocks render the
same `RailBlockHeader` primitive — two hand-rolled sticky headers would drift —
and `tests/architecture/rail-ownership.test.ts` keeps the rule in one place.
The header sits **outside** the `gap-1` column that holds the rows: a gap on the
scroll container would leave a transparent strip travelling under the header.

**Changes group headers are pinned too** (2026-10-30 copy/composer/theme/zoom
plan, amending the rail-headers plan's D2). `RailBlockHeader` is a fixed `h-7`
(28 px); the `Staged Changes` and `Changes` rows are `sticky top-7 z-[9]` with
the same opaque surface, so they pin directly under the block header while
their own group is in view. Both groups share the offset: scrolling into
_Changes_ lets its header replace _Staged Changes_ at the same position, the
way VS Code's sections behave. Collapsing a group leaves its header pinned.

**The Commit History block always has its header**, including when git is
unavailable: it then explains the state (`gitUnavailableMessage`) instead of
rendering nothing, because a titled block that vanishes is the same bug class as
a vanishing menu.

**Sizing** is two persisted fractions (`prefs.rail.split = { top, middle }`,
History being the remainder) so they always sum to 1. A drag calls
`railSplitWithDelta` from `src/shared/rail.ts`, which takes the container height
as an argument — jsdom has no layout, so the arithmetic is a node test rather
than a DOM one. Each boundary moves only its two neighbours: the top splitter
trades height between Source Control and Changes with History fixed, and the
middle splitter trades between Changes and History with Source Control fixed.

**Floors.** Every block may be at least `MIN_BLOCK_PX` (80 px) and at least
`MIN_SPLIT_FRACTION` (15 %) of the body. A panel shorter than three floors cannot
honour them; every block still scrolls internally, so content stays reachable
even at its floor, and `clampRailSplit` never produces a negative remainder.

**A render-time clamp is never written back.** The displayed split is clamped
against the height measured _now_, which differs per window size; persisting that
would silently rewrite the user's preference whenever the window was small. Only
an explicit gesture writes — a drag commits once on `pointerup` (never per
pixel), a keyboard nudge once per key, and `Home`/`End` go to the floors.

**Collapse** lives where it is cheap, not at block level: the `Staged Changes` /
`Changes` headers and the `Stashes` header each own an `aria-expanded` toggle
(`prefs.rail.collapsed`), with the group action as a **sibling** button so
_Stage all_ never doubles as a fold. Stashes start collapsed — three stashes used
to cost four rows in a column that also has to show changed files — while
_Stash changes_ stays outside the fold, because stashing is what you do while
looking at a change.

## Scope: folder, session, app

The three rail menus act on two scopes, and the panel header names the folder it
is showing in its `title`. There is no per-menu scope row (2026-10-30
project-scoped rail plan): the rail is app chrome scoped to the **selected
project**, so the panel and the sidebar cannot disagree.

| Menu           | Scope                     | Where the truth lives                                | How to switch                                     |
| -------------- | ------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| Source Control | the rail's project folder | `state.git[folder]`; main polls that folder          | select a project, or click a session in it        |
| Checkpoints    | the same project folder   | `<profile>/checkpoints/<basename>-<hash>` per folder | select a project; rows keep the per-session chips |
| Documents      | the app-wide bridge       | one bridge on port 38617, owned by the `office` tab  | _Open host session_, _Use this session instead_   |

Selecting a project jumps to its most recently active **open** tab (never a
saved-but-closed session, and never a `web` tab); a project with no open tab
clears the active selection so Welcome shows while the rail keeps that project's
source control and checkpoints.

The **Changes** block opens with its pinned header — the title, the combined file
count, and an icon-only _Refresh changes_ button — followed by the two collapsible
lists. A clean tree renders no paragraph: the count already says 0. The
**Commit History** block has the same shape (title, loaded-commit count, refresh)
and reloads page one rather than the current cursor.

The **commit box** keeps only the message, the meta row and the button. A
blocking condition (nothing staged, no message, no git identity, an over-long
message) is explained at the moment the button is pressed, as a notification; the
button stays pressable and carries the reason in its `title` and `aria-disabled`,
so no row is spent on a standing warning.

Checkpoints is deliberately folder-wide rather than per-session: the store is per
folder, and hiding older folder state behind a session filter would make a
restore from a new session look impossible. The existing _This session_ /
_Before the fork_ chips carry the session linkage instead.

## The host-side extension

`src/extensions/pi-checkpoints.ts` is a normal Pi extension with one source and
three load paths:

- **bundled** — `additionalExtensionPaths` on the host's resource loader;
- **profile clone** — `<profile>/extensions/checkpoints/index.mjs`, discovered by Pi;
- **npm package** — `<profile>/npm/node_modules/@dieulc/checkpoints`, discovered by Pi.

The host resolves **profile → npm → bundled** (`src/host/checkpoint-extension.ts`)
and only passes the bundled path through `additionalExtensionPaths`. An installed
copy therefore wins, and the bundled copy never loads alongside it. The npm
package is `@dieulc/checkpoints`; the unscoped `pi-checkpoints` name belongs to
another author. Development can still use
`npm run build:extension && pi install path:<repo>/dist/pi-checkpoints`.

### Safe mode does not disable `additionalExtensionPaths`

This is the one non-obvious rule in the whole feature. The SDK builds its
extension list as

```js
// node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js
extensionPaths = this.noExtensions
  ? cliEnabledExtensions
  : this.mergePaths(cliEnabledExtensions, enabledExtensions);
```

and `cliEnabledExtensions` **is** the `additionalExtensionPaths` list. Merging our
path into the safe-mode object would therefore keep loading it and quietly break
the "zero third-party code" promise. `checkpointExtensionLoaderOptions` in
`src/host/safe-mode.ts` makes the two branches mutually exclusive, and
`tests/host/safe-mode.test.ts` asserts both **as values**.

The host reports `capabilities.checkpointsExtension` and
`capabilities.checkpointExtensionSource` (`profile`, `package`, `bundled`, or
null) on `host.hello`; a stale host answers nothing, which the rail reads as
"automatic snapshots are unavailable" (never as silence).

### Structural types, not an SDK import

The extension imports **neither** `@earendil-works/*` nor `electron`. It declares
the narrow `CheckpointExtensionApi` it uses, the same way
`src/renderer/src/completion/types.ts` and `src/shared/model-scope.ts` mirror
theirs. AGENTS rule 4 is the first reason; the second is that
`dist/pi-checkpoints/index.mjs` has to load with **no `node_modules` beside it**,
and a real SDK import would make that impossible. A test greps the import
specifiers to keep it true.

## Configuration: one writer

`prefs.checkpoints` (validated in `userData/app-state.json`) is the source.
Main **projects** it to `<profileDir>/checkpoints/config.json` on every change
(`projectConfigFromPrefs`), and the extension only ever reads that file — at each
snapshot, so a toggle applies without a host restart. Two writable copies would
drift; this is why there is no second store.

A malformed config file is **reported and kept** (AGENTS rule 5). Main falls back
to the defaults for that read; the next explicit prefs change replaces it.

## Trust boundaries

- **Folders.** The IPC layer resolves a renderer-supplied path against the open
  tab cwds plus the remembered projects (`requireProjectPath`). `..` paths,
  unknown folders and Windows spelling differences are all covered by
  `tests/main/ipc.test.ts`.
- **Actions.** `parseGitAction` and `parseCheckpointAction` are closed unions. A
  ref must be a full 40-hex sha, so `--hard` cannot be smuggled through.
- **Credentials.** git's own. `GIT_TERMINAL_PROMPT=0` means a missing credential
  fails fast with git's message and a copy-paste hint instead of hanging the UI.
  No secret enters the app.
- **Diagnostics.** The bundle names repositories and checkpoint folders, and
  **redacts an identity email** — the rail shows `Name <email>`, the bundle shows
  `Name <***@***>`. Every other redaction pattern in `redactSecrets` is key- or
  prefix-shaped and would never match a bare address.
