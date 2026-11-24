# Prompt-refinement acceptance record (plan step 36)

Plan: `.pi/plans/2026-11-22-prompt-refinement-workflow-parity.md`, step 36 —
"Run Desktop composer E2E and Terminal interaction acceptance".

This file is the **evidence record**, not a new contract. It maps every
scenario named by step 36 to the check that exercises it, records the exact
versions the checks ran against, and keeps the real-terminal/GUI runs in an
explicit **NOT RUN** state where this environment cannot execute them. Nothing
here converts a unit or fixture-level substitute into evidence for a real
terminal surface.

## Environment and exact versions

Recorded while producing the rows below (Windows, automated session; no
interactive TTY and no authorized live provider).

| Component                         | Version / evidence                                                    |
| --------------------------------- | --------------------------------------------------------------------- |
| OS                                | `Microsoft Windows [Version 10.0.26300.9974]`                         |
| Node used for the harness         | `v24.22.2` (bundled runtime pin; see `docs/architecture/versions.md`) |
| npm                               | `11.19.1`                                                             |
| Desktop app                       | `0.11.0` working tree (`package.json`)                                |
| Electron                          | `44.4.3` (`npx electron --version`)                                   |
| Playwright                        | `@playwright/test 1.63.0`                                             |
| Pi SDK / agent                    | `@earendil-works/pi-coding-agent 1.5.0` (exact pin)                   |
| Workflow extension under test (W) | `@dieulc/workflow 0.13.0`                                             |
| Desktop build used by E2E         | `out/main/index.mjs` produced by the repo build                       |

The Desktop E2E publisher is a **generic fixture extension**
(`tests/e2e/composer-refinement.spec.ts`): arbitrary owner id, arbitrary labels,
one additive `composer-control` contribution, the frozen
`composer-transform-v1` contract, the real host registry, the real private
single-use EventBus rendezvous, real IPC and the real renderer reducer. No
Workflow-specific branch in Desktop is required for the suite to pass.

## Desktop composer E2E

Command (from the repository root, after `npm run build`):

```bash
npx playwright test tests/e2e/composer-refinement.spec.ts --reporter=list
```

Coverage map. "Automated" means a Playwright assertion in the spec file above.

| Step-36 scenario                           | Check (test title)                                                                     | Status                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle position/accessibility              | `the control sits in the bottom-right composer row and reports armed state accessibly` | PASS (automated)                                                                                                                                        |
| Refine → send → return → off → edit → send | `refine → send → return → off → edit → send dispatches only the later human send`      | PASS (automated)                                                                                                                                        |
| Typed `/prompt` route                      | `a typed /command runs the same structured operation as an armed Send`                 | PASS (automated)                                                                                                                                        |
| Keyboard/completion route                  | `Tab completes the advertised transform command and Enter still routes it`             | PASS (automated)                                                                                                                                        |
| Images and pasted text                     | `images and a collapsed paste survive refinement and the later human send`             | PASS (automated)                                                                                                                                        |
| Typed route + image preservation           | `a typed transform command carries its images into the later human send`               | PASS (automated)                                                                                                                                        |
| Question docking/remount                   | `a question docks over the composer and remounts it with draft and image intact`       | PASS (automated)                                                                                                                                        |
| Newer-typing conflict                      | `typing while a refinement runs wins: the candidate conflicts instead of overwriting`  | PASS (automated)                                                                                                                                        |
| Cancellation/error retry                   | `cancellation keeps the arm and a retryable error keeps the draft`                     | PASS (automated)                                                                                                                                        |
| Two panes                                  | `two panes keep their own arm, draft and candidate`                                    | PASS (automated)                                                                                                                                        |
| Background attention                       | `two tabs stay isolated and a background question only marks attention`                | PASS (automated)                                                                                                                                        |
| Renderer reload (applied)                  | `a renderer reload keeps the applied text once and never re-runs the operation`        | PASS (automated)                                                                                                                                        |
| Renderer reload (mid-refinement)           | `a reload mid-refinement never starts a second operation and never double-inserts`     | PASS (automated)                                                                                                                                        |
| Applied-receipt loss                       | `an applied receipt lost on reload is never re-applied and never double-inserts`       | PASS (automated)                                                                                                                                        |
| Live-operation adoption after reload       | `a reload mid-refinement adopts the live operation and offers its candidate`           | KNOWN GAP, `test.fixme` — host must migrate a live job across a same-session reattach (protocol change). Safety properties are pinned by the row above. |

Every one of these also pins the zero-execution invariant: no parent/provider
turn, no plain-command fallback (`/fixture-prompt` handler must not run) and no
transcript row carrying the draft or candidate.

### Last verified run

Run from the repository root on 2026-11-24 (Windows, Node 24.22.2):

| Command                                                                                                            | Exit | Result                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------- |
| `npx playwright test tests/e2e/composer-refinement.spec.ts --reporter=list`                                        | 0    | 14 passed, 1 skipped (the `test.fixme` known gap), 1.5m |
| `npm run typecheck:e2e`                                                                                            | 0    | clean                                                   |
| `npx eslint tests/e2e/composer-refinement.spec.ts`                                                                 | 0    | clean                                                   |
| `npx prettier --check tests/e2e/composer-refinement.spec.ts docs/architecture/refinement-acceptance-2026-11-24.md` | 0    | clean                                                   |

### Known gap kept honest

`test.fixme("a reload mid-refinement adopts the live operation and offers its
candidate")` records a real behavioural hole: after a renderer reload during a
still-live refinement, the host answers `composer.current` for the newer session
epoch while the live job is bound to the older one, so the late candidate is
dropped. The draft is preserved, nothing is re-run and nothing is double
inserted (asserted), but the candidate is not offered. This is a protocol
change (host migration/reattach of a live job) and is deliberately not faked.

## Real Terminal interaction acceptance (W)

These rows require the actual Pi TUI on a real terminal surface with a real
provider configured. **They were not executed in this row** — the environment is
an automated Windows session with no interactive TTY and no authorized live
model. They are marked **NOT RUN**, not passed. The automated substitutes listed
below are recorded only for traceability and explicitly do **not** satisfy the
row.

| Scenario                                    | Manual procedure (exact expected observation)                                                                                                                                                                                                                                                                                                                            | Automated substitute (not evidence for this row)                            | Status  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------- |
| Prefix command                              | In a trusted project, type `/prompt make the paragrph better` + Enter. Expect: one progress surface, refinement across inspect/question/compose, candidate returned **in the editor without** `/prompt`, editable, caret sensible. Main transcript gains no user/assistant turn.                                                                                         | `prompt-refinement-command.test.ts`                                         | NOT RUN |
| Esc                                         | During a live refinement press Esc once: operation cancels, progress surface disposed, draft restored (or kept recoverable when the buffer moved on), no send. Press Esc twice quickly: second press is consumed, no second cancel, no fall-through to aborting the main agent or an unrelated Review. Esc during a question aborts the questionnaire and the operation. | `prompt-refinement-command.test.ts`, `clarification-presenter.test.ts`      | NOT RUN |
| Questionnaire                               | Refinement asks a question: the progress surface is suspended before the question (never nested), the Terminal questionnaire accepts arrows/Enter and free text, copy/paste and wheel/resize work, answering resumes the operation, cancellation mid-question cleans up with no authority side effect.                                                                   | `questionnaire-view.test.ts`, `questionnaire-layout.test.ts`                | NOT RUN |
| Paste-marker expansion/history preservation | Paste a large multi-line block: the editor shows `[paste #N +X lines]`; `/prompt` receives the **expanded** text; after the candidate returns the marker, its side-table entry and the canonical text survive; Up-arrow history recalls the pre-refinement draft with the marker intact; a later human send expands the paste exactly once.                              | `tab-editor.test.ts`                                                        | NOT RUN |
| Image paths                                 | Type `/prompt describe images/error.png`: the path is literal prompt text. Terminal command handlers receive no structured images, so no image bytes are attached and the model must not claim to have seen file content it did not inspect; unsupported image content is disclosed rather than silently dropped. Structured image bytes are a Desktop-only capability.  | `prompt-refinement-command.test.ts`                                         | NOT RUN |
| No task execution                           | After any of the above: zero main-agent turns, zero provider requests attributable to the refinement, no bash/tool execution in the parent, no plan/todo/checkpoint files, no commit authorization, no Review/handoff change and no Orchestrator dispatch until a separate human send.                                                                                   | `prompt-refinement-cross-host.test.ts`, `prompt-refinement-runtime.test.ts` | NOT RUN |

### Completing these rows

```bash
# real terminal, real provider, trusted project, Workflow 0.13.0 loaded
pi --version            # expect the SDK 1.5.0 family the app pins
/prompt <draft>         # then Esc / answer a question / paste a large block
```

Record the observation per row above (replace `NOT RUN` with `PASS`/`FAIL` and
the exact terminal, provider/model, extension source and date). A unit test that
passes is not a substitute for any row in this table.

## Not run in this row

- Real Terminal TUI keyboard runs (`/prompt`, Esc, questionnaire, paste
  markers, image paths, no-execution) — no interactive TTY here.
- Live-model refinement quality sample — needs a separately authorized provider.
- Packaged/offline Desktop and platform acceptance — recorded separately in
  `docs/architecture/packaged-workflow-acceptance-2026-11-24.md` (plan step 39:
  Windows packaged rows PASS; macOS/Linux and packaged GUI keyboard runs are
  NOT RUN release blockers).
- macOS/Linux terminal and GUI keyboard behaviour — plan step 39 platform
  signoff.

## Reproduce the automated rows

```bash
cd <pi-desktop>
npm run build
npx playwright test tests/e2e/composer-refinement.spec.ts --reporter=list
npm run typecheck:e2e
npx prettier --check tests/e2e/composer-refinement.spec.ts
```

Results are also attached to the Playwright report on failure
(`publisher-log.jsonl`), which is the fixture's own record of bootstrap keys,
claim, draft snapshot, candidate and applied receipt — never draft text in logs
beyond what the assertions need.
