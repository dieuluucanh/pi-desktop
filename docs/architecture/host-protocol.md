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

| Group         | Methods                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| transport     | `host.hello`, `host.ping`, `host.shutdown`, `host.blobs.read`                                                                       |
| sessions      | `session.create/open/list/resume/fork/clone/delete/rename/exportHtml`                                                               |
| conversation  | `prompt`, `steer`, `followUp`, `abort`, `clearQueue`                                                                                |
| state         | `state.get`, `messages.get`, `entries.get`, `tree.get`, `stats.get`, `compact`, `commands.list`, `tools.*`, `model.*`, `thinking.*` |
| configuration | `settings.*`, `providers.*`, `packages.*`                                                                                           |
| other         | `oi.respond` (extension UI answers), `files.list`                                                                                   |

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

## Process contract

- Selected by `--service` or `PI_DESKTOP_HOST_MODE=service`; **never** by a `pi`
  argument, so the same entry point can stand in for the `pi` binary (plan D16).
- Injected env: `PI_CODING_AGENT_DIR` (shared profile), `PI_OFFICE_BRIDGE_PORT`
  (38617 for the Office host, 38618+ otherwise, plan D10), `PI_DESKTOP_SESSION_ID`,
  `PI_DESKTOP_HOST_ROLE` (`control` = app-wide state and no `AgentSession`,
  `session` = one Pi session; plan D-A3),
  `PI_DESKTOP_BLOB_DIR`, `PI_DESKTOP_BACKUP_DIR` (where a host copies a file
  before rewriting it; plan step 12), `PI_DESKTOP_NODE` /
  `PI_DESKTOP_HOST_ENTRY`, and `PATH` prefixed with the shim directory.
- `host.hello` reports protocol version, node/pi version, cwd, bridge port and
  pid/ppid. A protocol mismatch is logged, not fatal (risk R8).

## Supervisor behaviour (`src/main/host-supervisor.ts`)

| Concern        | Behaviour                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| correlation    | `{id}` → pending promise; a response for an unknown id is ignored                                                                                                            |
| timeouts       | default 30 s per request, then `HostTimeoutError` (never an infinite hang)                                                                                                   |
| crash          | `exit` rejects every in-flight request, emits `crashed`, restarts with backoff `0/500/2000 ms`, then re-runs the handshake and `session.resume` when a session file is known |
| restart budget | after the backoff table is exhausted the host becomes `failed` and `ready()` rejects                                                                                         |
| ports          | 38617 reserved for the Office host, 38618+ allocated per host and released on stop                                                                                           |
| host cap       | `maxHosts` (8) — starting one more rejects with a readable message                                                                                                           |
| idle recycling | non-Office hosts shut down after `idleTimeoutMs` (15 min) when no event listeners remain                                                                                     |
| logs           | one append-only file per session in `userData/logs/<sessionId>.log`                                                                                                          |
| shutdown       | `host.shutdown` → `SIGTERM`, all pending requests settled, port released                                                                                                     |

`SpawnedHostProcess`, the spawn function and the filesystem port are all injected,
so the whole supervisor is unit tested against a scripted fake host
(`tests/main/host-supervisor.test.ts`), and `tests/host/service.live.test.ts`
drives the real bundle when `out/host/index.mjs` has been built.

## Implementation status (2026-09-20, after plan step 12)

### Wired and tested

| Group             | Methods                                                                                                                                                                                                                                                                                                                                                                                | Where                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| transport         | `host.hello` (reports `role`), `host.ping`, `host.shutdown`, `host.blobs.read`                                                                                                                                                                                                                                                                                                         | `src/host/service.ts`                                              |
| sessions          | `session.create`, `session.open`, `session.resume`, `session.list`, `session.new`, `session.switch`, `session.clone`, `session.fork`, `session.forkMessages`, `session.rename`, `session.reload`, `session.lastAssistantText`, `session.exportHtml`, `session.navigateTree`, `session.setLabel`                                                                                        | `src/host/session-core.ts`                                         |
| conversation      | `prompt` (images + `streamingBehavior`), `steer`, `followUp`, `abort`, `clearQueue`                                                                                                                                                                                                                                                                                                    | `src/host/session-core.ts`                                         |
| state             | `state.get`, `messages.get`, `entries.get` (`since` cursor), `tree.get`, `stats.get` (`contextUsage`, `tokens`, queue modes), `compact`, `tools.list`, `tools.setActive`, `commands.list`, `files.list` (workspace listing for `@` completion, rooted at the session's own cwd)                                                                                                        | `src/host/session-core.ts`                                         |
| models & thinking | `model.list`, `model.available`, `model.set`, `model.cycle`, `thinking.levels`, `thinking.set`, `thinking.cycle`                                                                                                                                                                                                                                                                       | `src/host/session-core.ts`                                         |
| session behaviour | `session.queueMode`, `session.autoCompaction`, `session.autoRetry`, `session.abortRetry`                                                                                                                                                                                                                                                                                               | `src/host/session-core.ts`                                         |
| settings          | `settings.get`, `settings.set`, `settings.raw` (read **or** write a whole scope), `settings.flush`; every response carries **both** scopes, the two file paths + mtimes, `drainErrors` and the project-trust flag. Writes are schema-validated: a named `SettingsManager` setter when Pi has one, otherwise an atomic whole-document edit, always with a backup before the first write | `src/host/settings.ts` + `src/host/sdk/settings.ts`, in both cores |
| control host      | `settings.*`, `session.list` (all projects), `session.delete` (validates; main trashes), `session.rename` (a stored, closed session), `providers.*`, `providers.custom`, `project.inspect`, `project.trust`, `resources.list` (loads a project's resources with no session)                                                                                                            | `src/host/control-core.ts`                                         |
| extensions hub    | `resources.list` (both cores): extensions/skills/prompts/themes with source, scope, origin, contributed tools/commands/shortcuts/flags, loader diagnostics and live `extension_error` history                                                                                                                                                                                          | `src/host/resources.ts` (+ `src/host/sdk/resources.ts`)            |
| extension UI      | `oi.respond` + `oi.request` events                                                                                                                                                                                                                                                                                                                                                     | `src/host/extension-ui.ts`                                         |

### Declared and answering `not_implemented` (with the owning step)

| Methods                     | Step |
| --------------------------- | ---- |
| `bash.run`, `bash.abort`    | 6    |
| `packages.*`                | 14   |
| `files.read`, `files.write` | 20   |

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
| `model.available` / `model.cycle`                                     | `get_available_models` / `cycle_model`                            |
| `thinking.cycle` / `thinking.set`                                     | `cycle_thinking_level` / `set_thinking_level`                     |
| `session.new` / `session.switch` / `session.clone` / `session.fork`   | `new_session` / `switch_session` / `clone` / `fork`               |
| `session.forkMessages` / `session.lastAssistantText`                  | `get_fork_messages` / `get_last_assistant_text`                   |
| `session.rename`                                                      | `set_session_name`                                                |
| `session.exportHtml`                                                  | `export_html`                                                     |
| `session.queueMode` (steering / follow-up)                            | `set_steering_mode` / `set_follow_up_mode`                        |
| `session.autoCompaction` / `session.autoRetry` / `session.abortRetry` | `set_auto_compaction` / `set_auto_retry` / `abort_retry`          |
| `bash.run` / `bash.abort` (declared)                                  | `bash` / `abort_bash`                                             |
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
so RPC has no command for it).
