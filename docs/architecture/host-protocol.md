# Host protocol

One Pi host process per session tab (plan D4). The Electron main process spawns
it with the bundled Node runtime and drives it over **JSONL on stdio**: one JSON
object per line, requests on stdin, responses and events on stdout.

Both sides share `src/shared/host-protocol.ts`; nothing else knows the wire shape.

```text
main → host   {"id":7,"method":"prompt","params":{"text":"hi"}}
host → main   {"id":7,"ok":true,"result":{...}}
host → main   {"event":"message_update","sessionId":"s1","payload":{"text":"he"}}
```

## Methods

`HOST_METHODS` is the complete list; `isHostMethod` validates it. Everything that
is declared but not yet wired answers
`{"ok":false,"error":{"code":"not_implemented"}}` **with the plan step that owns
it** in the message — see “Implementation status” below, which is the current
truth and supersedes the group table's implications.

| Group         | Methods                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transport     | `host.hello`, `host.ping`, `host.shutdown`, `host.blobs.read`, `host.metrics`                                                                                                                                             |
| sessions      | `session.create/open/list/resume/fork/clone/delete/rename/exportHtml`                                                                                                                                                     |
| conversation  | `prompt`, `steer`, `followUp`, `abort`, `clearQueue`                                                                                                                                                                      |
| state         | `state.get`, `messages.get`, `entries.get`, `tree.get`, `stats.get`, `compact`, `commands.list`, `tools.*`, `model.*`, `thinking.*`                                                                                       |
| configuration | `settings.*`, `providers.*`, `packages.*`                                                                                                                                                                                 |
| other         | `oi.respond` (extension UI answers), `oi.state`, `oi.editorText`, `completion.suggest`, `completion.apply` (extension UI + composer bridge), `tui.state`, `tui.resize`, `tui.input` (extension TUI surface), `files.list` |

## Framing rules

- `JsonlFrameDecoder` buffers chunks and emits complete lines; it tolerates split
  frames and blank lines.
- A line longer than `MAX_FRAME_BYTES` (5 MiB) is dropped and reported once; the
  decoder resynchronises on the next newline, and the supervisor marks that host
  `failed` instead of pretending nothing happened.
- A result at or above `BLOB_SPILL_THRESHOLD_BYTES` (1 MiB) is written to the
  host's blob cache and replaced by `{"$blob":"<path>","bytes":N}`; read it back
  with `host.blobs.read`. That method is deliberately exempt from spilling again,
  and it refuses any path outside the blob directory.
- An **event** payload over the threshold is spilled _in place_: each oversized
  top-level field (a tool `result`, a message body) becomes a `BlobRef` while the
  event keeps its identity, so the renderer can still render the card and fetch
  the body lazily. Event frames are serialized through a promise chain, so a
  spill can never reorder events.

## Process contract

- Selected by `--service` or `PI_DESKTOP_HOST_MODE=service`; **never** by a `pi`
  argument, so the same entry point can stand in for the `pi` binary (plan D16).
- Injected env: `PI_CODING_AGENT_DIR` (shared profile), `PI_OFFICE_BRIDGE_PORT`
  (the host's default bridge port; Desktop's Connect action always passes an
  explicit `38617`, so any session can become the owner on demand), `PI_DESKTOP_SESSION_ID`,
  `PI_DESKTOP_HOST_ROLE` (`control` = app-wide state and no `AgentSession`,
  `session` = one Pi session; plan D-A3),
  `PI_DESKTOP_BLOB_DIR`, `PI_DESKTOP_BACKUP_DIR` (where a host copies a file
  before rewriting it; plan step 12), `PI_DESKTOP_NODE`,
  `PI_DESKTOP_NPM_CLI` (absolute path to the bundled `npm-cli.js`, so package
  operations use the app's runtime and work with `npm` absent from PATH; plan
  step 14), `PI_DESKTOP_HOST_ENTRY`, `PI_DESKTOP_HOST_BUILD` (a fingerprint of
  the host bundle this process was spawned from; see the stale-host section),
  and `PATH` prefixed with the shim directory.
- `host.hello` reports protocol version, node/pi version, cwd, bridge port,
  pid/ppid and `buildId` (the `PI_DESKTOP_HOST_BUILD` value, or `null` for a
  host started by an older main). A protocol mismatch is logged, not fatal
  (risk R8).

## Supervisor behaviour (`src/main/host-supervisor.ts`)

| Concern        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| correlation    | `{id}` → pending promise; a response for an unknown id is ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| timeouts       | default 30 s per request, then `HostTimeoutError` (never an infinite hang)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| crash          | `exit` rejects every in-flight request, emits `crashed`, restarts with backoff `0/500/2000 ms`, then re-runs the handshake. **The supervisor does not resume sessions**; `session-service` owns the JSONL and reopens it on the `ready` status.                                                                                                                                                                                                                                                                   |
| restart budget | after the backoff table is exhausted the host becomes `failed` and `ready()` rejects                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ports          | 38617 is the bridge's default; host processes get 38617 for the `office` tab and 38618+ otherwise. The on-demand Connect command passes `38617` explicitly, so a normal tab can own the bridge without a restart.                                                                                                                                                                                                                                                                                                 |
| host cap       | `maxHosts` is the **memory-derived process ceiling** (`hostProcessCeiling(totalMemory)` = soft target + 2, clamped 4–10), not a capacity policy and not a session-tab limit. Starting one more rejects with a coded `HostLimitError` (`host_limit`) and a message that names host processes. The soft live-host target is enforced by the session service (LRU parking), not here.                                                                                                                                |
| idle recycling | a non-Office host with no real traffic for `idleTimeoutMs` is stopped and dropped from the supervisor, so the next activation re-spawns it and `session-service` resumes from JSONL. The timeout is **on by default at 15 minutes**; `isPinned(sessionId)` protects the control host, the active tab and the `/health` bridge owner from _idle_ sleep. Before stopping, the supervisor sends `state.get` and skips the recycle when the session is streaming, compacting, retrying or queued.                     |
| memory         | `host.metrics` is polled (`memoryPollMs`, 15 s); an **idle** host over `maxRssBytes` (1 GB default) is **stopped** (the same recycle path as idle), then the next interaction/ensure spawns and the session service resumes from JSONL. It is never restarted in place. The probe checks `state.get` first. Only the Office host and the `isBridgeOwner` host are exempt (they own port 38617); the active tab is deliberately **not** exempt, because this is the only per-host guard against a leaking session. |
| logs           | one file per session in `userData/logs/<sessionId>.log`, bounded to the last 200 lines / 64 KB in memory and on disk.                                                                                                                                                                                                                                                                                                                                                                                             |
| shutdown       | `host.shutdown` and a closed stdin pipe both run one idempotent teardown → `SIGTERM`, all pending requests settled, port released. A failed `start()`/`restart()` handshake terminates the child it spawned.                                                                                                                                                                                                                                                                                                      |

`SpawnedHostProcess`, the spawn function and the filesystem port are all injected,
so the whole supervisor is unit tested against a scripted fake host
(`tests/main/host-supervisor.test.ts`), and `tests/host/service.live.test.ts`
drives the real bundle when `out/host/index.mjs` has been built.

## Implementation status (2026-09-20, after plan step 17)

### Wired and tested

| Group             | Methods                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| transport         | `host.hello` (reports `role`), `host.ping`, `host.shutdown`, `host.blobs.read`, `host.metrics` (own RSS/heap/uptime)                                                                                                                                                                                                                                                                                                                                                                                                                            | `src/host/service.ts`                                                                                                             |
| sessions          | `session.create`, `session.open`, `session.resume`, `session.list`, `session.new`, `session.switch`, `session.clone`, `session.fork`, `session.forkMessages`, `session.rename`, `session.reload`, `session.lastAssistantText`, `session.exportHtml`, `session.exportJsonl`, `session.importJsonl`, `session.changelog`, `session.navigateTree`, `session.setLabel`                                                                                                                                                                              | `src/host/session-core.ts`                                                                                                        |
| conversation      | `prompt` (images + `streamingBehavior`; optional `promptOrigin` + `ack:"preflight"`), `steer`, `followUp`, `abort`, `clearQueue`                                                                                                                                                                                                                                                                                                                                                                                                                | `src/host/session-core.ts`                                                                                                        |
| state             | `state.get`, `messages.get`, `entries.get` (`since` cursor), `tree.get`, `stats.get` (`contextUsage`, `tokens`, queue modes), `compact`, `tools.list`, `tools.setActive`, `commands.list`, `commands.complete` (a live command's `getArgumentCompletions`), `commands.run` (direct handler execution; optional `ack:"started"`), `files.list` (workspace listing for `@` completion, rooted at the session's own cwd)                                                                                                                           | `src/host/session-core.ts`                                                                                                        |
| models & thinking | `model.list`, `model.available`, `model.set`, `model.cycle`, `thinking.levels`, `thinking.set`, `thinking.cycle`                                                                                                                                                                                                                                                                                                                                                                                                                                | `src/host/session-core.ts`                                                                                                        |
| session behaviour | `session.queueMode`, `session.autoCompaction`, `session.autoRetry`, `session.abortRetry`, `session.abortCompaction`, `session.abortBranchSummary`                                                                                                                                                                                                                                                                                                                                                                                               | `src/host/session-core.ts`                                                                                                        |
| settings          | `settings.get`, `settings.set`, `settings.raw` (read **or** write a whole scope), `settings.flush`; every response carries **both** scopes, the two file paths + mtimes, `drainErrors` and the project-trust flag. Writes are schema-validated: a named `SettingsManager` setter when Pi has one, otherwise an atomic whole-document edit, always with a backup before the first write                                                                                                                                                          | `src/host/settings.ts` + `src/host/sdk/settings.ts`, in both cores                                                                |
| control host      | `settings.*`, `session.list` (all projects), `session.delete` (validates; main trashes), `session.rename` (a stored, closed session), `providers.*`, `providers.custom`, `packages.*`, `project.inspect`, `project.trust`, `resources.list` (loads a project's resources with no session), `themes.*`, `keybindings.*`                                                                                                                                                                                                                          | `src/host/control-core.ts`                                                                                                        |
| extensions hub    | `resources.list` (both cores): extensions/skills/prompts/themes with source, scope, origin, contributed tools/commands/shortcuts/flags, loader diagnostics and live `extension_error` history                                                                                                                                                                                                                                                                                                                                                   | `src/host/resources.ts` (+ `src/host/sdk/resources.ts`)                                                                           |
| extension UI      | `oi.respond` + `oi.request` events; `oi.state` (the pushed snapshot, also readable on demand), `oi.editorText` (composer mirror), `completion.suggest`/`completion.apply` (host-run extension autocomplete providers). The full `ExtensionUIContext` is bound to every session via `bindSession`                                                                                                                                                                                                                                                | `src/host/extension-ui.ts` + `src/host/sdk/extension-ui.ts` (session host only)                                                   |
| TUI surface       | `tui.state` (pull the whole surface snapshot), `tui.resize` (the **session column's** measured rows/cols), `tui.input` (raw terminal bytes). The host emulates `TUI` for `ctx.ui.custom()`, resolves overlay geometry and renders `custom`/`header`/`footer`/`widgetsAbove`/`widgetsBelow` to ANSI frames; the renderer converts them to HTML, docks a bottom sheet, floats any other overlay, and forwards DOM keys/wheel                                                                                                                      | `src/host/tui-surface.ts` + `src/host/sdk/tui-surface.ts`, `src/renderer/src/tui/*` (session host only)                           |
| extension renders | `render.request` (run a registered `renderCall`/`renderResult`/message/entry renderer for one item and return ANSI lines), `render.markdown` (apply the registered `MarkdownTransformer`s to user/assistant text); `render.invalidate` is an event the host pushes when a renderer calls `context.invalidate()`                                                                                                                                                                                                                                 | `src/host/extension-renderers.ts` + the `bindSession` adapter (session host only)                                                 |
| skills & themes   | `themes.list` (both cores: built-ins + loader themes + conventional dirs + `themes` settings paths, with resolved swatches and the active theme), `themes.import` (validates name/filename/content before writing `<agentDir>/themes/<name>.json`); `keybindings.get/set/reset` (both cores: `<agentDir>/keybindings.json` validated against the documented table, conflicts reported); `shortcuts.list/invoke` (**session host only**: `ExtensionRunner.getShortcuts` with the effective bindings, handler runs with the runner's own context) | `src/host/themes.ts` + `src/host/sdk/themes.ts`, `src/host/keybindings.ts`, `src/host/shortcuts.ts` + `src/host/sdk/shortcuts.ts` |

### Declared and answering `not_implemented` (with the owning step)

| Methods                     | Step |
| --------------------------- | ---- |
| `files.read`, `files.write` | 20   |

`bash.run` / `bash.abort` are **implemented** (2026-10-26 session-parity step 7):
`bash.run` emits Pi's `message_start`, runs `executeBash` behind the `user_bash`
extension hook (forwarding `operations` or a full replacement result), streams
`bash_execution_update` chunks under the synthetic id and finishes with
`message_end`. `bash.abort` calls `abortBash`. A second command while one runs is
refused with `busy`.

Both `bash.run` and `commands.run` accept `ack: "started"`: with the flag the
request resolves as soon as the operation starts, and the final `message_end`,
`extension_error` or `session_error` arrives as an event. Without the flag the
legacy await-the-operation behavior is preserved for other callers.

### Prompt acknowledgement and command origins (2026-10-26 composer plan)

- `prompt` accepts `ack: "preflight"`: the request resolves with the session
  snapshot plus a `disposition` (`started` | `queued` | `handled`) as soon as Pi
  accepts the message, instead of after the run. A failure after that point is
  emitted as a `session_error` event (`{message}`), which the transcript renders
  as an error notice. Without `ack`, the handler keeps awaiting the whole run.
- `prompt` also accepts `promptOrigin` (≤400 chars): the raw `/command` text for
  a prompt template or `/skill:*`. The host pairs the dispatch with the next
  user-role `message_start` and adds `promptOrigin` to that event's **payload**
  (never to the SDK message). A plain prompt is matched by exact text and is
  consumed without a tag.
- `commands.run({name, args, ack:"started"})` derives the same origin as
  `/<name> <args>` before the handler runs, so a message injected by an extension
  (for example `/commit`'s `sendUserMessage`) is tagged too.
  `message_start.promptOrigin` is the only source of the transcript's command
  row; the renderer never infers it.

### Packages (plan step 14)

`packages.list` takes `{cwd?}` and answers `{packages, loadedAt}`: every entry in
`settings.json#packages` (both scopes for the requested project) with its
normalised source, kind (`npm`/`git`/`path`), scope, installed version, pin
state and installed path. `packages.install`, `packages.remove` and
`packages.update` take `{source?, scope, cwd?}` and answer the refreshed list.

- **Bare names are normalised to `npm:`** before anything else happens, because
  Pi's package manager treats a bare string as a _local path_ (`isLocalPath`).
  The normalised source is what is persisted and what terminal Pi then resolves.
- **Install and update require consent.** The caller must echo the exact source
  it showed the user (`consent: {source, systemAccess: true}`); a missing or
  stale echo is refused with `consent_required` before npm runs. `packages.update`
  without a source (update-all) echoes `*`.
- **Mutations are serialised** in the handler, so progress frames cannot
  interleave and two operations cannot fight over the npm root.
- **`packages.progress`** events carry `{operationId, action, phase, source,
message?, percent?}` (npm reports no percentage, so `percent` is coarse), and
  a successful mutation emits `packages.changed` so every open hub re-reads.

`DefaultPackageManager` lives in `src/host/sdk/packages.ts` (the only module
that constructs one). The bundled npm is injected as a **runtime-only**
`applyOverrides({npmCommand})` — never written to the shared profile — and Pi's
package manager is pointed at a small capture shim instead of npm directly: the
shim pipes npm, forwards read-only queries (`root -g`, `view …`) on stdout for
Pi's capture paths, sends installs to stderr so a package can never write into
the JSONL stream, and tees the output to a log file. A failed operation
re-throws a `PackageError` carrying the npm output tail and a classified hint
(offline / not found / auth / peer-dependency / missing runtime). The control
host reloads the shared settings after a mutation, so the app's cached
`SettingsManager` sees the entry the package manager wrote.

`tests/host/packages-parity.test.ts` pins the app's Office-bootstrap npm
plumbing (`src/main/packages/*`) to the SDK path: the same normalised
`settings.json` entries and the same `~/.pi/agent/npm` / `<cwd>/.pi/npm` root,
manifest name (`pi-extensions`) and `.gitignore`.

### Extension UI (plan step 16)

`src/host/extension-ui.ts` owns the stateful half (SDK-free) and
`src/host/sdk/extension-ui.ts` turns it into Pi's real `ExtensionUIContext` and
binds it to each session (`bindSession` in `src/host/index.ts`, now wired).

- **Dialogs** (`select`/`confirm`/`input`/`editor`) emit `oi.request` and block
  until `oi.respond` arrives with the same id — the RPC shape verbatim. A
  cancelled or aborted dialog resolves to the member's default (`undefined` /
  `false`), never a rejection the extension would have to catch; a timeout
  rejects so a wedged host cannot hang a session forever.
- **State** (`notify`, `setStatus`, `setWidget` string arrays, working message /
  visibility / indicator, `setHiddenThinkingLabel`, `setTitle`,
  `getToolsExpanded`/`setToolsExpanded`) is pushed as one `oi.state` snapshot
  after every change; `undefined` clears a status or widget. `oi.state` also
  answers on demand, which is what a tab activation uses.
- **Composer mirror**: `setEditorText`/`pasteToEditor` bump a monotonic `seq` in
  the snapshot so the renderer applies each host-issued edit exactly once;
  `oi.editorText` reports the composer's own text back so `getEditorText()` is
  truthful.
- **Autocomplete**: extension factories cannot cross the frame boundary, so the
  host runs the chain and `completion.suggest`/`completion.apply` return plain
  data. The renderer forwards its built-in `/`, `@`, `#` result as the chain's
  `current`, so an extension that delegates (the Office bridge does for anything
  that is not a `#` mention) still sees the app's own completion.
- **Theme** (`theme`, `getAllThemes`, `getTheme`, `setTheme`) reads Pi's active
  `Theme` through the well-known global symbol (the SDK exports `initTheme` and
  `Theme` but not the `theme` proxy); `setTheme` also persists the `theme`
  setting and emits `oi.theme` so the app chrome follows.
- **TUI surface** (plan step 17): `custom`, `setFooter`, `setHeader` and
  `onTerminalInput` render through the emulated TUI (see “Extension TUI surface”
  below). `setEditorComponent` is **recorded but never mounted** — the native
  composer is always the editor (a TUI editor has no submit/autocomplete/action
  bridge here). Every session bind resets the port’s session-scoped
  registrations before the new `session_start`. Without a surface (a control
  host, or a test that does not build one) `custom()` returns `undefined`
  exactly as RPC mode does, so an extension degrades instead of hanging.

Errors an extension throws while handling an event arrive as `extension_error`
and render as a transcript notice; an extension asking to shut down emits
`session.shutdown_requested`, which closes its tab.

### Extension TUI surface (plan step 17)

Pi's `ctx.ui.custom(factory, options)` hands an extension a `TUI` and a
component that owns the keyboard; RPC mode returns `undefined` for it. The
app emulates the TUI instead:

- **Host** (`src/host/tui-surface.ts`, SDK-free): coalesces `requestRender()`,
  exposes `terminal.rows/cols`, tracks focus (`Focusable.focused`), resolves
  overlay geometry (anchor, `width`/`minWidth`/`maxHeight`, margins, `%` sizes,
  `visible()`), implements `OverlayHandle` (`focus`/`unfocus`/`setHidden`/
  `hide`/`getBounds`) and renders each slot to ANSI lines with
  `component.render(width)`. `CURSOR_MARKER` is extracted and stripped for the
  focused component. A throwing component renders nothing rather than killing
  the session.
- **SDK adapter** (`src/host/sdk/tui-surface.ts`): injects pi-tui's real
  `visibleWidth`/`sliceByColumn`/`stripTerminalSequences`/`CURSOR_MARKER`, the
  `EditorTheme` an `EditorFactory` needs, a `ReadonlyFooterDataProvider`
  (live statuses, no git watcher) and the profile's effective keybindings —
  installed globally with `setKeybindings`, so Pi's `Editor`/`SelectList`
  honour a remap from the app's Keybindings view.
- **Wire**: one `tui.state` event pushes the whole `TuiSurfaceSnapshot` after
  every change (like `oi.state`); `tui.state`/`tui.resize`/`tui.input` are the
  renderer's pull/resize/key methods. `custom` is a single slot; a visible
  overlay takes it and reports `overlay: true` plus the resolved `bounds`.
  `widgetsAbove`/`widgetsBelow` carry component-factory widgets (at most 16 each
  after the sanitizer).
- **Grid**: `tui.resize` is the **session column's** measured grid — the
  transcript, status rows, composer/dock and footer — not the TUI surface's own
  box. That keeps `terminal.rows` stable while a row-aware extension component
  (the Workflow questionnaire) renders.
- **Renderer** (`src/renderer/src/tui/TuiSurface.tsx`, `AnsiBlock.tsx`): parses
  SGR/OSC-8 into styled spans (no `dangerouslySetInnerHTML`), pads each line to
  the host's cell width, draws the cursor, scrolls a tall frame with wheel +
  PageUp/PageDown, forwards a wheel that fits as an SGR wheel sequence, and turns
  DOM keys into terminal bytes with `src/shared/terminal-keys.ts` (pinned against
  pi-tui's `matchesKey`). A paste is framed as a bracketed paste, which is what
  Pi's `Input`/`Editor` expect.
- **Layout**: a non-overlay `custom` component and a bottom-anchored full-width
  overlay (the questionnaire) render as an in-flow dock in the composer region;
  `header`/`footer` and component widgets render around it. Any other overlay
  floats inside the session column at the host-resolved rectangle, with no dim
  backdrop; the transcript stays visible and scrollable. `src/shared/ansi.ts`
  mirrors pi-tui's `visibleWidth` (pinned by a corpus test) so wide characters
  and emoji stay aligned.
- **Dialogs**: `ctx.ui.select/confirm/input/editor` are inline docks, not
  page-level modals. The renderer store owns their `opts.timeout` so a
  background tab's dialog still expires.

### Extension renderers (plan step 18)

An extension can own the rendering of a custom message (`registerMessageRenderer`),
a bare custom entry (`registerEntryRenderer`) and a tool call/result
(`renderCall`/`renderResult`). Those are host functions returning pi-tui
`Component`s, so they cannot cross the frame boundary. `render.request` runs one
and answers ANSI lines the renderer shows inside the native card:

- **Request/response, not a pushed frame.** `expanded` (the app's Ctrl+O / view
  mode state) and `width` (the measured transcript grid) are renderer-local, and
  a streaming tool's result changes on every update. The renderer asks, and
  re-asks (debounced) while a tool streams; the request carries the same options
  Pi's `ToolRenderContext` does (`isPartial`, `isError`, `showImages`,
  `argsComplete`).
- **Fallback is native.** An item with no renderer answers `rendered: false`, and
  a renderer that throws answers `rendered: false` with an `error` — the card
  keeps the app's HTML diff/output, which is Pi's documented fallback. The
  registry never lets a throw reach the session.
- **Per-tool renderer state persists.** `ToolRenderContext.state` and
  `lastComponent` survive across the call and result renders for one
  `toolCallId`, and are dropped when the session is rebound (`/reload`).
- **`render.markdown`** chains the registered transformers (throw-safe, in
  registration order) with the `{messageType, isStreaming, availableWidth}`
  context; the renderer applies it to user and assistant text before parsing.
- **`render.invalidate`** is pushed when a renderer calls `context.invalidate()`,
  so an asynchronous redraw (an image conversion, say) reaches the card.

`src/host/extension-renderers.ts` is SDK-free and unit-tested with fake
components; the SDK adapter points it at the live runner and the current `Theme`
(read at render time, so a theme switch shows) on every `bindSession`.

### Extensions hub (plan step 13)

`resources.list` takes `{cwd?, refresh?}` and answers a `ResourcesSnapshot`:
every loaded extension, skill, prompt template and theme with its `source`,
`scope` (`user`/`project`/`temporary`), `origin` (`package`/`top-level`),
contributed tools/commands/shortcuts/flags, plus loader diagnostics and live
`extension_error` history. It is answered by **both** cores:

- a **session host** reports its live `ResourceLoader`/`ExtensionRunner`, so the
  data is the running truth and includes errors an extension threw mid-event;
- a **control host** has no `AgentSession`, so `createSdkResourceInspector`
  builds a real `DefaultResourceLoader` for the requested project on demand
  (cached; `refresh: true` rebuilds it) — this is what makes the hub work before
  any session tab exists. Project resources load only when the app's trust store
  says the project is trusted.

Enable/disable is **not** a new write path: Pi resolves the `extensions`,
`skills`, `prompts` and `themes` settings arrays, where `-path` force-excludes
and `+path` force-includes an exact resource. The app writes that entry through
`settings.set` in the resource's own scope (project resources stay project),
then reloads the runtime. Disabled resources are derived back out of those
override entries, so a disabled extension is still listed and can be
re-enabled; glob overrides are reported verbatim instead of being turned into
phantom resources.

### Settings (plan step 12)

`settings.set` takes `{cwd?, key, value, scope}` and `settings.raw` takes
`{cwd?, scope, document}` (with no `document`, `settings.raw` still reads).
`src/shared/settings-schema.ts` is the single key list, pinned to Pi's own
`docs/settings.md` by `tests/shared/settings-schema.test.ts`, so the app can
neither invent a key nor drop a documented one.

Pi's `SettingsManager` has **named setters**, not `set(key, value)`, and only its
resource keys have project-scope writers, so the port writes two ways:

- a named setter when Pi has one (this is why `enableAnalytics` still generates
  `trackingId`); a global-only key written to the project scope is refused;
- otherwise an atomic, schema-validated **document edit** — parse (refuse a
  malformed file), back up once, replace via temp file + rename, `reload()` the
  manager and revert the previous bytes if Pi cannot load the result. This is the
  only way to write project-scope keys the SDK has no setter for, and it is the
  same shape `providers.custom` uses for `models.json`.

`cwd` selects the project whose `.pi/settings.json` is read and written; the
manager is created with the project's real trust status, so an untrusted project
refuses project writes exactly as Pi does.

### RPC mapping (the parity test pins this)

`tests/host/rpc-parity.test.ts` types each mirrored host method against
`RpcCommand["type"]`, so an upstream rename breaks the build instead of drifting.

| Host method                                                           | Pi RPC command                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `prompt` / `steer` / `followUp` / `abort` / `clearQueue`              | `prompt` / `steer` / `follow_up` / `abort` / `clear_queue`        |
| `state.get` / `messages.get` / `stats.get`                            | `get_state` / `get_messages` / `get_session_stats`                |
| `entries.get` (`since`) / `tree.get`                                  | `get_entries` / `get_tree`                                        |
| `commands.list`                                                       | `get_commands`                                                    |
| `commands.complete` / `commands.run`                                  | **no RPC equivalent** (see below)                                 |
| `model.available` / `model.cycle`                                     | `get_available_models` / `cycle_model`                            |
| `thinking.cycle` / `thinking.set`                                     | `cycle_thinking_level` / `set_thinking_level`                     |
| `session.new` / `session.switch` / `session.clone` / `session.fork`   | `new_session` / `switch_session` / `clone` / `fork`               |
| `session.forkMessages` / `session.lastAssistantText`                  | `get_fork_messages` / `get_last_assistant_text`                   |
| `session.rename`                                                      | `set_session_name`                                                |
| `session.exportHtml` / `session.exportJsonl` / `session.importJsonl`  | `export_html` / (`/export jsonl`, `importFromJsonl`)              |
| `session.changelog`                                                   | **no RPC equivalent** (the TUI prints its own changelog)          |
| `session.queueMode` (steering / follow-up)                            | `set_steering_mode` / `set_follow_up_mode`                        |
| `session.autoCompaction` / `session.autoRetry` / `session.abortRetry` | `set_auto_compaction` / `set_auto_retry` / `abort_retry`          |
| `bash.run` / `bash.abort`                                             | `bash` / `abort_bash`                                             |
| `oi.request` / `oi.respond`                                           | the `extension_ui_request` / `extension_ui_response` sub-protocol |

Host methods with **no** RPC equivalent (the app needs them, RPC does not):
`host.*`, `session.list`, `session.create/open/resume/reload`, `session.delete`
(the host validates the path; the app trashes it), `session.rename` on a
_stored_ session, `session.navigateTree` / `session.setLabel` (the TUI drives its
tree selector in-process), `session.queueMode`'s single envelope,
`providers.runtimeKey/refresh/custom`, `packages.*`, `files.list`, `settings.*`,
`resources.list` (RPC mode never lists resources), `project.inspect`,
`project.trust`
(project inspection and trust: the TUI resolves trust through its own session,
so RPC has no command for it), `themes.list/import` (RPC mode never lists
themes), `keybindings.get/set/reset` (RPC mode never reads `keybindings.json`),
`shortcuts.list/invoke` (RPC mode has no shortcut protocol), `commands.run` /
`commands.complete` (RPC mode's `prompt` runs an extension command in-process
and its client cannot evaluate a function-valued argument hook),
`oi.state`, `oi.editorText`, `completion.suggest`, `completion.apply` (RPC mode
has no session-state channel, no editor mirror, and cannot evaluate extension
autocomplete providers), `tui.state`/`tui.resize`/`tui.input` (RPC mode's
`custom()` returns `undefined`, so it has no terminal to render into or feed
keys to), `render.request`/`render.markdown` (RPC mode renders tool/message
components in-process; it has no client that could display ANSI lines).

### Host build identity and stale recycling (2026-10-24)

A host is a long-lived child process, so it keeps running the
`out/host/index.mjs` that existed when it was spawned. The supervisor stamps
every spawn with a fingerprint of that file (SHA-256, first 16 hex characters)
via `PI_DESKTOP_HOST_BUILD`; `host.hello` echoes it as `buildId`. Before
forwarding a renderer request, the session service compares `buildId` with the
current file. If they differ and `state.get` reports an idle session (not
streaming/compacting/retrying, no pending/steering/follow-up messages, and a
known session file), it stops the host and lets `ensureHost` spawn a replacement
that resumes the JSONL. Streaming or queued work is never interrupted, and the
control host is never recycled this way.

`commands.complete` has one extra fallback: when the live host answers
`method not implemented yet: commands.complete` (or `unknown method: ...`),
main returns `{ items: null, unsupported: true }` instead of an IPC error. The
renderer shows a persistent banner with **Restart session**, and Diagnostics
records a `host_stale` incident. The `unsupported` field is synthesized by
**main**, never sent by a host. `npm run dev` runs a watch build for the host
bundle beside `electron-vite dev --watch`, so host, main and preload bundles all
rebuild and Electron restarts when main/preload changes. A manual
`electron-vite dev` without `--watch` still needs a restart after main edits and
`npm run build:host` after host edits.

Adding a method to `HOST_METHODS` is additive: it does not bump
`HOST_PROTOCOL_VERSION`, because a current main can still talk to a current
host. Skew inside a development session is handled instead by the watch above
and by `AppInfo.hostMethods`, a copy of main's compiled allowlist. The renderer
uses it to block a method main does not advertise and to show a
**Restart app** banner rather than a raw
`session: unsupported host method …` error.

### Extension commands and argument completion (2026-10-24)

`commands.list` keeps Pi's RPC shape. `commands.complete({ name, prefix })` asks
the live command for `getArgumentCompletions(prefix)` and returns sanitised
`{ value, label, description? }` items (values keep trailing spaces, capped at
50). `commands.run({ name, args })` executes the command's handler with
`ExtensionRunner.createCommandContext()`; a handler error is reported through
the runner and as an `extension_error` transcript notice, and the invocation
still counts as handled. Both methods are session-host only and answer
`not_implemented` before a session exists. Direct execution is deliberate: a
command runs even while the agent streams, exactly as terminal Pi's
`_tryExecuteExtensionCommand` does, while prompt templates and `/skill:*` keep
the `prompt` path.
