# Review Mode provider baseline (2026-11-09)

This records the reproduction evidence behind the Review Mode provider-recovery work. It is a
snapshot, not a live guarantee: Command Code routing, upstream capacity and model versions change.

## Failing symptom

Review Mode runs the reviewer as an isolated child session. With the `command-code` provider and
`deepseek/deepseek-v4.1-flash`, the reviewer audited the repository, then the next assistant stream
ended after roughly 130 s with:

```text
reviewer run ended on a provider error: Stream ended without finish_reason
```

The SDK auto-retry repeated the same long request and failed again; Review Mode handed the author's
plan over unreviewed. The same failure was observed in Pi Desktop and in terminal Pi, so it is not a
Desktop-only defect.

Observed in the local session logs on 2026-11-09:

| Product                         | Window      | Reviewer model                              | Pattern                                        |
| ------------------------------- | ----------- | ------------------------------------------- | ---------------------------------------------- |
| Pi Desktop (pi-studio session)  | 09:52–09:59 | `command-code/deepseek/deepseek-v4.1-flash` | 3 attempts, ~130 s each, then `review skipped` |
| Pi Terminal (same session file) | 13:58–14:02 | `command-code/deepseek/deepseek-v4.1-flash` | same cut after many `review_bash` calls        |

The failing runs all had a long multi-turn review context: many `review_bash`/`read` tool calls, a
large plan, and a final rewrite. The error arrives after the last tool result, when the reviewer
asks for the next assistant message.

## Probe matrix

The probe is `scripts/probe-commandcode-stream.mjs`; it is gated by
`PI_COMMANDCODE_PROBE=1` and never prints the key. Each row is one paid request.

| Wire             | Thinking | Max tokens | Input                          | HTTP | First event | Longest gap | Total   | Outcome | Finish      |
| ---------------- | -------- | ---------- | ------------------------------ | ---- | ----------- | ----------- | ------- | ------- | ----------- |
| Chat Completions | high     | 32,768     | built-in synthetic plan        | 200  | 1.9 s       | 496 ms      | 30.0 s  | OK      | `stop`      |
| Responses        | high     | 32,768     | built-in synthetic plan        | 200  | 1.4 s       | 514 ms      | 35.4 s  | OK      | `completed` |
| Chat Completions | max      | 65,536     | built-in synthetic plan        | 200  | 2.2 s       | 511 ms      | 64.1 s  | OK      | `stop`      |
| Responses        | max      | 65,536     | built-in synthetic plan        | 200  | 1.9 s       | 388 ms      | 98.3 s  | OK      | `completed` |
| Chat Completions | max      | 65,536     | this repository's 33-step plan | 200  | 2.8 s       | 451 ms      | 152.2 s | OK      | `stop`      |
| Responses        | max      | 65,536     | this repository's 33-step plan | 200  | 2.6 s       | 719 ms      | 117.6 s | OK      | `completed` |

Reproduce with:

```sh
PI_COMMANDCODE_PROBE=1 node scripts/probe-commandcode-stream.mjs \
  --wire both --thinking max --max-tokens 65536 --runs 1 \
  --plan-file .pi/plans/2026-11-09-review-mode-provider-esc.md
```

The probe has an offline suite (`tests/scripts/commandcode-probe.test.ts`) that asserts a clean EOF
without `finish_reason` is reported as a `CUT`, and that HTTP errors/timeouts are reported rather
than thrown.

## What the matrix means

- A single long generation is **not** enough to reproduce the cut. Both wires completed a 53,717
  character rewrite in 152.2 s on Chat Completions and 117.6 s on Responses. A fixed 120/130 s
  server limit is therefore not the whole explanation.
- The wire is not the only variable. Responses is still the preferred route for models that
  advertise it, because the maintained `pi-commandcode-provider` maps that wire and normalizes
  Command Code's reasoning deltas; but switching wires alone is not a guaranteed fix.
- The failure correlates with the **review's multi-turn/tool-call context**, not with a static
  prompt. That is why the fix combines a bounded fallback model chain with chunked plan submission:
  the review must survive a cut regardless of which request the gateway drops.
- The literal `Stream ended without finish_reason` is pinned to real SDK behavior by
  `tests/host/provider-stream-cut.test.ts`. If an SDK upgrade renames it, that test fails before the
  recovery classifier silently stops matching.

## Control

A review on a non-Command-Code reviewer (synthetic/opencode) completed normally. That keeps the
provider-specific failure separate from the Review Mode orchestration, and is the recommended
immediate mitigation until the recovery work ships.

## 2026-11-10 follow-up — handoff continuity and manual-review visibility

Two additional gaps were observed after the provider recovery work:

- **Manual `/review` had no live status.** Desktop mounted `WorkingRow` only while
  `tab.status === "running"`. An automatic review runs inside `agent_end` while the parent turn
  streams; a manual `/review` is a slash command on an idle tab, so the extension's
  `🔍 Reviewing plan…` message was never rendered and Escape was never forwarded. Fixed by treating
  an active extension working message as busy (working row + Escape), independent of the parent run.
- **Round 2+ could lose the browser handoff.** A manual `/review` started a new round without
  clearing an older `awaitingDecision`; a stale browser Deny arriving during a new round was
  rejected without clearing it; restore read the boolean but nulled the review id/path/hash; and a
  slow request response fell back to inline while the browser tab still opened. Fixed with a
  persisted full correlation (review id, request id, URL, source, plan hash, cycle), stale-gate
  supersede on every new round, `session-opened`/`session-closed` lifecycle listeners, and
  `review-status` recovery after `reload`/`resume`/`fork`.
- **The new review tab stayed behind the old one.** Notification URLs opened with
  `activate:false`, and an existing same-URL tab was left untouched. Notification review URLs now
  focus; an existing same-URL tab is reloaded before focus. Tool-result localhost URLs stay in the
  background.

## 2026-11-14 follow-up — Review is an isolated mode with an in-app handoff

`@dieulc/workflow` 0.11.0 turns Review into an explicit turn (`running` →
`paused` → `running` → `handoff` → `transition` → `idle`) and emits it as its own
status: `🔍 review`, `🔍 review — paused`, `🔍 review — awaiting decision`.
Pi Desktop now parses that as the fourth workflow mode instead of inferring
Review from a working message. The heuristic (`/review/i` over the status or the
working text) could miss the handoff phase entirely and could misclassify
unrelated extension text.

The desktop half of the contract:

- **One visible status row.** `ReviewBar` renders after the above-editor widget
  strips (the TODO panel) and immediately above the composer, matching terminal
  Pi's placement. Its text is the extension's `workflow-review` status:
  `🔍 Reviewing plan… · ESC or /review-pause to pause · /review-abort to stop ·
<phase detail>`, `⏸ Review paused — /review-resume to continue,
/review-abort to stop`, or `🔍 review · awaiting decision — /review-abort to
skip`. The row adds Pause/Abort while running, Resume/Abort while paused, and
  **Open review tab** during the handoff. The generic working row is suppressed
  while it is visible and the footer omits `workflow-review` so the line
  appears once. The bar reads the linked loopback web tab for this session, so
  a closed review tab degrades to the command path instead of a dead button.
- **An older extension still gets a line.** If `workflow-review` is absent, the
  desktop composes the canonical phase line and appends the running hints. The
  fallback has the commands and phase, but not the extension's live
  pass/finding detail; the next companion release supplies the full line.
- **The store refuses prose, not commands.** `sendPrompt`/`sendPromptNow`
  reject anything that does not start with `/` while the workflow status is
  Review, set a hint, and leave the draft untouched. The extension remains the
  authority on which commands are allowed. `runReviewCommand` (the bar's action)
  runs `commands.run` directly and never calls `setDraft`, so a draft typed
  before the review survives.
- **The desktop host never launches the system browser.** `host-supervisor.ts`
  composes `PLANNOTATOR_BROWSER=none` into desktop host processes only. Terminal
  Pi and the in-app terminal keep their own environment and therefore keep the
  browser. The review page opens as a focused web tab; `web.open` now carries
  `reload` and honours `activate`, so a reused Plannotator URL is reloaded only
  after the parked view is created, and the app window is raised.
- **Composer.** The Review badge uses the `info` tone, Stop is hidden while
  Review owns the turn (Stop would abort the parent run, not the review), and
  the hint row explains that only review/model/profile commands are accepted.
- **Todo panel.** The native Todo bar above the panel exposes the four display
  verbs in Review; the extension's `workflow-todos` status supplies progress
  while the panel is hidden or Review owns the turn, and a same-path Review
  rewrite keeps the user's collapse/hide choice (plan-scoped preference).

Both halves must be upgraded together. A new extension with an old desktop
degrades to no badge but keeps the extension-side lock; an old extension with
the new desktop keeps emitting the legacy Plan sub-state, which is parsed as
Plan and never as Review.

Verification: `tests/renderer/review-bar.test.tsx`,
`tests/shared/workflow-mode.test.ts`, `tests/renderer/session-view.test.tsx`,
`tests/renderer/session-footer.test.tsx`, `tests/renderer/composer.test.tsx`,
`tests/renderer/composer-store.test.ts`, `tests/renderer/web-tab-store.test.ts`
and `tests/main/host-supervisor.test.ts`.
The manual cross-version matrix in the 2026-11-14 plan (step 19) has not been
exercised on real provider sessions for this release.
