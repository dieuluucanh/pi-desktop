# Getting started

Pi Desktop is the graphical client for the [Pi coding agent](https://pi.dev). It manages projects,
sessions, chat, providers, models, extensions, packages, skills, themes and settings through a UI,
and it uses the **same Pi profile as terminal Pi** — so the two are interchangeable.

## Install

| Platform      | Artefact                                                         |
| ------------- | ---------------------------------------------------------------- |
| Windows (x64) | NSIS installer and a portable `.exe` (both unsigned — see below) |
| macOS         | `.dmg` and `.zip`, arm64 + x64 (beta, unsigned)                  |
| Linux         | AppImage and `.deb`, x64 + arm64 (beta, unsigned)                |

Builds are published on GitHub Releases. The Windows installer is the primary
artefact; versions are checked automatically once installed (see
[Updates](#updates) below).

### Installing on Linux

Both artefacts are unsigned and self-contained — the app bundles its own Node
runtime, so no system Node, npm or Pi install is needed.

**AppImage** (any distribution, no install step):

```bash
chmod +x Pi-Desktop-*-linux-x86_64-appimage.AppImage
./Pi-Desktop-*-linux-x86_64-appimage.AppImage
```

The AppImage needs FUSE. Without it, either install `fuse`/`libfuse2` or run
`--appimage-extract-and-run`.

**Debian / Ubuntu** (installs to `/opt/Pi Desktop`, adds a launcher entry):

```bash
sudo apt install ./Pi-Desktop-*-linux-amd64-deb.deb
```

Use `apt install ./file.deb` rather than `dpkg -i` so the GTK/NSS/asound
runtime dependencies are resolved for you. ARM64 machines use the `arm64`
artefacts instead. To remove: `sudo apt remove pi-desktop`.

> **Unsigned builds.** Windows SmartScreen and macOS Gatekeeper will warn on
> first launch. Choose “More info → Run anyway” (Windows) or right-click → Open
> (macOS). Code signing is tracked in the backlog, not in v0.3.0.

## First launch

Two screens run once, in order:

1. **Privacy.** Pi can send one anonymous install/update ping and a provider
   attribution header. The app keeps that **off** unless you opt in. The choice
   is an app preference — it never rewrites the shared `settings.json`.
2. **Setup.** A short guided flow: what the app is → which Pi profile to use →
   connect a provider → open a project → optional recommended extensions →
   optional Pi for Office. Every step can be skipped, and you can re-run the flow
   from a fresh install.

### Choose a Pi profile

- **Shared (default)** — the app uses `~/.pi/agent`, the same profile as terminal
  Pi. Sessions, credentials, extensions and settings are shared in both
  directions.
- **Separate** — the app keeps its own profile under the app's data directory.
  Useful when you do not want GUI sessions in your terminal history.

`PI_CODING_AGENT_DIR` always wins over the in-app choice, so a scripted or
portable run can pin the profile. Changing the choice takes effect on the next
launch; the app offers a restart.

## The window

```text
tabs      ─ one tab per open session (plus web tabs and the Office session);
            the topmost row, with the "+" new-session action
sidebar   ─ command palette · projects (+ menu · open folder) → sessions ·
            Settings · Extensions · Connections · Skills · Diagnostics
main area ─ the active view (session, settings, extensions, …)
footer    ─ session footer: pwd (branch) · tokens/cost/context · model •
            thinking · extension statuses · compact widgets, in one wrapping
            row (an extension setFooter replaces it)
status bar─ active project path · display zoom · version · profile · runtime · hints
```

Keyboard: `Ctrl/Cmd+K` command palette, `Ctrl/Cmd+N` new session, `Ctrl/Cmd+W`
close session, `Ctrl/Cmd+B` sidebar, `Ctrl/Cmd+=` / `-` / `0` zoom in / out /
reset, `Ctrl+Tab` next session, `Ctrl/Cmd+/` shortcuts, `Esc` stops the run.

## Your first session

1. **Open project folder…** (or create a default project in
   `Documents/Pi-Desktop` / a blank project / clone a repository).
   If the folder contains a `.pi/` directory, the app asks how you want to trust
   it — see [Projects](projects.md).
2. A session tab opens in that folder. Type a prompt and press **Enter**
   (`Shift+Enter` for a newline).
3. Use `/` for commands, `@` to reference files and paste or drop images into
   the composer. `#` mentions Office documents when the Office bridge is
   connected.

Every session runs in its own Pi host process, so several sessions can run in
parallel across projects. See [Sessions and tabs](sessions-and-tabs.md).

## Updates

Release builds check GitHub Releases shortly after launch. A newer version
appears as a small **Update vX** chip in the status bar; the full status,
**Download** and **Restart & install** live in **Settings → About & updates**.
`Help → Check for Updates…` opens that card and runs a check on demand. Locally
built packages skip automatic checks and flag themselves as local builds;
development builds report that updates are checked in installed builds only.

## Where your data lives

| What                                    | Where                                      |
| --------------------------------------- | ------------------------------------------ |
| Sessions (JSONL), settings, credentials | the Pi profile (`~/.pi/agent` by default)  |
| Project configuration                   | `<project>/.pi/`                           |
| App state (tabs, recents, preferences)  | Electron `userData` (`app-state.json`)     |
| Logs and support data                   | `userData/logs`, exported from Diagnostics |

Nothing Pi-related is stored in app state; see
[architecture/app-shell.md](../architecture/app-shell.md).

## Related

- [Projects](projects.md) · [Sessions and tabs](sessions-and-tabs.md) ·
  [Providers and auth](providers-and-auth.md) ·
  [Models and thinking](models-and-thinking.md)
- [Extensions and packages](extensions-and-packages.md) · [Settings](settings.md) ·
  [Skills, themes and keybindings](skills-themes-keybindings.md)
- [Pi for Office](office-setup.md) · [Web tabs](plannotator-web-tabs.md)
- [Troubleshooting](troubleshooting.md) · [FAQ](faq.md)
