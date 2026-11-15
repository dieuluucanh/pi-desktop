# Session parity contract

**Last updated:** 2026-11-15 · **Terminal reference:** `@earendil-works/pi-coding-agent` 1.5.0 · **Plan:** `.pi/plans/2026-10-26-pi-desktop-session-parity.md` · `.pi/plans/2026-11-14-transcript-line-parity.md` · `.pi/plans/2026-11-15-transcript-full-width.md` · `.pi/plans/2026-11-15-extension-command-output-parity.md`

**Status:** Phase A–F (steps 1–24) shipped. **Phase G (steps 25–28, updates) is deferred whole**, as the plan permits; `/bug` writes a local zip and does not upload to Radius.

This document is the session-chat contract between Pi Desktop and terminal Pi.
The product-wide matrix stays in [parity.md](../product/parity.md); this file
owns the chat/composer/transcript/command details so a refactor cannot silently
drift from the terminal.

## Invariants

1. **The transcript is a pure function of host events.** The renderer never
   injects a row. Anything that survives resume must be derivable from
   `messages.get`; anything live must arrive as an SDK event. A command
   invocation is not echoed as a user bubble.
2. **Hydration and live rendering are identical.** Every SDK message role has one
   mapping: `user`, `assistant`, `custom`, `custom_message`, `compactionSummary`,
   `branchSummary`, `bashExecution`, `toolResult`; `system` is hidden. A resumed
   session must look like it did before the restart.
3. **`toolResult` is not a chat message.** Pi emits `tool_execution_end` and then a
   `toolResult` message pair (`agent-loop.js:532-558`). The tool card is built
   from the execution events; hydration pairs the result with its assistant
   `toolCall` by `toolCallId`. A result must never render as an assistant bubble.
4. **One tool call renders once.** An inline `toolCall` block is a fallback only
   when no tool run card exists. Tool-result images render in the card.
5. **Turn plumbing is silent.** `agent_start`, `agent_end`, `agent_settled`,
   `turn_start`, `turn_end` and `session_info_changed` update state, never append
   transcript rows.
6. **No silent stalls.** A retry, compaction, branch summary, aborted tool or
   failed turn always has a visible, cancellable state. A tool card never stays
   "running…" after the run settles.
7. **Bash is host-executed.** `!` runs through `executeBash` and keeps context;
   `!!` runs with `excludeFromContext`; neither is sent to the model as prose.
8. **Chrome is token-only.** Transcript/completion/dialog surfaces use
   `src/renderer/src/ui/*` and tokens from `styles/tokens.css`; no literal colour,
   radius or font.
9. **The composer clears at submit.** Enter empties the draft before the host
   request, matching terminal's `submitValue`; only a pre-acceptance refusal
   restores it (above anything typed since). A run that was acknowledged never
   puts the text back. A prompt submitted from history clears the composer and
   drops its stashed draft too (`submitValue` → `exitHistoryBrowsing`).
10. **Command prompts are host-tagged and collapsed by default.** A prompt
    template/skill or an extension-injected user message carries
    `promptOrigin`; the row names the command, hides the expanded body, and is
    revealed by the row toggle, Ctrl+O, or `prefs.showExpandedPrompts`. Search
    and copy follow the visible state; hydration looks the origin up in the
    bounded `app-state.json` hash map, never by inventing a renderer row.
11. **Markdown is structural: a span is inline, a block is a block.** A code
    span renders as an inline `<code>` inside the paragraph that contains it;
    only a fenced or indented code block renders as a `<pre>`. The discriminator
    is the hast shape `pre > code`, never a `language-*` class (a fence with no
    info string has no class). Block text is read from the AST, not from
    stringified React children, so a find `<mark>` inside a fence cannot corrupt
    the source. Inline code carries the token-driven `--color-code-bg` pill;
    the transcript content column fills the scroll area (the pane width minus
    its `px-4` gutter) at every zoom level, so display zoom changes how much
    content fits instead of adding side gutters. A fixed `ch` measure is
    absolute in CSS px and cannot follow a zoomed-out pane, which is why the
    old 110ch cap was removed (2026-11-15).
12. **A transcript re-render never resets syntax highlighting.** Two mechanisms
    keep a coloured fence coloured. First, the Markdown element overrides
    (`components`) are a module-level constant and `Markdown` is memoized; a
    changed element type would make React unmount and remount the subtree, which
    is why `streaming` reaches the `pre` renderer through a context rather than a
    closure. Second, `highlight-store.ts` caches Shiki tokens outside React,
    keyed by `language + "\0" + code` and bounded by entry count and source
    size; `CodeBlock` asks the cache and a synchronous warm path during render,
    so a remount (virtualized rows, tab/pane changes) paints colour on its first
    frame. The triggers to keep working: scroll re-renders, pointer-down
    `ensureSession`, the `focus`/`visibilitychange` re-sync, and find-bar/tool
    toggles. Never rebuild `components` inline and never move tokens back into
    component state.
13. **Prompt history is a draft-stashing walk.** The first `↑` stashes the draft
    text and caret in `historyBrowse` and shows the newest sent prompt; `↓` walks
    forward and, at the newest entry, restores the stash (including an empty
    draft). Any real write (`setDraft`) or submit ends the walk and drops the
    stash, exactly like pi-tui's `setText`/`submitValue` calling
    `exitHistoryBrowsing`. While a preview is visible, the debounced
    `prefs.set` and the `oi.editorText` mirror carry the stashed draft, never the
    recalled prompt. The walked entries are the merge of prompts sent in this
    renderer run (`draftHistory`) and a per-tab session seed rebuilt from the
    hydrated transcript's user messages (`messages.get`, `promptOrigin` first,
    100 cap). The seed is re-installed on every hydrate and branch switch,
    upgraded after `loadPrefs` re-applies command origins, cleared by
    `resetTranscript`, and pruned with the tab; shell `!` commands are not in the
    transcript and are not seeded.
14. **Line semantics are terminal's.** Every source newline inside transcript
    Markdown is a rendered line: `remark-breaks` turns a CommonMark soft break
    into a `<br>`, matching `pi-tui`'s inline renderer, while fenced/indented
    code keeps its own newlines. Extension **plain text** — `ctx.ui.notify`, a
    `ctx.ui.confirm` message, `ctx.ui.select` option labels,
    `setWorkingMessage` and the session error banner — is rendered verbatim by
    `MultilineText` (`white-space: pre-wrap`) and is **never** parsed as
    Markdown; only `custom_message` / `custom` entry content goes through the
    Markdown pipeline. The notice severity badge and the bell/toast class and
    mute rules are orthogonal to line preservation; they never gate whether the
    transcript row exists. A find query that spans a soft
    break is still counted by the item-model matcher but cannot paint one
    `<mark>` across the `<br>`; copy always uses the raw message text.
15. **Extension notifications are chat content.** Every `ctx.ui.notify` call
    prints a transcript notice with its full multi-line text, like terminal Pi's
    `showStatus` / `showWarning` / `showError`. Notification classes and mute
    rules filter the bell and toasts only; they never hide a transcript row.
    Only an immediately repeated identical notice collapses; a repeat after any
    other transcript content adds a row.

## Gap matrix (terminal 1.5.0 → desktop)

| Area                     | Terminal                                     | Desktop before this work                                                                                    | Owning step |
| ------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| Turn plumbing            | no rows                                      | ✅ silent, state-only (step 3)                                                                              | 3           |
| Stop reasons             | aborted/error/length notes                   | ✅ rendered once per turn                                                                                   | 3           |
| Resume roles             | compaction/branch/bash/toolResult            | ✅ every role mapped; toolResult hidden                                                                     | 4           |
| Tool calls               | one row                                      | ✅ visible in content order; one record per call                                                            | 5           |
| Aborted tools            | cancelled rows                               | ✅ swept + cancelled, with previews                                                                         | 6           |
| Tool previews            | read/grep/bash previews                      | ✅ 10-line preview + "N more lines"                                                                         | 6           |
| Bash `!`/`!!`            | host-executed, streams                       | ✅ `user_bash` → `executeBash`, `!!` excluded; no built-in shell menu, extension providers may still answer | 7           |
| Command prompts          | skill blocks collapse; injected prompts full | ✅ host-tagged command row collapsed by default; setting/Ctrl+O/row reveals                                 | 2026-10-26  |
| Retry                    | countdown + cancel                           | ✅ countdown row + Esc/Cancel                                                                               | 8           |
| Compaction               | spinner + cancel                             | ✅ status row + `session.abortCompaction`                                                                   | 8           |
| Queue                    | pending rows + Alt+Up                        | ✅ pending rows, Alt+Up, Ctrl+Q/Alt+Enter, live modes                                                       | 9           |
| Streaming follow         | pinned + jump-to-latest                      | ✅ content-size follow + jump pill + Ctrl+End                                                               | 10          |
| Find                     | Ctrl+Shift+F                                 | ✅ Ctrl+F, inline marks, next/prev (remappable)                                                             | 11          |
| Multi-line output        | one source line per line                     | ✅ 2026-11-14 (`remark-breaks`; verbatim extension text)                                                    | 2026-11-14  |
| Extension command output | status line in chat, always printed          | ✅ 2026-11-15 (every `ctx.ui.notify` prints; classes/mutes filter only the bell and toasts)                 | 2026-11-15  |
| Copy last / session info | `/copy`, `/session`                          | ✅ `/copy`, Ctrl+X outside editor, `/session`                                                               | 12          |
| Clone / extension switch | works                                        | ✅ leaf fork fallback; replaced sessions rehydrate                                                          | 13          |
| JSONL                    | export/import                                | ✅ `/export jsonl`, `/import` with confirmation                                                             | 14          |
| Changelog/hotkeys/quit   | commands                                     | ✅ `/changelog`, `/hotkeys`, `/quit`                                                                        | 15          |
| Session browser          | scope/sort/named/path/regex                  | ✅ scope tabs, sort cycle, named/path, re:/phrase                                                           | 16          |
| Session tree             | filters/fold/labels/search                   | ✅ filters, fold, search, label times, summary prompt                                                       | 17          |
| Share/bug                | gist or Radius; zip                          | ✅ secret gist + local redacted zip (no Radius)                                                             | 18          |
| Mermaid/LaTeX            | setting + renderer                           | ✅ KaTeX + lazy Mermaid (off/final/streaming)                                                               | 19          |
| Paste markers            | collapsed pastes                             | ✅ marker + memory body + content-lost hint                                                                 | 20          |
| External editor          | Ctrl+G                                       | ✅ in-app editor + shell-free OS editor                                                                     | 21          |
| Keybindings              | all actions remappable                       | ✅ Pi actions + desktop registry + capture UI                                                               | 22-24       |
| Updates                  | self + extensions                            | 🚧 Phase G deferred (desktop app only)                                                                      | 25-28       |

## Terminal reference anchors

- `dist/modes/interactive/interactive-mode.js` — key dispatch, slash commands,
  queue/pending area, retry/compaction status, `!`/`!!`, `/share`, `/bug`,
  `/session`, `/copy`.
- `dist/modes/interactive/components/assistant-message.js` — content order,
  grouped thinking, aborted/error/length notes.
- `dist/modes/interactive/components/tool-execution.js` — tool rows, previews,
  images.
- `dist/modes/interactive/components/session-selector*.js` — scope/sort/search.
- `dist/modes/interactive/components/tree-selector.js` — filters/fold/labels.
- `@earendil-works/pi-agent-core/dist/agent-loop.js:532-558` — tool execution end
  followed by the `toolResult` message pair.
- `@earendil-works/pi-tui/dist/components/editor.js` — paste markers, history,
  kill-ring (desktop keeps native textarea editing instead).
- `@earendil-works/pi-tui/dist/keybindings.js` — default chords.

## Where it is enforced

- `tests/renderer/session-events.test.ts` — reducer, hydration, tool-result
  suppression, retry/compaction/queue/bash state, command-prompt origins.
- `tests/renderer/fixtures/session-events.ts` — deterministic turn/tool/bash
  fixtures used by every later test.
- `tests/renderer/transcript.test.tsx` — content order, one card per call,
  previews, images, auto-follow, find, collapsed command rows, the
  inline-code sentence and the pane-wide content column.
- `tests/renderer/markdown-code.test.ts` — the pure `pre > code` extractor
  (language-less fences, `mark` flattening, the trailing-newline rule).
- `tests/renderer/markdown.test.tsx` — inline spans stay inside their paragraph,
  fenced/indented blocks stay blocks, find marks never reach block code, a soft
  newline becomes a `<br>`, and the Build Complete TODO sample keeps one line
  per TODO.
- `tests/renderer/multiline-text.test.tsx` — the shared primitive's class
  contract, caller-class merging and newline/indent preservation.
- `tests/renderer/transcript.test.tsx` — the `/profile` and `/folder-policy
status` notices print with the default `info: false` prefs and keep every
  line; the `workflow-complete` fallback has one `<br>` per TODO boundary, and
  assistant prose keeps a single newline.
- `tests/renderer/extension-ui.test.tsx` — an info row prints with default
  prefs; a warning row still prints when its class is off and a mute rule
  matches.
- `tests/renderer/session-events.test.ts` — only an immediately repeated
  identical `oi.notify` collapses; a repeat after other content appends.
- `tests/host/integration.test.ts` — every command output channel reaches its
  host event through `commands.run`.
- `tests/e2e/session.spec.ts` — a seeded extension's info command output is
  visible in the real transcript with default prefs.
- `tests/renderer/extension-ui.test.tsx`, `tests/renderer/notifications.test.tsx`,
  `tests/renderer/session-view.test.tsx`, `tests/renderer/notify-toast.test.tsx` —
  confirm/select/working/archive/toast/error-banner text keeps its lines.
- `tests/renderer/highlight-store.test.ts` — the token cache's contract: cache
  hits, in-flight/grammar dedupe, the synchronous warm path, `maxEntries` /
  `maxChars` eviction, oversized blocks, failure retries and `reset()`.
- `tests/renderer/markdown-highlight.test.tsx` — a forced re-render keeps the
  same `pre` node and its colours, a click-driven state update does too, a
  remount paints colour synchronously, and context still reaches the memoized
  surface.
- `tests/renderer/markdown-highlight-fallback.test.tsx` — a missing Shiki keeps
  the source text visible instead of rendering an empty block.
- `tests/renderer/transcript.test.tsx` — a fenced block's `pre` survives an
  unrelated transcript re-render (expand state, a new items array).
- `tests/renderer/composer.test.tsx` — `!`/`!!`, chords, paste markers, queue,
  and the history key routing/caret.
- `tests/renderer/prompt-history.test.ts` — the pure prompt-history walk: stash on
  entry, restore (including an empty draft), no wrap, stale-index clamping.
- `tests/host/session-core.test.ts` — bash run/abort, clone, export/import,
  replacement.
- `tests/host/packages.test.ts` — extension update check.
- `tests/shared/desktop-keymap.test.ts` — desktop keymap + conflicts.
- `tests/shared/updates.test.ts`, `tests/main/agent-runtime.test.ts` — update
  channels and runtime probe/rollback.

## Known desktop differences

- **Native textarea editing** (undo, word navigation, clipboard) is kept; the
  terminal kill-ring, `Ctrl+W/K/U`, `Ctrl+C` clear, double-Esc tree/fork, `Ctrl+D`
  exit and `Ctrl+Z` suspend are not ported. The menu/tabs own those actions.
- **Prompt-history carets.** `↑` places the caret at the end of a recalled
  prompt (pi-tui puts it at the start), so `↓` from the last line returns to the
  draft in one press even for a multi-line prompt. `↑` enters history from line 1
  at any column; pi-tui requires column 0.
- **Prompt-history reconstruction.** `!` shell commands are not in the resumed
  transcript, so history after a restart contains only typed prompts (terminal
  Pi behaves the same). Pressing `↑` before the session finishes loading is a
  no-op; the next press after hydration recalls.
- **External editor** opens an in-app expanded editor; a configured GUI editor is
  best-effort. TUI editors need a TTY the app does not have.
- **Paste markers** are persisted with a bounded paste map; the terminal keeps
  them in memory only.
- **Mermaid** renders SVG in the desktop (terminal renders Unicode diagrams).
- **No transcript measure.** The transcript column is the pane width (minus the
  scroll area's 16 px gutter) at every zoom level, so a zoomed-out window shows
  more content instead of adding side gutters; terminal Pi is bounded by its pane
  width in the same way. There is no readable-measure cap, so a maximised wide
  display gives long prose lines (the 110ch cap was removed 2026-11-15). Code
  blocks and tables keep their own horizontal scroll inside the column.
- **Markdown chrome stays desktop-native.** Bubbles, native list bullets, styled
  headings and syntax-highlighted code cards are kept; only line semantics follow
  `pi-tui`. A find query spanning a soft break is counted
  but cannot paint one `<mark>` across the `<br>`; copy uses the raw text.
- **Notification classes and mute rules filter the bell and toasts, not the
  transcript.** Every `ctx.ui.notify` prints in the transcript; info starts off
  for the bell by default. Only an immediately repeated identical notice
  collapses. Terminal's `showStatus` does the same for status lines; terminal
  appends repeated warnings/errors, while the desktop also collapses a
  back-to-back identical warning/error row.
- **Code colours are `github-dark` in both appearances.** Shiki token colours do
  not follow the light palette; only the block chrome (`bg-sunken`, `border-line`)
  is token-driven. A theme-aware Shiki palette is a separate change.
