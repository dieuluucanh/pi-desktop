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

## Protocol versions

| Bridge | Protocol | `agent_message`                                                       | Pane-side Stop             | App pin  |
| ------ | -------- | --------------------------------------------------------------------- | -------------------------- | -------- |
| 0.4.x  | 2        | `kind:"final"` only                                                   | no                         | —        |
| 0.5.0+ | 3        | `kind:"delta"` while streaming, then the authoritative `kind:"final"` | yes (`abort` client frame) | `^0.5.0` |

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

| Situation                     | `/health`                                            | App behaviour                                                                                                                               |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No session hosting the bridge | unreachable                                          | "Start an Office session to stream replies here and stop a run"; the wizard offers the bridge install/verify steps                          |
| Bridge too old (protocol < 2) | `protocolVersion: 1`                                 | Reported as **unsupported**: the handshake would be rejected, so no streaming or Stop is claimed                                            |
| Bridge 0.4.x (protocol 2)     | `protocolVersion: 2`, no capabilities                | Connects and works. Replies are **final only** (no live text), and only the app can stop a run. The panel says so and points at the upgrade |
| Bridge 0.5.0 (protocol 3)     | `protocolVersion: 3`, `agent-deltas`, `client-abort` | Live text while the agent works, and a Stop button in the task pane as well as in the app                                                   |
| Bridge newer than the app     | `protocolVersion: 4`                                 | Rendered with the v3 affordances and **never** treated as broken: additive changes keep older clients working                               |

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

- **Documents section** (`src/renderer/src/rail/DocumentsSection.tsx`), one section of
  the session's shared right rail (it was the whole rail until the 2026-10-27 plan added
  Git, Changes, History and Checkpoints beside it — see
  [`source-control.md`](source-control.md)). It renders only when `/health` answers (plan
  D-A10: no Office surface before setup) and lists each pane with its facts and actions — _Chat
  about this_ (prepends the `[office:…]` tag to the composer draft), _Insert
  #mention_, _Copy id_, _Open Office_. With the bridge up but no pane attached it
  shows the empty state; the footer names the Office host and offers **Promote to
  Office host**.
- **`#` completion** — the same registry feeds `createDocumentProvider` through
  `toDocumentMentions()`, so mentions work even when the bridge extension's own
  autocomplete provider is absent.
- **Office tool cards** (`src/renderer/src/session/OfficeToolCard.tsx`) — an
  `office_*` call shows the document it targeted (`document: "active"` resolved
  against the registry) and whether the call was capability-gated (`advertised`,
  `legacy`, `gated` or `unattached`). `office_list_documents` renders as a table
  with per-row actions instead of markdown.

**One Office host.** The supervisor gives port 38617 to the tab whose spawn spec
has `officeHost: true` (the `office` tab kind); every other host gets 38618+.
`promoteToOfficeHost(tabId)` in `src/main/session-service.ts` keeps that
invariant: it demotes and stops any other `office` tab, then restarts the
promoted tab's host so it binds 38617, resuming the session from its JSONL.

## Failure modes and what the user sees

| Symptom                                    | Cause                                    | Where it surfaces                                                                                            |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| "The bridge is too old to connect"         | protocol < 2                             | troubleshooting item `bridge-version-skew` (error)                                                           |
| "The bridge uses an older protocol"        | protocol 2                               | troubleshooting item `bridge-version-skew` (warning), plus the panel's `Replies: final message only`         |
| "The bridge exposes an older tool catalog" | `catalogVersion` < 3                     | troubleshooting item `catalog-version-skew`                                                                  |
| "Port 38617 is already in use"             | another Pi session owns the bridge       | troubleshooting item `port-in-use`, with the `netstat`/`lsof` command and the `PI_OFFICE_BRIDGE_PORT` escape |
| "The bridge is not listening yet"          | no session hosts it                      | troubleshooting item `bridge-not-listening`                                                                  |
| "The add-in is not connected yet"          | manifest registered but no pane attached | troubleshooting item `pane-not-attached` (reopen Office so the manifest is re-read)                          |

## Upgrading the bridge

The app installs `PI_OFFICE_BRIDGE.pinnedVersion` (`^0.5.0`) into the Pi profile
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
| Office host promotion (38617)                                    | done (`promoteToOfficeHost` in `session-service.ts`)                                                                         |

Until step 14 lands, `view.run` is `{ available: false }` and the panel says
"Start an Office session…". The Stop handler is already live through the
supervisor: if an Office session exists it aborts that session's run.

## Test coverage

| Test                                                                   | Pins                                                                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/office/bridge-compat.test.ts`                                   | projection for v1/v2/v3/v4/unreachable, capability-over-version precedence, delta/final buffer semantics, promptId staleness, preview cap, pane tag parsing |
| `tests/office/office-run.test.ts`                                      | the tracker: delta accumulation, final replacement, pane vs app attribution, idle/failed Stop, settle behaviour                                             |
| `tests/office/version-skew.test.ts`                                    | the matrix end to end through a fake pane for both generations, plus the panel labels                                                                       |
| `tests/office/setup-view.test.ts`, `tests/office/setup-wizard.test.ts` | the view/wizard surface that carries the compatibility and the pin                                                                                          |
| `tests/main/office-documents-service.test.ts`                          | the registry poll: projection, not-our-bridge rejection, change-only emission, start/stop/dispose                                                           |
| `tests/shared/office-documents.test.ts`                                | the pane projection, mention values, document tag, capability states, target resolution, `office_list_documents` table parsing, `toDocumentMentions`        |
| `tests/renderer/documents-section.test.tsx`                            | the rail: visibility rules, per-pane facts, empty state, chat/mention actions, promotion footer                                                             |
| `tests/renderer/office-tool-card.test.tsx`                             | office tool cards: target chip, capability note, document-list table and row actions                                                                        |
| pi-for-office `bridge-extension/tests/{multi-document,smoke}.mjs`      | v2 handshake accepted, v1 rejected, `/health` protocolVersion + capabilities                                                                                |
| pi-for-office `packages/protocol/tests/protocol.test.ts`               | the version window, the `abort` frame, v2 frame acceptance                                                                                                  |

### Known gaps

- No test yet asserts that a **v3 bridge sends no deltas to a v2 pane** (the
  bridge-side branch is version-gated but only exercised indirectly).
- The add-in's streaming UI (rendering deltas with the same rAF batching as its
  local agent) is tested in pi-for-office, not end to end against a real pane.
- Only Windows has been exercised with a real Office host; the macOS `wef` path
  is covered by unit tests, not by a live pane.

### User guide

The end-user side of this integration — install, set up, the Documents section,
`#` mentions, promotion and troubleshooting — lives in
[`../guide/office-setup.md`](../guide/office-setup.md).
