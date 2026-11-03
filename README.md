# Pi Desktop

<img src="assets/pi-desktop-logo-full.svg" alt="pi — PI DESKTOP" width="440">

A desktop app for the [Pi coding agent](https://pi.dev) — no terminal, no global
installs. Projects, sessions, chat, providers, models, extensions, packages,
skills, themes and settings are managed through a UI, using the **same
`~/.pi/agent` profile as terminal Pi**, so the two are interchangeable.

> **Status:** v0.4.0 development build (the core-first plan's steps 1–29 plus
> the interface, source-control, session-first chrome and explorer/editor work).
> The Windows installer is the primary artefact; macOS and Linux are beta, and
> builds are unsigned. Known limitations and the deferred backlog are recorded in
> [docs/releases/v0.4.0.md](docs/releases/v0.4.0.md) and
> [docs/product/backlog.md](docs/product/backlog.md).
>
> **Pi for Office is an optional integration.** It installs from Extensions →
> Integrations like any other Pi package, and no Office surface appears unless
> you set it up.

## What it does

- **Projects and sessions** — open a folder, manage recents and trust, and run
  parallel sessions in tabs, each in its own Pi host process.
- **File explorer and editor** — a project tree with hidden/ignored toggles,
  project-wide name search and drag-to-chat mentions; CodeMirror editor tabs with
  syntax highlighting, conflict-safe saves, hot-exit recovery and Format
  Document.
- **Chat** — streaming text that follows the cursor while pinned (scroll up for
  "Jump to latest"), thinking, one card per tool call with previews, diffs and
  result images, steering/follow-up with pending rows (`Alt+Up` restores them),
  `Esc` to stop, retry/compaction status with cancel, `!`/`!!` shell commands,
  transcript find (`Ctrl+F`), paste markers, `Ctrl+G` expanded editor, Mermaid
  and LaTeX, usage and cost.
- **Context and commands** — `/` commands (app, extension, prompt, skill), `@`
  files, image paste/drop, `#` Office document mentions, plus `/session`,
  `/copy`, `/import`, `/export jsonl`, `/share`, `/bug`, `/changelog`,
  `/hotkeys` and `/quit`.
- **Providers and models** — OAuth subscriptions, write-only API keys, custom
  gateways, model/thinking pickers, the model scope (shared with Ctrl+Alt cycling
  and extension pickers) and per-project defaults.
- **Extensions and packages** — the same discovery as terminal Pi, with
  provenance, load-error diagnostics, enable/disable, install consent and the
  full `ExtensionUIContext` (dialogs, widgets, status, and the TUI rendering
  surface for `ctx.ui.custom()`).
- **Settings** — every key in Pi’s `docs/settings.md`, global and per project,
  with a raw JSON editor, diff, backups and external-edit detection.
- **Keybindings** — Pi’s `keybindings.json` (including extension shortcuts) plus
  a desktop-only registry with click-to-capture chords, menu accelerators and
  scope-aware conflict warnings.
- **Optional web tabs** — Plannotator and other localhost UIs open in isolated
  in-app tabs.
- **Recovery and safety** — safe mode, crash recovery, a redacted diagnostics
  bundle, sandboxed renderer, strict CSP and an allowlisted IPC surface.

The feature-by-feature comparison with terminal Pi (including the explicit
“MCP = parity, no built-in” note) is
[docs/product/parity.md](docs/product/parity.md).

## Install

Download the installer for your platform from GitHub Releases. The Windows NSIS
installer and portable `.exe` are the primary artefacts; macOS `.dmg`/`.zip`
(arm64 + x64) and Linux AppImage/`.deb` (x64 + arm64) are beta. Builds are
unsigned in v0.4.0, so SmartScreen/Gatekeeper will warn on first launch
(instructions in the guide, including the Linux FUSE and apt notes).

Installed release builds check GitHub Releases in the background. When a newer
version exists, the status bar shows a small **Update vX** chip; Download and
**Restart & install** live in **Settings → About & updates**. Locally built
packages are stamped `local`, skip automatic checks, and say so in that card.

## Develop

```bash
npm ci
npm run runtime:fetch      # bundled Node + npm + shims (~37 MB, not committed)
npm run dev                # Electron with main/preload + host watch and the renderer dev server
```

Gates (run before every commit; CI runs the same set):

```bash
npm run format:check && npm run typecheck && npm run lint && npm test && npm run build
npm run runtime:verify     # bundled runtime + host bundle (needs runtime:fetch)
npm run office:manifest:check
npm run test:e2e           # Playwright-Electron (needs npm run build)
```

Useful probes: `npm run doctor` (runtime, profile, extensions, bridge, git,
Office) and `npm run office:doctor` (Office detection, sideload, bridge health).

`npm run package:win|mac|linux` fetches the runtime, builds, verifies it and
produces installers under `release/`.

## Layout

```text
src/main/            Electron main: window, menu, IPC router, supervisor, updater, Office wiring
src/main/office/     UI-free Office setup backend (detect, install, sideload, verify, wizard)
src/preload/         the only place that touches contextBridge/ipcRenderer
src/renderer/src/    React app: layout/, views/, ui/ primitives, state/ (zustand), styles/
src/host/            the Pi host process (all SDK contact in src/host/sdk/)
src/shared/          types, constants and the single IPC allowlist
packages/checkpoints/  the publishable @dieulc/checkpoints package
resources/           vendored Office manifest, fetched Node/npm runtime
tests/               vitest (node project + jsdom renderer project) and Playwright E2E
docs/                product/parity + backlog, the user guide, releases and the architecture docs
```

## Docs

- **User guide** — [docs/guide/](docs/guide/) (getting started, projects,
  sessions and tabs, providers, models, extensions and packages, settings,
  skills/themes/keybindings, Office, web tabs, troubleshooting, FAQ).
- **Architecture** — [docs/architecture/](docs/architecture/) (app shell,
  host protocol + RPC mapping, extension UI host + TUI surface, Office
  integration, runtime, pinned versions).
- **Parity** — [docs/product/parity.md](docs/product/parity.md).
- **Release notes** — [docs/releases/v0.4.0.md](docs/releases/v0.4.0.md)
  (install table, known limitations, verification status).
- **Backlog** — [docs/product/backlog.md](docs/product/backlog.md).
- **Contributing** — [CONTRIBUTING.md](CONTRIBUTING.md) and
  [AGENTS.md](AGENTS.md); the executable plan is
  `.pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md`.

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Pi Desktop is an independent client built on the Pi SDK and is not affiliated
with the Pi project.
