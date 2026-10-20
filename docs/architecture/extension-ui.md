# Extension UI host

Pi extensions drive the terminal UI through `ExtensionUIContext`. Pi Desktop
implements that surface in two halves (plan D‑A7, steps 16–18):

- **Host A** — dialogs, notifications, status, widgets and working state: things
  that map cleanly onto a graphical UI.
- **Host B** — the TUI rendering surface: `ctx.ui.custom()`, footers/headers,
  custom editors and overlays, rendered from Pi’s own components into ANSI frames
  the app displays in a terminal grid.

`mode: "tui"` is reported to extensions, so one that branches on the mode takes
the terminal path. The protocol between the host and the renderer is documented
in [`host-protocol.md`](host-protocol.md); this file is the member-by-member
mapping — the parity table the plan's definition of done calls
`extension-parity.md`. `tests/packaging/release.test.ts` pins that every member
of the SDK's `ExtensionUIContext` appears here.

## Member mapping

| `ExtensionUIContext` member                                       | Where it lands                                                      | Notes                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `select` / `confirm` / `input` / `editor`                         | native dialogs through `oi.request` / `oi.respond`                  | keyboard-first, live `timeout` countdown, `signal` cancel, Escape/overlay cancel           |
| `notify(message, type)`                                           | toast centre + a notification history panel (`oi.notify`)           | history survives tab switches; `undefined`-style clears are not applicable                 |
| `setStatus(key, text)`                                            | the composer footer’s dim status line (`oi.state`)                  | `undefined` removes the entry; values are sanitised for `title` and rendered ANSI-aware    |
| `setWidget(key, lines, opts)`                                     | widget strip above/below the composer (`oi.state`)                  | string arrays; a component **factory** is ignored (documented limitation)                  |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | the working row above the composer                                  | custom frames + interval honoured; `visible:false` hides it                                |
| `setHiddenThinkingLabel`                                          | transcript thinking blocks                                          | replaces the collapsed thinking label                                                      |
| `setTitle`                                                        | window title (validated in main)                                    | bounded, single-line                                                                       |
| `getToolsExpanded` / `setToolsExpanded`                           | transcript tool-card expansion (`oi.state` + `oi.setToolsExpanded`) | the app owns `Ctrl+O` and the view mode; the host’s copy stays truthful                    |
| `pasteToEditor` / `setEditorText`                                 | composer mirror (`oi.editorText`)                                   | renderer reports its buffer back, debounced per tab                                        |
| `getEditorText`                                                   | the mirror                                                          | **eventually consistent** — the host cannot read a textarea synchronously                  |
| `addAutocompleteProvider`                                         | the composer’s completion stack (`completion.suggest` / `apply`)    | the host runs `factory(current)`; the renderer sends its `/`, `@`, `#` result as `current` |
| `onTerminalInput`                                                 | first shot at keys in the TUI surface                               | runs before the surface’s own handling                                                     |
| `custom(factory, opts)`                                           | the TUI surface (`tui.state` frames)                                | `overlay`/`overlayOptions`/`onHandle` supported; returns `undefined` when nothing is shown |
| `setFooter` / `setHeader`                                         | TUI slots above/below the transcript                                | the factory’s component is rendered per frame                                              |
| `setEditorComponent` / `getEditorComponent`                       | the composer slot’s TUI editor                                      | replaces the composer while set                                                            |
| `theme` / `getAllThemes` / `getTheme` / `setTheme`                | host theme + `oi.theme`                                             | `setTheme` installs the theme in the host process and persists Pi’s `theme` setting        |

| `shortcuts` (registered via `pi.registerShortcut`) | the composer’s Tab cycle and the session’s other chords (`shortcuts.list` / `shortcuts.invoke`) | checked before the editor’s own handling, as in Pi; the list is listed per tab on activation |

`ExtensionContextActions` (`getModel`, `getScopedModels`, `isIdle`,
`isProjectTrusted`, `getSignal`, `getContextUsage`, `compact`, `getSystemPrompt`,
`getSystemPromptOptions`, `hasPendingMessages`, `shutdown`) and
`ExtensionCommandContextActions` (`waitForIdle`, `newSession`, `fork`,
`navigateTree`, `switchSession`, `reload`) are supplied by the SDK binder in
`src/host/sdk/extension-ui.ts`. `abort` is deliberately **not** overridden, so
`ctx.abort()` uses Pi’s own abort path.

## Routing across tabs

Every request carries the tab id that owns the host. If that tab is not active,
it is flagged in the sidebar and focused (per the routing preference); the
timeout is preserved either way, so a run cannot hang because a dialog went to
the wrong place (risk R5).

## Rendering

The TUI surface is **emulated**, not a `TuiBase` subclass: `src/host/tui-surface.ts`
reimplements render coalescing, focus, overlay layout and `onHandle`, and injects
pi-tui’s real helpers (`visibleWidth`, `sliceByColumn`, `stripTerminalSequences`,
`CURSOR_MARKER`), `Theme` and `KeybindingsManager`. The renderer converts ANSI to
styled spans without `dangerouslySetInnerHTML`, reports its measured grid through
`tui.resize`, maps DOM keys to terminal bytes, frames pastes with bracketed-paste
markers and scrolls tall frames.

Extension custom renderers (`renderCall`/`renderResult`, message/entry renderers,
markdown transformers) go through `render.request` / `render.markdown`: the host
runs the renderer with the live `Theme` and returns ANSI lines; a missing or
throwing renderer falls back to the native HTML card, exactly as Pi does.

### Pi-parity rules for custom transcript items (2026-10-19 UI rework)

Pi hides some custom items entirely, and the app must match it or a mode switch
shows up as chat noise:

- **A bare `custom` entry with no registered renderer renders nothing.** Pi’s
  `addCustomEntryToChat` returns early when `getEntryRenderer` finds none and
  `CustomEntryComponent.hasContent()` is the second gate. The Workflow extension
  appends `pi.appendEntry("workflow", …)` on every mode change (`persistState()`),
  which is why Tab used to print a card headed `workflow`; it now renders nothing.
  A renderer that **threw** still shows a card (Pi shows an error box), so the
  hidden case is exactly `rendered: false` with no `error`.
- **A `custom_message` with `display: false` is dropped.** It is LLM context, not
  transcript content: the SDK emits it live as `role: "custom"`
  (`agent-session.js` `_appendCustomMessage`) and persists it, so both the live
  reducer and `hydrateMessages` filter it. It must never be mapped to the
  `assistant` role.
- **`role: "custom"` is a custom item, never an assistant message**, and a
  `custom_message` keeps its dashed fallback card when no renderer matched.

The rule keys on `display` and on renderer presence — never on a `customType`.
`tests/renderer/session-events.test.ts` (“hidden-item boundary”) pins that,
because hiding `workflow` by name would also hide the Review bands that share the
prefix.

### The composer’s mode border and the Tab cycle

The composer’s textarea border reflects the Workflow extension’s mode, mirroring
terminal Pi’s editor border (which tracks the thinking level). The extension
reports its mode only through `setStatus("workflow", …)`, so
`src/shared/workflow-mode.ts` decodes that text (`⏸ plan` → warn, `▶ build` →
accent, `◦ …` → neutral) and an unrecognised value degrades to the neutral border
without guessing. The coupling is deliberate and documented: the extension lives
outside this repo, so the parser is tolerant by construction.

The desktop shows exactly the extension’s three modes — Default, Plan, Build.
The Plannotator phrase `⏸ plan — reviewing in browser` is a Plan **sub-state**,
not a mode (it is Plannotator’s phase label, rendered merely because the
Plannotator package is installed): the badge and the footer chip always read
`Plan` for it, while the raw phrase stays visible in the badge’s tooltip and in
the footer’s extension-status row (2026-10-20 startup-tab-cycle plan).

**Colour is never the only signal (2026-10-19).** The mode is named in two
places — the composer badge and a `mode: …` chip in the footer — and both are
exposed with `role="status"`. Every recognised mode has a label, including
`Default`, and the badge is shown at every window width. The footer (and its chip)
renders as a sibling of the editor branch in `SessionView`, so the indicator
survives an extension installing its own editor component.

**Tab reaches the extension’s shortcut first.** Terminal Pi checks
`onExtensionShortcut` _before_ the editor (`custom-editor.js`), which is how the
Workflow extension’s `registerShortcut("tab")` cycles Plan → Build → Default. The
desktop composer does the same through `shortcuts.invoke`, with one deliberate
deviation: while a **completion menu is open**, Tab accepts the highlighted item
and the mode cycle does not fire, because the extension cannot see the app’s
menu. Extension shortcuts are matched for every key (so `Ctrl+Alt+P`, the
extension’s alias, works too), and the list is loaded per tab on activation so a
fresh session has it before the first Tab.

**The Tab cycle needs the session to be open.** A boot-time `shortcuts.list` can
arrive while the host is still resuming its session; main gates tab requests on
the in-flight spawn so they wait for the session instead of hitting a
session-less host, and the renderer never latches a failed list — a tab whose
last attempt errored retries on the next load, on the next Tab press, and when
the tab becomes ready (2026-10-20 startup-tab-cycle plan). Shortcuts resolve
against Pi’s effective keybindings (documented defaults with the user’s
overrides applied), so a user remap behaves exactly as it does in terminal Pi.

## Tests

| Area                        | Tests                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire model                  | `tests/shared/extension-ui.test.ts`, `tests/shared/tui-surface.test.ts`, `tests/shared/extension-render.test.ts`                                                                                                                                                                                              |
| Host UI port                | `tests/host/extension-ui.test.ts`, `tests/host/sdk-extension-ui.test.ts`                                                                                                                                                                                                                                      |
| TUI surface                 | `tests/host/tui-surface.test.ts`, `tests/host/sdk-tui-surface.test.ts` (real `SelectList`/`Editor` by keyboard)                                                                                                                                                                                               |
| Renderers                   | `tests/host/extension-renderers.test.ts`                                                                                                                                                                                                                                                                      |
| Renderer store + components | `tests/renderer/extension-ui-store.test.ts`, `tests/renderer/extension-ui.test.tsx`, `tests/renderer/tui-surface.test.tsx`, `tests/renderer/tui-surface-store.test.ts`, `tests/renderer/extension-render-store.test.ts`, `tests/renderer/extension-block.test.tsx`, `tests/renderer/composer-footer.test.tsx` |
| Integration                 | `tests/host/integration.test.ts` (a real extension’s `confirm()` round-trips `oi.request`/`oi.respond`)                                                                                                                                                                                                       |
