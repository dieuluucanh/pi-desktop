# Git and checkpoints in the panel rail

The **panel rail** is docked to the right edge of a session, the way VS Code's
activity bar is. An always-visible vertical strip carries three menus —
**Source Control**, **Checkpoints** and **Documents** — and clicking one expands
its panel beside it; clicking the active one collapses the panel back to the
strip. <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> (rebindable in Settings →
Shortcuts) toggles the panel, and Go → Source Control / Checkpoints / Documents
opens a specific menu.

The strip's order is yours: drag an entry to a new position. The order, the last
menu you opened and the panel's width are remembered per app.

## The Source Control menu

The menu is **three blocks**, stacked, each with its own scrollbar:

1. **Source Control** — the branch row, the commit box and Stashes.
2. **Changes** — _Staged Changes_ and _Changes_.
3. **Commit History** — the log.

Because each block scrolls on its own, a long change list can no longer push the
history off the bottom (and scrolling to a commit cannot scroll your staged files
away). Drag the divider between two blocks to give one more room; double-click a
divider to reset. With the divider focused, <kbd>↑</kbd>/<kbd>↓</kbd> nudge it,
<kbd>Shift</kbd> nudges further, and <kbd>Home</kbd>/<kbd>End</kbd> jump to the
extremes. No block can shrink below a readable 80 px, and the split is remembered
across launches.

The top block, one row at a time:

- **The branch row** — the branch name is the switch button (or _detached @ sha_,
  or _no commits yet_), `↑n ↓n` beside it, then Fetch, Pull and Push as icons.
  Their tooltip names the target. A line appears underneath **only** when
  something is unavailable ("no upstream", "no remote is configured").
- **A sync in progress, and its outcome** — the running verb shows a spinner and
  all three verbs are disabled while it runs. A status line directly under the
  branch row says _Pushing to origin/main…_, then _Pushed._ or the failure with
  its fix; a failed line offers _Retry_ and every line can be dismissed. The
  same outcome arrives as a notification, so it is visible even if the panel is
  scrolled or another menu is open. A network call that runs past its timeout
  says so ("git timed out after 120 s") rather than reporting an exit code.
- **The commit box** — a message that grows up to ten rem and then scrolls,
  <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> to commit, the counter and the identity it
  will use (hover it for the config file it came from), and a <kbd>⋯</kbd> menu holding
  _Amend last commit_ (which prefills the previous message) plus _Change_ /
  _Set identity_.
- **Stashes** — collapsed by default, with the count and _Stash changes_ still
  visible in the header. Open it for _Restore_ and _Drop_; dropping asks first,
  since the entry is deleted.

_Staged Changes_, _Changes_ and _Stashes_ each fold away when you click their
header, and the fold is remembered. _Stage all_ / _Unstage all_ are separate
buttons, so bulk-staging never folds the list you are working through. The
_Staged Changes_ and _Changes_ rows stay pinned under the block header while
their files scroll, so the list you are working in is always named.

The **Changes** block opens with its own header: the title, the combined count,
and an icon-only refresh at the right. A clean tree shows just that header — the
count says 0, so nothing spends two rows explaining an empty list.

The rail is scoped to the **project you selected** in the sidebar, not to
the tab that happens to be on screen. Selecting a project jumps to its most
recently active open session; selecting a session selects its project. The panel
header shows the folder's name beside the menu title; hover it for the full path.

_Commit_ stays pressable even when something is missing. It explains what (stage
something, write a message, set a git identity) only when you press it, as a
notification, instead of printing a standing warning above the button.

## What it needs

- **Changes / History / Git** need `git` on your `PATH`. It is not bundled with
  the app — it resolves from the same `PATH` your terminal uses.
- **Checkpoints** need `git` too, but the folder does **not** need to be a
  repository. That is the point: it works in an Office folder.

If git is missing, every git and checkpoint surface says so, with instructions.
Nothing fails silently.

## Changes and History

- **Changes** shows two collapsible groups, _Staged Changes_ and _Changes_, with
  `M`/`A`/`D`/`R`/`U` badges, a per-file hover menu (stage, unstage, discard, open
  diff), and group-level _Stage all_ / _Unstage all_. A discard of a tracked file
  is a `git checkout --`; a discard of an **untracked** file moves it to the OS
  trash, not to oblivion.
- **History** lists commits, newest first, with _Load more_. Clicking one opens
  its diff. The list reloads itself when the repository moves — a new commit, a
  fetch, a push or a branch switch — so _Refresh_ is only for forcing a re-read.
  The branch and tag chips are git's own decorations: `origin/main` appears on a
  commit only when the upstream actually points at it, never on an unpushed tip.
  Remote-tracking refs are highlighted in cyan, so the upstream stands out from
  the accent-coloured current branch and the neutral tags.
- **Stashes** (collapsed until you open it, or until you use _Stash changes_)
  lists what is parked, with _Restore_ and _Drop_.
  **Hunk staging.** The diff viewer renders each hunk with _Stage hunk_ (for a
  working file) or _Unstage hunk_ (for a staged one). A binary file shows one
  "binary file changed" row with _Reveal in file manager_.

**Writes run directly.** Like VS Code, the button you press is the intent:
staging, unstaging, committing, stashing, creating or switching branches and
staging a hunk all act immediately. Destructive actions keep their own
confirmation instead — _Discard_ names the file (and moves an untracked file to
the system trash), _Drop_ asks before deleting a stash entry, and switching
branches with a dirty tree confirms first. Writing your git identity to
`.git/config` still requires the form's own checkbox. Network operations remain
explicit named buttons and never run on a timer.

**Authentication is git's.** `GIT_TERMINAL_PROMPT=0` means a missing credential
fails immediately with git's own message plus a hint, instead of a hidden prompt
that never appears. The app stores no credential, token or password.

Status is polled while a session tab is open **and** the window has focus, so a
background window costs nothing — the strip's changed-file count stays live even
when the panel is collapsed.

## Checkpoints: what they are

A checkpoint is a snapshot of the **whole folder** into a hidden git repository
under your Pi profile. It is not a commit in your project: your `.git`,
`.gitignore` and working tree are never touched, and a folder with no repository
works just as well.

When they are taken:

| Kind                        | When                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prompt (`run`)**          | automatically, once per user prompt, before it is processed (steer and follow-up included; from a Pi extension)                                        |
| **Manual**                  | when you press _Snapshot now_                                                                                                                          |
| **Safety (`pre-op`)**       | immediately before a discard or a branch switch — and if the snapshot fails, the action is refused                                                     |
| **Restore (`pre-restore`)** | immediately before any restore, so the restore is undoable                                                                                             |
| **Idle scan**               | while a Word/Excel/PowerPoint document is open in the app, a session in that folder is idle, and the folder changed (default: at most every 5 minutes) |

The idle scan is the only way to notice a document you saved in Word, because a
tool hook cannot see another application write a file.

## Checkpoints: restoring

Restoring overwrites files, so it is a three-step flow:

1. _Preview & restore…_ on a row.
2. The dialog shows **Will change**, **Will be removed** (with the exact files) and
   any target that is **open in Word/Excel right now** — close those first, because
   an open document cannot be written.
3. _Restore_. A safety snapshot is taken first; a restore whose safety snapshot
   fails does not happen at all.

Afterwards the section offers **Undo restore**, which puts back the state you had
just before restoring. **Removing files created after the checkpoint is opt-in**
(the checkbox is off by default) and always goes to the OS trash.

### What a checkpoint is not

- It is **not** a commit: nothing is staged, nothing enters your history, and no
  remote ever sees it.
- It does **not** capture your conversation. A prompt checkpoint records which
  turn it belongs to; `/checkpoint` in terminal Pi can use that. A prompt that never
  got a turn is kept as an unlinked, files-only checkpoint. The rail only labels
  the link.
- It is **not** a backup: the bytes live on the same disk, in
  `<profile>/checkpoints/`.

## Retention and disk use

Defaults: **100 checkpoints per folder, 30 days, 2 GB per folder**, files over
25 MB skipped and counted. The newest checkpoint is never pruned, even when it
alone is bigger than the budget.

The section's footer shows the current usage and offers _Prune now…_. Settings →
Checkpoints sets the limits and the extra ignore patterns (the Office lock files
and `node_modules/` are ignored by default).

Only the recent checkpoints of a folder are cheap: git stores unchanged files
once, so the ten snapshots of a mostly-unchanged folder are far smaller than ten
copies.

## `/checkpoint` in terminal Pi

Pi Desktop bundles the extension, so no install is needed there. Terminal Pi
users install the published package:

```bash
pi install npm:@dieulc/checkpoints
```

Update it with `pi update --extensions`; remove it with
`pi remove npm:@dieulc/checkpoints`. A development checkout can use
`npm run build:extension && pi install path:<repo>/packages/checkpoints`.

The host prefers an installed profile/npm copy over the bundled one, so the
extension never loads twice. Pick **one** installed copy — a profile copy or the
npm package, not both. The `~/.pi` dotfiles clone no longer contains this
package; install the npm package if you want folder checkpoints in terminal Pi.

If you already have `0.1.1` installed, update it (`pi update --extensions`) before
relying on `/checkpoint`: Pi Desktop prefers the installed copy over its bundled
extension, and `0.1.1` still registers the old command name.

`/checkpoint` lists this session's checkpoints and offers **Files and
conversation**, **Files only** or **Conversation only** (unlinked prompts are
Files only). It takes a safety snapshot before restoring files, exactly as the
rail does, and it reads the same shadow repository — so a checkpoint taken by the
app appears in terminal Pi and vice versa.

`@dieulc/workflow` keeps its older `/rewind` command for git-backed message and
tracked-file restore. That implementation uses its own shadow repository under
`<profile>/checkpoints/checkpoint-<slug>.git`; it is separate from the folder
store above.

## Safe mode

Safe mode hard-disables the checkpoint extension, so **automatic** snapshots do
not happen. Manual snapshots, the pre-op hook and restores still work, and the
section says so. Safe mode's promise — zero third-party code loaded — is not
weakened by the app's own extension.

A session whose host predates the extension reports that too (_automatic
snapshots are unavailable_), rather than leaving you to wonder why no prompt
checkpoints appear.

## Where the bytes live

```text
<Pi profile>/checkpoints/
  config.json                       the projected settings (written by the app only)
  <folder-name>-<hash>/             one bare git repository per folder
```

The profile is `~/.pi/agent` by default; Settings → Profile shows the exact path,
and an app-private profile keeps them under the app's data folder instead.

`config.json` is derived from the app's own preferences: editing it by hand works
until the next time you change a checkpoint setting, which rewrites it.
