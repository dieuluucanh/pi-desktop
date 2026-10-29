# Git and checkpoints in the right rail

The **right rail** is one resizable column with five collapsible sections: **Git**,
**Changes**, **History**, **Checkpoints**, **Documents**. Open it with the panel
button in the session header, or <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>
(rebindable in Settings → Shortcuts), or View → Source Control / Checkpoints.

Its width and which sections are open are remembered per app.

## What it needs

- **Changes / History / Git** need `git` on your `PATH`. It is not bundled with
  the app — it resolves from the same `PATH` your terminal uses.
- **Checkpoints** need `git` too, but the folder does **not** need to be a
  repository. That is the point: it works in an Office folder.

If git is missing, every git and checkpoint surface says so, with instructions.
Nothing fails silently.

## Git, Changes and History

- **Changes** shows two groups, _Staged Changes_ and _Changes_, with `M`/`A`/`D`/`R`/`U`
  badges, a per-file hover menu (stage, unstage, discard, open diff), and
  group-level _Stage all_ / _Unstage all_. A discard of a tracked file is a
  `git checkout --`; a discard of an **untracked** file moves it to the OS trash,
  not to oblivion.
- **The commit box** (inside Changes) takes a message, <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>
  to commit, an _Amend_ switch that prefills the previous message, and the
  identity it will use. When no identity is configured, the commit button is
  disabled and an inline form offers to write `user.name`/`user.email` **for this
  repository only** — the global variant is shown as a hint, never run behind
  your back.
- **History** lists commits, newest first, with _Load more_. Clicking one opens
  its diff.
- **Git** shows the branch (or _detached @ sha_, or _no commits yet_), `↑n ↓n`
  against the upstream, the remote, and stashes. _Fetch_, _Pull_ and _Push_ are
  three buttons that name their target; they are disabled without an upstream.

**Hunk staging.** The diff viewer renders each hunk with _Stage hunk_ (for a
working file) or _Unstage hunk_ (for a staged one). A binary file shows one
"binary file changed" row with _Reveal in file manager_.

**Consent.** Mutating git commands are gated once per session: staging, committing,
discarding, branching and stashing ask the first time and remember the answer.
Network operations are always explicit named buttons and never run on a timer.

**Authentication is git's.** `GIT_TERMINAL_PROMPT=0` means a missing credential
fails immediately with git's own message plus a hint, instead of a hidden prompt
that never appears. The app stores no credential, token or password.

Status is polled only while the rail is open **and** the window has focus, so a
closed panel costs nothing.

## Checkpoints: what they are

A checkpoint is a snapshot of the **whole folder** into a hidden git repository
under your Pi profile. It is not a commit in your project: your `.git`,
`.gitignore` and working tree are never touched, and a folder with no repository
works just as well.

When they are taken:

| Kind                        | When                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Run**                     | automatically, once per agent run, before the model edits anything (from a Pi extension)                                                               |
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
- It does **not** capture your conversation. A _run_ checkpoint records which
  session entry it belongs to, and `/rewind` in terminal Pi can use that; the rail
  only labels it.
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

## `/rewind` in terminal Pi

The same extension ships as an installable package:

```bash
npm run build:extension            # in the Pi Desktop repository
pi install path:<repo>/dist/pi-checkpoints
```

`/rewind` lists this session's checkpoints and offers **Files and conversation**,
**Files only** or **Conversation only**. It takes a safety snapshot before
restoring files, exactly as the rail does, and it reads the same shadow repository
— so a checkpoint taken by the app appears in terminal Pi and vice versa.

## Safe mode

Safe mode hard-disables the checkpoint extension, so **run** snapshots do not
happen. Manual snapshots, the pre-op hook and restores still work, and the section
says so. Safe mode's promise — zero third-party code loaded — is not weakened by
the app's own extension.

A session whose host predates the extension reports that too (_run snapshots are
unavailable_), rather than leaving you to wonder why no run checkpoints appear.

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
