# Prompt refinement

Prompt refinement rewrites a **drafted request** and returns the result to the
composer. It never sends the request and never runs it: nothing happens until
you press Send yourself. It is provided by `@dieulc/workflow`; without that
extension the Refine prompt control simply does not appear, and nothing else
changes.

## Refining a draft

A publisher that implements the frozen `composer-transform-v1` capability adds a
**Refine prompt** control to the composer. It is a one-shot toggle:

1. Type or paste your draft.
2. Arm the control (or type `/prompt <draft>`). The composer shows a “Send
   refines, does not run” hint while it is armed.
3. Press **Send**. One progress strip appears above the composer while the
   request is refined. The conversation is **not** marked as running; no user or
   assistant turn is appended.
4. When the candidate comes back it replaces the draft in place, editable, with
   the caret where you would expect. Review it, edit it, and only then send it —
   or disarm and keep the original.

The toggle is one-shot: after one refinement it disarms. `/prompt-refine on|off`
sets the same arm state from the command line.

## Which model refines it

Refinement uses its own optional model, independent of your chat model, roles and
profiles. The order is: a **trusted** project setting → the global setting →
the Default-mode model. Configure it with `/prompt-model`:

- `/prompt-model status` shows the effective model, thinking level, its source
  and any shadowed scope.
- `/prompt-model set <provider/model> [thinking] [global|project]` saves a
  validated override.
- `/prompt-model inherit [global|project]` deliberately falls back to the
  Default-mode model (a trusted project inherit suppresses a global override).
- `/prompt-model reset [global|project]` removes only that scope.

A missing or invalid setting is reported and refinement refuses rather than
silently using another model. Refining never changes your chat model, roles,
profiles or Pi's saved default.

## What it can and cannot do

- **It only edits text.** Refinement cannot run a command, edit a file, create a
  plan, todo or checkpoint, start a review, approve a handoff or dispatch an
  Orchestrator child. A later human Send is the only way work begins.
- **It reads through your policies.** It inspects files only within your
  folder/read/trust policy, and applies grants, sensitive-file rules and
  exclusions per file before any text reaches the model. A narrowing change (a
  revoked grant, a new exclusion, lost trust) cancels the operation rather than
  delivering a stale result. Revocation stops _future_ reads and model requests;
  it cannot recall file text a provider already received.
- **It asks when it needs to.** If the request is ambiguous it may open a short
  questionnaire (1–4 questions) before composing.
- **Images are Desktop-only.** On Desktop an attached image is sent only after
  the selected model is confirmed to support vision; an unsupported image is
  disclosed and you are asked for a text description instead. In **Terminal Pi**
  a path like `images/error.png` is just literal prompt text — no image bytes are
  attached — so the model must not claim to have inspected a file it did not
  read.
- **It is bounded.** A refinement caps its model turns, inspections, question
  rounds and active time. Running out is a recoverable failure, not a silently
  truncated result.

## Busy, cancel and conflicts

- Refinement is refused (not queued) while a run owns the turn, a Review round is
  active or paused, a handoff or questionnaire owns input, or an Orchestrator
  child owns the operation.
- **Esc / Stop** cancels the refinement first; it never pauses or aborts an
  unrelated Review. Turning the toggle off cancels and disarms; other errors keep
  it armed for a retry.
- If you keep typing while a refinement runs, your newer text **wins**. The
  candidate is kept as a viewable, copyable result with the original beside it,
  and only an explicit **Replace** overwrites your draft — against the exact
  revision you confirmed.

## Recovery

- The original draft, the candidate and a short change summary stay in memory,
  outside the transcript and session file. You can always View/Copy the original.
- A lost apply acknowledgement is settled from the host's receipt ledger; a
  renderer reload adopts the live operation instead of starting a second one.
- A host restart, new/resume/fork/rewind session, `/reload`, disabling the
  extension, or closing the tab cancels the job and invalidates its grant. The
  candidate stays viewable but cannot be applied; your draft text is preserved.
- **Attached images do not survive a full app or renderer restart.** Image bytes
  live only in renderer memory; the saved draft carries text only. Surviving
  images would need a separate secure draft store, which this build does not
  have.

## Bundled, overridden, disabled and safe mode

Pi Desktop can bundle a pinned `@dieulc/workflow` artifact. It is loaded offline,
marked as the builtin, and reported (version/source/replacement) in the resource
hub and About & updates. An explicitly installed npm/git/local/project copy
overrides the builtin exactly once with a provenance note. `-builtin:workflow`
opts the builtin out without editing your settings; the Extensions hub can disable
and re-enable it; and safe mode loads neither the builtin nor a third-party copy.
Terminal Pi is unaffected — it loads the extension from npm or a checkout as
before.

## Compatibility and limits

| Concern                     | Behaviour                                                                  |
| --------------------------- | -------------------------------------------------------------------------- |
| Terminal Pi                 | `/prompt <draft>` writes the editor; image paths are text only             |
| Pi Desktop                  | Armed composer control; typed `/prompt` routes through the structured path |
| Refinement model            | Extension-owned `/prompt-model` with Default-mode inheritance              |
| Old desktop / old extension | Additive fallback: text/status only, `attachmentAware: false`              |
| Apply                       | CAS on the exact draft revision + idempotent receipt                       |

**Tested:** `@dieulc/workflow` 0.13.0 with Pi SDK 1.5.0. **Not proven here:**
semantic _quality_ is a human-reviewed property, not a guarantee; a live-model
quality sample, Playwright composer E2E and real Terminal keyboard acceptance are
recorded as NOT RUN rather than inferred from unit tests. See
[refinement acceptance](../architecture/refinement-acceptance-2026-11-24.md) and
the host-side [composer-transform contract](../architecture/extension-ui.md#composer-transform-contract-frozen-row-13).
