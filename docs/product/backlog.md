# Pi Desktop — deferred backlog

**Last updated:** 2026-09-21 (plan step 27, v0.1.0).

The executable plan (`.pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md`)
is gitignored, so this file is the durable, in-repo record of what the MVP
deliberately leaves out. Nothing here is a bug: each item has a reason and, where
it matters, a workaround that ships today.

## Post-MVP (explicitly out of the core-first plan)

| Item                                                                    | Why it is deferred                                                                                                                  | Ships today instead                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| In-app terminal tab (`node-pty` + `xterm.js`) running the real `pi` TUI | Native-module/Electron ABI risk is not worth MVP time; the TUI surface already renders extension `custom()` components.             | The bundled `pi` PATH shim + an external terminal.            |
| Native Plan/Review workspace for the workflow extension                 | Steps 16–18 give the workflow extension a faithful TUI surface; a native two-pane reviewer is a differentiator, not a prerequisite. | The extension's own TUI rendering surface in-app.             |
| SQLite session index, full-text search, tags, archive automation        | `SessionManager.listAll()` is adequate for hundreds of sessions; the JSONL stays the source of truth.                               | The session browser, rename, OS-trash delete, HTML export.    |
| i18n (en / zh-CN)                                                       | Product scope; the chrome is small enough to localise later.                                                                        | English UI.                                                   |
| Git worktrees per session (OpenCode-style isolation)                    | Needs its own design (worktree lifecycle, prune, per-worktree session dirs); not required for parity.                               | One project folder per session.                               |
| First-party MCP bridge extension                                        | Parity first; a bridge is a standalone extension project.                                                                           | MCP through an installed extension, exactly like terminal Pi. |
| Multi-window, scheduled tasks, cloud/remote sessions                    | Not parity with terminal Pi.                                                                                                        | Single window; multiple tabs.                                 |

## Deferred from the MVP during the plan

| Item                                                                    | Where it was deferred                             | Why, and what remains                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code signing / notarization** (Windows SmartScreen, macOS Gatekeeper) | Release engineering (AGENTS.md backlog B1/B2)     | Signing needs certificates and a release pipeline. v0.1.0 ships unsigned; the guide documents the first-run prompts.                                                                                                                         |
| **External-editor launcher (Ctrl+G)**                                   | Step 12 (setting shipped) → reliability backlog   | The `externalEditor` key is editable in Settings, but the validated main-process spawn + temp-file round trip is not wired. The setting is honest about it.                                                                                  |
| **A UI caller for `files.read` / `files.write`**                        | Step 7 deferred, step 23 implemented the handlers | The secure, cwd-rooted handlers exist and are tested (and are what the security suite attacks), but no view uses them yet.                                                                                                                   |
| **Backups for `models.json`, `keybindings.json`, imported themes**      | Step 12 (settings backup only)                    | Writes are atomic and `fsync`'d; only `settings.json` gets a pre-write backup today.                                                                                                                                                         |
| **The residual parent-directory TOCTOU in `resolveInsideRoot`**         | Step 23 (documented)                              | A write accepts a not-yet-existing parent chain when the nearest existing ancestor is inside the root. The missing segments cannot be symlinks and the writer renames over the final component; the residual race is documented, not closed. |
| **A real frame-timing/RSS measurement harness**                         | Step 24 (structural assertions)                   | 60 fps, the 8-host RSS budget and the 1.5 GB restart threshold are asserted structurally or with injected samples; no live frame-timing rig exists.                                                                                          |
| **macOS/Linux install verification**                                    | Step 26 (beta artefacts)                          | The same `electron-builder` config builds them and the runtime lock covers their Node artefacts, but no real Mac/Linux install has been exercised.                                                                                           |

## Release engineering (next, not MVP)

- Sign and notarize Windows/macOS artefacts, then publish a real GitHub Release
  feed so the updater's download → restart → install path is exercised end to end.
- Run the step-27 acceptance matrix on a clean Windows VM with real providers and
  a real Office install, and record the results with the release.
- Promote the beta macOS/Linux artefacts after a real install run on each.

## Upstream watch

| Item                                                         | Why it matters                                                                                                   | Mitigation                                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi's `SettingsManager`/`SessionManager` write non-atomically | A crash during Pi's own flush can truncate `settings.json` or a session JSONL. The pinned SDK cannot be patched. | Pin `0.85.1`; keep every SDK import in `src/host/sdk/*`; the app's own writes are atomic (`fsync` + rename). Re-check on each SDK upgrade. |
| `ExtensionUIContext` / extension API drift                   | The app implements an undocumented hosting surface.                                                              | The RPC-parity test and the `extension-ui.md` member-coverage guard fail on drift; upgrades stay opt-in with a smoke test.                 |
| npm search index staleness (pi.dev gallery)                  | `keywords:pi-package` packages can be missing from the gallery despite being published.                          | `npm run gallery` (pi-workflow repo) reports `not-indexed`; not a Pi Desktop concern beyond the install source.                            |
