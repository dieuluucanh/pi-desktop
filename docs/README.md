# Pi Desktop docs

## Product

- [`product/parity.md`](product/parity.md) — the feature matrix against terminal Pi (implemented,
  planned at which step, and what is deliberately out of scope, including MCP).
- [`product/backlog.md`](product/backlog.md) — the deferred backlog: post-MVP items, MVP scope
  deferred during the plan, release engineering and the upstream watch list.

## Releases

- [`releases/v0.2.0.md`](releases/v0.2.0.md) — v0.2.0 release notes (Pi 1.4.0 session
  parity), install table, the known-limitations list and the verification status.
- [`releases/v0.1.0.md`](releases/v0.1.0.md) — the v0.1.0 release notes, kept as the
  historical first release.

## User guide

- [`guide/getting-started.md`](guide/getting-started.md) — install, first launch, the window, your
  first session, updates, where data lives.
- [`guide/projects.md`](guide/projects.md) — adding projects, the project header, trust.
- [`guide/sessions-and-tabs.md`](guide/sessions-and-tabs.md) — tabs, the session browser, tree/fork,
  recovery, the composer.
- [`guide/providers-and-auth.md`](guide/providers-and-auth.md) — Connections, OAuth, write-only API
  keys, custom gateways, proxy/offline.
- [`guide/models-and-thinking.md`](guide/models-and-thinking.md) — model picker, thinking levels,
  usage, view mode.
- [`guide/extensions-and-packages.md`](guide/extensions-and-packages.md) — the Extensions hub,
  enable/disable, packages and consent, safe mode.
- [`guide/settings.md`](guide/settings.md) — every Pi setting, scopes, raw JSON, backups.
- [`guide/skills-themes-keybindings.md`](guide/skills-themes-keybindings.md) — skills, themes and
  `keybindings.json`.
- [`guide/office-setup.md`](guide/office-setup.md) — Pi for Office as an optional integration.
- [`guide/git-and-checkpoints.md`](guide/git-and-checkpoints.md) — the right rail's Git, Changes,
  History and Checkpoints sections: staging and committing, what a checkpoint is (and is not),
  restoring safely, retention, and `/rewind` in terminal Pi.
- [`guide/plannotator-web-tabs.md`](guide/plannotator-web-tabs.md) — in-app web tabs and reviews.
- [`guide/troubleshooting.md`](guide/troubleshooting.md) — safe mode, recovery, diagnostics.
- [`guide/branding.md`](guide/branding.md) — the logo set, which mark belongs to which product, and
  how the icons are wired into the build.
- [`guide/faq.md`](guide/faq.md) — common questions.

## Architecture

- [`architecture/app-shell.md`](architecture/app-shell.md) — the window's IA, view model, theme
  tokens, command ownership, the renderer file map, plus security/privacy, reliability,
  performance, onboarding/updates and packaging.
- [`architecture/host-protocol.md`](architecture/host-protocol.md) — the main ⇄ Pi host JSONL
  protocol, including the RPC mapping table.
- [`architecture/extension-ui.md`](architecture/extension-ui.md) — `ExtensionUIContext`
  member-by-member (the parity doc the definition of done calls `extension-parity.md`) and the
  TUI rendering surface.
- [`architecture/source-control.md`](architecture/source-control.md) — the git and checkpoint
  engines, the shadow-repository layout, the private-index recipe, the CAS-retry and
  prune-suffix invariants, restore safety and the safe-mode rule for the extension.
- [`architecture/office-integration.md`](architecture/office-integration.md) — the Office bridge:
  processes and flows, the protocol compatibility matrix, streaming/stop rules, `/health` usage and
  release order.
- [`architecture/runtime.md`](architecture/runtime.md) — the bundled Node/npm runtime, the
  `pi`/`npm` PATH shims, resolution order and packaging.
- [`architecture/versions.md`](architecture/versions.md) — pinned toolchain and runtime versions,
  and why.

## Contributing

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — setup, gates, conventions, how to run the tests.
- [`../AGENTS.md`](../AGENTS.md) — the repo conventions an automated agent (or a human) must follow.

The executable plan is `.pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md` (core-first: Pi
agent GUI first, Pi for Office re-homed as an optional integration). The 2026-09-18 spec and its
2026-09-19 deltas stay the design authority for what the plan does not amend.
