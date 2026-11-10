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
