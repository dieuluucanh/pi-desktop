# The app shell: IA, view model, theme tokens, shortcuts

**Plan step 1.** This document is the reference for the window's structure; later
steps must extend it rather than re-invent it.

## Regions

```text
title bar        brand, active project, Open project…, New session
sidebar          + New session · Open project… · Project · Sessions · Views
tab strip        session tabs (empty until step 11) + the "+" action
main area        the active view (welcome | session | settings | extensions |
                 connections | skills | diagnostics)
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
  change is reversible and visible to terminal Pi.
- **Integrations (plan step 19).** `OfficeIntegrationCard` is the only Office
  surface in the app (plan D-A10): it derives its facts
  (`src/shared/integrations.ts`) from the wizard view plus the package manager's
  installed list, and folds the unchanged `OfficeSetupPanel` in as detailed
  evidence. The bridge install goes through the same consent dialog as any
  package (`packages.install`), and the app records that consent in its own
  state (`app-state.json#integrations`, written by
  `src/main/integrations-service.ts`). The sidebar, palette and `AppView` union
  carry no Office entry; the Integrations menu item routes to the hub with
  `extensionsFocus: "integrations"`.
- **The app's own record is not Pi state.** `integrations` in `app-state.json`
  only remembers what Pi cannot: that the user consented to the bridge install
  here and when setup last completed. Whether a package is installed stays a
  `packages` entry in Pi's `settings.json`, which terminal Pi also sees.
- **Documents panel (plan step 20).** `DocumentsPanel` is the session's right
  rail: it renders only while the bridge answers `/health` (plan D-A10) and lists
  every attached task pane with its facts and actions. The registry is the main
  process's `/health` poll (`src/main/office/documents-service.ts`), pushed over
  `office:documents-state`; the pure projection lives in
  `src/shared/office-documents.ts` and also feeds the `#` completion source and
  the office tool cards. A session tab that owns port 38617 is the **Office
  host**; the panel's footer names it or offers _Promote to Office host_.
- **Web tabs (plan step 21).** A `web` tab is a page the app did not write — a
  Plannotator review served on a loopback port, or any localhost UI. It has no Pi
  host: `src/shared/session-ipc.ts` carries only its record (`url`,
  `sessionTabId`) and main owns the page in `src/main/web-tabs.ts`, an
  Electron-free service whose `WebContentsView` is injected by
  `src/main/web-view-host.ts`. The renderer draws the chrome (`WebTabView`) and
  reports the rectangle the native view must occupy over `web:set-bounds`; a
  native view always paints above React, so the chrome reports `visible: false`
  whenever a dialog/menu is open (`src/renderer/src/web/overlay-detect.ts`). A
  loopback URL that arrives in an extension notification or tool result opens a
  tab automatically (`openLoopbackUrl`); anything else that would leave the page
  is refused and answered through `WebNavigationDialog`. Security is structural:
  every web tab shares one partition with no preload, `sandbox: true`,
  `contextIsolation: true` and all permissions denied, so `window.pi` never
  exists in it and it cannot reach the Pi bridge.

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

```text
src/shared/prefs.ts            preference key set, defaults, clamping, merge
src/shared/ipc.ts              the IPC allowlist + MenuCommand union + AppInfo
src/main/menu.ts               the menu template (pure, unit tested) + installer
src/main/ipc.ts               handlers + validation for every renderer channel
src/main/app-store.ts          atomic app state (projects, prefs, tabs, integrations)
src/main/integrations-service.ts  the consented-install record (plan step 19)
src/main/office/documents-service.ts  the live /health pane-registry poll (step 20)
src/shared/office-documents.ts  the pure pane projection + mention/target helpers
src/shared/web-tabs.ts         the web-tab wire model, URL policy and review parse
src/main/web-tabs.ts           the Electron-free web-tab service (policy + reconciliation)
src/main/web-view-host.ts      the WebContentsView adapter (isolated partition, no preload)
src/renderer/src/App.tsx       regions + view routing + theme + menu dispatch
src/renderer/src/menu-actions.ts  what each command does today
src/renderer/src/state/app-store.ts  view state (zustand)
src/renderer/src/layout/*      TitleBar, Sidebar, TabStrip, StatusBar, CommandPalette
src/renderer/src/views/*       Welcome, Session, Settings, Extensions, Connections,
                               Skills, Diagnostics
src/renderer/src/office/*      OfficeIntegrationCard, DocumentsPanel + the unchanged wizard panel
src/renderer/src/web/*         WebTabView chrome, the URL/navigation dialogs, overlay detect
src/renderer/src/session/*     Transcript, Composer, OfficeToolCard, …
src/renderer/src/ui/*          Button, Badge, Kbd, Separator, Dialog, DropdownMenu,
                               ScrollArea, Switch, Toaster
src/renderer/src/styles/*      tokens.css (Tailwind + theme tokens), office-panel.css
```

`src/renderer/src/styles/office-panel.css` keeps the shipped Pi for Office
wizard panel rendering exactly as before; the card around it uses `ui/*`
primitives. Migrating the panel itself to `ui/*` is not required by step 19.

## Tests

- `tests/main/prefs.test.ts` — validation/clamping/merge of the preference patch.
- `tests/main/integrations-service.test.ts` — the consented-install record goes
  through the store's sanitizer and keeps unknown keys out.
- `tests/main/menu.test.ts` — every `MenuCommand` has exactly one menu item, New
  Session keeps `Ctrl+N`, Office stays out of the primary menus.
- `tests/renderer/shell.test.tsx` — the shell renders navigation and the welcome
  state, the old scaffold placeholder copy is gone, and Pi for Office is not a
  primary-navigation button.
- `tests/renderer/extensions.test.tsx` — the Office card mounts under Extensions →
  Integrations and the wizard panel appears once the bridge is installed; the hub
  lists resources, shows load/live errors, writes an enable/disable override and
  offers the recommended set.
- `tests/renderer/office-integration-card.test.tsx` — the card's derived facts,
  the consented install, the diagnostics copy and the completed-setup record.
- `tests/renderer/integration-store.test.ts` — `installOfficeBridge` opens the
  standard consent dialog, and `openOfficeSession` focuses rather than duplicates
  an Office tab.
- `tests/shared/integrations.test.ts` — the facts derivation and record
  sanitizers (pure, node project).
- `tests/main/office-documents-service.test.ts` — the registry poll projects
  `/health`, rejects another service on the port, emits only on change and stops
  cleanly (plan step 20).
- `tests/renderer/documents-panel.test.tsx`, `tests/renderer/office-tool-card.test.tsx`
  — the right rail and the office tool cards (plan step 20).
- `tests/renderer/office-documents-store.test.ts` — the registry in the store,
  the `#`-tagged composer draft and Office-host promotion.
- `tests/shared/web-tabs.test.ts` — the URL policy (only http(s), loopback
  classification, URL extraction from prose), the state/command/bounds
  sanitizers and the Plannotator decision parser (plan step 21).
- `tests/shared/session-ipc.test.ts` — a web tab survives the app-state
  sanitizer only with a permitted URL; a host-backed tab needs a folder.
- `tests/main/web-tabs.test.ts` — reconciliation with the tab table, the chrome
  commands, and the navigation policy (loopback loads without a prompt).
- `tests/renderer/web-tab-store.test.ts` — the pushed state, one tab per URL,
  the chrome commands, bounds reporting and the navigation decision.
- `tests/renderer/web-tab-view.test.tsx` — the toolbar, retry affordance, the
  rectangle reported to main, and the URL/navigation dialogs.

The renderer project is configured in `vitest.config.ts` (`projects`), with
`tests/renderer/setup.ts` for jest-dom and Testing Library cleanup.
