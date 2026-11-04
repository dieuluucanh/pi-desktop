# Pi for Office integration

How Pi Desktop talks to Microsoft Office, and what happens when the two halves of
the bridge are not the same age.

The bridge ships **independently** of this app: `@dieulc/pi-office-bridge` and
the task-pane add-in are published from the [pi-for-office](https://github.com/dieuluucanh/pi-for-office)
repository on their own cadence, while Pi Desktop installs a pinned range of the
bridge into the user's Pi profile. A user can therefore be running a bridge that
is older or newer than the app — the compatibility rules below are what keeps
that from turning into a support ticket.

## The three processes

| Process                                 | Owns                                                  | Talks to                                                                         |
| --------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Office app + task-pane add-in           | the document, `Office.js`                             | the bridge over `ws://127.0.0.1:38617`                                           |
| Pi session hosting the bridge extension | the agent, the bridge WebSocket server, `GET /health` | the pane (WebSocket), the agent (in-process)                                     |
| Pi Desktop (this app)                   | the session process, the wizard, the Office panel     | the session (host JSONL protocol), `/health` (HTTP), the pane list via `/health` |

Two flows cross the bridge:

1. **Tool proxy (agent → pane).** An `office_*` tool call is forwarded as
   `tool_call`; the pane runs the `Office.js` operation and answers
   `tool_result`. The `document` argument selects the target; the bridge's
   per-pane `documentId`/`targetId` routing resolves it.
2. **Pane chat (pane → agent).** A prompt typed in the task pane is tagged with
   the document it came from (`[office:excel "Book1.xlsx" id=url_sha256:…]`) and
   injected into the session as a user message. The reply goes back as
   `agent_message`.

Pi Desktop sees flow 2 through the session it owns: the prompt _is_ a session
message and the reply _is_ streamed session output, so the app needs no second
WebSocket client to render pane traffic. That is what `src/main/office/office-run.ts`
consumes.

## Lifecycle: the bridge is off until asked (0.6+)

The bridge no longer starts in `session_start`. A fresh Pi session — terminal or
Desktop — registers the `office_*` tools but leaves the server down and removes
the whole Office tool family from the active set. The user connects explicitly:

```text
/office status
/office connect [port]
/office close
/office restart [port]
```

Desktop exposes the same contract through the Documents rail (Connect this
session, Disconnect, Restart, Move bridge here, Take over). Main orchestrates a
move: it closes the current app-owned tab's bridge, waits for `/health` to go
silent, then runs `connect 38617` in the target tab. **Neither session restarts.**

Rules that matter:

- Only one session can own 38617. A second connect reports the owner; it never
  silently falls back to 38618.
- Only a host-backed tab (`session`/`office`) can be the bridge target. Editor
  and web tabs are refused before any host RPC (`officeBridgeCandidateTab` and
  `requireConnectableTab`).
- `session_shutdown` always stops the server. Pi re-instantiates extension
  factories on `/new`, `/resume`, `/fork` and `/reload`, so keeping it would
  orphan it; every new session starts off.
- A normal (non-`office`) tab that hosts the bridge is pinned against idle
  recycling (`HostSupervisor.isPinned`).
- The opt-in `--office-bridge-autostart` / `PI_OFFICE_BRIDGE_AUTOSTART=1`
  restores the old start-on-session behaviour for scripts.
- The setup wizard calls an injected `ensureBridge` before opening Office, so
  zero-touch setup still works without making every session auto-connect.

`GET /health` carries the owner so the app can map the live bridge to a tab or
report a terminal/foreign process:

```json
"owner": { "pid": 12345, "sessionId": "tab-abc", "client": "desktop", "cwd": "C:\\work" }
```

`capabilities` also advertises `manual-lifecycle`. A client must not assume the
0.6 commands exist on a bridge that lacks the capability or predates 0.6.

## Protocol versions

| Bridge | Protocol | `agent_message`                                                       | Pane-side Stop             | App pin  |
| ------ | -------- | --------------------------------------------------------------------- | -------------------------- | -------- |
| 0.4.x  | 2        | `kind:"final"` only                                                   | no                         | —        |
| 0.5.0+ | 3        | `kind:"delta"` while streaming, then the authoritative `kind:"final"` | yes (`abort` client frame) | `^0.5.0` |
| 0.6.0+ | 3        | same as 0.5.0, plus `owner` + `manual-lifecycle` in `/health`         | yes                        | `^0.6.0` |

v3 is **additive**: the handshake accepts the whole window
`[MIN_SUPPORTED_PROTOCOL_VERSION, BRIDGE_PROTOCOL_VERSION]` = `[2, 3]`, so an
older pane keeps connecting after the bridge is upgraded. v1 is rejected with
`protocol_mismatch` (v2 was the breaking change: `hello.document` became
required).

Capabilities advertised in `welcome` and `GET /health`:

| Capability     | Meaning                                                |
| -------------- | ------------------------------------------------------ |
| `http-health`  | the server answers `GET /health`                       |
| `agent-deltas` | the server streams `agent_message` deltas to v3+ panes |
| `client-abort` | the server honours the client `abort` frame            |

## Compatibility matrix — what the app does

| Situation                               | `/health`                                            | App behaviour                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No session hosting the bridge           | unreachable                                          | "The Office bridge is off"; the Documents row offers _Connect this session_; the wizard offers install/verify and connects one session itself |
| Bridge 0.6+, running in a terminal      | `owner.client:"cli"`                                 | Documents shows the PID/cwd and offers a confirmed _Take over_; chat/`#` stay disabled in every app tab                                       |
| Bridge 0.6+, running in another app tab | `owner.sessionId` matches that tab                   | _Open host session_ / _Move bridge here_; the move closes the old bridge without restarting either session                                    |
| Bridge too old (protocol < 2)           | `protocolVersion: 1`                                 | Reported as **unsupported**: the handshake would be rejected, so no streaming or Stop is claimed                                              |
| Bridge 0.4.x (protocol 2)               | `protocolVersion: 2`, no capabilities                | Connects and works. Replies are **final only** (no live text), and only the app can stop a run. The panel says so and points at the upgrade   |
| Bridge 0.5.0 (protocol 3)               | `protocolVersion: 3`, `agent-deltas`, `client-abort` | Live text while the agent works, and a Stop button in the task pane as well as in the app                                                     |
| Bridge newer than the app               | `protocolVersion: 4`                                 | Rendered with the v3 affordances and **never** treated as broken: additive changes keep older clients working                                 |

`projectBridgeCompatibility()` in `src/shared/office-bridge.ts` is the single
place this decision is made; `bridgeReplyLabel()`/`bridgeStopLabel()` produce the
panel's wording from it, so the UI and the tests cannot disagree.

An **absent** `capabilities` array means a bridge from before capability
advertisement: the version decides. A **present** array is authoritative — a v3
bridge that does not advertise `agent-deltas` is not assumed to stream.

## Streaming rules

- Deltas are **display-only**. The bridge coalesces them (~60 ms batches, capped
  at `MAX_TEXT_CHARS`) and may drop chunks, so the concatenation is not
  guaranteed to equal the reply. The final message is authoritative and
  replaces whatever the preview accumulated.
- Deltas are only sent to panes whose `hello.protocolVersion >= 3`; a v2 pane
  would drop them, so the server never spends bandwidth on them.
- A delta carries the `promptId` (and `messageId`) of the reply it belongs to. A
  late delta from a superseded prompt is discarded instead of being appended to
  the next answer (`createStreamBuffer`).
- The app caps its _preview_ at `MAX_STREAM_CHARS` (200 000) so a runaway stream
  cannot grow unbounded; the final reply is applied regardless.
- Only `text_delta` is user-visible prose; thinking and tool-call deltas are not
  forwarded to the pane or the panel.

## Stopping a run

| Who           | Path                                                                        | Works when                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The task pane | protocol `abort` client frame → the bridge extension aborts the session run | protocol v3, and only for a pane prompt that is in flight (a `promptId`, when supplied, must match) — a pane can never abort a TUI-initiated turn |
| Pi Desktop    | `office:stop-run` → the host's `session.abort` for the Office session       | every bridge version: the app owns the session that is executing the pane's run, so it aborts it regardless of protocol                           |

The app's Stop is therefore _not_ gated on `client-abort`; `supportsAbort` in the
compatibility view describes the **pane's** own Stop button. An aborted pane run
sees no final message (the bridge clears the binding on `agent_settled`), which
is why a pane's Stop must stay usable when the reply keeps arriving.

## `/health` contract used by the app

The app reads (and never infers):

| Field                                                                                                                                                                    | Use                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `protocolVersion`                                                                                                                                                        | compatibility shape; drives the skew diagnostics                                                |
| `capabilities`                                                                                                                                                           | `agent-deltas` / `client-abort` availability                                                    |
| `serverVersion`, `serverName`                                                                                                                                            | shown in the Bridge card and diagnostics                                                        |
| `catalogVersion`                                                                                                                                                         | tool-catalog skew (`knownCatalogVersion` is 3)                                                  |
| `panes[]` (`host`, `documentName`, `documentId`, `targetId`, `focused`, `visible`, `windows`, `ops`, `lastSeen`, `protocolVersion`, `catalogVersion`, `opsIgnoredCount`) | the attached-documents list; `document: "active"` resolution happens in the bridge, not the app |
| `port`, `uptimeMs`                                                                                                                                                       | diagnostics                                                                                     |

## The pane registry (plan step 20)

`GET /health` is not only a wizard probe: its `panes[]` array is the live registry
of attached task panes, and Pi Desktop reads it continuously.
`src/main/office/documents-service.ts` polls the Office host port (38617) every
five seconds while the app runs and pushes a projected view to the renderer.
`src/shared/office-documents.ts` is the pure projection: it parses each pane
(name, id, `targetId`, focus, window count, advertised ops, `lastSeen`, versions,
ignored-op count) and derives the `#` mention value (the name when unique among
the open documents, otherwise the id).

Three renderer surfaces consume that view:

- **Documents menu** (`src/renderer/src/rail/DocumentsSection.tsx`), one of the three
  menus in the session's docked panel rail (Source Control, Checkpoints, Documents —
  see [`source-control.md`](source-control.md)). Its **presence** is a stable fact
  rather than a probe reading (2026-10-30 rail-headers plan): the entry is in the
  strip when the Pi settings list the bridge package
  (`OfficeDocumentsView.configured`, read once at startup and refreshed after a
  wizard install), or the bridge answers `/health`, or an `office`-kind tab
  exists. One failed probe while a promoted host re-binds 38617 can therefore not
  remove the entry (and the fallback in `resolveActiveMenu` cannot switch the panel
  away mid-takeover). The body lists each pane with its facts and actions — _Chat
  about this_ (prepends the `[office:…]` tag to the composer draft), _Insert
  #mention_, _Copy id_, _Open Office_ — and, while the bridge is not answering,
  says which state it is in (the host is starting _vs._ another program owns
  port 38617) and keeps its re-check instead of rendering nothing. With the bridge
  up but no pane attached it shows the empty state.
- **The Documents scope row** (`src/renderer/src/rail/DocumentsScope.tsx`) is the
  one owner of the host facts and the bridge-switching actions. It is a single
  compact line — _Office host: \<title>_ (with the host's folder only when it
  differs from the rail's) or _This session is the Office host._ — plus:
  - **Open host session** — focuses the tab that already holds port 38617;
- **Connect this session** — runs `/office connect 38617` in the active tab;
  the bridge stays off until this is clicked (or `/office connect` is typed in a
  terminal);
- **Disconnect** / **Restart** — only while this tab is the live owner;
- **Open host session** — focuses the tab that `/health.owner.sessionId` names;
- **Move bridge here** — from another app tab, behind a confirmation. Main
  closes that tab's bridge (the session stays open), waits for the port to free,
  then connects this one. No restart, no history loss;
- **Take over** — when a terminal Pi/foreign process owns the port. It asks
  first, then uses the existing verified port reclaimer;
- **Update bridge** — when a 0.5.x auto-start bridge is detected. The app cannot
  close what the old bridge does not expose, so it offers the pinned update
  instead of pretending a control worked.

  It no longer repeats the host's title and project as a two-line header: the rail
  is scoped to the selected project (2026-10-30 plan), and a header naming the
  _host's_ project went stale the moment the user switched to a session in another
  folder. `officeDocumentScope` in `src/shared/office-documents.ts` resolves the
  host through `officeBridgeOwnerTab` (`/health.owner.sessionId`, with the old
  `office` kind only as a 0.5.x fallback).

- **Moving the bridge is a clean handoff, not a restart.** `bridge-control.ts`
  runs `/office close` in the current app-owned tab, waits for `/health` to go
  silent, then runs `/office connect 38617` in the target. Neither session is
  stopped or resumed; only the bridge moves. The old `promoteToOfficeHost` path
  remains a compatibility hook with no renderer caller.
- **Taking over a foreign port is explicit.** After the user confirms, main asks
  `releaseOfficePort` (`src/main/office/port-owner.ts`) to free 38617. The
  reclaimer probes `/health`, then looks up the listeners:
  `Get-NetTCPConnection -LocalPort 38617 -State Listen` first (structured
  answers, so a localized `netstat` state word and IPv6-only sockets cannot hide
  the owner), falling back to `netstat -ano` **without** `-p tcp` (that filter
  is IPv4-only; a dual-stack `[::]` listener — what Node's `listen(port)` binds
  — is invisible to it). `lsof -nP -iTCP:38617 -sTCP:LISTEN -t` elsewhere. It
  refuses every PID the app owns and every PID ≤ 4, re-reads the owner
  immediately before each signal (PID-reuse guard), escalates `SIGTERM` →
  `SIGKILL` (`taskkill /T /F` on Windows), and polls until the port answers
  nothing. It **never reports a free port that is not free**: if no owner can
  be identified, or the probe still answers, the call fails with the owner/port
  state named.

- **Scope in a non-host session (D10).** `office_*` calls reach whichever host owns
  38617, so a sibling session cannot serve one. Its _Chat about this_ and _Insert
  #mention_ are therefore **disabled**, a line (`documents-not-host`) explains why
  and points at _Move bridge here_, and **`#` completion returns nothing**
  (`documentMentionsForHost`). A mention that tags a prompt the bridge never
  answers is worse than an empty list.
- **`#` completion** — the same registry feeds `createDocumentProvider` through
  `toDocumentMentions()`, so mentions work even when the bridge extension's own
  autocomplete provider is absent. It is gated on the active tab being the host.

**Cross-session Office routing is deliberately absent.** An `office_*` call from a
non-host session does not proxy to the host: that needs its own IPC, auth and
idle-host semantics. Promotion is the supported way to move the bridge; a backlog
entry tracks the proxy.

- **Office tool cards** (`src/renderer/src/session/OfficeToolCard.tsx`) — an
  `office_*` call shows the document it targeted (`document: "active"` resolved
  against the registry) and whether the call was capability-gated (`advertised`,
  `legacy`, `gated` or `unattached`). `office_list_documents` renders as a table
  with per-row actions instead of markdown.

**One live bridge owner, derived from `/health`.** The old `office`-kind tab is
now only a convenience/migration shim (and the fallback owner for a 0.5.x
bridge, which cannot report one). A 0.6+ bridge reports `owner.sessionId`;
`officeBridgeOwnerTab` maps it to a tab, `officeHostProjectPath` uses the same
predicate for the checkpoint idle scan, and `officeRun.stop` aborts that tab's
run. A bridge in a terminal/foreign process has no tab, so Stop returns
`reason: "external"` and the UI says to stop it there.

**The idle checkpoint scan follows that host.** `checkpoint-service.ts` scans only
the folder of the non-stopped `office` tab (`officeHostProjectPath`): the bridge
reports a document name and a `url_sha256:` id, never a path, so the host
session's cwd is the only defensible target. See
[`source-control.md`](source-control.md#capture-triggers).

## Failure modes and what the user sees

| Symptom                                    | Cause                                    | Where it surfaces                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The bridge is too old to connect"         | protocol < 2                             | troubleshooting item `bridge-version-skew` (error)                                                                                                                                                                |
| "The bridge uses an older protocol"        | protocol 2                               | troubleshooting item `bridge-version-skew` (warning), plus the panel's `Replies: final message only`                                                                                                              |
| "The bridge exposes an older tool catalog" | `catalogVersion` < 3                     | troubleshooting item `catalog-version-skew`                                                                                                                                                                       |
| "Port 38617 is already in use"             | another program or Pi session holds it   | connect reports the owner; Desktop offers a confirmed _Take over_, terminal says to run `/office close` in the owner or use another port. The wizard records the failure in the `bridge-listening` checklist step |
| "The bridge is not listening yet"          | no session has connected                 | Documents says "The Office bridge is off" and offers _Connect this session_; `/office status` says the same                                                                                                       |
| "Automatic bridge (legacy)"                | installed bridge < 0.6                   | Documents and the Integrations card offer _Update bridge_; the old auto-start behaviour is otherwise preserved                                                                                                    |
| "Stop failed / external"                   | a terminal Pi owns the run               | the app cannot abort a run it does not host; the message says to stop it in that terminal                                                                                                                         |
| "The add-in is not connected yet"          | manifest registered but no pane attached | troubleshooting item `pane-not-attached` (reopen Office so the manifest is re-read)                                                                                                                               |

## Upgrading the bridge

The app installs `PI_OFFICE_BRIDGE.pinnedVersion` (`^0.6.0`) into the Pi profile
(`~/.pi/agent/npm`) and verifies it during the wizard's `bridge-package` step.

```bash
npm install @dieulc/pi-office-bridge@latest      # in the Pi npm root
```

Then restart the Office session — the extension is loaded per session, so a
running one keeps the old code. Confirm in the Office panel: **Protocol** should
read `3` and **Replies** `streamed (protocol v3)`.

### Release order (pi-for-office)

Additive changes may ship protocol-first; breaking changes require lockstep:

1. `@dieulc/pi-office-protocol` (wire types)
2. `@dieulc/pi-office-bridge` (server)
3. the add-in (client) — the deployed manifest is served from GitHub Pages, so
   panes update on their own schedule
4. this repo's pin (`src/shared/office.ts`)

An older pane connecting to a newer bridge is expected and supported; the
reverse (a newer pane against an older bridge) is not, which is why the pin is a
minimum range rather than an exact version.

## Implementation status

| Piece                                                            | State                                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bridge pin + skew diagnostics                                    | done (`src/shared/office.ts`, `src/main/office/troubleshoot.ts`)                                                             |
| Compatibility projection + labels                                | done (`src/shared/office-bridge.ts`)                                                                                         |
| Delta consumption (stream buffer, promptId binding, preview cap) | done                                                                                                                         |
| Pane-run tracker (session events → view; Stop → session)         | done (`src/main/office/office-run.ts`)                                                                                       |
| `office:stop-run` IPC → preload → panel Stop button              | done                                                                                                                         |
| Live streamed text in the panel                                  | wired, waiting on the Office **session** tab (plan step 14), which is what instantiates the tracker and populates `view.run` |
| Live pane registry → Documents panel, `#` mentions, tool cards   | done (plan step 20: `documents-service.ts`, `office-documents.ts`, `DocumentsPanel.tsx`, `OfficeToolCard.tsx`)               |
| On-demand lifecycle + commands (0.6)                             | done (`lifecycle.ts`, `commands.ts`, `config.ts`; bridge 0.6.0)                                                              |
| Owner-aware Documents rail / mentions / Stop / checkpoints       | done (`officeBridgeOwnerTab`, `bridge-control.ts`)                                                                           |
| Wizard connects a session                                        | done (`ensureBridge` injection)                                                                                              |
| Legacy 0.5.x auto-start + Update bridge path                     | done (compatibility fallback)                                                                                                |

The Office panel's `view.run` remains `{ available: false }` until the in-process
run tracker is wired; Stop is live through the supervisor and aborts the live
owner's run. When a terminal/foreign process owns the bridge, Stop reports
`reason: "external"` and the UI says to stop it there.

## Test coverage

| Test                                                                                                | Pins                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/office/bridge-compat.test.ts`                                                                | projection for v1/v2/v3/v4/unreachable, capability-over-version precedence, delta/final buffer semantics, promptId staleness, preview cap, pane tag parsing |
| `tests/office/office-run.test.ts`                                                                   | the tracker: delta accumulation, final replacement, pane vs app attribution, idle/failed Stop, settle behaviour                                             |
| `tests/office/version-skew.test.ts`                                                                 | the matrix end to end through a fake pane for both generations, plus the panel labels                                                                       |
| `tests/office/setup-view.test.ts`, `tests/office/setup-wizard.test.ts`                              | the view/wizard surface that carries the compatibility and the pin                                                                                          |
| `tests/main/office-documents-service.test.ts`                                                       | the registry poll: projection, not-our-bridge rejection, change-only emission, start/stop/dispose                                                           |
| `tests/shared/office-documents.test.ts`                                                             | the pane projection, mention values, document tag, capability states, target resolution, `office_list_documents` table parsing, `toDocumentMentions`        |
| `tests/renderer/documents-section.test.tsx`                                                         | the rail: visibility rules, per-pane facts, empty state, chat/mention actions                                                                               |
| `tests/renderer/rail-scope.test.tsx`                                                                | the six Documents scope states, connect/disconnect/move/takeover confirmations                                                                              |
| `tests/renderer/office-documents-store.test.ts`                                                     | owner-aware chat/mentions, connect/close/restart actions, busy guard                                                                                        |
| `tests/renderer/office-tool-card.test.tsx`                                                          | office tool cards: target chip, capability note, document-list table and row actions                                                                        |
| `tests/main/office-bridge-control.test.ts`                                                          | connect/close/restart orchestration, close-other-tab, takeover, legacy, timeout                                                                             |
| `tests/main/host-supervisor.test.ts`                                                                | a pinned bridge owner is not idle-recycled; unpinning restores recycling                                                                                    |
| pi-for-office `bridge-extension/tests/{bridge-lifecycle,office-command,extension-harness}.test.mjs` | lifecycle idempotency/failure cleanup, command grammar, no-autostart + tool activation                                                                      |
| pi-for-office `bridge-extension/tests/{multi-document,smoke}.mjs`                                   | v2 handshake accepted, v1 rejected, `/health` protocolVersion + capabilities + owner                                                                        |
| pi-for-office `packages/protocol/tests/protocol.test.ts`                                            | the version window, the `abort` frame, v2 frame acceptance                                                                                                  |

### Known gaps

- No test yet asserts that a **v3 bridge sends no deltas to a v2 pane** (the
  bridge-side branch is version-gated but only exercised indirectly).
- The add-in's streaming UI (rendering deltas with the same rAF batching as its
  local agent) is tested in pi-for-office, not end to end against a real pane.
- Only Windows has been exercised with a real Office host; the macOS `wef` path
  is covered by unit tests, not by a live pane.

### User guide

The end-user side of this integration — install, set up, the Documents section,
`#` mentions, connect/move/takeover and troubleshooting — lives in
[`../guide/office-setup.md`](../guide/office-setup.md).
