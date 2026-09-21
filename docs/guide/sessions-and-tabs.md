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
  (remembered per session, default from the message-delivery settings). Queued
  messages appear as chips.
- **Stop** (or `Esc`) clears the queue, aborts the run and restores the
  interrupted text into the composer — the same recipe terminal Pi uses.
- Drafts are kept per tab, so switching tabs or restarting the app does not lose
  an unfinished prompt.
- Paste or drop images to attach them; they are downscaled in the renderer and
  passed to the model as inline image content.

## Related

- [Projects](projects.md) · [Models and thinking](models-and-thinking.md)
- [Getting started](getting-started.md) · [FAQ](faq.md)
