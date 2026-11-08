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
npm run dev                # Electron + host bundle watch (src/host/** rebuilds)
```

`npm run runtime:fetch` is optional for typecheck/lint/unit tests (the live
runtime suites skip without it) but required for `dev`, `runtime:verify` and
packaging. `npm run doctor` probes the runtime, profile, extensions, bridge, git
and Office state on the current machine.

`npm run dev` starts `vite build --watch` for the host bundle and
`electron-vite dev` together through `scripts/dev.mjs`. The renderer dev server
is `http://127.0.0.1:5273`, deliberately not Vite's default 5173, which every
project dev server takes; `PI_DESKTOP_RENDERER_PORT` moves it when needed. The
app compares the running host's build id with the bundle on disk and recycles an
idle stale host before the next request, so editing `src/host/**` takes effect
without a manual restart. `npm run build:host` remains the one-shot build.

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
packages/checkpoints/  the publishable @dieulc/checkpoints package
resources/           vendored Office manifest, fetched Node/npm runtime
tests/               vitest (node + renderer) and the Playwright E2E suite
```

## Releases

Releases are cut from `main`. `npm run package:win|mac|linux` fetches the
runtime, builds, regenerates the host shims, runs `runtime:verify` and produces
the installers under `release/`. Windows NSIS + portable is the primary
artefact; macOS and Linux are beta. `electron-builder.yml` writes the artefacts,
and the tag-driven `release.yml` publishes them to GitHub Releases, which is also
the `electron-updater` feed. Artefacts are unsigned in v0.8.0; signing is
backlog. Mac builds are ad-hoc signed and report manual updates (Squirrel.Mac
rejects an ad-hoc update). The `afterPack` hook prunes `resources/runtime` to
the platform/arch being packaged, so an installer never carries another
platform's Node runtime.

Each platform's `package:*` script fetches every runtime that platform ships
(`package:linux` gets x64 **and** arm64, `package:mac` gets both macOS arches),
because a foreign runtime is verified statically — it is never executed — so a
Linux installer can be produced from a Windows machine and vice versa. `--all`
writes no shims (a shim names one platform's node binary), so `package:mac` and
`package:linux` run `runtime:shims` before `runtime:verify`; only the host
platform's runtime is additionally run through `--version`. Both arches of each
target come from `electron-builder.yml`; the scripts pass no arch flags.

All three platforms are built and published by
[`release.yml`](.github/workflows/release.yml) on a `v*` tag: each job runs on
its own OS, asserts the finished artefacts, and uploads the installers plus their
`latest*.yml` manifests to a **draft** Release that is published only once all
three succeed. A `workflow_dispatch` run with `publish: false` is the dry run.
The mechanics — and how to cut the next release — are in
[the release pipeline](docs/architecture/release-pipeline.md).

The checkpoint extension is a separately versioned npm package:
`@dieulc/checkpoints` in `packages/checkpoints`. Its version and tag are
independent of the app (`@dieulc/checkpoints@0.1.2`). Use:

```bash
npm run build:extension
npm run verify:extension
npm run release:extension:status -- --check
npm run release:extension -- --bump patch --branch dev --yes
```

`release:extension` defaults to `main`; pass `--branch dev` for a pre-merge
release. It runs the full gate, builds and verifies the tarball, commits only the
package manifest/changelog, publishes with npm, then tags and pushes. A stale
installed copy in a profile is updated with `pi update --extensions`.

To build Linux locally on a Linux machine (or WSL):

```bash
npm ci
npm run build
npm run runtime:fetch -- --platform linux-x64
npm run runtime:fetch -- --platform linux-arm64   # only for arm64 artefacts
npm run runtime:verify
npx electron-builder --linux --x64 --publish never  # add --arm64 for arm64
```

## Public site

The product site lives in `site/` (Astro + Starlight) with its own
`site/package-lock.json`. It is deployed by `.github/workflows/pages.yml` to
GitHub Pages. The Markdown in `docs/` is the source of truth; the generated files
under `site/src/content/docs/` are gitignored and must not be edited.

```bash
npm ci --prefix site
npm run site:dev          # sync docs/brand, then Astro dev
npm run site:sync         # regenerate docs and brand assets once
npm run site:check        # sync, astro check and site unit tests
npm run site:build        # build, link-check, built-output tests
npm run site:screenshots  # rebuild the app and capture the six landing images
```

`site:` changes are also gated by the `site` job in `.github/workflows/checks.yml`,
which does not install Electron. Keep the site package's dependencies exact-pinned
and do not add analytics or third-party runtime scripts.

## Security

Do not open a public issue for a vulnerability. Report it privately to the
maintainers. The threat model and the app's isolation rules are documented in
[`docs/architecture/app-shell.md`](docs/architecture/app-shell.md) and
[`docs/product/parity.md`](docs/product/parity.md).

## License

MIT — see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
