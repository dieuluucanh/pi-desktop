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
| other         | `oi.respond` (extension UI answers), `files.*`                                                                                      |

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
  `PI_DESKTOP_BLOB_DIR`, `PI_DESKTOP_NODE` / `PI_DESKTOP_HOST_ENTRY`, and `PATH`
  prefixed with the shim directory.
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

## Implementation status (2026-09-20, after plan step 4)

### Wired and tested

| Group             | Methods                                                                                                                                                                                                                       | Where                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| transport         | `host.hello` (reports `role`), `host.ping`, `host.shutdown`, `host.blobs.read`                                                                                                                                                | `src/host/service.ts`                                  |
| sessions          | `session.create`, `session.open`, `session.resume`, `session.list`, `session.new`, `session.switch`, `session.clone`, `session.fork`, `session.forkMessages`, `session.rename`, `session.reload`, `session.lastAssistantText` | `src/host/session-core.ts`                             |
| conversation      | `prompt` (images + `streamingBehavior`), `steer`, `followUp`, `abort`, `clearQueue`                                                                                                                                           | `src/host/session-core.ts`                             |
| state             | `state.get`, `messages.get`, `entries.get` (`since` cursor), `tree.get`, `stats.get` (`contextUsage`, `tokens`, queue modes), `compact`, `tools.list`, `tools.setActive`, `commands.list`                                     | `src/host/session-core.ts`                             |
| models & thinking | `model.list`, `model.available`, `model.set`, `model.cycle`, `thinking.levels`, `thinking.set`, `thinking.cycle`                                                                                                              | `src/host/session-core.ts`                             |
| session behaviour | `session.queueMode`, `session.autoCompaction`, `session.autoRetry`, `session.abortRetry`                                                                                                                                      | `src/host/session-core.ts`                             |
| settings          | `settings.get`, `settings.raw`, `settings.flush` (returns **both** scopes: `{global, project}`)                                                                                                                               | `src/host/session-core.ts`, `src/host/control-core.ts` |
| control host      | `settings.get/raw`, `session.list` (all projects)                                                                                                                                                                             | `src/host/control-core.ts`                             |
| extension UI      | `oi.respond` + `oi.request` events                                                                                                                                                                                            | `src/host/extension-ui.ts`                             |

### Declared and answering `not_implemented` (with the owning step)

| Methods                                | Step       |
| -------------------------------------- | ---------- |
| `settings.set`                         | 12         |
| `session.delete`, `session.exportHtml` | 11         |
| `bash.run`, `bash.abort`               | 6          |
| `providers.*`, `packages.*`, `files.*` | 9 / 14 / 7 |

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
| `session.queueMode` (steering / follow-up)                            | `set_steering_mode` / `set_follow_up_mode`                        |
| `session.autoCompaction` / `session.autoRetry` / `session.abortRetry` | `set_auto_compaction` / `set_auto_retry` / `abort_retry`          |
| `bash.run` / `bash.abort` (declared)                                  | `bash` / `abort_bash`                                             |
| `oi.request` / `oi.respond`                                           | the `extension_ui_request` / `extension_ui_response` sub-protocol |

Host methods with **no** RPC equivalent (the app needs them, RPC does not):
`host.*`, `session.list`, `session.create/open/resume/reload/delete/exportHtml`,
`session.queueMode`'s single envelope, `providers.runtimeKey/refresh/custom`,
`packages.*`, `files.*`, `settings.*`.
