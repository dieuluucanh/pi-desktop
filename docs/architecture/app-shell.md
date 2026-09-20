# The app shell: IA, view model, theme tokens, shortcuts

**Plan step 1.** This document is the reference for the window's structure; later
steps must extend it rather than re-invent it.

## Regions

```text
title bar        brand, active project, Open project…, New session
sidebar          + New session · Open project… · Project · Sessions · Views · Integrations
tab strip        session tabs (empty until step 11) + the "+" action
main area        the active view (welcome | session | settings | extensions |
                 connections | skills | diagnostics | office)
status bar       Pi profile · bundled runtime · view mode · transient hints
overlays         command palette (Ctrl+K), toast host
```

The sidebar and the tab strip are fixed parts of the frame: step 11 fills the tab
strip, step 10 fills the project section — neither re-lays-out the window.

## View model

- `src/renderer/src/state/app-store.ts` (zustand) owns `view`, `project`, `prefs`,
  `paletteOpen`, `info` and a one-line `hint`.
- Views are keyed in `src/renderer/src/App.tsx` (`VIEWS`) and rendered one at a
  time. No URL router: a desktop app has no address bar, and the palette + menu
  are the navigation.
- **The renderer never talks to a Pi host directly.** Sessions will be addressed
  through the main process (step 3). Today the store holds only app state.
- `prefs` is the only persisted part, written through `prefs.*` IPC into
  `userData/app-state.json` by the main process (`src/main/app-store.ts`), which
  validates the patch against a closed key set (`src/shared/prefs.ts`). Projects
  and tabs become persistent in steps 10 and 11.
- **Extensions hub (plan step 13).** `ExtensionsView` lists Pi's loaded
  extensions/skills/prompts/themes through the host's `resources.list` (a live
  session host when one is active, otherwise the control host, which loads a
  `DefaultResourceLoader` on demand). Enable/disable edits the `extensions` /
  `skills` / `prompts` / `themes` settings arrays (`-path` / `+path`), so the
  change is reversible and visible to terminal Pi. The shipped Pi for Office
  wizard stays mounted, unchanged, under Extensions → Integrations (plan D-A10).

## Command ownership (no double-firing)

| Surface                                       | Owns                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron menu (`src/main/menu.ts`)            | every global accelerator: `Ctrl+N` new session, `Ctrl+O` open project, `Ctrl+W` close session, `Ctrl+,` settings, `Ctrl+K` palette, `Ctrl+B` sidebar, `Ctrl+Tab` / `Ctrl+Shift+Tab` tab cycling, `Ctrl+/` shortcuts |
| Renderer (`src/renderer/src/menu-actions.ts`) | the _behaviour_ of each command, dispatched from `app:menu-command`                                                                                                                                                 |
| Renderer (`CommandPalette`)                   | palette-local keys only (arrow/enter/escape)                                                                                                                                                                        |

Menu items never touch windows: they forward a `MenuCommand` (typed in
`src/shared/ipc.ts`), so the renderer stays the single owner of view state. A
command whose feature lands later reports a precise hint (`hint` in the store →
status bar) instead of failing silently.

## Theme tokens

`src/renderer/src/styles/tokens.css` is the only place with colour, radius and
font values; it declares Tailwind v4 `@theme` variables (`--color-*`) plus a
`[data-theme="light"]` override. Components use utilities
(`bg-surface text-ink border-line`) or `var(--color-*)` in the few plain-CSS
files. `App.tsx` sets `data-theme` from the `theme` preference (`system` follows
`prefers-color-scheme`). Step 15 maps the active Pi theme onto these same tokens,
so the app chrome and the extension TUI surface stay in step.

## App files (step 1)

```
src/shared/prefs.ts            preference key set, defaults, clamping, merge
src/shared/ipc.ts              the IPC allowlist + MenuCommand union + AppInfo
src/main/menu.ts               the menu template (pure, unit tested) + installer
src/main/ipc.ts               handlers + validation for every renderer channel
src/main/app-store.ts          atomic app state (projects, prefs, tabs)
src/renderer/src/App.tsx       regions + view routing + theme + menu dispatch
src/renderer/src/menu-actions.ts  what each command does today
src/renderer/src/state/app-store.ts  view state (zustand)
src/renderer/src/layout/*      TitleBar, Sidebar, TabStrip, StatusBar, CommandPalette
src/renderer/src/views/*       Welcome, Session, Settings, Extensions, Connections,
                               Skills, Diagnostics, Office
src/renderer/src/ui/*          Button, Badge, Kbd, Separator, Dialog, DropdownMenu,
                               ScrollArea, Switch, Toaster
src/renderer/src/styles/*      tokens.css (Tailwind + theme tokens), office-panel.css
```

`src/renderer/src/styles/office-panel.css` is temporary: it keeps the shipped Pi
for Office wizard rendering exactly as before while step 19 migrates that panel
to `ui/*` primitives.

## Tests

- `tests/main/prefs.test.ts` — validation/clamping/merge of the preference patch.
- `tests/main/menu.test.ts` — every `MenuCommand` has exactly one menu item, New
  Session keeps `Ctrl+N`, Office stays out of the primary menus.
- `tests/renderer/shell.test.tsx` — the shell renders navigation and the welcome
  state, and the old scaffold placeholder copy is gone.
- `tests/renderer/extensions.test.tsx` — the Office wizard still mounts under
  Extensions → Integrations, and the hub lists resources, shows load/live errors,
  writes an enable/disable override and offers the recommended set.

The renderer project is configured in `vitest.config.ts` (`projects`), with
`tests/renderer/setup.ts` for jest-dom and Testing Library cleanup.
