# Sessions and tabs

A **session** is one conversation with the agent, stored as JSONL in the Pi
profile. A **tab** is the app's handle on a session: each session tab owns its
own Pi host process, so tabs run in parallel and one crash does not disturb the
others.

## Creating and closing

- **New session**: `Ctrl/Cmd+N`, the title-bar button, or the sidebar’s **+ New
  session**. A project must be open first; without one the app says so instead of
  doing nothing.
- **Close**: the tab’s × or `Ctrl/Cmd+W`. Closing a tab stops its host.
- **Close others**, **duplicate** (a fresh session in the same project), rename,
  reorder (drag) and an overflow menu with fork/clone/export live on the tab.

Sessions are grouped by project in the sidebar; a running tab shows a status dot.

## Resuming and the session browser

`Ctrl/Cmd+Shift+O` opens the **Sessions** browser, also reachable with `/resume`.
It lists every session of the profile from Pi’s own index, grouped by project,
searchable by title or first prompt, newest first.

From there you can:

- **Resume** a session into a new tab (its full history loads);
- **Continue the most recent** session of a project;
- **Rename** or **delete** a stored session — deletion goes to the OS trash, is
  validated against Pi’s index in the host and contained to the profile in the
  main process, and is recoverable;
- see sessions created by **terminal Pi** — they are the same files.

## History tree, fork and clone

- `/tree` (or the View menu) opens the conversation tree: branch navigation,
  entry labels, and **fork from an entry**.
- `/fork` — fork from an earlier user message.
- `/clone` — clone the current session and switch to the copy.
- `/export` — export the session to a self-contained HTML file and reveal it.

Navigation and forking re-hydrate the transcript from the session file, so the
view always matches what the SDK recorded.

## Recovery

Each tab remembers its session file. If a host crashes, the supervisor restarts
it and re-issues `session.resume`; the tab shows a **Restart** banner and emits a
“session recovered” notice. Diagnostics lists host logs, incidents and extension
errors if you need to dig in — see [Troubleshooting](troubleshooting.md).

## Crash-free persistence

Tabs, order and the active tab are stored in app state and restored on launch,
but **no host is spawned until a tab is activated**. The most recently used tab
is warmed in the background so the first session is fast.

## Composer

The composer is a plain text area with Pi’s autocomplete contract:

- `Enter` sends, `Shift+Enter` inserts a newline; IME composition is respected.
- While the agent is streaming, sending offers **Steer** or **Follow-up**
  (remembered per session, default from the message-delivery settings).
  `Ctrl+Q` / `Alt+Enter` always queue a follow-up. Queued messages appear as
  pending rows above the composer labelled **Steering** / **Follow-up**;
  `Alt+Up` restores them all into the draft ("restore all"), and a Settings
  queue-mode change applies to open sessions without a reload.
- `!command` runs a shell command in the session folder (streamed into the
  transcript, `Esc` cancels it); `!!command` keeps it out of the model's context.
- A large paste collapses to `[paste #1 +240 lines]`; the body stays in memory
  and is expanded when sent. After a restart the marker says its content is lost
  rather than sending the token.
- `Ctrl+G` opens the expanded editor; a configured `externalEditor` (or
  `$VISUAL`/`$EDITOR`) is also offered and awaited. Terminal editors need a TTY
  the app does not have.
- `Ctrl+F` searches the transcript (all matches, next/prev, regex with `.*`);
  scrolling up while a response streams stops auto-follow and offers
  **Jump to latest** (`Ctrl+End`).
- **Stop** (or `Esc`) clears the queue, aborts the run and restores the
  interrupted text into the composer — the same recipe terminal Pi uses.
- Drafts are kept per tab, so switching tabs or restarting the app does not lose
  an unfinished prompt.
- Paste or drop images to attach them; they are downscaled in the renderer and
  passed to the model as inline image content.

## Sessions on disk, sharing and bug reports

- `/session` shows the file, id, model, context and the full token breakdown
  (input/output/cache read/write, cost), plus queue modes and automation state.
- `/copy` (or `Ctrl+X` outside an editor) copies the last assistant answer.
- `/export` writes a standalone HTML page; `/export jsonl` writes Pi's own
  session JSONL and reveals it. `/import [path]` opens a JSONL picker and asks
  before replacing the open conversation.
- `/share` uploads a **secret gist** (unlisted, not private — anyone with the
  link can read it) through GitHub's `gh` CLI and opens Pi's viewer URL. Keys and
  tokens are redacted first. `gh auth login` must include the gist scope; a
  missing `gh` offers "Export HTML instead".
- `/bug [what happened]` writes a local zip with versions, diagnostics, a
  non-LLM summary and (optionally) the redacted transcript, then reveals it.
  Nothing is uploaded from this build; Radius upload is not wired.
- `/changelog` shows the Pi changelog, `/hotkeys` the shortcuts dialog and
  `/quit` closes the session tab.

## Related

- [Projects](projects.md) · [Models and thinking](models-and-thinking.md)
- [Getting started](getting-started.md) · [FAQ](faq.md)
