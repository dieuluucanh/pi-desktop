# The app shell: IA, view model, theme tokens, shortcuts

**Plan step 1.** This document is the reference for the window's structure; later
steps must extend it rather than re-invent it.

## Regions

```text
title bar        brand logo, active project, Open project…, New session
sidebar          + New session · Open project… · Project · Sessions · Views
tab strip        session tabs (empty until step 11) + the "+" action
main area        the active view (welcome | session | settings | extensions |
                 connections | skills | diagnostics)
status bar       slim app-level facts only: build version · Pi profile ·
                 bundled runtime · transient hints · notifications
composer footer  session facts, bound to the prompt input: cwd (branch) · model ·
                 thinking · context/tokens/cost, then one dim line of extension
                 statuses (ctx.ui.setStatus), ANSI-coloured
overlays         command palette (Ctrl+K), toast host
```

The sidebar and the tab strip are fixed parts of the frame: step 11 fills the tab
strip, step 10 fills the project section — neither re-lays-out the window.

**Two status surfaces, one job each (2026-10-19 UI rework).** The status bar is
app-level and mounted on every view; it never carries session facts. Everything
session-scoped lives in `ComposerFooter`, under the prompt input, the way
terminal Pi binds its footer to the editor. Extension statuses
(`ctx.ui.setStatus`) render in that footer's dim second line — for example the
Office bridge's `office: Excel attached (bridge :38617)` — not in the status bar.
The footer is rendered as a **sibling of the editor branch**, not inside
`<Composer>`, so its facts and mode chip survive when an extension installs its
own editor component and `<TuiSurface>` replaces the composer.

**The workflow mode is shown as text, not just colour.** The composer's textarea
border reflects the Workflow extension's mode (`Plan` → warn, `Build` → accent),
decoded from its status text by `src/shared/workflow-mode.ts`; an unrecognised
value degrades to the neutral border rather than guessing. The desktop names
exactly the extension's three modes (Default/Plan/Build): the Plannotator
`reviewing in browser` phrase is a Plan sub-state, so the mode chip reads the
mode — `Plan` — never the sub-state (2026-10-20 startup-tab-cycle plan). Because colour alone is
not an indicator, the mode is also named: a badge on the composer's top edge and a
`mode: …` chip in the footer, both exposed through `role="status"`. Every
recognised mode has a label, including `Default`. The badge renders at every
window width — it used to be hidden below the `sm` breakpoint.

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
  JSONL, so history returns. The supervisor also emits `timeout` and forwards
  `crashed`/`resumed`, which the session service turns into `session.timeout`,
  `session.crashed` and `session.recovered` transcript notices.
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
  OS-specific process query). The supervisor polls it, Diagnostics shows it
  against the soft budget, and an idle host over the hard threshold is recycled
  (with a cooldown, so a host whose RSS does not drop cannot loop). The session
  service drops a handle that reports `stopped`, so the next activation spawns a
  fresh one.
- **Caps and backpressure.** The supervisor enforces the host cap (8) and the
  session service the tab cap (8); both raise a coded, user-facing sentence
  (`capacityMessage`), and Diagnostics shows used/limit.

## Tests

- `tests/shared/diagnostics.test.ts` — classification order, severity/recovery/
  fix derivation, bounded incident list and the env allowlist (plan step 22).
- `tests/host/safe-mode.test.ts` — the loader options that disable every
  third-party collection, and the package-refusal message (plan step 22).
- `tests/main/diagnostics-service.test.ts` — snapshot shape, incident merge, the
  bundle structure, credential redaction and the allowlisted environment.
- `tests/shared/performance.test.ts` — budget classification, the startup report,
  the memory threshold, capacity and formatting (plan step 24).
- `tests/main/host-supervisor.test.ts` — `host.metrics` polling, the RSS restart
  cooldown, idle recycling and the coded host-cap error (plan step 24).
- `tests/main/session-service.test.ts` — coalescing measurements, capacity and
  the stopped-host handle drop (plan step 24).
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
- `tests/renderer/composer-footer.test.tsx` — the composer-bound session footer:
  cwd/branch/model/thinking and the context budget, the ANSI-coloured extension
  status line, and the `mode: …` chip for every recognised mode.
- `tests/renderer/composer.test.tsx` — Enter vs Shift+Enter, IME safety, the
  steer/follow-up choice, the hint row, the workflow mode border/badge
  (always visible, announced, focus ring does not mask it) and Tab dispatch to a
  registered extension shortcut before completion.
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
create → send → stream → abort, the steering/follow-up modes and two independent
tabs; `settings.spec.ts` round-trips a preference across a restart;
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
Events reduce into `UpdateState` (`src/shared/updates.ts`), pushed over
`updates:state`; the renderer reads `updates.get` on start and shows an
`UpdateBanner` for the actionable phases (available → Download, downloading →
progress, downloaded → Restart & install, error → Retry). A finished check with
nothing to install reports in the status bar instead of leaving a banner.
`Help → Check for Updates…` runs one on demand; installed builds also check ~10 s
after launch (skipped when `PI_OFFLINE`). A dev build reports `supported: false`.

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
