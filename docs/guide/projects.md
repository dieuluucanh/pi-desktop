# Projects

A **project** is a folder a session runs in. Pi reads `AGENTS.md`, `.pi/`
configuration, extensions, skills and prompts from it, so the folder — not the
window — is the unit of context.

## Adding a project

- **Open project folder…** — native folder picker. The folder is added to the
  sidebar’s recent list and becomes active.
- **New default project** — one click creates a dated folder
  (`2026-11-03T10-15-42`) inside your OS Documents folder’s `Pi-Desktop`
  directory. `Pi-Desktop` is created on first use and reused afterwards; each
  project gets its own timestamp folder, and the project becomes active with a
  new session. No `git init` runs — use **Create blank project…** when you want
  to choose the folder and the git option.
- **Create blank project…** — creates the directory (and optionally runs
  `git init`; the app probes `git --version` before creating anything).
- **Clone repository…** — validates the URL and clones with `git`, surfacing the
  first line of an error.
- **Quick session in home** — opens your home folder as a project for a one-off
  session.

Projects can be reordered and removed from the sidebar; the recent list is
stored in app state (`app-state.json`), never in Pi state. Removing a project
closes every tab in that folder (session, Office, web, editor and pinned), but
does **not** delete the folder or Pi session files. A dirty editor tab prompts
Save/Discard/Cancel first; Cancel aborts the removal.

## The project header

The sidebar shows, per project:

- name and path;
- the **git branch**, when `git` is available;
- a **trust** badge;
- a `.pi/` summary (which of settings/extensions/skills/prompts/themes exist);
- whether `AGENTS.md` is present;
- the session directory Pi will use;
- the open session tabs for the project (file tabs are listed only in the editor
  tab strip).

Actions: reveal in the file manager, open an external terminal, copy the path,
and **Use project settings** (a per-project switch), plus **Edit JSON…** for the
advanced project document. Clicking the project name activates the project and
focuses its most recently active session tab, never a file tab. The switch
defaults to **off** (shared global
settings). Turning it on makes model, scope, thinking, theme, package and
extension writes in this project target `.pi/settings.json`; turning it off
saves the project document to app state, empties it, and the project uses global
settings. While off, a non-empty project file is reported in the project panel.

## Trust

Opening a folder with project-level Pi configuration triggers a trust prompt:

- **Trust once** — this app run only;
- **Trust & remember** — persisted;
- **Never** — the project stays untrusted;
- **Ignore** — dismiss without a decision (the project remains untrusted).

Until a project is trusted, its project resources stay disabled, exactly as Pi
behaves. `/trust` re-opens the prompt, and the trust chip in the sidebar shows
the current state. A session refused for trust retries `session.create` with the
answer you chose, so you never have to retype a prompt.

## Where state lives

| What                                                 | Where                            |
| ---------------------------------------------------- | -------------------------------- |
| Project config and overrides                         | `<project>/.pi/`                 |
| Per-project session files                            | the profile’s `sessions/` tree   |
| Project-scope defaults/scope (when the toggle is on) | `<project>/.pi/settings.json`    |
| Global defaults/scope (toggle off)                   | the Pi profile’s `settings.json` |
| Project extensions/packages                          | `<project>/.pi/npm`, `.pi/…`     |
| Saved project document while the toggle is off       | `app-state.json` (snapshot)      |

## Related

- [Sessions and tabs](sessions-and-tabs.md) · [Settings](settings.md)
- [Extensions and packages](extensions-and-packages.md) · [Getting started](getting-started.md)
