# Pi Desktop docs

- [`architecture/versions.md`](architecture/versions.md) — pinned toolchain and
  runtime versions, and why.
- [`architecture/runtime.md`](architecture/runtime.md) — the bundled Node/npm
  runtime, the `pi`/`npm` PATH shims and how the app resolves them.
- `architecture/host-protocol.md` — main ⇄ Pi host JSONL protocol (added in plan step 4).
- `architecture/extension-ui.md` — `ExtensionUIContext` behaviour and the TUI
  rendering surface (added in plan steps 6–7).
- `architecture/office-integration.md` — bridge, port assignment, sideload paths
  (added in plan step 19).
- `guide/troubleshooting.md` — user-facing troubleshooting (added in plan step 26).

The two plans under `.pi/plans/` remain the design authority for anything not
covered here.
