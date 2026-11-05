# Session parity contract

**Last updated:** 2026-10-26 · **Terminal reference:** `@earendil-works/pi-coding-agent` 1.4.0 · **Plan:** `.pi/plans/2026-10-26-pi-desktop-session-parity.md`

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
   puts the text back.
10. **Command prompts are host-tagged and collapsed by default.** A prompt
    template/skill or an extension-injected user message carries
    `promptOrigin`; the row names the command, hides the expanded body, and is
    revealed by the row toggle, Ctrl+O, or `prefs.showExpandedPrompts`. Search
    and copy follow the visible state; hydration looks the origin up in the
    bounded `app-state.json` hash map, never by inventing a renderer row.

## Gap matrix (terminal 1.4.0 → desktop)

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
  previews, images, auto-follow, find, collapsed command rows.
- `tests/renderer/composer.test.tsx` — `!`/`!!`, chords, paste markers, queue.
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
- **External editor** opens an in-app expanded editor; a configured GUI editor is
  best-effort. TUI editors need a TTY the app does not have.
- **Paste markers** are persisted with a bounded paste map; the terminal keeps
  them in memory only.
- **Mermaid** renders SVG in the desktop (terminal renders Unicode diagrams).
