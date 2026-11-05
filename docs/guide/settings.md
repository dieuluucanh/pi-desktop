# Settings

The **Settings** view edits every key in Pi’s `docs/settings.md`, global or
per project, plus a raw JSON editor. Because it writes Pi’s own `settings.json`,
terminal Pi sees the change immediately.

## Groups

| Group             | What it covers                                                        |
| ----------------- | --------------------------------------------------------------------- |
| Model & Thinking  | Startup provider/model, thinking level, per-model levels              |
| UI & Display      | Theme, editor chrome, tree filters, analytics                         |
| Network           | Proxy and network settings                                            |
| Warnings          | Transcript warnings the agent may show                                |
| Compaction        | When and how the conversation is compacted                            |
| Branch Summary    | How branch history is summarised                                      |
| Retry             | Automatic retries for transient provider errors                       |
| Message Delivery  | Steering/follow-up modes and transport timeouts                       |
| Terminal & Images | Terminal rendering overrides and image handling                       |
| Shell             | The shell and npm used for tools and packages                         |
| Tools             | Which built-in tools are enabled at startup                           |
| Sessions          | Where session files are stored                                        |
| Model scope       | Models for Ctrl+Alt cycling, the dialog's stars and extension pickers |
| Markdown          | Code-block indentation and Mermaid rendering                          |
| Resources         | Packages, extensions, skills, prompts and themes                      |

Each field shows a **provenance badge** — where its effective value came from
(default, global, project). Values are validated before anything is written; an
invalid value shows an inline error and never corrupts the file.

## Global vs project scope

**Settings edits global settings only.** The per-field Global/Project switch is
gone. Select a project in the sidebar to enable its **Settings** switch when you
want project-scoped values; the project panel also hosts the advanced
`.pi/settings.json` editor. Project values win with Pi’s nested-merge semantics;
a row shows a **project override** badge when the active project defines the key.

Turning a project’s Settings switch off snapshots its whole `.pi/settings.json`
to app state, replaces it with `{}`, and makes the project use global settings.
Turning it on restores the snapshot when the file is still empty; if the file was
changed while off, the current file is kept and the app reports it.

## Raw JSON, diff and reset

- **Raw JSON** opens a dialog for the **global** document, formats it, and lets
  you copy it out or paste an import. The paste is validated against the schema
  before it is written. Project JSON is edited from the project panel.
- **Diff vs defaults** shows exactly what differs from Pi’s defaults.
- **Reset** clears a single field or a whole scope.

## Safety

- `settings.json` is **backed up** to the app’s `userData/backups` directory
  before the first write per file per host process.
- A **malformed** file is reported, never repaired silently, and never
  overwritten.
- If terminal Pi edits the file while the app is open, an **external edit**
  banner appears (detected by mtime) with **Reload from disk**.
- `/reload` reloads extensions and settings in a live session.

## Terminal (app-owned)

**Settings → Terminal** controls the integrated terminal, separately from Pi's
`shellPath` (which drives the agent's tools and `!` commands):

- **Default shell profile** — `Auto` or any detected shell (PowerShell 7,
  Windows PowerShell, Command Prompt, Git Bash and WSL distros on Windows; the
  platform login shells elsewhere). A custom absolute executable can override
  the list; the conventional Git Bash layouts keep their login-shell arguments.
  Existing terminals keep their shell when the default changes.
- **Appearance** — font size and family with a live preview, cursor style and
  blink, scrollback lines, copy-on-selection, a visual bell and (on macOS)
  Option-as-Meta. Changes apply to open terminals without losing scrollback.

The strip's **New terminal** button opens the saved default. The chevron beside
it opens a one-off terminal with another detected profile; **Select default
profile…** opens this card. Ctrl/Cmd + = / - changes the terminal's font size,
and Ctrl/Cmd + 0 resets it.

## Preferences that are _not_ Pi settings

A few things live in app state on purpose, so they never change terminal Pi’s
behaviour:

- theme first-paint cache (`prefs.theme`) and per-theme chrome colour overrides
  (`prefs.themeColors`); the active Pi theme is loaded at startup and owns the
  accent/status colours from then on, while the app owns the high-contrast
  neutral surfaces;
- follow-system appearance (`prefs.followSystemTheme`) and app display zoom
  (`prefs.zoomFactor`; View → Zoom In / Zoom Out / Actual Size, or
  <kbd>Ctrl/Cmd</kbd>+<kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd>);
- sidebar layout and per-tab drafts;
- telemetry opt-in (`PI_TELEMETRY=0` unless enabled);
- the Pi profile choice (shared vs app-private);
- `externalEditor` is a Pi setting, but the launcher that spawns the editor is
  app-side.

## Related

- [Providers and auth](providers-and-auth.md) · [Extensions and packages](extensions-and-packages.md)
- [architecture/app-shell.md](../architecture/app-shell.md)

**Notifications.** Settings → Notifications lists mute rules created from a
notification's gear or from the notification history. Each rule can be unmuted
individually, or use **Unmute all**. Muted notifications stay in the history
(marked `muted`) but disappear from the transcript and stop toasting.
