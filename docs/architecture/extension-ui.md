# Extension UI host

Pi extensions drive the terminal UI through `ExtensionUIContext`. Pi Desktop
implements that surface in two halves (plan D‑A7, steps 16–18):

- **Host A** — dialogs, notifications, status, widgets and working state: things
  that map cleanly onto a graphical UI.
- **Host B** — the TUI rendering surface: `ctx.ui.custom()`, footers/headers and
  overlays, rendered from Pi’s own components into ANSI frames the app displays
  in a terminal grid. `setEditorComponent()` is recorded for
  `getEditorComponent()`/extension coordination but never mounted: the desktop
  always uses its native composer.

`mode: "tui"` is reported to extensions, so one that branches on the mode takes
the terminal path. The protocol between the host and the renderer is documented
in [`host-protocol.md`](host-protocol.md); this file is the member-by-member
mapping — the parity table the plan's definition of done calls
`extension-parity.md`. `tests/packaging/release.test.ts` pins that every member
of the SDK's `ExtensionUIContext` appears here.

## Member mapping

| `ExtensionUIContext` member                                       | Where it lands                                                                                          | Notes                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select` / `confirm` / `input` / `editor`                         | inline dock in the session column through `oi.request` / `oi.respond`                                   | keyboard-first, live `timeout` countdown (store-enforced), `signal` cancel, Escape cancels                                                                                                                             |
| `notify(message, type)`                                           | transcript notice + history panel; warning/error also toast (`oi.notify`)                               | info output is chat content as in terminal Pi; the archive keeps every notification                                                                                                                                    |
| `setStatus(key, text)`                                            | one column in the wrapping session-footer status rail (`oi.state`)                                      | `undefined` removes the entry; keep status text short so it behaves as a column; values are sanitised for `title` and rendered ANSI-aware                                                                              |
| `setWidget(key, lines \| factory, opts)`                          | string strip (`oi.state`) or TUI widget frames (`tui.state`)                                            | string arrays keep the strip; a component factory renders above/below the editor dock; a **single-line** component frame joins the footer rail instead of taking its own strip (2026-10-31 UI plan); one owner per key |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | the working row above the composer                                                                      | custom frames + interval honoured; `visible:false` hides it                                                                                                                                                            |
| `setHiddenThinkingLabel`                                          | transcript thinking blocks                                                                              | replaces the collapsed thinking label                                                                                                                                                                                  |
| `setTitle`                                                        | window title (validated in main)                                                                        | bounded, single-line                                                                                                                                                                                                   |
| `getToolsExpanded` / `setToolsExpanded`                           | transcript tool-card expansion (`oi.state` + `oi.setToolsExpanded`)                                     | the app owns `Ctrl+O`; the host’s copy stays truthful                                                                                                                                                                  |
| `pasteToEditor` / `setEditorText`                                 | composer mirror (`oi.editorText`)                                                                       | renderer reports its buffer back, debounced per tab                                                                                                                                                                    |
| `getEditorText`                                                   | the mirror                                                                                              | **eventually consistent** — the host cannot read a textarea synchronously                                                                                                                                              |
| `addAutocompleteProvider`                                         | the composer’s completion stack (`completion.suggest` / `apply`)                                        | the host runs `factory(current)`; the renderer sends its `/`, `@`, `#` result as `current`                                                                                                                             |
| `onTerminalInput`                                                 | first shot at keys in the TUI surface                                                                   | runs before the surface’s own handling                                                                                                                                                                                 |
| `custom(factory, opts)`                                           | the TUI surface (`tui.state` frames)                                                                    | `overlay`/`overlayOptions`/`onHandle` supported; returns `undefined` when nothing is shown                                                                                                                             |
| `setFooter` / `setHeader`                                         | `setFooter` replaces the built-in session footer; `setHeader` renders a TUI frame in the session column | the factory’s component is rendered per frame; a custom footer owns the statuses (it receives the `FooterDataProvider`)                                                                                                |
| `setEditorComponent` / `getEditorComponent`                       | recorded on the UI port; **never mounted**                                                              | the native composer is always the editor; see “A custom editor is recorded, not mounted”                                                                                                                               |
| `theme` / `getAllThemes` / `getTheme` / `setTheme`                | host theme + `oi.theme`                                                                                 | `setTheme` installs the theme in the host process and persists Pi’s `theme` setting                                                                                                                                    |

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
styled spans without `dangerouslySetInnerHTML`, reports the **session column's**
grid through `tui.resize` (never the surface's own box), maps DOM keys to
terminal bytes, frames pastes with bracketed-paste markers and scrolls tall
frames. A wheel over a frame that fits its viewport is forwarded as an SGR wheel
sequence; the local DOM scroller is only the fallback for an overflowing frame.

### Geometry and presentation (2026-10-26)

**The grid is the session column.** Terminal Pi's components size themselves
from the terminal viewport; the desktop's analog is the column that holds the
transcript, status rows, composer/dock and footer. `SessionView` measures a
hidden monospace probe plus that column and reports `tui.resize`; the TUI
surface never measures itself. This matters because row-aware components (the
Workflow questionnaire computes `max(1, min(32, floor(rows*0.8)-1))` from
`terminal.rows`) used to receive their own rendered height and collapse to one
row. The old fixed `max-h-72`/`max-h-80` caps are gone; a frame is sized from
the grid and the frame itself.

**A bottom sheet is docked; everything else floats inside the column.** A
bottom-anchored, full-width overlay (the Workflow questionnaire: anchor
`bottom-center`, `width: "100%"`, `maxHeight: "80%"`, `margin: 0`) is rendered
as an in-flow dock that replaces the composer; the transcript shrinks and stays
fully readable/scrollable. Every other overlay floats inside the session column
at the host-resolved rectangle, with no dim backdrop. The float and dock are
never page-level modals; clicking the transcript re-focuses the surface, and a
float makes the composer `inert` so keys cannot leak to the wrong place.

**Component widgets are read-only TUI slots.** `ctx.ui.setWidget(key, factory)`
is constructed with the live TUI and `Theme`, rendered by the host at the
docked grid width, and sent as `widgetsAbove`/`widgetsBelow` frames. They render
above/below the editor dock via `TuiWidgetStrip`; string-array widgets keep the
existing `oi.state` path. Replacing/removing/`/reload` disposes the component,
and a throwing factory renders nothing. Widgets never take focus or surface
input.

**Extension dialogs are inline, not modals.** `ctx.ui.select/confirm/input/editor`
render as an `ExtensionDialogDock` in the composer region (the host of Pi's
editor-dock selector). It replaces the composer, keeps the transcript visible,
scrolls a long list, and owns Escape/Enter. `Enter` submits the multi-line
editor and `Shift+Enter` inserts a newline. The extension's `opts.timeout` is
enforced by the renderer store, so it still fires while its tab is in the
background; `closeTab` purges that tab's queued dialogs and timers.

The shell/orchestration details live in
`src/renderer/src/tui/tui-geometry.ts`, `use-tui-viewport.ts`,
`TuiSurface.tsx`, `TuiWidgetStrip.tsx` and `src/renderer/src/extension-ui/ExtensionDialog.tsx`.

Extension custom renderers (`renderCall`/`renderResult`, message/entry renderers,
markdown transformers) go through `render.request` / `render.markdown`: the host
runs the renderer with the live `Theme` and returns ANSI lines; a missing or
throwing renderer falls back to the native HTML card, exactly as Pi does.

A bare `custom` entry (`pi.appendEntry`) is different: Pi hides it when no
`registerEntryRenderer` matched, so the host annotates its `entry_appended`
event with `entryRenderable` from the live runner and the transcript reducer
drops the item when it is not `true`. This is what keeps the Workflow mode
switches (state entries with no renderer) out of the transcript instead of
leaving blank padded rows. `custom_message` entries keep their fallback card.

### The selection in an extension-drawn surface (2026-10-21)

**Pi marks the selected element of a `ctx.ui.custom` component with a
background fill** — `theme.bg("selectedBg", …)`. The Workflow extension's
questionnaire is the case the app meets in the wild: its tab row draws the
active tab with that fill and nothing else (the `■`/`□` glyphs mean
answered/unanswered, and the `✓` belongs to the Submit tab).

Two rules make that state legible in the desktop:

- **A background fill inside a TUI frame means "selected".** The app repaints
  such a span with its own selection surface (`--color-selected`, derived from
  the accent) and an accent underline instead of Pi's raw terminal hex
  (`src/renderer/src/tui/selection.ts`). The rule is applied to the TUI surface
  **only**: an extension _renderer_ (a tool card, a custom message) paints
  `userMessageBg` and `toolPendingBg` surfaces, and those are surfaces, not
  selections.
- **A parsed span never changes afterwards.** `applySgr` returns a new style
  object; it used to mutate the one the parsed spans hold, so Pi's closing
  `\x1b[39m` / `\x1b[49m` wiped the colour of the span that had just been
  parsed (and a fill set for the next span bled backwards). The selected tab
  therefore had **no** background on screen, and the accent `"> "` marker of
  the option list had no accent either. `tests/shared/ansi.test.ts` pins it.

**The surface has chrome, because it owns the keyboard.** While a custom
component is mounted, the panel replaces the composer and the keys go to the
extension. The panel says so: a caption row (`Extension UI` · _keys are
forwarded to the extension_) and an accent border. The read-only header/footer
slots (`TuiSlotFrame`) stay plain chrome.

**Copying from a TUI surface (2026-10-30 copy plan).** The frame is real,
selectable DOM, but the surface forwards every Ctrl key as terminal bytes — so
Ctrl+C used to become the terminal's `^C` and there was no way to copy a
proposed commit message out of the Workflow questionnaire. Two rules fix it:

- **A selection wins.** Ctrl+C / Cmd+C with a non-collapsed selection inside the
  surface copies the selected text instead of forwarding `^C`. Without a
  selection the chord still reaches the extension, and Esc still aborts.
- **A Copy control is always available.** The dock's caption row (and a
  hover-revealed corner button on overlay surfaces) presses the same path: copy
  the selection if there is one, otherwise the whole frame with ANSI escapes and
  terminal padding stripped (`src/renderer/src/tui/frame-text.ts`).

The renderer's right-click menu offers the same Copy action.

**A custom editor is recorded, not mounted (2026-10-26).** Pi’s interactive
mode’s `setCustomEditorComponent` wires `onSubmit`, `onChange`, the autocomplete
provider, `actionHandlers`, `onExtensionShortcut`, `onEscape`, `onCtrlD` and
`onPasteImage` when an extension installs an editor. The emulated TUI has no
equivalent bridge: a mounted editor accepts keystrokes but its Enter calls an
undefined `onSubmit` (the buffer is discarded), the app’s `/`, `@` and `#`
completion is gone, and `onExtensionShortcut` never fires. The desktop therefore
keeps its native composer and only **records** the factory on the UI port, so
`getEditorComponent()` remains meaningful for extension-to-extension
coordination (the Workflow extension’s guard). This is the same choice Pi’s RPC
mode makes. The Workflow extension’s `CustomEditor` subclass exists only to fix
terminal Pi’s Tab precedence; the native composer already implements it
(`Composer.tsx` checks the open completion menu first, then the matched
extension shortcut), so nothing is lost.

**Every session bind starts clean.** `createSdkExtensionBinder` calls
`port.resetSessionUi()` before the TUI-surface reset and `bindExtensions`. That
clears statuses, widgets, working state, the hidden-thinking label, title,
footer/header/editor factories, terminal-input handlers and autocomplete
providers; the app-owned `toolsExpanded` flag and the renderer-owned draft
mirror survive. Without it, a stale `getEditorComponent()` made the Workflow
extension skip re-installing on `/reload` (which is why toggling project
settings appeared to “fix” the composer), and old handlers/providers kept firing
in the new session.

**`ctx.ui.select` is a listbox.** The dialog renders a `role="listbox"` whose
rows are `role="option"` with `aria-selected`; the selected row carries the
same `→` marker and selection surface as the TUI surface, `↑`/`↓` move the
selection (wrapping), `Enter` answers with it and `Esc` cancels. A click still
answers immediately.

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
Plannotator package is installed): the composer label always reads `Plan` for
it, while the raw phrase stays visible in the label’s tooltip and in the
footer’s extension-status row (2026-10-20 startup-tab-cycle plan).

**Colour is never the only signal (2026-10-19, tightened 2026-10-31).** The mode
is named in the composer’s top-right corner and exposed with `role="status"`.
Every recognised mode has a label, including `Default`, and the label is shown at
every window width; Plan/Build use the same warn/accent tone as the border. It
renders inside the composer, so it survives a non-overlay `ctx.ui.custom()`
replacement of the editor; the footer has no duplicate `mode: …` chip (the raw
`workflow` status still appears as its mode/progress column).

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

**Command arguments fill like terminal Pi (2026-10-24).** The first line of a
`/` buffer is one command context: before the first whitespace the menu lists
command names, and after it the host evaluates the command’s
`getArgumentCompletions(prefix)` (`commands.complete`). App-owned commands use
renderer completers instead: `/model` suggests `provider/id`, `/thinking`
suggests levels, `/login` suggests provider ids. Argument items replace the
whole argument prefix verbatim — their value owns any trailing space
(`"use "`) — while command-name/file/document items keep the historical
trailing space. **Enter** on a command-name suggestion applies it and submits
in the same keystroke; Enter on an argument suggestion applies only; Tab always
applies only. A delegating autocomplete provider preserves the base item’s
source and `appendSpace`, so it cannot turn an argument fill into an
auto-spaced one.

## Tests

| Area                        | Tests                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire model                  | `tests/shared/extension-ui.test.ts`, `tests/shared/tui-surface.test.ts`, `tests/shared/extension-render.test.ts`                                                                                                                                                                                                        |
| Host UI port                | `tests/host/extension-ui.test.ts` (includes `resetSessionUi`), `tests/host/sdk-extension-ui.test.ts` (the bind reset)                                                                                                                                                                                                   |
| TUI surface                 | `tests/host/tui-surface.test.ts`, `tests/host/sdk-tui-surface.test.ts` (real `SelectList`/`Editor` by keyboard; a custom editor factory is never invoked; component widget lifecycle)                                                                                                                                   |
| Viewport + presentation     | `tests/renderer/tui-geometry.test.ts`, `tests/renderer/tui-surface.test.tsx`, `tests/renderer/tui-widgets.test.tsx`, `tests/renderer/session-view.test.tsx` (session-column grid, dock vs float, no backdrop, wheel/focus, widget strips)                                                                               |
| Renderers                   | `tests/host/extension-renderers.test.ts`                                                                                                                                                                                                                                                                                |
| Renderer store + components | `tests/renderer/extension-ui-store.test.ts` (dialog timers and close-tab purge), `tests/renderer/extension-ui.test.tsx` (inline dock), `tests/renderer/tui-surface-store.test.ts`, `tests/renderer/extension-render-store.test.ts`, `tests/renderer/extension-block.test.tsx`, `tests/renderer/session-footer.test.tsx` |
| Integration                 | `tests/host/integration.test.ts` (a real extension’s `confirm()` round-trips `oi.request`/`oi.respond`; a `session_start` `setEditorComponent` produces no editor frame before or after `/reload`), `tests/e2e/custom-editor.spec.ts` (a seeded extension leaves the native composer, and Enter sends)                  |

## Known limitations / backlog (2026-10-26)

- **Nested overlays and a base custom under an overlay**: the wire still carries
  one `custom` slot, so only the topmost overlay is rendered and a non-overlay
  custom underneath is hidden. Pi composites the overlay stack.
- **A background tab's `ctx.ui.custom()` does not activate its tab** (only an
  `oi.request` dialog does), so a background questionnaire can block silently.
- **`setEditorComponent` remains recorded, never mounted** (the native composer
  is always the editor).
- **Mouse `handleMouse` dispatch** is not implemented; wheel is delivered as raw
  SGR input, which is what the Workflow questionnaire parses. The inline
  extension editor has no external-editor (`Ctrl+G`) bridge.
- **`opts.signal` abort** resolves the host promise without clearing an
  already-visible renderer dialog; the store timeout is the current backstop.
- **Stale `tuiSurfaces`** are not deleted when a tab closes.
- **An extension `setFooter` factory gets a reduced `FooterDataProvider`**: the
  renderer-built session footer shows the real git branch (from project
  inspection), but a custom footer’s `footerData.getGitBranch()` is `null` and
  `getAvailableProviderCount()` is `0` (`src/host/sdk/tui-surface.ts`). Fixing
  that needs a host-side branch watcher and a provider count; the built-in
  footer is unaffected (2026-10-31 minimal-session-ui).

## Notification muting (2026-10-31)

`ctx.ui.notify` has no extension/source field, so mute rules are derived from the
message: **exact text**, a **template** signature (numbers, quoted values,
`provider/model` refs and thinking-level words become `*`), or the whole
**type**. The gear on a warning/error toast (and on a history row) opens the Mute
dialog; Settings → Notifications lists the rules with Unmute/Unmute all.

A muted notification is **not deleted**: it stays in the history, is marked
`muted`, and is hidden from the transcript and future toasts. Identical
`oi.notify` messages are deduped in the transcript and their toasts are
suppressed per tab for five minutes, so an extension that re-emits the same
advisory on every state change cannot flood either surface.
