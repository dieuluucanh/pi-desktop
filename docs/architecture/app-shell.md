# The app shell: IA, view model, theme tokens, shortcuts

**Plan step 1.** This document is the reference for the window's structure; later
steps must extend it rather than re-invent it.

## Regions

```text
tab strip        session tabs (the topmost app row; the OS frame owns the window
                 controls) + New session, New terminal + its profile chevron,
                 and the grid-layout switcher at the right
editor tab strip editor tabs in a second row under the session strip; it
                 renders only while at least one file is open
sidebar          Projects (+ menu: default · new · clone · open folder) ·
                 Sessions · Views
main area        the active view (welcome | session | settings | extensions |
                 connections | skills | diagnostics)
status bar       active project path · build version · Pi profile · bundled
                 runtime · display zoom · transient hints · notifications
panel rail       docked at the right edge of a session: an always-visible 44 px
                 menu strip (Source Control · Checkpoints · Documents) beside one
                 resizable panel body; the strip's order is user-adjustable
session footer   one responsive status rail under the composer: pwd (branch) ·
                 tokens/cost/context · model • thinking · extension statuses
                 (ctx.ui.setStatus) · single-line extension widgets; an extension
                 ctx.ui.setFooter() replaces the whole footer
overlays         command palette (Ctrl+K), toast host
```

The sidebar and the tab strip are fixed parts of the frame: step 11 fills the tab
strip, step 10 fills the project section — neither re-lays-out the window. The
in-app title bar was removed in the 2026-10-31 minimal-session-ui pass; the brand
mark survives in the welcome/onboarding views and the OS window title is set by
`app:set-title`.

**Two tab rows, one workbench (2026-11-02 editor-tabs plan).** Sessions, the
Office host and web tabs stay in the top strip. File tabs get their own row
directly beneath it, still inside `<main>`, so the sidebar and the panel rail
bound both rows. The editor row renders nothing until a file is open, and both
rows share one `activeTabId`: clicking a file replaces the main view rather than
creating a second pane. Both rows scroll horizontally with the mouse wheel, reveal the active tab when
the selection changes, and keep the user's manual scroll position across window
focus and tab updates. The tab-strip horizontal scrollbar is 2 px (the app
default is 10 px); the strips reset `scrollbar-width`/`scrollbar-color` to
`auto` so the WebKit pixel size is not overridden by the standard properties,
with the native thin bar as the fallback. The sidebar's project groups list only
the session row's tabs (sessions, the Office host and web tabs); file tabs are
never repeated there and live only in the editor row.

**The chip is identity, not chrome (2026-11-03 tab-strip plan).** A chip renders
its kind glyph, the title and the close × — there is no per-tab overflow button in
either strip, so the `max-w-48` title owns the freed width. The lifecycle menu
(`layout/TabMenu.tsx`, one `tabMenuItems()` list) opens by right-click or, from
the keyboard, `Shift+F10` / the Menu key: `openTabContextMenuFromKeyboard`
synthesizes the `contextmenu` event Radix listens for. The sidebar session rows
keep their hover-revealed “…” dropdown, which renders the same list.

**Session view grid (2026-11-03 grid plan).** The content area — the `<section>`
under both strips — can show several tabs at once. The tab strips, the sidebar
and the panel rail stay global chrome; only the content area splits.

- **Five presets**, no draggable splitters: `single`, `two` (two full-height
  columns), `three-left` (left pane full height, right column split),
  `three-right` (mirrored) and `four` (2×2). `shared/session-grid.ts` owns the
  pane count and visibility math; `layout/pane-areas.ts` owns the complete
  Tailwind placement literals (`col-start`, `row-start`, `row-span`) so CSS
  auto-placement cannot push a pane into an implicit row. The geometry is unit
  tested without a DOM.
- **A pane is one `TabRecord`** (`session`, `office`, `web`, `editor` or
  `terminal`, from any
  project), rendered by `views/TabSurface.tsx` — the same kind dispatcher the
  solo view uses. `editor-store`, `editor-registry` and the web-tab service are
  keyed by tab id, so **one tab may be visible in one pane only**: assigning a tab
  another pane already holds swaps the two slots (`assignGridPane`).
- **The focused pane is `activeTabId`.** Clicking a pane activates its tab, which
  is what menus, the palette, the rail scope and the window title already follow.
  Several mounted `SessionView`s therefore each render their own tab; the two
  `window` key listeners (find, jump-to-bottom) and the editor's mount focus are
  gated on the focused tab.
- **Solo mode is derived.** `prefs.grid.layout` stays authoritative. Activating a
  tab that no **visible** pane holds shows it full-size; activating a pane's tab
  returns to the grid. `gridMode()` is the single decision, and no mode flag is
  stored. A split layout with no active tab shows the **empty grid**, which is
  what makes clearing the last pane stay in the grid. The layout and every
  assignment survive a trip through Single.
- **Drag reveals the grid.** While a tab drag is active from a solo view,
  `gridSurface()` renders the remembered multi layout (`lastMultiLayout`) at
  reduced opacity so every pane is a drop target. A drop adopts that layout; a
  cancelled drag restores solo without writing prefs.
- **Persistence.** `prefs.grid = { layout, lastMultiLayout, panes }`; `panes` is a
  fixed four-slot array, so hidden assignments survive a smaller preset.
  `applyTabs` clears a closed tab's slot to `null` (never re-flows the layout) and
  writes prefs only when something actually changed.
- **Clearing a pane keeps the grid.** The header `×` removes that pane's
  assignment only; the session stays open in the tab strip. If the cleared pane
  held the active tab, focus moves cyclically to the next occupied visible pane;
  if none is left, `activeTabId` becomes `null` and the split layout stays on the
  empty grid. Header controls carry `data-pane-control`, so pointer-down on the
  clear button or picker chevron does not first focus the tab being removed.
- **Host pinning.** The renderer pushes the mounted pane tabs over
  `session:set-visible`; main feeds them to `keepHostAlive`, excludes them from
  `parkTab`/`idleCandidates` and raises `reclaimHosts`' floor. The per-host RSS
  watchdog still applies, and panes wake lazily on first interaction, so a
  four-pane layout never spawns four hosts by itself.
- **Web panes.** A web view's visibility is now what its pane reports, not
  `tabId === activeTabId`; eviction only ever takes a hidden view and
  `MAX_LIVE_WEB_VIEWS` is 6 (four panes may each show one).

Entry points: the icon-only layout switcher at the far right of the session strip
(`layout/GridLayoutMenu.tsx`), View ▸ Layout in the menu, and the command palette.
The switcher trigger shows the current preset. To its left sit New Terminal,
the Terminal profiles chevron (`layout/TerminalProfileMenu.tsx`) and New Session,
in that order; the chevron opens a one-off terminal with another detected shell
without changing the default. Its five icons run widest to
narrowest — four panes at the far left, then the two three-pane shapes, two
columns, and single at the far right. They have accessible names, not visible
labels. Each pane has **one controlled
`layout/PanePicker.tsx`**; its header chevron is the sole trigger and anchor. The
empty pane's centred `+` button opens that same menu, so it also hangs from the
chevron rather than the centre of the pane. Only the `+` is clickable — “Pick a
session” and “or drop a tab here” are plain text. The menu lists session tabs
grouped by project, then editor tabs, then a route into the session browser. A
tab can also be dragged from either strip or the sidebar onto a pane
(`shared/tab-drag.ts`, MIME `application/x-pi-tab`, no `text/plain` copy).

**Two surfaces, one job each (2026-10-31 minimal-session-ui).** The status bar is
app-level and mounted on every view; it never carries session facts. It shows the
active project path on the left and the app facts on the right. Everything
session-scoped lives in `SessionFooter`, under the composer, the way terminal Pi
binds its footer to the editor: `pwd (branch)`, the token/cost/context facts,
`model • thinking`, the extension statuses (`ctx.ui.setStatus`) — for example the
Office bridge's `office: Excel attached (bridge :38617)` or pi-lens'
`pi-lens-lsp` line — and single-line component widgets. They share one
`flex-wrap` rail (2026-10-31 UI plan), so a wide window uses one row and a narrow
one wraps instead of always stacking three rows; long items truncate and keep
the full value in `title`. An extension's `ctx.ui.setFooter()` **replaces** that
built-in footer rather than stacking above it; the custom footer then owns the
statuses, exactly as Pi hands its factory a `FooterDataProvider`. The built-in
footer renders as a **sibling of the editor branch**, not inside `<Composer>`, so
it survives when an extension shows a non-overlay `ctx.ui.custom()` UI and
`<TuiSurface>` replaces the composer. An extension's
`ctx.ui.setEditorComponent()` is recorded but never mounted: the native composer
is always the editor (2026-10-26 plan).

**Right-click is the platform's editing menu.** Electron ships no default
context menu, so the app builds one from `src/main/context-menu.ts` and attaches
it to the main window's `webContents`: Undo / Redo / Cut / Paste / Select All for
an editable field, and Copy for any non-collapsed selection — including a
selection inside the extension TUI surface, where Ctrl+C normally belongs to the
terminal. The template is pure and unit-tested; `index.ts` only supplies the
`webContents` actions (2026-10-30 copy plan).

**Display zoom is an app fact (2026-10-30 zoom plan).** The factor lives in
`prefs.zoomFactor` (50 %–300 %, discrete levels) and is applied by main with
`webContents.setZoomFactor` to every window. The status bar carries the always-
visible `− 100 % +` cluster (the application menu is hidden on Windows/Linux
until Alt), Settings has a Display zoom row, and View → Zoom In / Zoom Out /
Actual Size use explicit `Ctrl/Cmd+=`, `Ctrl/Cmd+-` and `Ctrl/Cmd+0`
accelerators. The Electron zoom roles were removed because `zoomIn` binds
`Ctrl+Shift+=` on Windows/Linux (`electron#40674`) — the reported "zoom does
not work". The factor is re-applied on `did-finish-load` because Chromium keeps
a per-origin zoom map.

**The chrome palette is app-owned and high-contrast (2026-10-31).** The active
Pi theme still supplies accent and status hues, but the Desktop owns the neutral
surfaces and separators: `APP_CHROME_SWATCHES` (in `src/shared/themes.ts`) is
mirrored by `src/renderer/src/styles/tokens.css`, and `applyChromeTheme` maps
all 14 chrome tokens (`canvas`, `surface`, `raised`, `sunken`, `line`,
`line-strong`, `ink`, `ink-muted`, `ink-faint`, accent, info, ok, warn, danger). Dark
is deliberately high-contrast; tests guard the separator contrast and the
`tokens.css` values. Per-theme overrides live in `prefs.themeColors` and are
edited in Skills → Themes; they never write a Pi theme file.

**Extension interactions live in the session column (2026-10-26).**
`ctx.ui.select/confirm/input/editor` render as an inline `ExtensionDialogDock`
in the composer region, not as a Radix modal: the transcript stays visible and
scrollable, Esc/Enter stay with the dock, and the store enforces the
extension's timeout even when its tab is in the background. A bottom-anchored,
full-width `ctx.ui.custom({overlay:true})` component (the Workflow
questionnaire) is an in-flow **dock** that replaces the composer; any other
overlay floats inside the column with no dim backdrop. While either owns the
keyboard, clicking the transcript re-focuses it and a floating overlay makes the
composer `inert`. Component-factory widgets (`ctx.ui.setWidget(key, factory)`)
render as read-only TUI frames above/below the editor dock, next to the
existing string-array widget strip. A component frame with exactly one line is
rendered as a footer column instead of its own strip (2026-10-31 UI plan);
multi-line frames keep Pi's placement. The TUI grid is measured from this column,
never from the surface's own rendered frame (`src/renderer/src/tui/use-tui-viewport.ts`).

**The workflow mode is shown as text, not just colour.** The composer's textarea
border reflects the Workflow extension's mode (`Plan` → warn, `Build` → accent),
decoded from its status text by `src/shared/workflow-mode.ts`; an unrecognised
value degrades to the neutral border rather than guessing. The desktop names
exactly the extension's three modes (Default/Plan/Build): the Plannotator
`reviewing in browser` phrase is a Plan sub-state, so the composer label reads
the mode — `Plan` — never the sub-state (2026-10-20 startup-tab-cycle plan).
Because colour alone is not an indicator, the mode is also named in the
composer's top-right corner, exposed through `role="status"`. Every
recognised mode has a label, including `Default`; Plan/Build use the same
`text-warn`/`text-accent` tone as the border, and Default uses the readable
faint ink. The label renders at every
window width — it used to be hidden below the `sm` breakpoint — and there is no
duplicate `mode: …` chip in the footer (2026-10-31 minimal-session-ui).

**The composer says where the cursor is (2026-10-21).** The textarea's caret
carries the app's accent colour, and the composer's status row spells the
position out (`Ln 2 · Col 7`) next to the shortcut hints. The offset is the one
the completion engine already tracks (`caretRef`), so the readout and the
providers can never disagree; `src/renderer/src/session/caret.ts` turns the
offset into the line/column pair.

**Both composers grow with their content (2026-11-01).** The session prompt and
the Source Control commit message use one shared `useAutoGrowTextarea` hook
(`src/renderer/src/ui/auto-grow.ts`): it measures `scrollHeight` plus the border
and writes an explicit height, capped at 192 px for the prompt and 160 px for
the commit message. Past the cap the box scrolls. The session prompt no longer
has a manual `resize-y` handle — the next keystroke would overwrite the drag —
while the commit box keeps `resize-none`. The two-row floor comes from `rows=2`
and the CSS minimum; no height is persisted.

**The thinking picker shows the whole scale (2026-11-01).**
`thinkingLevelOptions()` in `src/shared/thinking.ts` unions the canonical seven
levels with any custom level the host reported, keeps canonical order and marks
support. `ThinkingPicker` renders every row and disables the ones the current
model does not expose, with a “not supported” marker and a tooltip naming the
model; the enabled set follows the selected model. The model picker's per-model
preview and the `/thinking` completion remain supported-only, because they are
capability hints rather than the selector.

**The composer completes three levels (2026-10-24).** `/` names a command;
after the first space the same provider asks for the command's arguments
(extension hooks via `commands.complete`, app completers for `/model`,
`/thinking` and `/login`); `@` and `#` remain file and document sources. The
first line of a `/` buffer is never treated as a path, including its argument
section, so Tab re-queries the command menu rather than forcing files. Argument
items replace their whole prefix verbatim, command names keep the trailing
space, and Enter on a command-name suggestion runs it in one keystroke while an
argument suggestion only fills.

**The session column is transcript-first (2026-10-31 minimal-session-ui).** There
is no session header any more: the tab strip owns the title (with rename in its
menu), the status dot and the linked review tabs; the composer owns Stop and the
compact model/thinking/context controls in the blank space above Send; the error
banner owns Restart; a stopped session wakes on typing. The view keeps only an
`sr-only` `<h1>` for the accessible name, so the freed rows go to the transcript.
Tool-card detail is still not a header control: Ctrl+O (or each card's chevron)
is the one expand-all switch (2026-10-30 copy plan removed the
Normal/Verbose/Summary menu).

**Global CSS lives in `@layer base`.** Tailwind v4 emits its own rules into
cascade layers, and in CSS an _unlayered_ rule beats every layered one regardless
of specificity. `src/renderer/src/styles.css` therefore wraps its document-level
rules in `@layer base`; a bare `:focus-visible` there used to override Tailwind's
`.outline-none` utility and painted a blue ring over the mode-coloured composer
border. `tests/styles-layering.test.ts` fails if a future rule is added outside
the layer. (The workflow border class literals live in `src/shared/`, outside the
renderer's Tailwind scan root, so `styles.css` also declares them with
`@source`/`@source inline(...)`; the same test pins that list against
`workflowBorderClass`.)

## View model

- **Product views scroll the full main area (2026-11-01).** Settings,
  Extensions, Connections, Skills and Diagnostics render through
  `src/renderer/src/views/ViewShell.tsx`: a full-width `h-full overflow-y-auto`
  outer element (scrollbar at the far-right edge, wheel works over the gutters)
  around a centred `mx-auto w-full min-h-full max-w-4xl/3xl` content column. The
  inner column keeps the old readable width; the outer element is the only
  scroller. Welcome is unchanged.
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
  and tabs become persistent in steps 10 and 11. The closed set also carries the
  transcript's display-only command-prompt state: `showExpandedPrompts`
  (default off) and the bounded `promptOrigins`
  `hash(message text) -> raw command` map used to keep collapsed command rows
  after a restart; neither holds the expanded prompt body.
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
- **Docked panel rail (2026-10-29 plan).** The session's right edge carries an
  always-visible 44 px menu **strip** — Source Control, Checkpoints, Documents —
  beside one resizable panel body. Clicking an entry expands its body, clicking
  the active entry collapses it back to the strip, and the strip's order is
  user-adjustable by dragging an entry (there is no per-entry reorder menu).
  The panel body clamps to 200 px at its narrowest — the same floor as the
  sidebar — while the 44 px strip remains additional chrome.
  `prefs.rail` persists `{ open, activeMenu, width, order, split, collapsed }`;
  the strip is never unmounted, which is what makes it the stable entry point
  (the old header button
  was gated on the Office bridge and so came and went). A menu this session does
  not have — Documents with no `/health` — is resolved at render time to the first
  available menu without rewriting the user's choice.
- **Source Control is three blocks (2026-10-29 plan).** The body stacks
  Source Control (branch row, commit composer, collapsible Stashes), Changes and
  Commit History, each with its own scroller, separated by two draggable
  `BlockSplitter`s whose sizes persist in `prefs.rail.split`. `Staged Changes`,
  `Changes` and `Stashes` fold independently (`prefs.rail.collapsed`; Stashes
  start collapsed). A render-time clamp is never written back — only a drag, a
  key or a double-click reset persists.
- **Block headers are pinned (2026-10-30 rail-headers plan).** Each block's header
  is its scroller's first child: `sticky top-0` with an opaque `bg-surface` and a
  hairline, so the block's name, count and _Refresh_ stay visible while the rows
  scroll under them. Both blocks use `rail/RailBlockHeader` (one owner for the
  rule), and the header sits outside the `gap` column that holds the rows. The
  Commit History block always renders its header — a repository with no log
  explains why instead of leaving a bare block.
- **Project scope.** The rail is **app chrome**, not part of a view: `ProjectRail`
  sits beside the session column in `App.tsx` and is scoped to the **selected
  project** (`railScopeFolder` in `src/shared/rail-scope.ts`), falling back to the
  active session's folder when a cwd was never saved as a project. Selecting a
  project jumps to that project's most recently active **open** tab, and clears
  the active tab when the folder has none — so Welcome shows while the rail keeps
  the project's source control and checkpoints. Selecting a session selects its
  project. The rail is hidden on Settings, Extensions, Connections, Skills and
  Diagnostics, which get the full width.
- **No scope row.** The panel header names the folder in its `title`
  (`RailMenuSpec.scopeTitle`); there is no per-menu project line and no
  _Go to project_ button, because the panel and the sidebar always agree now.
  `RightRail` still renders `RailMenuSpec.scope` **outside** the body's scroll
  container, which is what keeps the Documents action row pinned.
- **Documents section (plan step 20).** One of those three menus. Its **presence**
  is a stable fact, not a probe reading (2026-10-30 rail-headers plan): the entry
  is in the strip when the Pi settings list the bridge package
  (`OfficeDocumentsView.configured`, read once at startup and after a wizard
  install), **or** the bridge answers `/health` right now, **or** an `office`-kind
  tab exists. One failed probe during a host restart therefore cannot make it
  vanish, and `resolveActiveMenu` no longer falls back to another menu mid-takeover.
  The body lists every attached task pane with its facts and actions; while the
  bridge is not answering it says why (still starting, versus another program
  owning port 38617) and keeps its re-check, instead of rendering nothing. When a
  host exists but the bridge is down, the scope row offers _Restart host session_.
  The registry is the main process's `/health` poll
  (`src/main/office/documents-service.ts`), pushed over
  `office:documents-state`; the pure projection lives in
  `src/shared/office-documents.ts` and also feeds the `#` completion source and
  the office tool cards. The menu appears in **every** session while the package
  is configured, even when the bridge is off. Its pinned row is the control
  surface: _The Office bridge is off_ + _Connect this session_, or _Office host:
  …_ / _This session is the Office host._ plus Disconnect/Restart. Another app
  tab offers _Open host session_ / _Move bridge here_; a terminal/foreign owner
  offers a confirmed _Take over_. Moving runs `/office close` in the old tab and
  `/office connect 38617` in the new one, **without restarting either session**.
  A non-owner session has its two composer actions disabled and `#` completion
  returns nothing, because only the live owner can serve the `office_*` call.

  A legacy 0.5.x bridge cannot be closed by the app; the row offers _Update
  bridge_ instead. The old `promoteToOfficeHost` path stays only as a
  compatibility hook and has no renderer caller. A takeover of a terminal or
  foreign owner is still explicit: `src/main/office/port-owner.ts` samples this
  app's PIDs before detaching, finds the listener (structured
  `Get-NetTCPConnection`, falling back to dual-stack `netstat -ano`), terminates
  it only after confirmation, re-reads the owner before each signal, and
  **verifies the port is free**. A forced kill of a TUI can leave that console in
  raw mode; reopening it is the user's call, and the confirm dialog says so.

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
src/main/branding.ts           Electron-free brand-icon resolution + APP_NAME (step 28)
src/main/office/documents-service.ts  the live /health pane-registry poll (step 20)
src/shared/office-documents.ts  the pure pane projection + mention/target helpers
src/shared/web-tabs.ts         the web-tab wire model, URL policy and review parse
src/main/web-tabs.ts           the Electron-free web-tab service (policy + reconciliation)
src/main/web-view-host.ts      the WebContentsView adapter (isolated partition, no preload)
src/shared/diagnostics.ts      incident vocabulary, offline rule, bundle snapshot types (step 22)
src/main/diagnostics-service.ts  the Electron-free snapshot + redacted support bundle
src/host/safe-mode.ts          the one "no third-party code" policy value (step 22)
src/renderer/src/App.tsx       regions + view routing + theme + menu dispatch
src/renderer/src/menu-actions.ts  what each command does today
src/renderer/src/state/app-store.ts  view state (zustand)
src/git/*                     the git engine: runner, repo, status, diff, service
src/checkpoints/*             the shadow-repo engine, its Node fs adapter and config
src/extensions/*              the app's own Pi extension (prompt snapshots + /checkpoint)
src/renderer/src/layout/*      TitleBar, Sidebar, TabStrip, StatusBar, CommandPalette, RightRail
src/renderer/src/rail/*       the docked panel rail: RightRail (host), RailStrip (the
                             always-visible menu column), the three menu bodies
                             (SourceControlPanel, CheckpointsSection, DocumentsSection)
                             and their dialogs
src/renderer/src/views/*       Welcome, Session, Settings, Extensions, Connections,
                               Skills, Diagnostics; ViewShell is the five product
                               views' full-width scroller + centred column
src/renderer/src/office/*      OfficeIntegrationCard, the Documents section body + the unchanged wizard panel
src/renderer/src/web/*         WebTabView chrome, the URL/navigation dialogs, overlay detect
src/renderer/src/session/*     Transcript, Composer, OfficeToolCard, …
src/renderer/src/ui/*          Button, Badge, Kbd, Separator, Dialog, DropdownMenu,
                               ScrollArea, Switch, Toaster, the auto-grow textarea hook
src/renderer/src/styles/*      tokens.css (Tailwind + theme tokens), office-panel.css
```

`src/renderer/src/styles/office-panel.css` keeps the shipped Pi for Office
wizard panel rendering exactly as before; the card around it uses `ui/*`
primitives. Migrating the panel itself to `ui/*` is not required by step 19.

## Reliability and recovery (step 22)

The app treats failure as a first-class state rather than a silent no-op:

- **Incidents.** `src/shared/diagnostics.ts` classifies a failed operation into a
  family (`host_crash`, `host_timeout`, `offline`, `permission`, `read_only`,
  `disk_full`, …), derives severity, whether a restart is a plausible fix, and an
  actionable `fix` sentence. Disk problems outrank connectivity so the user fixes
  the cause first. The session service records host crashes, wedged requests and
  `extension_error` events into a bounded list; main records process-level
  `unhandledRejection`/`uncaughtException`; the renderer reports its own
  unhandled rejections through `diagnostics:record` (validated in main).
- **Recovery.** A crashed or wedged tab shows a banner with **Restart**
  (`session:restart`): the old host is stopped and a fresh one resumes the same
  JSONL, so history returns. The supervisor owns processes only: on a crash it
  restarts the child and emits `crashed`/`ready`; the session service reopens
  the session and turns the transition into `session.timeout`,
  `session.crashed` and `session.recovered` transcript notices.
- **Status is a readiness claim.** A tab is `starting` until `session.create`
  or `session.resume` returns (or a real `state` frame carries a session id),
  then **ready** (`idle` internally); a streaming turn is **working**; a stopped
  host is **asleep**. The UI never shows the raw word `idle`, so a ready
  session does not read as inactive. Window focus/visibility and
  `powerMonitor` resume call `sessions.reconcile()`; any interaction calls the
  coalesced `ensureSession()`, which repairs a stopped or sessionless host.
- **Only host-backed tabs receive host RPCs.** `isHostBackedTab(kind)` is true for
  `session` and `office` only. Cross-tab fan-outs (model scope, queue modes,
  project-settings reload) go through `hostBackedTabs()`; an `editor` or `web`
  tab never receives `session.request`. Main still rejects a misplaced request
  with `editor_tab`/`web_tab` as defense in depth.
- **Stale host.** A host process keeps the bundle it was spawned from. The app
  compares its `buildId` with `out/host/index.mjs`; an idle stale session is
  recycled before the next request, and a busy one shows a persistent banner
  with **Restart session**. Diagnostics shows the host build id and a
  `stale build` badge. The renderer's `commands.complete` fallback also converts
  a missing host method into a banner instead of an empty completion menu.
- **Cancellation.** Abort/clear-queue already restore the queued text; closing a
  tab mid-run stops its host through the supervisor (a test pins that no host is
  left behind).
- **Offline.** `isOfflineEnv` mirrors Pi's own `PI_OFFLINE` rule (`1`/`true`/
  `yes`); the value travels in `AppInfo.piOffline` and raises a persistent banner.
  Every user-visible catch path funnels through the store's `noteFailure`, which
  classifies the message and raises the banner for connectivity failures.
- **Safe mode.** `--safe-mode` (or `PI_DESKTOP_SAFE_MODE=1`) is passed to every
  host. `src/host/safe-mode.ts` supplies the one loader-options object that
  disables extensions, skills, prompt templates, themes and project context
  files, and the composition root refuses every `packages.*` mutation. The app
  also skips the Office registry poll and the session pre-warm, so it starts with
  zero third-party code. The banner in `App.tsx` and the Diagnostics badge make
  the state impossible to miss.
- **Diagnostics view.** `src/main/diagnostics-service.ts` gathers the app/runtime
  facts, profile paths, each host's status and log tail, incidents, extension
  errors, the Office probe and the allowlisted environment into one snapshot. The
  export renders a bundle through the Office wizard's `redactSecrets`, so it is
  safe to paste; the view offers Copy and Save (main owns the save dialog).

## Security and privacy (step 23)

The trust boundaries are declared in code and asserted by tests, not by prose:

- **The renderer window.** `src/main/security.ts` owns `rendererWindowOptions`
  (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webviewTag: false`) and the Content Security Policy. The app window is created
  from that object, so `tests/main/security.test.ts` reads the posture the app
  actually uses. It takes an optional `{ icon }` — a plain path resolved by
  `src/main/branding.ts`, so the module stays Electron-free (plan step 28).
- **The CSP.** A `file://` page cannot receive a CSP header — Electron's
  `webRequest.onHeadersReceived` never fires for the file scheme — so the policy
  lives in `src/renderer/index.html` as a `<meta>` tag with a
  `__PI_RENDERER_CSP__` placeholder. The `pi-desktop-renderer-csp` plugin in
  `electron.vite.config.ts` splices in `RENDERER_CSP` for a build and
  `DEV_RENDERER_CSP` (which allows Vite's inline refresh preamble) for the dev
  server. Production is `default-src 'none'` with `script-src 'self'` — no
  `unsafe-inline`, no `unsafe-eval`.
- **Web tabs.** `webTabWebPreferences()` is the same secure base plus one shared
  partition and **no preload**, which is what keeps `window.pi` out of an
  arbitrary localhost page; every permission request is denied.
- **The IPC allowlist.** `src/shared/ipc.ts` is the single channel map;
  `src/preload/index.ts` and `src/main/ipc.ts` are the only places that touch
  `ipcRenderer`/`ipcMain`. `tests/architecture/security.test.ts` proves every
  declared channel is reachable, every invoked channel has a handler, and no raw
  channel string is ever passed.
- **File access.** `src/host/path-guard.ts` provides the lexical containment
  check (`isPathInside`) and the symlink-aware one (`resolveInsideRoot`).
  `files.read`/`files.write` are rooted at the session's own cwd and refuse a
  path (or a symlink) that leaves it; `host.blobs.read` uses the same check
  instead of a `startsWith` prefix test. `files.read` bounds the bytes returned
  and `files.write` bounds the payload.
- **Packages.** A package source is normalised and validated on both sides of
  the host boundary: an npm name or version that contains a path separator or
  `..` is refused, so the generated npm-root `package.json` can never contain a
  local-path dependency that escapes the npm root. Installing still requires the
  consent dialog (step 14).
- **Credentials.** Pi owns `auth.json` (0600); the app never reads it back into
  a reply — `providers.*` returns status summaries only — and no IPC channel is
  named for auth or credentials. The diagnostics bundle runs through
  `redactSecrets`.
- **Telemetry.** Off by default. The supervisor spawns every host with
  `PI_TELEMETRY=0` unless the user opts in on the first-run privacy screen
  (`UiPrefs.telemetryEnabled`). Pi's own `isInstallTelemetryEnabled` prefers that
  variable over the shared `settings.json`, so the guarantee holds without
  rewriting the profile terminal Pi also reads.
- **Extension trust.** Extensions are not sandboxed — they run with the user's
  privileges, as in terminal Pi. The Extensions hub carries a **“What can
  extensions do?”** page that says so, next to the gates the app does provide
  (project trust, install consent, safe mode).

## Performance and resource guardrails (step 24)

`src/shared/performance.ts` is the single source of the numbers; main, the host
and the renderer all read it, so a budget change is one edit.

- **Startup budget.** `createStartupMetrics()` records process start,
  `appReady`, the window's first `ready-to-show` and the first pre-warmed
  session. Main marks each; Diagnostics shows the result against the plan's
  targets (window interactive ≤ 2.5 s, warm session ready ≤ 5 s). The E2E `@perf`
  suite asserts the window budget on every CI run; the warm mark stays `unknown`
  when there is no tab to pre-warm, so the measurement never lies.
- **Lazy start and pre-warm.** The tab table is restored without spawning any
  host; only the most recently used tab is pre-warmed in the background, and
  safe mode skips even that.
- **Delta coalescing, measured.** `message_update` frames batch for 33 ms or
  1 KB before one IPC push; `sessionService.coalesceStats()` reports batches,
  deltas, flush reason and the largest batch, and a test pins that a 400-delta
  storm becomes far fewer pushes.
- **Transcript virtualization.** Above 50 items the transcript mounts only the
  window of rows plus overscan; a 10k-item test asserts the DOM stays bounded
  while the scroll height covers the whole session.
- **Blob spilling + lazy fetch.** A host response over 1 MB becomes one
  `{$blob}` reference; a large field inside an _event_ payload (a tool result) is
  replaced in place so the card keeps its identity, and the renderer fetches the
  body through `host.blobs.read` only when the card is opened.
- **Per-host memory.** Every host answers `host.metrics` with its own RSS (no
  OS-specific process query), plus heap/external/array-buffer counters so a large
  RSS can be attributed. The supervisor polls it and Diagnostics shows it against
  the soft budget. A **background idle** host over the hard threshold (1 GB) is
  recycled by **stopping** it, but only after two consecutive over-budget samples
  and a one-minute startup grace period. The session service drops a handle that
  reports `stopped`, so the next activation spawns a fresh process and resumes
  from JSONL. The 15-minute time-based idle recycler is **on by default**. The
  active tab, every visible pane, the control host, an Office host, the bridge
  owner and a session linked to an active/visible web tab are protected from
  **both** idle sleep and the RSS watchdog: an over-budget active host gets a
  warning and a manual Restart action instead of being killed. Passive reads
  (`tui.resize`, `messages.get`, `oi.state`, `shortcuts.list`, …) never wake a
  stopped host; only activation/ensure, a prompt or a lifecycle command does.
- **Open tabs vs live hosts.** A tab is a resumable JSONL record, not a process,
  so session, Office, web and editor tabs are **unlimited**. The only resource
  budget is live host processes: `liveHostBudget(totalMemory)` reserves 20% of
  physical RAM at 512 MB per host, clamped to 2–8. Before a spawn the session
  service parks the least-recently-used **idle** host (status `stopped` shows as
  "asleep"); if every live session is busy the spawn still proceeds, so a
  session count can never block the user. `hostProcessCeiling(totalMemory)` is
  the memory-derived process ceiling (`target + 2`, 4–10). A 30-second
  main-process tick parks idle hosts when the live count is over target or the
  sum of host RSS is over 50% of physical RAM. Diagnostics shows
  `live/target (ceiling)`, aggregate host RSS/limit, system free/total memory and
  live web views, with over-target/over-memory warn badges. Both idle and RSS
  recycling probe `state.get` first, so a streaming turn or a long tool call is
  never stopped mid-work.
- **Bounded live renderers and caches.** Unlimited web tabs are URL records; at
  most four `WebContentsView`s stay live (active + three recent), and an evicted
  view reloads its URL on activation. The renderer keeps at most four hydrated
  transcripts and a bounded lazy blob cache; closed tabs lose every per-tab
  cache immediately. These bounds are independent of the tab count, so opening
  many tabs cannot grow Chromium or the renderer without limit.
- **Host process lifetime.** A service host shuts down when its stdin pipe
  closes, which is what happens when main exits (including an `electron-vite`
  dev restart). A failed `start()` or `restart()` terminates the child it
  spawned, and host logs are bounded in memory and on disk. Without these, each
  dev restart could leave invisible hosts behind.

## Tests

- `tests/shared/diagnostics.test.ts` — classification order, severity/recovery/
  fix derivation, bounded incident list and the env allowlist (plan step 22).
- `tests/host/safe-mode.test.ts` — the loader options that disable every
  third-party collection, and the package-refusal message (plan step 22).
- `tests/main/diagnostics-service.test.ts` — snapshot shape, incident merge, the
  bundle structure, credential redaction and the allowlisted environment.
- `tests/shared/performance.test.ts` — budget classification, the startup report,
  the memory threshold, the RAM-derived live-host budget and formatting.
- `tests/shared/session-ipc.test.ts` — tab sanitizing and the shared "is this
  session busy?" predicate used by parking and recycling.
- `tests/main/host-supervisor.test.ts` — `host.metrics` polling, busy-aware RSS
  recycling, idle recycling/pinning and the coded emergency-ceiling error.
- `tests/main/session-service.test.ts` — coalescing measurements, unbounded
  restore, soft-budget capacity, LRU parking and wake, and the stopped-host
  handle drop.
- `tests/main/host-policy.test.ts` — control/active/bridge-owner protection for
  the idle reaper.
- `tests/renderer/session-tab-strip.test.tsx` — a strip with more than eight
  session tabs; `editor-tab-strip.test.tsx` covers more than sixteen files.
- `tests/host/service.test.ts` — in-place event spilling and `host.metrics`.
- `tests/renderer/transcript.test.tsx` — 10k virtualization and the lazy blob
  fetch.
- `tests/shared/workflow-mode.test.ts` — the workflow status decoder: every
  shipped label, ANSI-wrapped text, progress extraction, a label for every
  recognised mode (including `Default`), and null-on-unknown degradation
  (2026-10-19 UI rework).
- `tests/styles-layering.test.ts` — the global stylesheet stays inside
  `@layer base` (an unlayered rule beats Tailwind's utilities), and the
  `@source inline(...)` list matches every class `workflowBorderClass` returns.
- `tests/renderer/session-footer.test.tsx` — the Pi-shaped session footer:
  pwd/branch and the token/cost/context line, `model • thinking`, the
  ANSI-coloured extension status line, and no `mode:` chip (the composer names
  the mode now).
- `tests/renderer/composer.test.tsx` — Enter vs Shift+Enter, IME safety, the
  one-Send streaming model (Enter steers, Alt+Enter queues a follow-up), the hint
  row, the `! shell` placeholder, the workflow mode border/badge (always visible,
  announced, focus ring does not mask it), Tab dispatch to a registered extension
  shortcut before completion, and no built-in completion menu on a shell line.
- `tests/renderer/session-events.test.ts` — the reducer, including the
  hidden-item boundary: a `display: false` custom message is dropped (live and on
  reload), and the rule never keys on `customType`.
- `tests/e2e/performance.spec.ts` — the startup budget on the real built app
  (`npm run e2e:perf`).
- `tests/main/security.test.ts` — the CSP is strict in production and a superset
  in dev; the window/web-tab preferences keep the sandbox and drop the preload;
  the external-URL policy allows only http(s)/mailto (plan step 23).
- `tests/architecture/security.test.ts` — the IPC allowlist is closed (every
  declared channel reachable, every invoked channel handled, no raw strings), the
  renderer HTML is inline-script-free with the CSP placeholder, and the renderer
  has no filesystem access (plan step 23).
- `tests/host/path-guard.test.ts` / `tests/host/workspace-files.test.ts` — lexical
  and symlink containment, the read/write limits, and a real symlink escape
  (plan step 23).
- `tests/host/workspace-handlers.test.ts` — `files.read`/`files.write` parameter
  validation and the `unsupported` answer without a workspace port.
- `tests/packages/security.test.ts` — traversal-shaped npm sources are refused by
  both parsers, and the npm-root manifest only ever carries a plain name/version.
- `tests/main/host-supervisor.test.ts` — every host gets `PI_TELEMETRY=0` unless
  the user opted in, and the preference is read at each spawn (plan step 23).
- `tests/renderer/privacy-dialog.test.tsx` — the first-run screen appears once,
  defaults telemetry off, and only an explicit opt-in turns it on.
- `tests/renderer/extension-capabilities.test.tsx` — the extension trust page
  states the privilege model and the gates.
- `tests/main/host-supervisor.test.ts` / `tests/main/session-service.test.ts` —
  timeout events, host identity/log tails, incidents, restart-resume and the
  closed-mid-run host stop (plan step 22).
- `tests/renderer/reliability-store.test.ts`, `tests/renderer/reliability-banners.test.tsx`
  — `noteFailure`/offline classification, restart re-hydration and the safe-mode
  and offline banners.
- `tests/renderer/diagnostics-view.test.tsx` — hosts, incidents, extension
  errors, the Office probe, the environment and the Copy/Save exports.

- `tests/main/prefs.test.ts` — validation/clamping/merge of the preference patch.
- `tests/main/integrations-service.test.ts` — the consented-install record goes
  through the store's sanitizer and keeps unknown keys out.
- `tests/main/menu.test.ts` — every `MenuCommand` has exactly one menu item, New
  Session keeps `Ctrl+N`, Office stays out of the primary menus.
- `tests/renderer/shell.test.tsx` — the shell renders navigation and the welcome
  state, the old scaffold placeholder copy is gone, Pi for Office is not a
  primary-navigation button, and the slim status bar reports the resolved profile
  through `data-profile`.
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
- `tests/renderer/documents-section.test.tsx`, `tests/renderer/office-tool-card.test.tsx`
  — the Documents section and the office tool cards (plan step 20).
- `tests/renderer/right-rail.test.tsx`, `tests/renderer/rail-order.test.tsx`,
  `tests/renderer/rail-store.test.ts`, `tests/renderer/source-control-panel.test.tsx`,
  `tests/renderer/rail-*.test.tsx`, `tests/renderer/diff-dialog.test.tsx` — the rail
  host, the strip's order and store slice, the Source Control composition
  (composer → sync → changes → stashes → history) and the diff viewer.
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

### Test suite and CI matrix (step 25)

**Deterministic provider.** `tests/host/fixtures/fake-provider.ts` is a real
OpenAI-compatible SSE server; `tests/host/fixtures/fixture-profile.ts` writes a
throw-away profile whose `settings.json` selects the fake model and whose
`models.json` points a custom provider at the server. `AgentSession` hard-wires
its stream function to `ModelRuntime.streamSimple`, so scripting the wire bytes
is the only injection point that still runs the SDK's own request → SSE parse →
agent loop. A scripted queue of turns (`text`, `slowText`, `toolCall`,
`thinking`, `error`) makes prompts, tools, retries and compaction deterministic.

**Host integration harness.** `tests/host/integration.test.ts` drives the real
`createSessionCore` with the real SDK runtime against that provider: a streamed
reply, an image attachment, a `read` tool loop, a provider 500 that Pi retries,
`compact`, `/reload`, `session.new` and `session.resume` from JSONL — plus an
extension loaded from the fixture profile whose `ctx.ui.confirm()` round-trips
through `oi.request`/`oi.respond`.

**Method coverage.** `tests/host/method-coverage.test.ts` composes every handler
factory (session core, control core, extension-UI port/bridge, renderer
registry, provider-login bridge, the TUI surface and the service transport) and
asserts the union is _exactly_ `HOST_METHODS`. It then requires every declared
method to be named in another test file. Adding a method to `HOST_METHODS`
without a handler fails the first check; adding a handler without declaring it
fails the second; shipping either without a test fails the third.

**Coverage thresholds.** `npm run test:coverage` enforces floors (global, plus
tighter floors for `src/shared/**`, `src/host/**` and `src/renderer/src/**`) and
runs on the Ubuntu leg of CI. Electron-only wiring (`src/main/index.ts`,
`src/main/ipc.ts`, `src/main/web-view-host.ts`, `src/preload/**`) and the host
entry point (`src/host/index.ts`) are excluded: they need a live Electron/host
process, which is the Playwright suite's job, not a Vitest one.

**Playwright-Electron E2E.** `tests/e2e/fixtures/fake-app.ts` launches the built
app with the fake provider and a seeded project. `session.spec.ts` covers
create → send → stream → abort, the one-Send model (Enter steers, Alt+Enter queues
a follow-up) and two independent tabs; `settings.spec.ts` round-trips a preference across a restart;
`persistence.spec.ts` restores a tab and its transcript; `web-tab.spec.ts` opens
a loopback URL in an in-app tab; `shell.spec.ts` and `performance.spec.ts` stay
as the tagged `@smoke`/`@perf` subsets. `npm run test:e2e` runs them all; CI runs
it on Windows (the job must not inherit `ELECTRON_SKIP_BINARY_DOWNLOAD`).

**Concurrency fix the E2E surfaced.** `ensureHost` had no in-flight dedupe, so a
startup pre-warm and the renderer's first `messages.get` could both spawn a host
for one tab, orphaning one host and its session file. It now memoises the spawn
promise per tab (`spawning`), which also makes the restored-transcript test
deterministic.

### Onboarding, updates and packaging (step 26)

**First run, in order.** The privacy screen (step 23) comes first; once it is
answered the onboarding wizard opens, and only until
`prefs.onboardingCompletedAt` is set. Dismissing it without finishing leaves the
flag unset, so it returns next launch; **Skip setup** marks it done. Steps:
welcome → profile choice → provider → project → optional recommended extensions
→ optional Office → first session. Each step reuses an existing flow (the folder
picker, Connections' sign-in, the package consent dialog, the Integrations
card); the wizard is a guide, not a second implementation.

**Profile choice.** `shared` (default) keeps `~/.pi/agent`; `app` keeps an
app-private profile under `userData/profile`. A host's profile is fixed at spawn,
so main resolves the choice **before** any service is constructed: it reads
`prefs.profileMode` from a synchronous bootstrap read of `app-state.json` and
passes it to `resolveAppPaths`. Changing the choice therefore takes effect on the
next launch, and the wizard offers **Restart now** (`app:relaunch`, which uses
`app.quit()` so `before-quit` still flushes tabs and stops hosts).
`PI_CODING_AGENT_DIR` always wins. `AppInfo.profileMode` reports the launch
value so the UI can tell the stored choice from the running one.

**Updates.** `src/main/updater.ts` is the Electron-free policy; the only module
that imports `electron-updater` is `src/main/electron-updater.ts`, reduced to an
`UpdatePort`. `autoDownload` is **off** — a check reports and the user chooses.
`resolveUpdateSupport` gates the updater by dev/safe mode/`PI_OFFLINE`/port, and
`<resources>/build-info.json` (written by the `afterPack` hook) records whether
the package is a **local** build or a **release** CI build. Local, dev, offline
and safe-mode launches never auto-check; a manual check is still allowed.

Events reduce into `UpdateState` (`src/shared/updates.ts`), whose phases include
the benign `no-feed` state for an unpublished build/feed. `prefs.updates` carries
`autoCheck` and the per-version `dismissedVersion`. The renderer shows only a
compact status-bar chip for available → **Update vX**, downloading → **Updating
N%** and downloaded → **Restart to update**; a new version re-notifies after a
dismissal. Every other outcome — up to date, no feed, an error — lives in
**Settings → About & updates**, with the raw updater text under Technical
details. `Help → Check for Updates…` opens that card and checks; on Windows and
Linux `Help → About Pi Desktop` opens the same card, while macOS keeps its native
About panel. Automatic failures stay silent; a manual failure is a dismissible
status hint plus the card. There is no full-width update banner.

**Packaging.** `electron-builder.yml` targets Windows NSIS + portable, macOS
dmg/zip on arm64 + x64, and Linux AppImage/deb on x64 + arm64. The bundled
runtime and the Office manifest ship in `extraResources`.

**Why the host's dependencies are unpacked.** The Pi host is spawned under the
_bundled_ Node, never Electron, and that Node has no asar support — so anything
the host can `import` at runtime must be a real file on disk. `asarUnpack`
therefore covers `node_modules/**` wholesale (plus `out/**`, the host bundle
itself) rather than a list: an earlier hand-maintained list named only the SDK,
`jiti` and `typebox`, and the first packaged session died with
`Cannot find package 'highlight.js'`. Unpacked entries stay readable _through_
the asar, so the main process is unaffected; the cost is a larger install
(`app.asar` ~60 MB, `app.asar.unpacked` ~68 MB). The generated runtime shims are
rewritten for the packaged layout by the `afterPack` hook, since the ones made
at fetch time point back into the build machine's repository.

All three platforms are built by `npm run package:win|mac|linux`, which fetches
the runtime, builds, runs `runtime:verify` and only then invokes electron-builder,
so an installer cannot ship without a working runtime. `publish` is the GitHub
provider, and `package.json` carries the `repository` URL so the builder and the
updater agree. `tests/packaging/builder-config.test.ts` pins the targets,
resources, unpack list, feed and the runtime artifacts each target needs; the
installers themselves are verified on a clean machine (step 27).

## Fixed footer, aligned composer, resizable sidebar (2026-10-31)

- The session footer is a fixed **40 px** (two-line) scroll viewport. Plan/Build
  status columns and inline widgets wrap and scroll inside it, so switching modes
  no longer changes the composer/transcript height.
- Composer controls (model, thinking, context, attach, Stop, Send) share the
  28 × 28 `icon-md` size. The tools row is at the top of the textarea's height and
  the action row at the bottom; Send/Stop are icon-only with accessible names.
- The sidebar has a resize handle on its right edge (local preview, one prefs
  write on release, 200–520 px) and a collapse button in the Projects header.
  When collapsed, a Show-sidebar button sits at the far left of the tab strip.
- Sidebar session rows reuse the tab lifecycle menu and support double-click
  inline rename (Enter/blur commits, Escape cancels).

## Modal layers and body locks (2026-11-03)

Radix keeps the modal `pointer-events: none` lock in **module-level** state, so
two installed copies of `@radix-ui/react-dismissable-layer` are two independent
locks on one document. Opening a dialog from a context-menu item made the dialog
record the menu's `"none"` as its previous value and restore it on close — the
renderer kept running but ignored every click (radix-ui/primitives#3317,
#3645).

- **One copy.** `package.json` `overrides` pins the stateful packages
  (`@radix-ui/react-dismissable-layer`, `@radix-ui/react-focus-guards`), and
  `tests/architecture/radix-singletons.test.ts` fails if a nested copy of any
  guarded package reappears. Add a new entry there when a dependency bump
  introduces another singleton.
- **Never stack a modal dialog on a closing modal menu.** The Explorer's Delete
  action defers the confirm dialog by one task so the menu layer has released
  the lock first (`ExplorerSection.tsx`).
- **Recovery net.** `src/renderer/src/ui/body-pointer-lock.ts` clears a stale
  `pointer-events: none` on the last dialog unmount and on window focus, but only
  when no `[data-state="open"]` dialog/menu/popover exists.
- **One reconcile per focus burst.** Alt+Tab emits both `focus` and
  `visibilitychange`; `createFocusResync` coalesces the burst into one
  `sessions.reconcile()`.
