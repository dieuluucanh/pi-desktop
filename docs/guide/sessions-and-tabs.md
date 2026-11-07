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
  reorder (drag) and a right-click menu with fork/clone/export live on the tab.

Editor and web documents have their own tab rows. Sessions, the Office host and
web tabs stay in the top strip; file tabs appear in a second strip directly
under it, only while a file is open. Both rows share one active tab and both
scroll horizontally with the mouse wheel. The active tab is revealed when the
selection changes; a manual scroll position is kept across window switches and
tab status updates.

Right-click a tab — or press `Shift+F10` / the Menu key while its tab has focus —
for the lifecycle actions. The chip itself carries only its kind glyph, title and
×. Editor tabs add Copy Path (absolute), Copy Relative Path, Pin/Unpin, Close,
Close Others and Close All. Pinned tabs stay at the front, hide their X, survive
a relaunch and are skipped by Close All/Close Others. Close All/Close Others are
kind-scoped, so closing all sessions leaves editor, web and Office tabs open.
Removing a project closes every tab in that project, including pinned tabs.

Sessions are grouped by project in the sidebar; the group lists the same tabs as
the top strip (file tabs stay in the editor strip), and a running tab shows a
status dot.

## Working with several sessions at once (grid)

The window can show several tabs side by side. The grid replaces only the content
area — the tab strips, the sidebar and the panel rail stay where they are.

- **Choose a layout** with the icon-only layout button at the far right of the
  session tab strip, from **View → Layout** in the menu, or from the command
  palette: single, two columns, three panes (left tall), three panes (right tall),
  or four panes. Hover an icon to see its name. The icons run widest to
  narrowest: four panes on the left, single on the right.
- **Fill a pane** with its header chevron or, when it is empty, the centred `+`
  button. Both open the same list of your open **session tabs** grouped by
  project, your open **editor tabs**, then **Browse saved sessions…** to resume
  one straight into that pane. The menu always hangs from the header chevron;
  “Pick a session” and “or drop a tab here” are labels, not buttons — only the
  `+` opens the list.
- **Drag a tab** from either tab strip (or a session in the sidebar) onto a pane.
  From a single/solo view the remembered multi-pane layout appears faded while
  you drag, so you can drop into any pane; releasing outside cancels and restores
  the single view. Each tab can be in one pane only, so dropping a tab that
  another pane already shows swaps the two panes.
- **Click a pane** to focus it. The focused pane is the tab the menu, the palette,
  model/thinking cycling and the panel rail act on, so the rail follows a pane in
  another project.
- **Single and grid run in parallel.** Clicking a tab that no pane holds shows it
  full-size without forgetting the layout; clicking a tab that a pane holds
  returns to the grid. The **Single** preset is the same one-tab view and keeps
  every pane assignment, so choosing a multi-pane preset later restores the split.
- **Clear a pane** with the header `×`: it removes that tab from the pane without
  closing the session, and the pane shows “Pick a session” again. If it held the
  focused tab, focus moves to the next occupied pane; the grid stays on screen
  even when the last pane is cleared. The tab strip's `×` still closes the
  session itself.
- Closing a tab empties its pane (it shows “Pick a session”); the other panes and
  the layout keep running. The layout, the last multi-pane preset and every pane
  assignment are remembered across a relaunch.

Every visible pane keeps its session awake. Sessions in panes you are not looking
at still sleep after a long idle period, and wake on the next click or keystroke.
A background review/web tab does not steal the selection: it opens beside the
session and keeps that session's host protected while the review is open.

## Resuming and the session browser

Click the **History** button in the session strip (between **New terminal** and the
layout switcher), press `Ctrl/Cmd+Alt+O`, choose **Sessions…** from the app menu,
run `/resume`, or click **Browse saved sessions…** in an empty grid pane. The
browser opens on **This project** (the sessions saved for the folder you are in);
**All sessions** shows every project in the Pi profile. (`Ctrl/Cmd+Shift+O` is
**Open Project…**, not Sessions.) Sessions come from Pi’s own index, grouped by
project, newest first. The row of the session you are in is marked **Current**.
Each row shows its last activity in your local timezone;
an unreadable timestamp shows `—` instead of a fake 1970 date. Search runs in the
control host over the full transcript, not just the visible title: a word from an
old assistant message still finds its session. The host keeps that text out of
the UI process and returns a bounded page, so the browser may show “Showing N of
M matches — narrow the search” on very large profiles. **Refresh** re-reads the
profile; the host caches the listing for a few seconds while you type.

From there you can:

- **Resume** a session into a new tab (its full history loads). The browser
  closes as soon as you pick a row, so the tab appears immediately and shows its
  starting state while Pi reads the history in the background. Picking the
  **Current** session, or one already open in another tab, closes the browser and
  returns to that tab instead — one session file never runs two hosts, so its
  transcript can never be split between tabs;
- **Continue the most recent** session of a project — the same, once the host has
  found that project’s newest session (and a return to its tab when that session
  is the one you are in);
- **Rename** or **delete** a stored session — deletion goes to the OS trash, is
  validated against Pi’s index in the host and contained to the profile in the
  main process, and is recoverable;
- **Copy Path** from a tab’s right-click menu, the sidebar `…`, or a row in the
  browser to put the absolute session JSONL path on the clipboard (the item is
  disabled until a new session has persisted its first message), ready to paste
  into the composer;
- see sessions created by **terminal Pi** — they are the same files.

Picking a session never waits for the host: the dialog closes on the click and the
new tab reports its own progress. If that resume fails (a deleted file, a crashed
host), the browser stays closed and the reason appears in the status bar; the tab
remains in the strip so it can be restarted or closed. Tabs persisted by an older
build that point at one session file are collapsed to a single tab on the next
launch, keeping the most recently used one.

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
- The box grows with your text up to about nine lines, then scrolls; it has no
  manual resize handle.
- While the agent is streaming, Enter **steers** the current turn. `Ctrl+Q` /
  `Alt+Enter` queue a **follow-up** instead. Queued messages appear as pending
  rows above the composer labelled **Steering** / **Follow-up**; `Alt+Up`
  restores them all into the draft ("restore all"), and a Settings queue-mode
  change applies to open sessions without a reload.
- `!command` runs a shell command in the session folder (streamed into the
  transcript, `Esc` cancels it); `!!command` keeps it out of the model's context.
  The composer shows a **shell** chip and a `! shell` hint. Unlike `/`, `@` and
  `#`, a shell line has no built-in completion menu (matching terminal Pi); an
  extension that provides `!` autocomplete still works. Commands are
  non-interactive: `git status`, `git add`, `git push -u origin main` work with
  configured credentials, but a password/TUI prompt needs a real terminal.
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
- `↑` recalls prompts already sent in this tab, newest first; `↓` walks forward
  and returns to the draft (and caret) you had when you started. Editing a
  recalled prompt — or sending it — ends history mode and adopts the visible
  text, exactly like terminal Pi. History is rebuilt from the session when a tab
  loads, so it survives an app restart and includes sessions created in terminal
  Pi; prompts sent in the current run stay on top. A command prompt is recalled
  as the command you typed when the app knows it. After a compaction only the
  prompts still in the active context remain (same as terminal Pi), and `!`
  shell commands are only in the current run.
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
