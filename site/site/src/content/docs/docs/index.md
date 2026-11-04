---
title: "Pi Desktop docs"
description: "The executable plan is .pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md (core-first: Pi agent GUI first, Pi for Office re-homed as an optional..."
editUrl: "https://github.com/dieuluucanh/pi-desktop/edit/main/docs/README.md"
---

## Product

- [`product/parity.md`](/product/parity/) — the feature matrix against terminal Pi (implemented,
  planned at which step, and what is deliberately out of scope, including MCP).
- [`product/backlog.md`](/product/backlog/) — the deferred backlog: post-MVP items, MVP scope
  deferred during the plan, release engineering and the upstream watch list.

## Releases

- [`releases/v0.5.0.md`](/releases/v0.5.0/) — v0.5.0 release notes (first public,
  cross-platform, auto-updating release: the tag-driven pipeline, the macOS artefacts,
  the live update feed and the macOS manual-update rule), install table, the
  known-limitations list and the verification status.
- [`releases/v0.3.0.md`](/releases/v0.3.0/) — v0.3.0 release notes (session-first
  chrome, the interface pass, source-control feedback and one-line history), install table,
  the known-limitations list and the verification status.
- [`releases/v0.2.0.md`](/releases/v0.2.0/) — v0.2.0 release notes (Pi 1.4.0 session
  parity), install table, the known-limitations list and the verification status.
- [`releases/v0.1.0.md`](/releases/v0.1.0/) — the v0.1.0 release notes, kept as the
  historical first release.

## User guide

- [`guide/getting-started.md`](/guide/getting-started/) — install, first launch, the window, your
  first session, updates, where data lives.
- [`guide/projects.md`](/guide/projects/) — adding projects, the project header, trust.
- [`guide/sessions-and-tabs.md`](/guide/sessions-and-tabs/) — tabs, the session browser, tree/fork,
  recovery, the composer.
- [`guide/providers-and-auth.md`](/guide/providers-and-auth/) — Connections, OAuth, write-only API
  keys, custom gateways, proxy/offline.
- [`guide/models-and-thinking.md`](/guide/models-and-thinking/) — model picker, thinking levels,
  usage, tool detail.
- [`guide/extensions-and-packages.md`](/guide/extensions-and-packages/) — the Extensions hub,
  enable/disable, packages and consent, safe mode.
- [`guide/settings.md`](/guide/settings/) — every Pi setting, scopes, raw JSON, backups.
- [`guide/skills-themes-keybindings.md`](/guide/skills-themes-keybindings/) — skills, themes and
  `keybindings.json`.
- [`guide/office-setup.md`](/guide/office-setup/) — Pi for Office as an optional integration.
- [`guide/git-and-checkpoints.md`](/guide/git-and-checkpoints/) — the right rail's Git, Changes,
  History and Checkpoints sections: staging and committing, what a checkpoint is (and is not),
  restoring safely, retention, and `/checkpoint` in terminal Pi.
- [`guide/plannotator-web-tabs.md`](/guide/plannotator-web-tabs/) — in-app web tabs and reviews.
- [`guide/troubleshooting.md`](/guide/troubleshooting/) — safe mode, recovery, diagnostics.
- [`guide/branding.md`](/guide/branding/) — the logo set, which mark belongs to which product, and
  how the icons are wired into the build.
- [`guide/faq.md`](/guide/faq/) — common questions.

## Architecture

- [`architecture/app-shell.md`](/architecture/app-shell/) — the window's IA, view model, theme
  tokens, command ownership, the renderer file map, plus security/privacy, reliability,
  performance, onboarding/updates and packaging.
- [`architecture/host-protocol.md`](/architecture/host-protocol/) — the main ⇄ Pi host JSONL
  protocol, including the RPC mapping table.
- [`architecture/extension-ui.md`](/architecture/extension-ui/) — `ExtensionUIContext`
  member-by-member (the parity doc the definition of done calls `extension-parity.md`) and the
  TUI rendering surface.
- [`architecture/source-control.md`](/architecture/source-control/) — the git and checkpoint
  engines, the shadow-repository layout, the private-index recipe, the CAS-retry and
  prune-suffix invariants, restore safety and the safe-mode rule for the extension.
- [`architecture/office-integration.md`](/architecture/office-integration/) — the Office bridge:
  processes and flows, the protocol compatibility matrix, streaming/stop rules, `/health` usage and
  release order.
- [`architecture/runtime.md`](/architecture/runtime/) — the bundled Node/npm runtime, the
  `pi`/`npm` PATH shims, resolution order and packaging.
- [`architecture/release-pipeline.md`](/architecture/release-pipeline/) — the tag-driven release
  workflow, the draft→publish contract, the per-platform asset and manifest matrix, and the
  macOS ad-hoc signing / manual-update rule.
- [`architecture/versions.md`](/architecture/versions/) — pinned toolchain and runtime versions,
  and why.

## Contributing

- [`../CONTRIBUTING.md`](https://github.com/dieuluucanh/pi-desktop/blob/main/CONTRIBUTING.md) — setup, gates, conventions, how to run the tests.
- [`../AGENTS.md`](https://github.com/dieuluucanh/pi-desktop/blob/main/AGENTS.md) — the repo conventions an automated agent (or a human) must follow.

The executable plan is `.pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md` (core-first: Pi
agent GUI first, Pi for Office re-homed as an optional integration). The 2026-09-18 spec and its
2026-09-19 deltas stay the design authority for what the plan does not amend.
