# Repo conventions

Pi Desktop is an Electron app that hosts the Pi coding agent. The plan is the
authority: `.pi/plans/2026-09-18-pi-desktop-app.md` (design) and
`.pi/plans/2026-09-19-pi-desktop-remaining-work.md` (the executable step list).

## Layout

```
src/main/        Electron main process (windows, IPC router, supervisor, office wizard wiring)
src/main/office/ UI-free Office setup backend (detect, registry, manifest, sideload, verify, wizard)
src/main/packages/ Pi-compatible package plumbing for pre-host bootstrap
src/preload/     the only place that touches contextBridge/ipcRenderer
src/renderer/    React app (app chrome, panels, dialogs, TUI surface)
src/host/        Pi host process: runs the SDK under the bundled Node runtime
src/shared/      types + constants shared by all of the above
resources/       vendored Office manifest, fetched Node/npm runtime
tests/           vitest suites (node environment)
```

## Hard rules

1. **`src/main/office/**`, `src/main/packages/**` and `src/host/**` never import
   `electron`.** They are pure Node so they stay unit-testable and can run in
   the host process. Enforced by `tests/architecture/no-electron-in-core.test.ts`.
2. **All filesystem/platform access goes through an injected port** (`FsPort`,
   `CommandRunner`, `FetchLike`, `openPath`, `now`, `sleep`). No `node:fs` calls
   directly in modules that need tests.
3. **Never hand-write Pi state.** `settings.json`, `auth.json`, `models.json`
   and session JSONL files are written through the SDK managers
   (`SettingsManager`, `ModelRuntime`, `SessionManager`) or, pre-host, through
   the atomic helpers in `src/main/packages/settings.ts`.
4. **SDK contact stays inside `src/host/sdk/*`** so a pi upgrade touches one
   directory.
5. **User data is never overwritten on parse failure.** Malformed JSON throws
   (`SettingsParseError`) and is surfaced, not repaired silently.
6. **Every new module ships with unit tests in the same step**, using the
   in-memory ports where possible.

## Style

- TypeScript strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- Relative imports, no path aliases.
- Prettier: 100 columns, double quotes, semicolons, trailing commas.
- ESLint flat config; `npm run lint` must be clean.
- Tests: `npm test` (vitest). `npm run typecheck` runs both TS projects.

## Workflow

- `npm run dev` starts the Electron app with the renderer dev server.
- `npm run build` builds the host bundle plus main/preload/renderer.
- `npm run package:win|mac|linux` produces installers (unsigned; signing is backlog B1/B2).
- One plan step per change set; keep `typecheck`, `lint` and `test` green at every step boundary.
