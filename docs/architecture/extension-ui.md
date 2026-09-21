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
| `setStatus(key, text)`                                            | status-bar entries (`oi.state`)                                     | `undefined` removes the entry                                                              |
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

## Tests

| Area                        | Tests                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire model                  | `tests/shared/extension-ui.test.ts`, `tests/shared/tui-surface.test.ts`, `tests/shared/extension-render.test.ts`                                                                                                                                                   |
| Host UI port                | `tests/host/extension-ui.test.ts`, `tests/host/sdk-extension-ui.test.ts`                                                                                                                                                                                           |
| TUI surface                 | `tests/host/tui-surface.test.ts`, `tests/host/sdk-tui-surface.test.ts` (real `SelectList`/`Editor` by keyboard)                                                                                                                                                    |
| Renderers                   | `tests/host/extension-renderers.test.ts`                                                                                                                                                                                                                           |
| Renderer store + components | `tests/renderer/extension-ui-store.test.ts`, `tests/renderer/extension-ui.test.tsx`, `tests/renderer/tui-surface.test.tsx`, `tests/renderer/tui-surface-store.test.ts`, `tests/renderer/extension-render-store.test.ts`, `tests/renderer/extension-block.test.tsx` |
| Integration                 | `tests/host/integration.test.ts` (a real extension’s `confirm()` round-trips `oi.request`/`oi.respond`)                                                                                                                                                            |
