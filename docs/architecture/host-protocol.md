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

`HOST_METHODS` is the complete list; `isHostMethod` validates it. Step 4 ships the
transport level and answers everything else with
`{"ok":false,"error":{"code":"not_implemented"}}` — sessions, prompts and settings
are wired in steps 5/9/14 by injecting handlers into `createHostService`.

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
