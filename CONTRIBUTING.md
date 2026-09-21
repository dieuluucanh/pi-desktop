# Contributing

Pi Desktop is an Electron app that hosts the Pi coding agent. Thanks for helping
— this file covers the mechanics; [`AGENTS.md`](AGENTS.md) is the detailed
convention list and takes precedence where the two overlap.

## Setup

```bash
git clone https://github.com/dieuluucanh/pi-desktop.git
cd pi-desktop
npm ci
npm run runtime:fetch      # bundled Node + npm + PATH shims (~37 MB, not committed)
npm run dev                # Electron with the renderer dev server
```

`npm run runtime:fetch` is optional for typecheck/lint/unit tests (the live
runtime suites skip without it) but required for `dev`, `runtime:verify` and
packaging. `npm run doctor` probes the runtime, profile, extensions, bridge, git
and Office state on the current machine.

## Gates

Run all of these before opening a pull request; CI runs the same set plus the
Windows E2E job.

```bash
npm run format:check
npm run typecheck         # node + web + e2e TS projects
npm run lint
npm test                  # vitest: node project + jsdom renderer project
npm run build             # host bundle + main/preload/renderer
npm run runtime:verify    # runtime, host bundle and shims (needs runtime:fetch)
npm run office:manifest:check
```

`npm run test:coverage` enforces the coverage floors and runs in CI on Ubuntu.
`npm run test:e2e` runs the Playwright-Electron suite (needs `npm run build`);
`npm run e2e:smoke` and `npm run e2e:perf` run the tagged subsets.

## Conventions

- **One plan step per change set**, committed as `feat(<area>): <what> (plan
step N)`.
- **Every new module ships unit tests in the same step.**
- **`src/main/office/**`, `src/main/packages/**` and `src/host/**` never import
  `electron`** — they stay pure Node and are enforced by an architecture test.
- **All filesystem/platform access goes through an injected port** (`FsPort`,
  `CommandRunner`, `FetchLike`, `openPath`, `now`, `sleep`).
- **Never hand-write Pi state.** `settings.json`, `auth.json`, `models.json` and
  session JSONL are written through SDK managers or the atomic helpers in
  `src/main/packages/settings.ts`.
- **SDK contact stays inside `src/host/sdk/*`.**
- **User data is never overwritten on parse failure** — a malformed file throws
  and is surfaced.
- **Every IPC channel** is declared in `src/shared/ipc.ts`, exposed in
  `src/preload/index.ts` and handled in `src/main/ipc.ts`; argument validation
  lives in main. A static test fails if the three lists drift.
- Renderer styling uses Tailwind v4 utilities and the `ui/*` primitives; never
  hard-code a colour, radius or font — add a token in `styles/tokens.css`.
- Global keyboard accelerators belong to the Electron menu (`src/main/menu.ts`).

## Layout

```text
src/main/            Electron main: window, menu, IPC, supervisor, Office wiring
src/preload/         the only place that touches contextBridge/ipcRenderer
src/renderer/src/    React app: layout/, views/, ui/, state/, styles/
src/host/            the Pi host process (SDK behind src/host/sdk/)
src/shared/          types + constants shared by all of the above
resources/           vendored Office manifest, fetched Node/npm runtime
tests/               vitest (node + renderer) and the Playwright E2E suite
```

## Releases

Releases are cut from `main`. `npm run package:win|mac|linux` fetches the
runtime, builds, verifies it and produces the installers under `release/`.
Windows NSIS + portable is the primary artefact; macOS and Linux are beta.
`electron-builder.yml` publishes to GitHub Releases, which is also the
`electron-updater` feed. Artefacts are unsigned in v0.1.0; signing is backlog.

## Security

Do not open a public issue for a vulnerability. Report it privately to the
maintainers. The threat model and the app's isolation rules are documented in
[`docs/architecture/app-shell.md`](docs/architecture/app-shell.md) and
[`docs/product/parity.md`](docs/product/parity.md).

## License

MIT — see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
