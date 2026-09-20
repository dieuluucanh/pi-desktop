# Pi Desktop — parity with terminal Pi

**Last updated:** 2026-09-20 (plan step 20).

This matrix is the product's contract: Pi Desktop is the desktop UI for the Pi
coding agent, and every row is either **implemented**, **planned at a stated
step**, or an explicit **non-goal**. "Terminal Pi" means the `pi` CLI running
from `@earendil-works/pi-coding-agent` 0.85.1.

Status legend: ✅ implemented · 🚧 planned (step) · ⛔ deliberately out of scope.

## Core agent loop

| Capability                                                 | Terminal Pi                     | Pi Desktop                                |
| ---------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| Chat with the agent (streaming text, thinking, tool calls) | ✅                              | 🚧 step 5 (transcript), step 6 (composer) |
| Steering / follow-up while streaming                       | ✅                              | 🚧 step 6                                 |
| Abort a run (Esc) and restore queued text                  | ✅                              | 🚧 step 6                                 |
| Compaction (auto + `/compact`)                             | ✅                              | 🚧 step 4 (methods), step 8 (surface)     |
| Branching: fork / clone / tree navigation                  | ✅                              | 🚧 step 11                                |
| Session list, resume, rename, delete, export HTML          | ✅                              | 🚧 step 11                                |
| Session storage                                            | JSONL in `~/.pi/agent/sessions` | ✅ same files (shared profile, D-A8)      |

## Models, providers, settings

| Capability                                               | Terminal Pi                | Pi Desktop                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model switching, per-model thinking levels               | ✅ (`/model`, `/thinking`) | ✅ step 8 (picker: grouped by provider, auth badges, search, favourites, “save as default” vs session-only)                                                                  |
| Context-usage ring, token/cost totals, rename, view mode | ✅                         | ✅ step 8                                                                                                                                                                    |
| Provider auth: OAuth subscriptions                       | ✅ (`/login`)              | 🚧 step 9 (system browser + code paste)                                                                                                                                      |
| Provider auth: API keys / env vars                       | ✅ (`auth.json`)           | 🚧 step 9 (write-only UI)                                                                                                                                                    |
| Custom models & gateways (`models.json`)                 | ✅                         | 🚧 step 9                                                                                                                                                                    |
| Every `settings.json` key, global + project              | ✅                         | ✅ step 12 (schema pinned to Pi's `docs/settings.md`; grouped editors, scope per key, raw JSON + diff, backup before first write)                                            |
| `keybindings.json`, themes, skills, prompt templates     | ✅                         | ✅ step 15 (keybindings editor with validation + conflicts; theme catalogue with swatches, import and chrome mapping; skills/prompts run via `/skill:<name>`)                |
| Proxy / offline (`httpProxy`, `PI_OFFLINE`)              | ✅                         | 🚧 `httpProxy` ✅ step 12; the `PI_OFFLINE` toggle lands with the offline banner in step 22 (it is process env, not a settings key, and cannot affect already-spawned hosts) |

## Extensions and packages

| Capability                                                                                 | Terminal Pi        | Pi Desktop                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load extensions, skills, prompts, themes from the profile and project                      | ✅                 | ✅ same discovery (shared profile)                                                                                                                                                                                                                                                                                                       |
| Extensions hub: inventory, provenance, contributions, load errors, enable/disable, reload  | ✅ (`/extensions`) | ✅ step 13 (live from a session host; a control host loads on demand with no session open)                                                                                                                                                                                                                                               |
| Extension slash commands (`/name`)                                                         | ✅                 | ✅ steps 7, 13 (completed with source + description from the hub)                                                                                                                                                                                                                                                                        |
| Extension keyboard shortcuts                                                               | ✅                 | ✅ step 15 (listed from the live runner with effective bindings, invoked with the runner's context; help dialog on Ctrl+/)                                                                                                                                                                                                               |
| Extension dialogs (`select`, `confirm`, `input`, `editor`), notifications, status, widgets | ✅ (TUI)           | ✅ step 16 (dialogs answer through `oi.respond`, with timeout countdown and cancel; notifications land in toasts + a history panel; status entries in the status bar; string widgets above/below the composer; working state and the hidden-thinking label)                                                                              |
| Extension autocomplete providers (`ctx.ui.addAutocompleteProvider`)                        | ✅ (TUI)           | ✅ step 16 (the host runs the factory chain and returns plain data; the renderer's `/`, `@`, `#` result is the chain's `current`, so a delegating provider still works)                                                                                                                                                                  |
| Extension custom UI (`ctx.ui.custom()`), footers, headers, custom editors                  | ✅ (TUI)           | ✅ step 17 (the host emulates `TUI`: `custom()` renders Pi's real components to ANSI frames with coalesced render, focus and overlay geometry; `setFooter`/`setHeader`/`setEditorComponent` render in their own slots; the renderer maps DOM keys to terminal bytes, frames a paste, honours `visible()`/resize and scrolls tall frames) |
| Extension custom tool/message/entry renderers                                              | ✅ (TUI)           | ✅ step 18 (the host runs `renderCall`/`renderResult`/`registerMessageRenderer`/`registerEntryRenderer` and returns ANSI lines the card shows; a missing or throwing renderer falls back to the native HTML card; Ctrl+O / the view mode drive `expanded`)                                                                               |
| Registered markdown transformers (`registerMarkdownTransformer`)                           | ✅ (TUI)           | ✅ step 18 (the host chains the transformers for user/assistant text before the renderer parses it)                                                                                                                                                                                                                                      |
| Install / update / remove packages (npm, git, path, URL)                                   | ✅ (`pi` CLI)      | ✅ step 14 (Pi's own package manager, bundled npm, streaming progress, consent dialog)                                                                                                                                                                                                                                                   |
| In-app terminal running the real `pi` TUI                                                  | n/a                | ⛔ post-MVP backlog (the bundled `pi` shim + an external terminal work today)                                                                                                                                                                                                                                                            |

## Context and input

| Capability                              | Terminal Pi           | Pi Desktop                                                                                                                                                |
| --------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@file` references with completion      | ✅                    | ✅ step 7 (rooted at the session's own cwd)                                                                                                               |
| `/` commands (extension, prompt, skill) | ✅                    | ✅ step 7 (app commands + host commands; a name both claim is listed with its source)                                                                     |
| Images: paste / drag into the prompt    | ✅                    | ✅ step 6                                                                                                                                                 |
| `#document` Office mentions             | ✅ (bridge extension) | ✅ step 20 (the app's own provider is fed by the live pane registry, so mentions work even when the bridge's provider is absent)                          |
| External editor for long prompts        | ✅                    | 🚧 setting ✅ step 12; the validated spawn lands with step 22 (reliability/cancellation), so the key is editable but the Ctrl+G launcher is not wired yet |

## Office

| Capability                                                                | Terminal Pi                         | Pi Desktop                                                                                                                                                |
| ------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi for Office bridge (`@dieulc/pi-office-bridge`)                         | install manually, sideload manually | ✅ step 19 — automated wizard (detect → bridge install → sideload → verify) as an **optional integration**                                                |
| Attached documents panel, document targeting, streamed pane replies, Stop | ✅ via bridge                       | ✅ step 20 (Documents panel from the live `/health` registry; office tool cards name the target and capability state; `office_list_documents` as a table) |
| Office surface in the primary navigation                                  | n/a                                 | ⛔ never — Office is an integration, not a menu (D-A10)                                                                                                   |

## MCP

| Capability                                                 | Terminal Pi                                                                                                                                                  | Pi Desktop                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Built-in MCP client                                        | ⛔ not provided by Pi ("It intentionally does not include built-in MCP… build or install those workflows as extensions or packages" — `<sdk>/docs/usage.md`) | ⛔ same: parity means no special work (D-A11)         |
| MCP servers, if a user installs a bridge extension/package | ✅ through the extension that provides it                                                                                                                    | ✅ same route: steps 13/14 (Extensions hub, Packages) |

## Platform

| Capability                                           | Terminal Pi               | Pi Desktop                                                |
| ---------------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| Runtime install                                      | user installs Node + `pi` | ✅ bundled Node 24 + `pi` PATH shim (`resources/runtime`) |
| Multi-session parallelism                            | multiple terminals        | 🚧 step 11 (tabs, one host per session)                   |
| Web UIs on localhost (e.g. Plannotator review pages) | system browser            | ✅ step 21 (in-app isolated web tab)                      |
| Auto-update                                          | `pi` self-update          | 🚧 step 26                                                |
| Windows / macOS / Linux                              | ✅                        | Windows first; macOS/Linux beta (D-A13)                   |
