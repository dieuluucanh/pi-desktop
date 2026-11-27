# Prompt refinement: operation, upgrade and compatibility

The user-facing guide is [`guide/prompt-refinement.md`](../guide/prompt-refinement.md).
This page is the architecture/operations contract for the feature: how a live
desktop build runs it, how a bundled Workflow artifact is sourced and can be
overridden, disabled or bypassed in safe mode, how to upgrade and roll back each
half independently, and which claims are backed by a run versus which are honest
limits.

Publisher-side detail lives in the Workflow package README
(`agent/extensions/workflow/README.md#prompt-refinement`). The generic wire
contract is frozen in
[`extension-ui.md`](extension-ui.md#composer-transform-contract-frozen-row-13)
and `src/shared/composer-transform.ts`.

## 1. Operation

A refinement is host work whose observable state is per tab.

1. A publisher exposes an additive `kind: "composer-control"` (checked / enabled
   / one-shot-return) with same-owner `actionRef` (toggle) and `transformActionRef`
   (operation) references, plus `operation` metadata naming its public input
   command and a registered bootstrap companion.
2. The host resolves both commands' live SDK `sourceInfo` and refuses equal names
   from different extensions. It mints a CSPRNG request-scoped grant, arms a
   **single-use** EventBus rendezvous, and invokes the companion with a grant-only
   JSON bootstrap (`contract` + `grant`). A matching random proof hands the typed
   in-process port to the companion. The public command text is never parsed as
   internal JSON.
3. The extension runs one bounded `inspect → ask → inspect → compose → submit`
   operation in an isolated in-memory second session — its own `ModelRuntime`, no
   ambient extensions/skills/templates/themes/AGENTS context, explicit
   caller-filtered context blocks, exact active-tool assertion, disposal on any
   bootstrap failure.
4. The host drives typed frames (`start`, `started`, `progress`, `candidate`,
   `cancel`, `status`, `apply`, lifecycle). The per-tab reducer applies a
   candidate only to the exact still-current draft revision, and records an
   idempotent apply receipt. Nothing is sent to the chat and no synthetic turn is
   appended.
5. Trust/grants/read policy are re-resolved at each authority boundary (every
   inspection, provider request, question, candidate delivery and turn boundary).
   A narrowing policy generation cancels the operation and disposes the child;
   the candidate is never applied from stale authority.

Cancellation: Esc/Stop cancels the refinement first (never an unrelated Review);
explicit toggle-off cancels and disarms; other errors keep the control armed.
Conflicts: newer typing/attachment changes/ABA edits/tab switch keep the
candidate viewable but require an explicit replace against the confirmed
revision. Recovery: original draft + candidate live in a bounded in-memory store
outside the transcript; a lost apply ack is settled from the host receipt ledger;
a reload adopts the live operation; host restart/reload/session replacement/
publisher disable/tab close invalidate the job and grant while preserving draft
text (but binary images live only in renderer memory and do not survive a full
process loss).

## 2. Bundled source, override, disable and safe mode

Pi Desktop ships a **pinned** `@dieulc/workflow` artifact as `builtin:workflow`,
staged from a locally verified tarball or an explicitly pinned release artifact
with recorded integrity/source metadata (see
[`packaged-workflow-acceptance-2026-11-24.md`](packaged-workflow-acceptance-2026-11-24.md)
and [`runtime.md`](runtime.md)). Loading is offline and independent of a
developer checkout.

- **Diagnostics.** The resource hub and About & updates report the builtin
  version, its source and whether it was replaced; a duplicate default
  recommendation offer is gone.
- **Explicit override.** An npm/git/local/project install replaces the builtin
  exactly once and surfaces a provenance warning naming which copy won. Older
  installed versions override too.
- **Opt-out.** `-builtin:workflow` removes the builtin without touching the
  user's `packages`/settings.
- **Disable / re-enable.** The Extensions hub can disable and re-enable the
  builtin; reload and the resource hub stay consistent.
- **Safe mode.** Safe mode loads neither the builtin nor a third-party copy, and
  refuses package mutations.
- **No runtime install, no settings rewrite.** These paths never install at
  runtime, never overwrite `packages`/settings, and coexist with checkpoints.

Terminal Pi is unaffected: it loads the extension from npm or a checkout as
before.

## 3. Upgrade and rollback (the two halves independently)

Refinement spans two independently versioned halves — the Workflow extension and
the Desktop host. They upgrade and roll back separately.

**Workflow (W).**

- Upgrade: `pi update --extensions` (or pin `pi install npm:@dieulc/workflow@x.y.z`).
  A packaged Desktop upgrades its builtin by installing a newer Desktop build;
  `pi install` still overrides it once.
- Roll back: `pi install npm:@dieulc/workflow@<previous>`; or remove the override
  and re-enable the builtin in the Extensions hub.

**Desktop (D).**

- Upgrade: install the newer signed/unsigned build; the bundled artifact and the
  capability reader advance together.
- Roll back: reinstall the previous Desktop build. The renderer and host ship in
  one binary, so a rollback never leaves a mismatched contract pair.

**Mixed versions fail safe.** Contribution v1 is additive: an older Desktop drops
the unknown `composer-control` kind and keeps status/action rows plus the plain
text command; `composerTransformFallback()` reports `nativeControl: false` and
`attachmentAware: false`, and a text fallback never promises attachment-aware
transformation. An older Workflow that publishes only status prose renders as a
plain generic row, not a parsed state. Because refinement is never required to
send a message, a mismatch degrades text-only rather than blocking the composer.

## 4. Compatibility matrix

| Concern            | Terminal Pi (W)                                       | Pi Desktop (D)                                                             |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Entry              | `/prompt <draft>` writes the editor                   | Armed composer control; typed `/prompt` routes through the structured path |
| Capability         | Publishes `composer-transform-v1`                     | Consumes it; unknown kinds fail safe                                       |
| Model              | Extension-owned `/prompt-model`, Default-mode inherit | Same setting                                                               |
| Image attachments  | Path is literal text, no bytes (accepted limitation)  | Bounded bytes/IDs after vision-capability validation                       |
| Apply              | Expected-buffer check + `setEditorText`               | CAS on exact draft revision + idempotent receipt                           |
| Busy / conflicts   | Refused while a run/review/handoff owns the turn      | Same, plus `request-conflict` for a duplicate binding                      |
| Cancellation       | Esc cancels the refinement first                      | Esc/Stop routed to the operation first                                     |
| Recovery           | Draft preserved; recoverable failure                  | Draft preserved; reload adopts live job; receipt replay                    |
| Old host/extension | —                                                     | Additive fallback, `attachmentAware: false`                                |

## 5. Tested versions

`@dieulc/workflow` **0.13.0** against the Pi SDK **1.5.0** (Desktop's exact pin;
`tests/packaging/pi-pins.test.ts` enforces the family equality). The structured
grant-only bootstrap + private rendezvous handshake is proven against unmodified
SDK 1.5, and the shared fixture is byte-identical between W and D (both suites
assert the same SHA-256).

Automated evidence is enumerated in
[`refinement-acceptance-2026-11-24.md`](refinement-acceptance-2026-11-24.md) and
[`product/parity.md`](../product/parity.md). Real-artifact, fake-host and
renderer suites cover the contract; the live/manual rows below are separate.

## 6. Honest acceptance limits

- **Semantic quality is human-reviewed, not guaranteed.** The rubric corpus and
  deterministic fake-provider harness check shape, literal/constraint
  preservation, language retention, suggestion consent, evidenced terminology and
  non-execution. They do not prove a candidate is _better_.
- **Not run here.** A live-model quality sample, Playwright composer E2E
  acceptance and real Terminal keyboard runs are recorded as **NOT RUN**, not
  inferred from unit substitutes. See
  [`refinement-acceptance-2026-11-24.md`](refinement-acceptance-2026-11-24.md).
- **Terminal structured images are an accepted difference** — the command handler
  receives no image bytes, and this build does not patch upstream
  `node_modules`.
- **Revocation is forward-looking.** A narrowed policy stops future reads and
  provider requests and prevents a stale apply; it does not recall provider data
  already disclosed in an earlier request.
- **Binary attachments do not survive a full app/renderer process loss**;
  surviving them would require a separate secure draft-blob store this build
  deliberately omits.
- Generic SDK APIs that Workflow does not use are outside this contract and are
  not advertised as supported.
