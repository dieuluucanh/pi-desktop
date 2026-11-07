# Pi Desktop — deferred backlog

**Last updated:** 2026-10-26 (session-parity plan: steps 1–24 shipped, Phase G deferred).

The executable plan (`.pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md`)
is gitignored, so this file is the durable, in-repo record of what the MVP
deliberately leaves out. Nothing here is a bug: each item has a reason and, where
it matters, a workaround that ships today.

## Post-MVP (explicitly out of the core-first plan)

| Item                                                             | Why it is deferred                                                                                                                                            | Ships today instead                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Bottom terminal panel, split panes                               | The `terminal` tab kind shipped 2026-11 (see `docs/architecture/terminal.md`); a docked panel and arbitrary splits are follow-ups on the same PTY foundation. | The terminal tab kind, plus the existing grid presets.        |
| Native Plan/Review workspace for the workflow extension          | Steps 16–18 give the workflow extension a faithful TUI surface; a native two-pane reviewer is a differentiator, not a prerequisite.                           | The extension's own TUI rendering surface in-app.             |
| SQLite session index, full-text search, tags, archive automation | `SessionManager.listAll()` is adequate for hundreds of sessions; the JSONL stays the source of truth.                                                         | The session browser, rename, OS-trash delete, HTML export.    |
| i18n (en / zh-CN)                                                | Product scope; the chrome is small enough to localise later.                                                                                                  | English UI.                                                   |
| Git worktrees per session (OpenCode-style isolation)             | Needs its own design (worktree lifecycle, prune, per-worktree session dirs); not required for parity.                                                         | One project folder per session.                               |
| First-party MCP bridge extension                                 | Parity first; a bridge is a standalone extension project.                                                                                                     | MCP through an installed extension, exactly like terminal Pi. |
| Multi-window, scheduled tasks, cloud/remote sessions             | Not parity with terminal Pi.                                                                                                                                  | Single window; multiple tabs.                                 |

## Deferred from the MVP during the plan

| Item                                                                    | Where it was deferred                             | Why, and what remains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code signing / notarization** (Windows SmartScreen, macOS Gatekeeper) | Release engineering (AGENTS.md backlog B1/B2)     | Signing needs certificates and a release pipeline. v0.7.3 ships unsigned; the guide documents the first-run prompts, including the macOS 15+ System Settings approval.                                                                                                                                                                                                                                                                                                                                                                              |
| **External-editor launcher (Ctrl+G)**                                   | ✅ shipped (session-parity step 21)               | `Ctrl+G` opens the guaranteed in-app expanded editor; a configured `externalEditor`/`$VISUAL`/`$EDITOR` is spawned **without a shell** and awaited, with a temp-file round trip and a "reload from file" path when a GUI editor forks. Terminal editors (vim/nano) stay unsupported in the launcher because it has no TTY; use a terminal tab for them.                                                                                                                                                                                             |
| **A UI caller for `files.read` / `files.write`**                        | Step 7 deferred, step 23 implemented the handlers | The secure, cwd-rooted handlers exist and are tested (and are what the security suite attacks), but no view uses them yet.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Backups for `models.json`, `keybindings.json`, imported themes**      | Step 12 (settings backup only)                    | Writes are atomic and `fsync`'d; only `settings.json` gets a pre-write backup today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **The residual parent-directory TOCTOU in `resolveInsideRoot`**         | Step 23 (documented)                              | A write accepts a not-yet-existing parent chain when the nearest existing ancestor is inside the root. The missing segments cannot be symlinks and the writer renames over the final component; the residual race is documented, not closed.                                                                                                                                                                                                                                                                                                        |
| **A real frame-timing/RSS measurement harness**                         | Step 24 (structural assertions)                   | 60 fps and the 1 GB per-host RSS threshold are asserted structurally or with injected samples; the live-host target is memory-derived, and no live frame-timing rig exists.                                                                                                                                                                                                                                                                                                                                                                         |
| **macOS/Linux install verification**                                    | Step 26 (beta artefacts)                          | Both are built from the same `electron-builder` config and the runtime lock covers their Node artefacts. The Linux `.deb`/AppImage are built and inspected on a real Ubuntu host (deb control, contents, bundled runtime, the packaged shim and host bundle actually running) and CI builds them on every tag (`release.yml`), but a real _install and first session_ on a Linux desktop has not been exercised, and the macOS bundles have never been launched by a person (CI verifies the signature, the packaged shim and the bundled runtime). |

## Deferred from the git/checkpoint plan

| Item                                      | Why it is deferred                                                                                                                                                    | Ships today instead                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **A merge-conflict resolution editor**    | A real 3-way editor is a project of its own; terminal git already does it well and the rail names the conflict with a fix hint.                                       | `git_conflict` incident + git's own message; resolve in a terminal. |
| **Rebase / cherry-pick / submodule UI**   | Explicit non-goals of the plan: each needs its own design (a todo list, a sequencer view), and none is required for the source-control parity the rail targets.       | The rail refuses with a clear message; terminal git does the work.  |
| **`git blame` / a per-line history view** | A different surface (line-anchored, needs the file's content and the commit trail per hunk) rather than an extension of the rail.                                     | Terminal `git blame`.                                               |
| **Per-hunk discard**                      | Discarding half a hunk is the one operation where a mistake is unrecoverable without the OS trash; the plan ships whole-file discard to trash plus a pre-op snapshot. | Whole-file discard, recoverable from the OS trash.                  |

## Deferred from the session-parity plan (Phase G)

| Item                                                                                    | Why it is deferred                                                                                                                                                                                                                                          | Ships today instead                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Three update channels** (desktop, Pi agent runtime overlay, extensions) — steps 25–28 | The plan makes Phase G a separate track that is deferred **whole** unless the three channels are re-confirmed. It also needs a published release feed to exercise the desktop download path, and the runtime overlay executes new code with app privileges. | Desktop app checks GitHub Releases (manual download); `packages.update` updates extensions with consent; the Pi runtime is pinned and reported in Diagnostics.                                                                  |
| **Pi runtime overlay installer + rollback** (step 26)                                   | Depends on the channel state machine (step 25) and a probe harness; the supervisor still captures one host path at construction.                                                                                                                            | The bundled runtime; `host.hello.piVersion` and the runtime source in Diagnostics.                                                                                                                                              |
| **Extension update check** (`packages.checkUpdates`, step 27)                           | Needs the coordinator's channel state and the unified UI.                                                                                                                                                                                                   | The Extensions hub lists installed packages and updates through the consent-gated `packages.update`.                                                                                                                            |
| **Radius upload for `/bug`**                                                            | No Radius credential/endpoint is wired, and a dead "Upload" button would be worse than none.                                                                                                                                                                | `/bug` writes a redacted zip locally (versions, diagnostics, optional transcript, non-LLM summary) and reveals it.                                                                                                              |
| **Cross-session Office tool routing**                                                   | `office_*` is served by the one session that owns bridge port 38617; proxying from another session needs its own IPC surface, auth, and idle-host semantics (who answers if the host is asleep?).                                                           | The Documents scope line names the live owner and offers _Open host session_ / _Move bridge here_; a terminal owner offers a confirmed takeover. Non-owner sessions disable the two composer actions and offer no `#` mentions. |

## Release engineering

**Shipped in v0.5.0** (`docs/architecture/release-pipeline.md`): a `v*` tag builds
Windows, Linux and macOS on their own runners, asserts the finished artefacts and
uploads them together with the `latest*.yml` manifests into a draft release that is
published only when all three succeed; `electron-updater` reads that feed anonymously
because the repository is public. macOS is ad-hoc signed and reports manual updates.

Next:

- **Code signing.** An Apple Developer Program membership (Developer ID + notarization)
  removes the macOS first-launch approval and makes in-app macOS updates possible; a
  Windows certificate removes SmartScreen. Both are purchases, not engineering.
- **Restore in-app macOS updates without Apple.** A stable self-signed release
  certificate keeps Squirrel.Mac's designated requirement constant across builds; it
  needs one Mac + Keychain to mint and two workflow secrets. Then set
  `PI_MAC_SIGNING=developer-id` and the `inAppUpdatesAllowed` gate opens by itself.
- **Prove one update cycle.** v0.6.0 was the first version an installed v0.5.0
  build could see on the published feed; v0.7.3 is the first version an installed
  v0.6.0 build should pick up (Windows and Linux AppImage; macOS stays manual).
- **Acceptance matrices.** Run the step-27 matrix on a clean Windows VM with real
  providers and a real Office install; install the Linux `.deb` and AppImage on a real
  desktop (launcher entry, window association, first session) and promote Linux out of
  beta; launch the macOS bundles on real Apple Silicon and Intel hardware and promote
  them the same way.
- **Discovery.** winget, Homebrew Cask and Flathub listings are free and follow the
  release assets, not the other way round.

## Public site

Shipped with v0.6.0: the GitHub Pages site in `site/`, the one-page product site,
the generated docs and release notes, the privacy page and the Playwright
screenshot harness. It has no analytics and no custom domain.

Next:

- **Custom domain.** Point a domain at GitHub Pages, add `public/CNAME`, set
  `SITE_URL`/`SITE_BASE_PATH` and remove the `/pi-desktop` base; the link checker
  already covers both bases.
- **Versioned docs.** Starlight versioning once there is more than one supported
  release line; today the site documents `main` and keeps every release note.
- **PR previews.** GitHub Pages has no preview deployments; a Cloudflare Pages
  preview job could build `site/dist` per pull request without changing the
  production deploy.
- **Privacy-friendly analytics.** Optional and explicitly out of the first site;
  adding it requires updating `privacy.md` in the same change.
- **Screenshot refresh.** Re-run `npm run site:screenshots` when the shell
  changes materially; the harness is deterministic but not part of CI.

## Upstream watch

| Item                                                         | Why it matters                                                                                                   | Mitigation                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi's `SettingsManager`/`SessionManager` write non-atomically | A crash during Pi's own flush can truncate `settings.json` or a session JSONL. The pinned SDK cannot be patched. | Pin `1.4.0`; keep every SDK import in `src/host/sdk/*`; the app's own writes are atomic (`fsync` + rename). Re-check on each SDK upgrade.                          |
| `ExtensionUIContext` / extension API drift                   | The app implements an undocumented hosting surface.                                                              | The RPC-parity test and the `extension-ui.md` member-coverage guard fail on drift; upgrades stay opt-in with a smoke test.                                         |
| npm search index staleness (pi.dev gallery)                  | `keywords:pi-package` packages can be missing from the gallery despite being published.                          | `@dieulc/checkpoints` is released from Pi Desktop, so the pi-workflow gallery scan no longer covers it; check `https://pi.dev/packages?name=checkpoints` manually. |
