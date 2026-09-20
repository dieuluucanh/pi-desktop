# Pi Desktop docs

- [`product/parity.md`](product/parity.md) — the feature matrix against terminal Pi (what is
  implemented, what is planned at which step, and what is deliberately out of scope, including MCP).
- [`architecture/app-shell.md`](architecture/app-shell.md) — the window's IA, view model, theme
  tokens, command ownership, the renderer file map, and the security/privacy posture (CSP, window
  and web-tab isolation, IPC allowlist, path containment, telemetry).
- [`architecture/versions.md`](architecture/versions.md) — pinned toolchain and
  runtime versions, and why.
- [`architecture/runtime.md`](architecture/runtime.md) — the bundled Node/npm
  runtime, the `pi`/`npm` PATH shims and how the app resolves them.
- `architecture/host-protocol.md` — main ⇄ Pi host JSONL protocol (plan step 4).
- `architecture/extension-ui.md` — `ExtensionUIContext` behaviour and the TUI
  rendering surface (added in plan steps 16–17).
- [`architecture/office-integration.md`](architecture/office-integration.md) —
  the Office bridge: processes and flows, the protocol v2/v3 compatibility
  matrix, the streaming and stop rules, `/health` usage, release order and test
  coverage.
- `guide/troubleshooting.md` — user-facing troubleshooting (added in plan step 26).

The executable plan is `.pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md`
(core-first: Pi agent GUI first, Pi for Office re-homed as an optional integration).
The 2026-09-18 spec and its 2026-09-19 deltas stay the design authority for what
the plan does not amend.
