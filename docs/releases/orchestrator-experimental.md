# Orchestrator (experimental) — release note draft

Status: **draft, not released**. No publish, tag or push has been performed.
The app version stays `0.11.0`, and no coordinated release has been cut. The
staged `@dieulc/workflow` is **0.17.4**, pinned by Desktop as a **local,
unpublished tarball** — `resources/workflow/dieulc-workflow-0.17.4.tgz`, 99
source files,
`sha512-IwbMvsiVi8YBHno5XUNS9CcucDsgvk4USPKUFN4/zuNk7UQpvB61wPjT0tREvZe0VKKhQbhdadKVYiF77rvYiA==`,
no release `url` or `tag` — until the user authorizes a coordinated release.
This is not a published asset, a GitHub/npm release, or packaged acceptance.

## What ships

- The generic extension contribution contract and related-session host are the
  public seam. Arbitrary extensions can publish modes, status, progress,
  actions, input availability and related-session links; Desktop does not parse
  Workflow names or status prose.
- Related sessions are normal tabs owned by one host, with source-bound ownership
  from the registered command, capability negotiation, bounded bootstrap entries
  written before `session_start`, and duplicate request replay instead of a
  second child.
- Workflow's Orchestrator mode is **opt-in and experimental**. Entering the mode
  launches nothing; ordinary Plan → Review → Build keeps its current defaults.

## Pinned artifact (0.17.4, local only)

`resources/workflow.lock.json` pins `@dieulc/workflow` **0.17.4** with
`source.kind: "tarball"`, `source.path:
resources/workflow/dieulc-workflow-0.17.4.tgz`, 99 source files, and the
integrity above — deliberately no `url`/`tag`. `npm run workflow:lock`,
`workflow:stage` and `workflow:verify --offline --require-dev` staged and
re-verified both `resources/extensions/workflow` and `out/extensions/workflow`
from those exact local bytes. The 0.17.4 source is the W checkout work and is
**unreleased and unpublished**; pin/stage/verify could not be run against a
published asset. Promoting this pin to a release URL/tag is a separately
authorized follow-up and must not be inferred from this note.

Child TODO display controls are part of this 0.17.4 artifact: the four verbs and
`/todos` target the active parent/child panel, the menu group reads `Child
todos` in child view, an empty or headerless child keeps the verbs available
without an invented widget, and `/todos clear` stays parent-only. These are the
staged extension's behaviors, not a claim that a live provider child session was
walked through in Desktop or Terminal.

## Compatibility

| Capability                    | Workflow | Desktop            | Missing behavior                  |
| ----------------------------- | -------- | ------------------ | --------------------------------- |
| Contribution contract v1      | required | this host or newer | older host: statuses/widgets only |
| Source-bound related sessions | required | this host or newer | `unsupported`, no hidden child    |
| Bootstrap + authorized wake   | required | this host or newer | resume stays idle; no replay      |
| Visible child tab/window      | required | this host or newer | unavailable with setup guidance   |
| Parent-only commits           | required | —                  | child commits/push suppressed     |

An older Desktop is a supported generic fallback, not a Workflow-specific
compatibility parser. Missing native capabilities return an explicit
`unsupported` result.

## Rollback

Desktop can ship without the Orchestrator/Workflow-specific path: ordinary Build
remains available, Workflow falls back to generic widgets/statuses, and no
session/evidence data is rewritten. Workflow can disable Orchestrator without
affecting existing short-task behavior.

## Verification

Automated gates (this change set): `format:check`, `typecheck`, `lint` (0
errors), `npm test` (5659 passed / 5 skipped), `npm run build`. The shared
two-extension fixture and `tests/host/extension-contract.e2e.test.ts` cover
arbitrary modes, cross-owner actions, stale epochs, reload, absent capabilities
and source-bound related sessions.

Not run: real provider/turn loop, real terminal automation, packaged Desktop E2E
and live platform signoff. The same limitation applies to the local 0.17.4 pin:
manual child TODO display acceptance and a published-asset re-verification are
both **NOT RUN**. See the Workflow repository's
`docs/orchestrator-live-acceptance.md`; it is currently **NOT RUN**.

## Promotion

Promote only after the live checklist passes or an approved exception is
recorded, both packages are version-coordinated, `npm run verify:extension`
passes, and the user explicitly authorizes publish/tag/push.
