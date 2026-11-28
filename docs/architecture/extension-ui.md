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

| `ExtensionUIContext` member                                       | Where it lands                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select` / `confirm` / `input` / `editor`                         | inline dock in the session column through `oi.request` / `oi.respond`                                   | keyboard-first, live `timeout` countdown (store-enforced), `signal` cancel, Escape cancels                                                                                                                                                                                                                                                                                                                    |
| `notify(message, type)`                                           | transcript notice + notification bell; warning/error also toast (`oi.notify`)                           | every notification prints in the transcript, like terminal Pi's status line; classes/mute rules filter only the bell and toasts; info starts off for the bell; the archive keeps every notification and Show hidden recovers a suppressed row                                                                                                                                                                 |
| `setStatus(key, text)`                                            | one column in the wrapping session-footer status rail (`oi.state`)                                      | `undefined` removes the entry; keep status text short so it behaves as a column; values are sanitised for `title` and rendered ANSI-aware; contribution `status`/`progress` rows share this rail, after these entries (2026-11-25)                                                                                                                                                                            |
| `setWidget(key, lines \| factory, opts)`                          | string strip (`oi.state`) or TUI widget frames (`tui.state`)                                            | string arrays keep the strip; a component factory renders above/below the editor dock; a **single-line** component frame joins the footer rail instead of taking its own strip (2026-10-31 UI plan); one owner per key; the extension’s own TODO panel keeps its frame and header, untouched by the bar (2026-11-25)                                                                                          |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | the one working bar above the composer                                                                  | custom frames + interval honoured; a message is the bar’s hint and suppresses the default `Esc to cancel`; `visible:false` and `frames:[]` hide **only** the indicator/message (inline controls, menu and the lock marker stay); the message is clamped visually to one line with the full text in `title` and in a visually hidden `role="status"` node (see “One working bar”, 2026-11-25)                  |
| `setHiddenThinkingLabel`                                          | transcript thinking blocks                                                                              | replaces the collapsed thinking label                                                                                                                                                                                                                                                                                                                                                                         |
| `setTitle`                                                        | window title (validated in main)                                                                        | bounded, single-line                                                                                                                                                                                                                                                                                                                                                                                          |
| `getToolsExpanded` / `setToolsExpanded`                           | transcript tool-card expansion (`oi.state` + `oi.setToolsExpanded`)                                     | the app owns `Ctrl+O`; the host’s copy stays truthful                                                                                                                                                                                                                                                                                                                                                         |
| `pasteToEditor` / `setEditorText`                                 | composer mirror (`oi.editorText`)                                                                       | renderer reports its buffer back, debounced per tab; each edit carries the host/UI **binding** + `seq` it was minted in, so a rebind can restart at 1 without a new host's low sequence being dropped, a repeated frame never clobbers the user, and `oi.editorConsumed` makes delivery one-shot across a renderer reconnect (`tests/host/extension-ui.test.ts`, `tests/renderer/extension-ui-store.test.ts`) |
| `getEditorText`                                                   | the mirror                                                                                              | **eventually consistent** — the host cannot read a textarea synchronously                                                                                                                                                                                                                                                                                                                                     |
| `addAutocompleteProvider`                                         | the composer’s completion stack (`completion.suggest` / `apply`)                                        | the host runs `factory(current)`; the renderer sends its `/`, `@`, `#` result as `current` (or `null` on a shell line)                                                                                                                                                                                                                                                                                        |
| `onTerminalInput`                                                 | first shot at keys in the TUI surface                                                                   | runs before the surface’s own handling                                                                                                                                                                                                                                                                                                                                                                        |
| `custom(factory, opts)`                                           | the TUI surface (`tui.state` frames, whole stack)                                                       | `overlay`/`overlayOptions`/`onHandle` supported; a base component and its overlays are all reported (bottom-to-top, `layers`); returns `undefined` when nothing is shown                                                                                                                                                                                                                                      |
| `setFooter` / `setHeader`                                         | `setFooter` replaces the built-in session footer; `setHeader` renders a TUI frame in the session column | the factory’s component is rendered per frame; a custom footer owns the statuses **and receives the live git branch and available-provider count** through its `FooterDataProvider`; because the replacement is wholesale, the generic contribution status/progress rows are **not** injected into it                                                                                                         |
| `setEditorComponent` / `getEditorComponent`                       | recorded on the UI port; **never mounted**                                                              | the native composer is always the editor; see “A custom editor is recorded, not mounted”                                                                                                                                                                                                                                                                                                                      |
| `theme` / `getAllThemes` / `getTheme` / `setTheme`                | host theme + `oi.theme`                                                                                 | `setTheme` installs the theme in the host process and persists Pi’s `theme` setting                                                                                                                                                                                                                                                                                                                           |

| `shortcuts` (registered via `pi.registerShortcut`) | the composer’s Tab cycle and the session’s other chords (`shortcuts.list` / `shortcuts.invoke`) | checked before the editor’s own handling, as in Pi; the list is listed per tab on activation |

A `!` / `!!` shell line intentionally has **no built-in completion source**,
matching terminal Pi. The extension chain is still called with the built-in
result `null`, so an extension that supports `!` still opens its menu; otherwise
the composer shows no list and Tab reaches a registered shortcut (the Workflow
mode cycle). This is not a shell-line block on extensions: `/`, `@`, `#` and `!`
all still flow through `factory(current)`.

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

**A background `ctx.ui.custom()` badges, it never steals focus (2026-11-22).**
A mounted extension surface owns the keyboard and can block until the user
answers, so its arrival raises the tab's attention dot
(`tuiSurfaceNeedsAttention`: a newly mounted layer id, not a repaint). The app
never activates the tab automatically and never moves DOM focus in another pane:
only the focused pane's `TuiSurface` autofocuses and reports `tui.focus`. This is
what makes a background questionnaire visible without pulling the user out of a
running session or another grid pane. The rule is generic — it keys on the
surface stack, never on an extension name.

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

**Dialog text keeps terminal line semantics.** The select title is
extension-owned text: the workflow read/write gate puts `Outside:` and one
`• command` bullet per line into it. It renders through `MultilineText`
(`whitespace-pre-wrap break-words`), with tabs normalised to three spaces, inside
a height-capped scroll region, so every command keeps its own rendered line and
a very long title never squeezes the answers out of the dock. The same rule
already applied to confirm messages, option labels, notifications and working
messages.

**The active dialog owns the keyboard, not the focused DOM node.** Up/Down and
Escape used to be attached to the listbox/root, so a prompt whose focus stayed on
`document.body` ignored them. The dock now installs a window listener while its
pane is active: Escape and Ctrl+C cancel every method (a real text selection
wins over Ctrl+C so copy still works), select moves with `tui.select.up/down`
plus `j`/`k` (clamped at the ends, as in terminal Pi), Enter selects the
highlighted option even when focus is on the page, and confirm moves its
focus between Confirm/Cancel. Input/editor keep normal typing and Ctrl+C, and
only gain the focus-independent Escape. That Ctrl+C rule is a deliberate
desktop divergence: Pi's input/editor dialogs cancel on `tui.select.cancel`
(which includes Ctrl+C), but a desktop text field must keep Ctrl+C as copy.
Confirm also keeps Enter on the focused button; Pi's selector confirms the
highlighted "Yes" even with no list focus, and the desktop deliberately refuses
to let a lost-focus Enter answer a permission. `tui.select.*` comes from the
profile's `keybindings.json`; the dock loads it once with the same lazy no-arg
`loadKeybindings()` as the shortcuts help dialog, with Pi's defaults until the
snapshot arrives.
Every answer/cancel path is one-shot, so a double Enter or Enter+click sends one
`oi.respond`.

**Only the focused pane's dialog takes global keys.** `SessionView` passes
`active={active.id === focusedTabId}`; a prompt in a non-focused grid pane waits
for the pane to be activated instead of stealing keys or focus. While a dialog
owns the active tab, `ShortcutDispatcher` blocks app shortcuts and `app.interrupt`
even when the event target is `body`; `Ctrl+O` (`app.tools.expand`) stays
available because terminal Pi's selector explicitly supports it. The regression
coverage is `tests/renderer/dialog-keys.test.ts`,
`tests/renderer/extension-ui.test.tsx`, `tests/renderer/shortcut-dispatcher.test.tsx`
and the Electron `tests/e2e/extension-dialog.spec.ts`.

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

### The custom-surface stack and its ownership (2026-11-22)

**Every mounted surface is reported, bottom-to-top.** The wire used to carry one
`custom` slot, so a questionnaire overlay hid the review pane underneath it.
`tui.state` now includes `layers`: one entry per mounted keyboard-bearing
component with a stable `id`, its own frame, `overlay`, resolved `bounds` and
`focused`. `custom`/`overlay`/`bounds` still mirror the top of the stack, so a
renderer (or an older build) that only knows the single slot keeps working.
`SessionView` docks the base (non-overlay) layer and every floating overlay
renders above it; a bottom-anchored full-width overlay still docks as a sheet
and takes the composer. Pi's own composition is the model: the base component is
a child, overlays float above it.

**Ownership closes in the right order.** `finish()`/`hide()` dispose exactly one
component and hand focus back to the previous owner (the base layer, or the
overlay below), not to nothing. `reset()` — every session bind and rebind — now
settles every pending `custom()` promise with `undefined` before clearing the
slots, so an extension replaced by `/reload` cannot keep an old promise (and its
loader) alive.

**An aborted dialog is retracted.** `ctx.ui.select/confirm/input/editor` accept
an `opts.signal`; aborting it resolves the extension's promise _and_ emits
`oi.cancel { id }`, so the visible dock disappears immediately instead of
waiting for the store's five-minute backstop. The same retraction runs when the
session is replaced (`resetSessionUi`/`bridge.dispose`). Unknown/duplicate ids
are ignored, and a settled dialog never emits a cancel.

**A custom footer gets real facts.** `ctx.ui.setFooter()` receives the live
`ReadonlyFooterDataProvider`: extension statuses, the git branch (polled only
while a footer is subscribed) and the count of providers with available models.
`src/host/footer-facts.ts` owns the watcher; the SDK adapter only exposes it. The
built-in session footer is unaffected and still shows the project-inspection
branch.

### The native composer is still the editor (Tab precedence)

W's `CustomEditor` exists to fix terminal Pi's Tab precedence. The desktop's
native composer already implements the same order — an open completion menu owns
Tab first (accept the highlighted item), otherwise a registered extension
shortcut gets it (the Workflow mode cycle), otherwise completion runs — and
prompt history (ArrowUp/ArrowDown from the buffer's last line) is untouched by
extension shortcuts. `setEditorComponent` stays recorded but never mounted, so
`getEditorComponent()` coordination works while `/`, `@`, `#`, history and the
extension shortcut bridge keep their real behaviour
(`tests/renderer/composer.test.tsx`, "extension shortcut dispatch (Tab)").

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

**Pasting into a TUI surface (2026-11-18 questionnaire paste plan).** The
questionnaire's free-text answer is the extension's own component, not a DOM
input, so Chromium's paste command never runs on it: Ctrl+V used to reach the
frame as the raw byte `\x16`, Cmd+V was dropped, and `webContents.paste()` is a
no-op on a non-editable `div`. This is a desktop-only gap — terminal Pi gets a
bracketed paste from its terminal emulator — so the surface now supplies the
same gesture:

- **The surface recognises the chord.** Ctrl+V and Ctrl+Shift+V (Windows/Linux),
  Cmd+V (macOS) and Shift+Insert read the clipboard through
  `readClipboardText()` and send **one bracketed paste** to the extension; the
  `paste` event path (middle-click, a menu paste) goes through the same
  `createPasteIntake` decision point, so one gesture writes once and two
  deliberate pastes still both pass. The paste body has its own delimiters
  stripped, so text can never escape the framing.
- **The extension keeps its own semantics.** A bracketed paste makes pi-tui's
  `Input` strip newlines and its `Editor` normalise line endings and collapse a
  large paste into its own `[paste #N +lines]` marker — exactly terminal Pi. The
  composer's `[paste #N]` markers are deliberately **not** applied here: the
  extension owns the field and its submit, so a marker would be sent as literal
  text.
- **Menus work.** The surface reports keyboard ownership (`IPC.tuiFocus`), and
  main's right-click Paste and Edit ▸ Paste send the renderer a paste request
  for that tab instead of running the native command. With no extension frame
  focused, Edit ▸ Paste is the ordinary `webContents.paste()`.

Image/file paste still has no path into an extension frame (`onPasteImage` is not
bridged); the native composer keeps its attachments for that.

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

### Extension-owned panels are generic frame strips (2026-11-22)

A component widget frame carries its `ctx.ui.setWidget` key as `TuiFrame.key`
and is rendered from its ANSI lines only; the renderer never parses a widget's
glyphs, summary or key to infer workflow state. The retired Workflow adapter
(`src/shared/workflow-mode.ts`, `src/shared/workflow-todos.ts`, `ReviewBar`,
`TodoPanelBar`, `/review-*` and `/todos-*` dispatch) is deleted;
`tests/architecture/no-workflow-adapters.test.ts` fails if the parsers, magic
keys or command ids return. Status/progress/actions/mode/input come from the
generic contribution contract, and an extension's own widget is just a
read-only frame. An older extension that publishes only `ctx.ui.setStatus` prose
still lands in the footer rail, without the structured rows and controls. The
successor of the deleted native bar is the single `WorkingBar` below.

### One working bar, grouped actions and the mode menu (2026-11-25)

The native chrome above the composer is **one** thin row (`WorkingBar` in
`src/renderer/src/session/WorkingBar.tsx`), mounted once directly above the
composer, after the above-editor widget strips and the related-sessions bar
(where the contributed bar sat before). The old `WorkingRow` and
`ContributionsBar` are deleted; `RunStatusRow` (retry/compaction) stays separate
because it is a transient run row, not a second working bar. Each mounted pane
renders its own copy, one per session tab. The extension's own TODO panel is a
separate region and is **not** part of this row.

**What the row contains.** A spinner (`working.frames`, else the app's pulsing
marker), the extension working message or `Working…` when the tab is running,
the elapsed time, the default `Esc to cancel` hint, the publisher's inline
controls, a compact linked-tab button, a lock marker for
`input.availability === "locked"` (its reason in `title`) and the three-dot
menu. It hides only when _all_ of those are empty — no visible indicator, no idle
group label, no inline action, no linked tab, no menu, no input lock. It is not
suppressed while input is locked (Review must show it) and it is not mounted on
`stopped`/`crashed`/`failed` tabs, so a stale click cannot dispatch into a dead
host.

**`setWorkingMessage` semantics.** A message is the bar's hint: it renders
verbatim (never Markdown) and the desktop **does not append** its own
`Esc to cancel`, because the publisher's text already names its chords. A plain
run with no extension message keeps `Working… · Esc to cancel`. The message is
clamped visually to one line (`truncate`, full text in `title`) so the bar stays
one row, and the same full text is always present in a visually hidden
`role="status"` node — the clamp is visual only, never a truncation of what
assistive technology reads. `setWorkingVisible(false)` and
`setWorkingIndicator({frames: []})` hide **only** the indicator and message: the
publisher's inline controls, the menu and the lock marker stay, because “hide
the spinner” is not “remove the controls”.

**Actions may declare a group and a placement.** Optional additive v1 metadata
on a top-level `kind: "action"` contribution:

```ts
interface ContributionActionGroup {
  id: string; // owner-namespaced
  label: string;
  order: number; // default 0
  placement: "inline" | "menu"; // default "inline"
}
```

`placement` is a closed enum, so an unknown value is rejected rather than
guessed. Group identity is `(ownerId, group.id)`: two publishers never merge,
and the **first declaration in presentation order** fixes the group's
`label`/`order`/`placement` while a later conflicting declaration only
contributes its actions. `buildContributionBar()` partitions the visible actions
once:

- `inlineActions` — inline-grouped and legacy ungrouped actions, in
  presentation order, capped at `MAX_INLINE_ACTIONS = 3`;
- `actionGroups` — menu groups, plus an inline group whose members overflowed
  the cap, ordered by group order, owner id, group id, and actions by action
  order/id;
- `overflowActions` — legacy ungrouped actions past the cap (rendered under a
  generic `More actions` label).

The renderer never re-derives groups or owner rules. A publisher with no group
keeps exactly the old fallback (the first few inline, the rest behind the dots),
so the addition is backward compatible.

**`mode-choice` is menu data with its own slot.** A new closed kind:

```ts
interface ModeChoiceContribution {
  kind: "mode-choice";
  slot: "mode-choice"; // its own slot, never "mode"
  label: string;
  description?: string;
  actionRef: string; // same-owner top-level kind:"action" id
  checked?: boolean; // presentation state only
}
```

A choice carries **no command** and no `enabled`/`disabledReason` of its own:
execution and disabled state belong to the same-owner top-level
`kind: "action"` named by `actionRef`, resolved exactly like the mode label's
reference (`resolveContributionAction`). A dangling, cross-owner, wrong-kind or
missing reference leaves the entry visible and non-actionable instead of
inventing a command. The dedicated slot is deliberate: `bar.mode`,
`contributionViewsBySlot(snapshot, "mode")` and every other slot-based reader can
never promote a menu option into the composer's identity, and
`buildContributionBar()` excludes choices from `rows`. **Only `kind: "mode"`
supplies the composer's label/tone/border**; choices from another owner than the
primary mode are ignored.

**The mode control is a split control.** The published mode label stays the
cycle button (its pointer-focus rule is unchanged). When the model has
`modeChoices`, a separate chevron on its right (`aria-label="Switch mode"`,
`aria-haspopup="menu"`, testid `composer-mode-menu`) opens an upward menu
(`side="top" align="end"`) with one `role="menuitemradio"` row per choice, a
check icon and `aria-checked` for the current mode. The current mode is checked
and disabled with its reason; a choice whose action is missing or disabled is
disabled with the reason in `title`. Selecting a choice runs the referenced
action through `contributions.run`, so the label moves only on the next
validated snapshot — never optimistically. The chevron stays usable while the
cycle action itself is disabled (e.g. during Review), so the reasons remain
readable, and a publisher with no choices gets the label alone. The **whole**
control is measured (label + chevron) so the textarea's first-line reservation
clears both.

**Status and progress rows live in the footer.** Contribution `status` and
`progress` rows no longer render in the bar. `SessionFooter` renders them after
the `ctx.ui.setStatus` entries, tone-aware via `contributionTextClass`, with the
progress counts (`done/total`, stale marker) appended and `detail ?? text` in
`title`. The rail is bounded (`min-h-10 max-h-24`) and an entry may wrap
(`max-w-[72ch]`, `whitespace-pre-wrap break-words`; ANSI lines pass the opt-in
`wrap` mode of `AnsiLine`), so a long child-telemetry line is readable instead of
being clipped at 48ch. `contributionRows` counts toward the empty-rail guard.

**A custom `ctx.ui.setFooter()` replaces the footer, rows included.** The
built-in footer is replaced wholesale, so the generic `status`/`progress` rows
are deliberately **not** injected into the publisher's custom footer: a
publisher that replaces the footer owns its own presentation. Statuses are still
handed to the factory through its `FooterDataProvider`.

**Focus returns to the real owner.** A bar action runs in the host and then
bumps `surfaceFocusToken` whenever a dialog, dock or floating overlay owns the
keyboard (`surfaceOwnsKeyboard`), otherwise `composerFocusToken`. A
questionnaire or extension dialog never loses focus to a bar button.

**The extension TODO panel and its header are untouched.** The panel stays the
publisher's own read-only TUI widget frame, including the
`Child 2/7 · model · ctx · local todos` header it composes itself. Desktop never
parses, moves or re-composes that header, and the bar does not mirror a
`Todos n/m` chip: when the bar is idle and only has menu actions it shows the
first menu group's label (e.g. `Todos` or `Child todos`) so the three-dot
trigger is not an orphan. Progress lives in the panel header and the footer
rail.

**The TODO display controls target the active panel.** With the pinned 0.17.5
publisher the four verbs (`Auto todos`, `Show todos`, `Collapse todos`,
`Hide todos`), bare `/todos` and the terminal `Ctrl+Alt+O` shortcut act on
whichever panel `/orchestrator view` resolves as active: the child while the
child panel is active, otherwise the parent. The working bar's menu group is
`Child todos` in child view and `Todos` in parent view; the group id (`todos`)
and every action id/command stay stable, so nothing in the Desktop contract
changes. Preferences are per target: the parent keeps its plan-scoped choice on
`TodoStore`, while the child has an independent session-scoped display choice
keyed to `child-run:<runId>` (or `child-session` without a run). A new run
starts at Auto; reloading the same run restores the choice; switching views or
clearing the parent never resets it. `/todos clear` stays **parent-only** — in
child view it refuses with `/orchestrator view parent` guidance and leaves both
lists untouched. A zero-row child is not settled: the four verbs (and the child
header) remain available so a preference can be stored, but that never invents
a child header, a TODO row or a `0/0` progress row. A real header renders alone
in Auto/expanded, header plus `No todos yet · /todos expand` when collapsed, and
no widget when hidden; with neither header nor rows — for example an explicit
child view restored after reload — no widget is registered at all. Menu
availability, derived display state and widget content are separate concerns.
The Desktop still never parses or re-composes the panel: the seam remains the
generic contribution contract.

**Compatibility matrix.** The Desktop's staged/pinned publisher bundle is
`resources/workflow.lock.json`: `@dieulc/workflow` **0.17.5**, pinned as a
**public npm release** (`source.kind: "release"`,
`source.url: https://registry.npmjs.org/@dieulc/workflow/-/workflow-0.17.5.tgz`,
`source.tag: @dieulc/workflow@0.17.5`, 99 source files,
`source.integrity: sha512-B99r3Aqdd9C+pnxTNv8swFhTUUfWQb/bXasPMqNu7Xgw/6KBUJO/UNXNjuYwSMkq72aDvYgKMN0XT4pdqSOyKA==`).
`npm run workflow:lock`/`workflow:stage` verified every byte against the lock and
staged both `resources/extensions/workflow` and `out/extensions/workflow`;
`npm run workflow:verify --offline --require-dev` re-read both staged copies.
The artifact is the published 0.17.5 npm tarball; packaged build and live
provider walkthrough remain **NOT RUN**. Contribution v1 stays additive:
`HOST_CONTRIBUTION_VERSION` does not move, and the kinds list in the host
capabilities gains `mode-choice`.

| Desktop | Publisher                             | Behavior                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New     | 0.17.5 (public npm, staged/pinned) | Full UX: one working bar, inline Pause/Resume/Abort, active parent/child TODO targeting with the `Child todos`/`Todos` menu group and four display verbs, `Auto todos`, the mode chevron, the live owner-by-owner `/profile use` switch and its `workflow-model-switch` entry, telemetry only in the footer. This is the published npm artifact (99 source files); packaged/live acceptance remains NOT RUN |
| New     | 0.15.0 (older, no longer pinned)      | Full UX with grouped three-dot TODO controls, `Auto todos` and the mode chevron, but no child-specific display controls and no live `/profile use` model switch                                                                                                                                                                                                                                    |
| New     | 0.14.0 (older checkout)               | No groups and no `mode-choice`: legacy flat actions (first few inline, rest in the dots), no chevron, verb-grammar commands (`/orchestrator pause`, `/review pause`)                                                                                                                                                                                                                               |
| New     | 0.13.0 (legacy, no longer pinned)     | Same fallback with hyphenated commands (`/orchestrator-pause`, `/orchestrator-resume`, `/orchestrator-abort`, `/orchestrator-view`, `/review-pause`, `/review-resume`, `/review-abort`, `/review-status`); its `orchestrator-child` status row is routed to the footer and may duplicate the `workflow-orchestrator` line                                                                          |
| Old     | 0.17.4                                | The old reader drops the unknown `mode-choice` kind, ignores `group` and renders the remaining actions in its old “first four + More…” layout; the four `/todos` display actions stay dispatchable but carry no `Child todos` grouping, and the removed `orchestrator-child` row does not affect the old footer                                                                                    |
| Old     | 0.15.0 / 0.14.0 / 0.13.0              | Existing behavior; no regression                                                                                                                                                                                                                                                                                                                                                                   |

> **Pin status:** the staged and pinned publisher is the published npm
> `@dieulc/workflow@0.17.5` artifact (99 files), pinned by integrity. The live
> model switch and the child display controls are compiled into this bundle.
> Manual Terminal/Desktop child acceptance remains **NOT RUN**, and no native
> Todo panel bar or new Desktop chord was added.

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

### The composer’s mode control and the mode cycle

The composer’s top-right corner shows the session’s **current mode** and, when
the publisher says so, is the control that changes it. Two independent Desktop
mechanisms are involved and neither knows a mode name:

- identity and tone come from a `kind: "mode"` contribution (`label`, `detail`,
  `tone`); **only a mode** may define the composer’s label and border. A
  progress/status row is never promoted into a mode, and a `mode-choice` menu
  entry (its own slot, see “One working bar”) never is either;
- activation comes from the mode’s optional `actionRef`, the id of a
  **same-owner, top-level `kind: "action"`** contribution. The reference carries
  no command: Desktop sends `(tabId, ownerId, actionId)` through
  `contributions.run`, and the host re-resolves the live action and its
  registered command. A dangling, cross-owner or non-action reference renders an
  informative label with no button.
- the label is a **split control** when the publisher also supplies same-owner
  `mode-choice` entries: the label keeps its cycle behaviour and a chevron on its
  right opens an upward mode list (`role="menuitemradio"`, checked + disabled for
  the current mode). No choices means no chevron, so a legacy publisher keeps the
  exact label/cycle control it had.

Nothing is extension-specific: the component (`ComposerModeControl`) never sees
“workflow”, “plan” or a command name. A third-party publisher gets the same
control, and its label can be any bounded text. The border uses the mode’s
semantic tone (`contributionBorderClass`), while a `!` shell line forces the
warning tone.

**The label follows published state, never an optimistic step.** A click (or a
keyboard activation) is a request; the displayed mode changes only when a new
validated `contributions.state` snapshot arrives. Acknowledgements are parsed
honestly: `{ran:true,error}` is a handler failure, `{ran:false}` is a refusal,
and neither proves a transition. Uncertain requests are never retried
automatically, and a settled action triggers one guarded refresh of the live
registry.

**Clicking does not disturb the prompt.** Pointer activation prevents the
default focus shift, so the draft, selection and caret stay in the textarea;
keyboard users Tab to the button and press Enter/Space. The control announces
mode changes through one polite status node and exposes
`"<mode> — <action label>"` as its accessible name. The reserved padding is
measured (`ResizeObserver`, bounded, with a safe default in jsdom) instead of a
fixed `pr-14`, so “Orchestrator” and localized labels do not overlap text.

**No fallback mode row.** The corner control is the only mode surface. When an
extension dialog or docked `TuiSurface` replaces the composer there is
deliberately no mode strip above it: the requested UX is “the composer label is
the control”, and a second location would drift. Unrelated task, progress,
review, handoff and recovery controls belong to the single working bar (below),
and status/progress rows belong to the footer rail; the bar renders nothing when
none of them are visible (no empty bordered strip).

**Tab and the button share one controller.** A publisher that offers a cycle
registers one command and one shortcut (Workflow registers `/workflow-cycle` and
`tab`); both call the same extension-side operation. Desktop matches registered
shortcuts before its own completion handling — so Tab cycles when no completion
menu is open and accepts the highlighted item when it is — and per-tab shortcut
lists mean two panes with different extensions never run each other’s keys.
Desktop never assumes `tab` means “mode”: an extension that does not register it
keeps the ordinary completion behaviour.

**The list is per tab and fenced.** `loadShortcuts({tabId})` /
`invokeShortcut(key, tabId)` target an explicit session; late responses and
failures are dropped when a newer load, a push or a lifecycle reset superseded
them. A boot-time list can arrive before the host resumes, so a failed or empty
list is not latched: the next activation, Tab press or readiness change retries.

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

## Known limitations / backlog (updated 2026-11-22, parity row 28)

Closed in this row, with regressions: nested overlays and a base `custom` under
an overlay (`layers` stack, `tests/host/tui-surface.test.ts`), background
`custom()` attention without focus theft
(`tests/renderer/tui-surface-store.test.ts`, `tests/renderer/tui-surface.test.tsx`),
`opts.signal` abort retraction (`oi.cancel`, `tests/host/extension-ui.test.ts`,
`tests/renderer/extension-ui-store.test.ts`), stale surfaces on close/rebind
(`tests/renderer/tui-surface-store.test.ts`, `reset()` settling pending
promises), and the reduced custom-footer `FooterDataProvider`
(`src/host/footer-facts.ts`, `tests/host/footer-facts.test.ts`).

Still open:

- **`setEditorComponent` remains recorded, never mounted.** This is deliberate:
  the native composer keeps `/`, `@`, `#`, history, paste attachments and the
  extension-shortcut bridge; mounting Pi's editor would drop them (the same
  choice Pi's RPC mode makes).
- **Mouse `handleMouse` dispatch** is not implemented; wheel is delivered as raw
  SGR input, which is what the Workflow questionnaire parses. The inline
  extension editor has no external-editor (`Ctrl+G`) bridge.

## Notification classes, offers and muting (2026-11-08; offers derived 2026-11-18)

`ctx.ui.notify` has no extension/source field, so the coarse class is **severity
plus the two app-owned offer kinds**: `update`, `extension`, `error`, `warning`,
`info`. Classes are toggled in Settings → Notifications and default to
everything except info **on** — background chatter such as “Server logs ready
(local)” never reaches the bell or a toast. The transcript always prints
extension output, like terminal Pi's status line. There are deliberately no
content heuristics; a noisy info message is handled by the class switch or a rule
for the bell and toasts.

Per-message rules remain the fine-grained switch for the bell and toasts,
derived from the message: **exact text**, a **template** signature (numbers,
quoted values, `provider/model` refs and thinking-level words become `*`), or
the whole **type**. The gear on a warning/error toast (and on a row) opens the
dialog; Settings → Notifications lists the rules with Unmute/Unmute all. All
three scopes are selectable; when a message has no variable parts the template
rule is equivalent to the exact one and the dialog says so. Rules apply to
**archive rows only** (extension output), never to app-owned offers.

A suppressed notification (class off or rule match) is **not deleted**: it stays
in the archive, is marked `hidden`/`muted`, and is hidden from the bell and
future toasts, while its transcript row still prints (2026-11-15). The bell
always renders, counts unsuppressed archive rows plus live offers, and closes its
popover on an outside click, Escape or the bell (there is no header `×`); it keeps
a per-row `×`, class badges and **Show hidden (N)**. A class-hidden row offers
**Show** (enable the class); a rule-muted row offers **Unmute**. Only an
immediately repeated identical `oi.notify` row collapses in the transcript; a
repeat after any other content adds a row. Toasts are suppressed per tab for
five minutes.

**Two channels, one bell (2026-11-18).** The archive holds _events_: extension
`ctx.ui.notify` output, bounded at 100 rows. The app's own **offers** are state,
not arrivals: the renderer derives them from live updater/package state on every
render (`offerNotifications` in `src/shared/notifications.ts`) and never stores
them. A row exists exactly while its condition holds, so an applied update clears
it without any bookkeeping, and a new version/set replaces rather than stacks.

An **app update offer** is class `update`, one per offered version, with a
**View update** action that opens About & updates. Its copy follows the updater:
available → “is available.”, downloading → “is downloading.”, downloaded → “is
ready to install.”; any other phase produces no row. The About & updates sidebar
item carries a dot while a version is offered/downloading/downloaded.

An **extension update offer** is class `extension`, one per update _set_ (a
sorted `source@latestVersion` fingerprint), with a **View extensions** action that
opens the Extensions hub on the Packages card. A partial update narrows the row
to the remaining count. The class is on by default and has its own Settings
switch, so muting app updates does not mute extension updates. The sidebar
**Extensions** item carries a dot while the set is non-empty, and each outdated
package row shows a `1.6.0 available` badge; a pinned row never does (the sweep
skips a deliberate pin).

**Dismissal, not a row cache.** `prefs.updates.dismissedVersion` and
`prefs.packages.dismissedSignature` record an offer the user removed with `×` or
**Clear**; they are the only reason a live offer stays hidden. A newer version or
a changed set no longer matches and raises the row again, and the surface that
owns the offer (About & updates for the app, the Packages card for extensions)
carries **Notify me again** to clear the marker. Both offers survive a relaunch
until dismissed or resolved. `prefs.updates.notifiedVersion` /
`prefs.packages.notifiedSignature` remain the toast-dedupe markers (one toast per
offer per profile). Navigation never dismisses: opening Extensions or About &
updates is not the action the offer is asking for.

## Generic extension contributions and related sessions (2026-11-21)

The host no longer routes any extension by name. Plan/Build/Review/TODO
presentation, input ownership and related-session links are generic, bounded
contributions validated in `src/shared/extension-contributions.ts` and stored in
one registry per session (`src/host/contributions.ts`).

- **Arbitrary modes/actions.** A contribution carries its own kind, slot, tone,
  label, bounded command name and presentation order. The host knows only the
  contract; it does not parse Workflow status prose, glyphs or mode strings.
  An action runs only a command resolved from the live host registry — a payload
  cannot inject a shell fragment or an arbitrary command.
- **Ownership is separate per publisher.** Envelopes are revision/epoch fenced.
  One owner cannot remove or replace another owner's rows through `removed`; a
  stale epoch is dropped and a newer epoch starts that owner clean. `reset()`
  during runtime replacement leaves no actionable stale button.
- **Input availability** is explicit (`available`/`restricted`/`locked`) with a
  reason, so the native composer can explain why it is not taking text.
- **Related sessions** use `src/shared/related-sessions.ts` and
  `src/host/related-sessions.ts`. Ownership is derived from the registered
  command's SDK `sourceInfo`; the payload's own owner key/label is never
  authority. Capabilities are negotiated per session, unsupported operations
  fail before work starts, bootstrap entries are written before the runtime is
  created (never as a turn trigger), and duplicate request ids replay/join the
  pending operation instead of creating a second child. Timeouts and teardown
  settle without a hidden retry.
- **Two unrelated fixtures** (`tests/host/extension-contract.e2e.test.ts` and
  the shared `tests/fixtures/two-extension-contract.json`) exercise arbitrary
  modes, cross-owner actions, stale epochs, reload, absent capabilities and
  source-bound related-session ownership. No Workflow import or name is needed.

The installed SDK's event bus is **not** publisher authentication. Source
binding is established for related-session authority through registered command
provenance; a contribution's declared owner is a namespace, not an auth token.
Extensions remain trusted executable code — this is not a new sandbox.

### Composer transform contract (frozen, row 13)

The additive `composer-transform-v1` capability is frozen in
`src/shared/composer-transform.ts` and
`tests/shared/fixtures/composer-transform.conformance.json`, copied
byte-for-byte from the Workflow package (both suites assert the same SHA-256).
This row adds the independent Desktop reader, not renderer integration.

- **Contribution shape.** `kind: "composer-control"` uses the
  `composer-actions` slot, a closed semantic icon list, checked/enabled/reason,
  an explicit `one-shot-return` or `persistent` behaviour, and same-owner
  `actionRef` (toggle) and `transformActionRef` (operation) references.
  `resolveComposerControlTargets` resolves live actions and refuses foreign,
  wrong-kind, dangling or command-less targets. The transform action must name
  the declared public input command; the renderer never supplies command text.
  The ordinary contribution bar ignores the new slot until the composer
  projection lands, so accepting the kind cannot create a blank row.
- **Operation metadata and source binding.** `operation` names the public input
  command and the registered bootstrap companion.
  `resolveComposerOperationCommands` requires both live SDK registrations to
  share `sourceInfo` (`path`, `source`, `scope`); equal names from different
  extensions are refused.
- **Frames and limits.** Start request (binding/session/epoch, contribution and
  draft revisions, selection, attachment identity/digest metadata, optional
  bounded in-band image bytes), started receipt, progress, candidate, status,
  cancellation, apply receipt and lifecycle failures have independent
  validators. Draft text, expanded text, image bytes, attachment ids/digests,
  model/provider context and grants are absent from `composerTransformDiagnostics`.
  The old contribution `maxArgsChars` stays 1 000; operation transport does not
  ride on command args.
- **Bootstrap/rendezvous.** SDK 1.5 command handlers are string-only. The
  companion bootstrap is a grant-only JSON string (`contract` + `grant`); extra
  fields are refused. The host arms a single-use listener on the SDK EventBus
  before bootstrap, the grant id selects a private channel, and a random proof
  must match before the typed in-process port is handed to the companion
  callback. Listeners are removed on claim, expiry, rejection and teardown.
- **Old hosts.** Contribution v1 stays additive: an older Desktop drops the
  unknown kind and keeps supported status/action rows plus the text command.
  `composerTransformFallback()` reports `nativeControl: false` and
  `attachmentAware: false`; a text fallback never promises attachment-aware
  transformation.
- **Implementer walkthrough (how a host drives a refinement).** Use the
  structured capability, never slash-string concatenation:
  1. Read a published `kind: "composer-control"` from the snapshot and resolve
     its `actionRef`/`transformActionRef` with `resolveComposerControlTargets`;
     refuse foreign, wrong-kind, dangling or command-less targets.
  2. Resolve the declared public input command and the `operation` companion with
     `resolveComposerOperationCommands`; require both live registrations to share
     one `sourceInfo`. Refuse equal names from different extensions.
  3. Arm a single-use EventBus listener, mint a CSPRNG request-scoped grant, and
     invoke the companion with the grant-only JSON bootstrap. A matching proof
     hands you the typed in-process port; nothing else does.
  4. Drive typed frames over that port — `start`, `started`, `progress`,
     `candidate`, `cancel`, `status`, `apply` — with the per-tab reducer applying
     a candidate only to the exact still-current draft revision and recording an
     idempotent apply receipt. Never parse a label, glyph or status string to
     infer state, and never route the draft through `command.args`.
  5. Re-resolve trust/grants/policy at each authority boundary; treat a narrowing
     policy-generation change as cancellation, not as an applicable cached
     result. Revocation stops future reads/prompts; it does not recall provider
     data already disclosed in an earlier request.
     Only a host with none of this may fall back to running the plain text `/prompt`
     command, and it must report `attachmentAware: false`.
- **Minimal generic frontend example.** Pseudocode, no Workflow import and no
  slash concatenation — a second, unrelated publisher gets the same treatment:

  ```ts
  // 1. Find any publisher's composer control in the validated snapshot.
  const control = snapshot.contributions.find((c) => c.kind === "composer-control");
  if (!control) return { state: "unsupported", attachmentAware: false };

  // 2. Resolve its same-owner toggle + transform references against live commands.
  const targets = resolveComposerControlTargets(snapshot, control);
  if (!targets.ok) return { state: "disabled", reason: targets.reason };

  // 3. Bind the public input command and its bootstrap companion by provenance.
  const op = resolveComposerOperationCommands(targets.transformCommand, targets.operation);
  if (!op.ok) return { state: "refused", reason: op.reason }; // e.g. foreign companion

  // 4. One-use private rendezvous: grant-only bootstrap, proof-checked port.
  const grant = mintGrant();
  const port = await armRendezvousBus(grant); // single-use listener; timeout + teardown
  await runCommand(op.companion, bootstrapString(op.contract, grant));
  const typed = await port.claimWithProof(); // not a string, not command args

  // 5. Typed operation, CAS apply on the exact current draft revision.
  const started = await typed.start({ draft: captureRevisionedDraft(), selection, attachments });
  const applied = await typed.applyCandidate(started.candidateId, {
    expectedRevision: started.baseRevision,
  });
  // Re-resolve policy before each turn; a narrowing generation cancels, never applies a cached candidate.
  ```

  Workflow registers `/prompt` (input) and `/prompt-refine-companion` (bootstrap)
  and `/prompt-refine` (toggle) against this contract; the host learns none of
  those names from its code — they come from the publisher's metadata.

### Related-session identity pass-through (2026-11-22)

A created child now returns both the opaque `sessionRef` handle and the real
durable `sessionId`/`sessionFile` when the host owns creation. They are distinct
fields: a handle may identify a tab, while the identity is what an extension
needs to write bootstrap metadata or reconcile a restart. `open` focuses the
existing owner rather than starting a second JSONL writer, and a duplicate
`requestId`/`dedupeKey` joins the original operation.

Bootstrap entries are data, never a turn trigger. The generic contract accepts
the Workflow-owned `workflow-task-scope` and `workflow-control-grant` types
alongside the managed/assignment/roadmap entries; the host forwards them
without interpreting them. The extension reads only a grant _reference_ from
that metadata — the shared secret stays in a private file, never in argv,
prompts or contribution text.
