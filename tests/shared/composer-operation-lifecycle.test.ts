import { describe, expect, it } from "vitest";

import {
  COMPOSER_TRANSFORM_CONTRACT,
  type ComposerControlContribution,
} from "../../src/shared/composer-transform";
import {
  composerTabOperation,
  createComposerOperationRegistry,
  deriveComposerOperation,
  reduceComposerOperation,
} from "../../src/shared/composer-operation";
import {
  buildContributionSnapshot,
  type ContributionSnapshot,
} from "../../src/shared/extension-contributions-view";
import type { ActionContribution, Contribution } from "../../src/shared/extension-contributions";

/**
 * Operation lifecycle across renderer/host boundaries (prompt-refinement plan
 * step 23).
 *
 * Every event is fenced by tab/session/host/UI binding; a reconciliation read
 * adopts live work instead of restarting it; an applied-but-ack-lost state is
 * settled from idempotent receipts (never by replacing the draft twice); and a
 * host/publisher/policy/trust invalidation is always a cancellation, never an
 * applicable cached result.
 */

const OWNER = "alpha.ext";
const BINDING = {
  sessionId: "session-1",
  epoch: 1,
  bindingId: "binding-1",
  hostGeneration: 7,
} as const;

function control(over: Partial<ComposerControlContribution> = {}): ComposerControlContribution {
  return {
    id: "alpha-composer",
    kind: "composer-control",
    slot: "composer-actions",
    tone: "accent",
    order: 0,
    label: "Refine prompt",
    description: "Returns a refined draft; never runs it.",
    icon: "sparkles",
    checked: false,
    enabled: true,
    behavior: "one-shot-return",
    actionRef: "toggle",
    transformActionRef: "transform",
    operation: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      publicCommand: "prompt",
      companionCommand: "prompt-companion",
    },
    ...over,
  };
}

function action(id: string, name = "prompt"): ActionContribution {
  return {
    id,
    kind: "action",
    slot: "action",
    label: `Run ${id}`,
    tone: "neutral",
    order: 0,
    command: { name },
    enabled: true,
  };
}

function snapshot(
  contributions: Contribution[],
  over: { revision?: number } = {},
): ContributionSnapshot {
  return buildContributionSnapshot(
    [{ ownerId: OWNER, epoch: 0, revision: over.revision ?? 1, contributions }],
    { supported: true, updatedAt: 10 },
  );
}

const BASE_CONTRIBUTIONS: Contribution[] = [
  control(),
  action("toggle", "prompt-toggle"),
  action("transform"),
];

function armedStarted() {
  let state = reduceComposerOperation(
    composerTabOperation(createComposerOperationRegistry(), "tab-1"),
    {
      type: "descriptor",
      snapshot: snapshot([
        control({ checked: true }),
        action("toggle", "prompt-toggle"),
        action("transform"),
      ]),
    },
  );
  state = reduceComposerOperation(state, { type: "binding", binding: BINDING });
  state = reduceComposerOperation(state, {
    type: "start",
    requestId: "req-1",
    ownerId: OWNER,
    controlId: "alpha-composer",
    binding: BINDING,
    descriptorGeneration: state.projection.controls[0]!.descriptorGeneration,
    baseRevision: 4,
    baseAttachmentRevision: 1,
    baseText: "original draft",
  });
  return reduceComposerOperation(state, {
    type: "started",
    receipt: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-1",
      operationId: "op-1",
      status: "started",
      binding: BINDING,
      startedAt: 2,
    },
  });
}

function withCandidate(text = "refined draft", revision = 8) {
  return reduceComposerOperation(armedStarted(), {
    type: "candidate",
    candidate: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-1",
      operationId: "op-1",
      candidateRevision: revision,
      text,
      at: 3,
    },
  });
}

function hostStatus(over: Record<string, unknown> = {}) {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req-1",
    operationId: "op-1",
    state: "running",
    revision: 5,
    updatedAt: 9,
    terminal: false,
    ...over,
  };
}

describe("event fencing by tab/session/host/UI binding", () => {
  it("drops a frame minted for another binding generation", () => {
    const running = armedStarted();
    const foreign = { ...BINDING, hostGeneration: BINDING.hostGeneration + 1 };
    const progress = reduceComposerOperation(running, {
      type: "progress",
      binding: foreign,
      progress: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        state: "awaiting-input",
        at: 5,
      },
    });
    expect(progress).toBe(running);

    const result = reduceComposerOperation(running, {
      type: "candidate",
      binding: foreign,
      candidate: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        candidateRevision: 8,
        text: "stale text",
        at: 6,
      },
    });
    expect(result).toBe(running);
    expect(result.operation?.candidate).toBe(undefined);
  });

  it("ignores a reconciliation read for another request id", () => {
    const running = armedStarted();
    const foreign = reduceComposerOperation(running, {
      type: "reconcile",
      status: hostStatus({ requestId: "req-other" }),
    });
    expect(foreign).toBe(running);
  });

  it("cancels live work when the binding generation changes", () => {
    const rebound = reduceComposerOperation(armedStarted(), {
      type: "binding",
      binding: { ...BINDING, hostGeneration: 8 },
    });
    expect(rebound.operation?.status).toBe("cancelled");
    expect(deriveComposerOperation(rebound).conflict?.kind).toBe("stale-binding");
  });
});

describe("reconciliation", () => {
  it("adopts the host's running state without inventing a candidate", () => {
    const reconciled = reduceComposerOperation(armedStarted(), {
      type: "reconcile",
      binding: BINDING,
      status: hostStatus(),
    });
    expect(reconciled.operation?.status).toBe("running");
    expect(reconciled.operation?.operationId).toBe("op-1");
    expect(reconciled.operation?.candidate).toBe(undefined);
  });

  it("settles an applied-but-ack-lost host operation without candidate text", () => {
    const running = armedStarted();
    const reconciled = reduceComposerOperation(running, {
      type: "reconcile",
      status: hostStatus({ state: "applied", revision: 6, terminal: true, updatedAt: 11 }),
    });
    expect(reconciled.operation?.status).toBe("applied");
    expect(reconciled.operation?.applied?.operationId).toBe("op-1");
    // No candidate text travels on this path, so a reload cannot insert a
    // second copy of the result.
    expect(reconciled.operation?.candidate).toBe(undefined);
  });

  it("never applies twice after a lost acknowledgement", () => {
    const candidateState = withCandidate();
    const applied = reduceComposerOperation(candidateState, {
      type: "applied",
      operationId: "op-1",
      appliedRevision: 8,
      disposition: "replaced",
      appliedAt: 4,
    });
    expect(applied.operation?.status).toBe("applied");
    const revision = applied.operation?.revision;
    const replayed = reduceComposerOperation(applied, {
      type: "reconcile",
      status: hostStatus({ state: "applied", revision: 9, terminal: true, updatedAt: 12 }),
    });
    expect(replayed).toBe(applied);
    expect(replayed.operation?.revision).toBe(revision);
    expect(replayed.operation?.applied?.appliedRevision).toBe(8);
  });

  it("expires an operation the host no longer has while keeping its result viewable", () => {
    const candidateState = withCandidate("keep me");
    const expired = reduceComposerOperation(candidateState, {
      type: "reconcile",
      status: hostStatus({ state: "expired", revision: 9, terminal: true, updatedAt: 12 }),
    });
    expect(expired.operation?.status).toBe("expired");
    expect(expired.operation?.candidate?.text).toBe("keep me");
    const derived = deriveComposerOperation(expired);
    expect(derived.canApply).toBe(false);
    expect(derived.candidateText).toBe("keep me");
  });

  it("adopts a live host operation with an unknown base so an auto-apply refuses", () => {
    let state = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      { type: "descriptor", snapshot: snapshot(BASE_CONTRIBUTIONS) },
    );
    state = reduceComposerOperation(state, {
      type: "adopt",
      binding: BINDING,
      requestId: "req-adopted",
      operationId: "op-adopted",
      ownerId: OWNER,
      controlId: "alpha-composer",
      state: "candidate",
      revision: 7,
      updatedAt: 20,
      candidate: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-adopted",
        operationId: "op-adopted",
        candidateRevision: 7,
        text: "adopted candidate",
        at: 19,
      },
    });
    expect(state.operation?.status).toBe("candidate");
    expect(state.operation?.baseRevision).toBe(0);
    expect(state.operation?.baseAttachmentRevision).toBe(undefined);
    expect(state.operation?.candidate?.text).toBe("adopted candidate");
  });
});

describe("invalidations are cancellations", () => {
  it("treats a policy/trust invalidation as cancellation, never an applicable result", () => {
    const candidateState = withCandidate("cached result");
    const invalidated = reduceComposerOperation(candidateState, {
      type: "invalidate",
      kind: "invalidated",
      message: "The project trust decision changed.",
    });
    expect(invalidated.operation?.status).toBe("cancelled");
    expect(invalidated.operation?.conflict?.kind).toBe("invalidated");
    expect(invalidated.operation?.candidate?.text).toBe("cached result");
    const derived = deriveComposerOperation(invalidated);
    expect(derived.canApply).toBe(false);
    expect(derived.hasCandidate).toBe(false);

    // An already applied operation is never rolled back by an invalidation.
    const applied = reduceComposerOperation(candidateState, {
      type: "applied",
      operationId: "op-1",
      appliedRevision: 8,
      disposition: "replaced",
      appliedAt: 4,
    });
    const after = reduceComposerOperation(applied, {
      type: "invalidate",
      message: "a late revocation",
    });
    expect(after).toBe(applied);
  });

  it("cancels live work when the publisher withdraws the control", () => {
    const candidateState = withCandidate("recoverable");
    const withdrawn = reduceComposerOperation(candidateState, {
      type: "descriptor",
      snapshot: snapshot([action("toggle", "prompt-toggle"), action("transform")], { revision: 2 }),
    });
    expect(withdrawn.operation?.status).toBe("cancelled");
    expect(deriveComposerOperation(withdrawn).conflict?.kind).toBe("publisher-withdrawn");
    expect(withdrawn.operation?.candidate?.text).toBe("recoverable");
    expect(deriveComposerOperation(withdrawn).canApply).toBe(false);
  });
});
