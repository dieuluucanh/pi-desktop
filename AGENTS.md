# Repo conventions

Pi Desktop is an Electron app that hosts the Pi coding agent. The plan is the
authority: **`.pi/plans/2026-09-19-pi-desktop-core-first-rebaseline.md`** (the
executable step list — core-first: Pi agent GUI first, Pi for Office re-homed as
an optional integration), with `.pi/plans/2026-09-18-pi-desktop-app.md` as the
design authority for everything the plan does not amend. `.pi/plans/*` is
gitignored, so keep it in sync locally.

## Layout

```text
src/main/        Electron main process (windows, app menu, IPC router, supervisor, office wiring)
src/main/office/ UI-free Office setup backend (detect, registry, manifest, sideload, verify, wizard)
src/main/packages/ Pi-compatible package plumbing for pre-host bootstrap
src/git/         the git engine (runner, repo, status, diff, service) — pure Node
src/checkpoints/ the shadow-repo checkpoint engine, its fs adapter and config — pure Node
src/extensions/  the app's own Pi extension (run snapshots + /rewind) — pure Node, no SDK import
src/preload/     the only place that touches contextBridge/ipcRenderer
src/renderer/src/layout/   app chrome: title bar, sidebar, tab strip, status bar, palette, RightRail
src/renderer/src/rail/     the right rail's five section bodies and their dialogs
src/renderer/src/views/    one module per full-page view (welcome, session, settings, …)
src/renderer/src/ui/       owned primitives on Radix (button, dialog, scroll area, …)
src/renderer/src/state/    renderer view state (zustand); never talks to a Pi host directly
src/renderer/src/styles/   tokens.css is the only source of theme values (Tailwind v4 @theme)
src/host/        Pi host process: runs the SDK under the bundled Node runtime
src/shared/      types + constants shared by all of the above (ipc.ts is the IPC allowlist)
resources/       vendored Office manifest, fetched Node/npm runtime
tests/           vitest: node project (tests/**) + jsdom renderer project (tests/renderer/)
```

## Hard rules

1. **`src/main/office/**`, `src/main/packages/**`, `src/host/**`, `src/git/**`,
   `src/checkpoints/**` and `src/extensions/**` never import `electron`** — and
   neither do `src/main/git-service.ts` / `src/main/checkpoint-service.ts`. They
   are pure Node so they stay unit-testable and can run in the host process; the
   Electron facts (`trashItem`, window focus, the Office pane registry) arrive as
   injected ports. Enforced by `tests/architecture/no-electron-in-core.test.ts`.
2. **All filesystem/platform access goes through an injected port** (`FsPort`,
   `CommandRunner`, `FetchLike`, `openPath`, `now`, `sleep`). No `node:fs` calls
   directly in modules that need tests.
3. **Never hand-write Pi state.** `settings.json`, `auth.json`, `models.json`
   and session JSONL files are written through the SDK managers
   (`SettingsManager`, `ModelRuntime`, `SessionManager`) or, pre-host, through
   the atomic helpers in `src/main/packages/settings.ts`.
4. **SDK contact stays inside `src/host/sdk/*`** so a pi upgrade touches one
   directory. `src/extensions/**` mirrors the few SDK members it uses as a
   structural interface instead of importing them — that is what lets
   `dist/pi-checkpoints/` load with no `node_modules` beside it.
5. **User data is never overwritten on parse failure.** Malformed JSON throws
   (`SettingsParseError`) and is surfaced, not repaired silently.
6. **Every new module ships with unit tests in the same step**, using the
   in-memory ports where possible.
7. **Checkpoint writes never touch the project's `.git`.** Every checkpoint
   invocation is `git --git-dir=<profile>/checkpoints/<key> --work-tree=<project>`,
   and the shadow repo's `info/exclude` carries the default ignores. See
   `docs/architecture/source-control.md`.
8. **The checkpoint config has one writer.** `prefs.checkpoints` is the source;
   main projects it to `<profile>/checkpoints/config.json`, and the host-side
   extension only reads it. Never add a second writable copy.
9. **Safe mode must hard-disable the checkpoint extension.** `noExtensions` does
   _not_ gate `additionalExtensionPaths` — use
   `checkpointExtensionLoaderOptions` in `src/host/safe-mode.ts`, which is the one
   place the decision is made.

## Style

- TypeScript strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- Relative imports, no path aliases.
- Prettier: 100 columns, double quotes, semicolons, trailing commas.
- ESLint flat config; `npm run lint` must be clean.
- Renderer styling: Tailwind v4 utilities plus `src/renderer/src/ui/*` primitives
  (shadcn-style, built on Radix). Never hard-code a colour, radius or font — add
  or use a token in `src/renderer/src/styles/tokens.css`.
- Global keyboard accelerators belong to the Electron menu (`src/main/menu.ts`),
  which forwards typed `MenuCommand`s to the renderer; the renderer only owns
  keys local to a component (command palette, dialogs, composer).
- Tests: `npm test` (vitest, node + renderer projects). `npm run typecheck` runs
  both TS projects.

## Workflow

- `npm run dev` starts the Electron app with main/preload watch, the host bundle
  watch and the renderer dev server.
- `npm run build` builds the host bundle plus main/preload/renderer.
- `npm run package:win|mac|linux` produces installers (unsigned; signing is backlog B1/B2).
- One plan step per change set; commit as `feat(<area>): <what> (plan step N)`.
- Gates before every commit: `npm run format:check && npm run typecheck && npm run lint && npm test && npm run build`.
  Assert exit codes without piping (`cmd > /tmp/x.log 2>&1; echo $?`).
