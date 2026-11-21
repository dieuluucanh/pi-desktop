# Orchestrator (experimental) — release note draft

Status: **draft, not released**. No publish, tag or push has been performed.
The app version stays `0.11.0` and `@dieulc/workflow` stays `0.13.0` until the
user authorizes a coordinated release.

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
and live platform signoff. See the Workflow repository's
`docs/orchestrator-live-acceptance.md`; it is currently **NOT RUN**.

## Promotion

Promote only after the live checklist passes or an approved exception is
recorded, both packages are version-coordinated, `npm run verify:extension`
passes, and the user explicitly authorizes publish/tag/push.
