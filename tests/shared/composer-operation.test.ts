import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COMPOSER_TRANSFORM_CONTRACT,
  type ComposerControlContribution,
} from "../../src/shared/composer-transform";
import {
  composerTabOperation,
  createComposerOperationRegistry,
  deriveComposerOperation,
  dropComposerOperationTab,
  projectComposerControls,
  reduceComposerOperation,
  reduceComposerOperationForTab,
} from "../../src/shared/composer-operation";
import {
  buildContributionSnapshot,
  type ContributionSnapshot,
  type ContributionView,
} from "../../src/shared/extension-contributions-view";
import type { ActionContribution, Contribution } from "../../src/shared/extension-contributions";

/**
 * Renderer-safe composer-control projection and per-tab operation reducer
 * (prompt-refinement row 16). The generic runtime must behave for any publisher:
 * no extension name, status-string parsing or chat-run coupling is allowed.
 */

const OWNER = "alpha.ext";
const OTHER = "beta.ext";
const PUBLIC_COMMAND = "prompt";

function control(
  id = "alpha-composer",
  over: Partial<ComposerControlContribution> = {},
): ComposerControlContribution {
  return {
    id,
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
      publicCommand: PUBLIC_COMMAND,
      companionCommand: "prompt-companion",
    },
    ...over,
  };
}

function action(id: string, name = PUBLIC_COMMAND): ActionContribution {
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

function status(text: string): Contribution {
  return { id: "status", kind: "status", slot: "status", text, tone: "neutral", order: 0 };
}

function snapshot(
  contributions: Contribution[],
  over: { ownerId?: string; epoch?: number; revision?: number } = {},
): ContributionSnapshot {
  return buildContributionSnapshot(
    [
      {
        ownerId: over.ownerId ?? OWNER,
        epoch: over.epoch ?? 0,
        revision: over.revision ?? 1,
        contributions,
      },
    ],
    { supported: true, updatedAt: 10 },
  );
}

const BASE_CONTRIBUTIONS: Contribution[] = [
  control(),
  action("toggle", "prompt-toggle"),
  action("transform"),
];

const BINDING = {
  sessionId: "session-1",
  epoch: 1,
  bindingId: "binding-1",
  hostGeneration: 7,
};

function armedControlView(source: ContributionSnapshot): ContributionView {
  const projected = projectComposerControls(source);
  const first = projected.controls[0];
  if (!first) throw new Error("expected a projected control");
  return {
    ownerId: first.ownerId,
    id: first.id,
    kind: "composer-control",
    slot: "composer-actions",
    tone: "accent",
    order: 0,
    text: first.label,
    checked: first.checked,
    enabled: first.enabled,
    actionRef: first.actionRef,
    transformActionRef: first.transformActionRef,
  };
}

describe("composer-control projection", () => {
  it("projects only typed, same-owner controls and carries the descriptor generation", () => {
    const source = snapshot(BASE_CONTRIBUTIONS, { revision: 7 });
    const projected = projectComposerControls(source);
    expect(projected.rejected).toEqual([]);
    expect(projected.controls).toHaveLength(1);
    expect(projected.controls[0]).toMatchObject({
      ownerId: OWNER,
      id: "alpha-composer",
      label: "Refine prompt",
      icon: "sparkles",
      behavior: "one-shot-return",
      actionRef: "toggle",
      transformActionRef: "transform",
      transformCommand: PUBLIC_COMMAND,
      descriptorGeneration: { ownerId: OWNER, epoch: 0, revision: 7 },
    });
    // The renderer projection carries no executable or operation metadata: the
    // advertised command is a bounded name that the host still re-resolves.
    const serialized = JSON.stringify(projected.controls[0]);
    expect(projected.controls[0]).not.toHaveProperty("operation");
    expect(projected.controls[0]).not.toHaveProperty("command");
    expect(serialized).not.toContain("prompt-companion");
    expect(serialized).not.toContain("args");

    expect(projected.descriptorGenerations).toEqual([{ ownerId: OWNER, epoch: 0, revision: 7 }]);
  });

  it("projects the transform action's advertised command, but never a collision suffix", () => {
    const advertised = projectComposerControls(snapshot(BASE_CONTRIBUTIONS));
    expect(advertised.controls[0]?.transformCommand).toBe(PUBLIC_COMMAND);

    // An SDK collision invocation name (`prompt:2`) is not the publisher's
    // declared command; matching it would refine text addressed to another
    // extension, so it is not projected at all.
    const suffixed = projectComposerControls(
      snapshot([control(), action("toggle", "prompt-toggle"), action("transform", "prompt:2")]),
    );
    expect(suffixed.controls).toHaveLength(1);
    expect(suffixed.controls[0]).not.toHaveProperty("transformCommand");
  });

  it("rejects a cross-owner reference instead of borrowing another publisher's action", () => {
    const shared = buildContributionSnapshot(
      [
        {
          ownerId: OWNER,
          epoch: 0,
          revision: 2,
          contributions: [control("cross", { actionRef: "other-toggle" })],
        },
        {
          ownerId: OTHER,
          epoch: 0,
          revision: 1,
          contributions: [action("other-toggle", "other-command")],
        },
      ],
      { supported: true, updatedAt: 10 },
    );
    const projected = projectComposerControls(shared);
    expect(projected.controls).toEqual([]);
    expect(projected.rejected).toEqual([{ ownerId: OWNER, id: "cross", reason: "foreign-action" }]);
  });

  it("drops a dangling or non-action reference rather than inventing a command", () => {
    const dangling = projectComposerControls(
      snapshot([control("gone", { transformActionRef: "missing" }), action("toggle")]),
    );
    expect(dangling.controls).toEqual([]);
    expect(dangling.rejected[0]?.reason).toBe("missing-transform-action");

    const wrongKind = projectComposerControls(
      snapshot([control("wrong", { actionRef: "status" }), status("here"), action("transform")]),
    );
    expect(wrongKind.controls).toEqual([]);
    expect(wrongKind.rejected[0]?.reason).toBe("missing-toggle-action");
  });

  it("drops a control with no published owner generation", () => {
    const forged = {
      version: 1,
      supported: true,
      owners: [],
      contributions: [armedControlView(snapshot(BASE_CONTRIBUTIONS))],
      updatedAt: 1,
    } as ContributionSnapshot;
    expect(projectComposerControls(forged).controls).toEqual([]);
    expect(projectComposerControls(forged).rejected[0]?.reason).toBe("unknown-generation");
  });
});

describe("per-tab operation reducer", () => {
  it("walks eligible -> armed -> running -> awaiting-input -> candidate -> applied", () => {
    let state = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      { type: "descriptor", snapshot: snapshot(BASE_CONTRIBUTIONS) },
    );
    expect(deriveComposerOperation(state).uiState).toBe("eligible");

    const controlView = armedControlView(snapshot(BASE_CONTRIBUTIONS));
    state = reduceComposerOperation(state, {
      type: "arm",
      ownerId: OWNER,
      controlId: controlView.id,
      armed: true,
    });
    expect(deriveComposerOperation(state).uiState).toBe("armed");

    state = reduceComposerOperation(state, { type: "binding", binding: BINDING });
    const generation = state.projection.controls[0]!.descriptorGeneration;
    state = reduceComposerOperation(state, {
      type: "start",
      requestId: "req-1",
      ownerId: OWNER,
      controlId: controlView.id,
      binding: BINDING,
      descriptorGeneration: generation,
      baseRevision: 1,
    });
    expect(deriveComposerOperation(state).uiState).toBe("running");

    state = reduceComposerOperation(state, {
      type: "started",
      receipt: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        status: "started",
        binding: BINDING,
        startedAt: 20,
      },
    });
    state = reduceComposerOperation(state, {
      type: "progress",
      progress: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        state: "awaiting-input",
        message: "one question",
        at: 21,
      },
    });
    const awaiting = deriveComposerOperation(state);
    expect(awaiting.uiState).toBe("awaiting-input");
    expect(awaiting.isAwaitingInput).toBe(true);

    state = reduceComposerOperation(state, {
      type: "candidate",
      candidate: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        candidateRevision: 3,
        text: "refined draft",
        at: 22,
      },
    });
    const candidate = deriveComposerOperation(state);
    expect(candidate.uiState).toBe("candidate");
    expect(candidate.hasCandidate).toBe(true);
    expect(candidate.canApply).toBe(true);
    expect(candidate.candidateText).toBe("refined draft");

    state = reduceComposerOperation(state, {
      type: "applied",
      operationId: "op-1",
      appliedRevision: 3,
      disposition: "replaced",
      appliedAt: 23,
    });
    const applied = deriveComposerOperation(state);
    expect(applied.uiState).toBe("eligible");
    expect(applied.armed).toEqual([]);
    expect(applied.hasCandidate).toBe(false);
    expect(state.operation?.status).toBe("applied");
  });

  it("conflicts an active operation when its publisher withdraws, keeping the candidate", () => {
    let state = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      {
        type: "descriptor",
        snapshot: snapshot([
          control("alpha-composer", { checked: true }),
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
      baseRevision: 1,
    });
    state = reduceComposerOperation(state, {
      type: "started",
      receipt: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        status: "started",
        binding: BINDING,
        startedAt: 20,
      },
    });
    state = reduceComposerOperation(state, {
      type: "candidate",
      candidate: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        candidateRevision: 2,
        text: "recoverable draft",
        at: 21,
      },
    });

    // The publisher republishes without the control.
    state = reduceComposerOperation(state, {
      type: "descriptor",
      snapshot: snapshot([status("publisher went away")], { revision: 2 }),
    });
    const derived = deriveComposerOperation(state);
    expect(derived.isConflict).toBe(true);
    expect(derived.conflict?.kind).toBe("publisher-withdrawn");
    expect(derived.hasCandidate).toBe(false);
    expect(derived.canApply).toBe(false);
    // The candidate stays recoverable in the record.
    expect(state.operation?.candidate?.text).toBe("recoverable draft");
  });

  it("refuses multiple armed controls instead of picking one arbitrarily", () => {
    const two = snapshot([
      control("first", { checked: true }),
      control("second", { checked: true }),
      action("toggle", "prompt-toggle"),
      action("transform"),
    ]);
    const state = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      { type: "descriptor", snapshot: two },
    );
    const derived = deriveComposerOperation(state);
    expect(derived.armed).toHaveLength(2);
    expect(derived.armedControl).toBe(null);
    expect(derived.uiState).toBe("conflict");
    expect(derived.conflict?.kind).toBe("multiple-armed");
    expect(derived.canStart).toBe(false);

    const started = reduceComposerOperation(state, {
      type: "start",
      requestId: "req-1",
      ownerId: OWNER,
      controlId: "first",
      binding: BINDING,
      descriptorGeneration: state.projection.controls[0]!.descriptorGeneration,
      baseRevision: 1,
    });
    expect(started.operation).toBe(null);
    expect(deriveComposerOperation(started).conflict?.kind).toBe("multiple-armed");
  });

  it("keeps a control disabled when the publisher reports no live capability", () => {
    // `enabled:false` is the publisher saying the capability is absent (no live
    // model/tool/action). It may stay `checked` (that is how Send refuses
    // honestly instead of dispatching the raw prompt), but it is never eligible
    // and can never start an operation (prompt-refinement plan step 29).
    const disabled = snapshot([
      control("alpha-composer", { enabled: false, checked: true, disabledReason: "Needs vision" }),
      action("toggle", "prompt-toggle"),
      action("transform"),
    ]);
    let state = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      { type: "descriptor", snapshot: disabled },
    );
    const derived = deriveComposerOperation(state);
    expect(derived.eligible).toEqual([]);
    expect(derived.armed).toHaveLength(1);
    expect(derived.armedControl?.enabled).toBe(false);
    expect(derived.uiState).toBe("armed");
    expect(derived.canStart).toBe(false);

    // An explicit arm is refused instead of remembered.
    state = reduceComposerOperation(state, {
      type: "arm",
      ownerId: OWNER,
      controlId: "alpha-composer",
      armed: true,
    });
    expect(state.armedOverrides).toEqual({});
    expect(deriveComposerOperation(state).canStart).toBe(false);

    // A typed start cannot manufacture a running operation either.
    const started = reduceComposerOperation(state, {
      type: "start",
      requestId: "req-1",
      ownerId: OWNER,
      controlId: "alpha-composer",
      binding: BINDING,
      descriptorGeneration: state.projection.controls[0]!.descriptorGeneration,
      baseRevision: 1,
    });
    expect(started.operation).toBe(null);
    expect(started.conflict?.kind).toBe("invalid-control");
  });

  it("never parses status text or labels for operation state", () => {
    const misleading = snapshot([
      control("alpha-composer", { checked: false }),
      action("toggle", "prompt-toggle"),
      action("transform"),
      status("running awaiting-input candidate applied"),
    ]);
    const state = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      { type: "descriptor", snapshot: misleading },
    );
    expect(deriveComposerOperation(state).uiState).toBe("eligible");
    expect(state.operation).toBe(null);

    // A status row changing later cannot manufacture a candidate either.
    const withCandidateProse = reduceComposerOperation(state, {
      type: "descriptor",
      snapshot: snapshot(
        [
          control(),
          action("toggle", "prompt-toggle"),
          action("transform"),
          status("candidate ready: refined draft"),
        ],
        { revision: 2 },
      ),
    });
    expect(deriveComposerOperation(withCandidateProse).hasCandidate).toBe(false);
  });

  it("fences a republished descriptor and a rebound binding", () => {
    const startState = (() => {
      let state = reduceComposerOperation(
        composerTabOperation(createComposerOperationRegistry(), "tab-1"),
        {
          type: "descriptor",
          snapshot: snapshot([
            control("alpha-composer", { checked: true }),
            action("toggle", "prompt-toggle"),
            action("transform"),
          ]),
        },
      );
      state = reduceComposerOperation(state, { type: "binding", binding: BINDING });
      return reduceComposerOperation(state, {
        type: "start",
        requestId: "req-1",
        ownerId: OWNER,
        controlId: "alpha-composer",
        binding: BINDING,
        descriptorGeneration: state.projection.controls[0]!.descriptorGeneration,
        baseRevision: 1,
      });
    })();

    const republished = reduceComposerOperation(startState, {
      type: "descriptor",
      snapshot: snapshot(
        [
          control("alpha-composer", { checked: true }),
          action("toggle", "prompt-toggle"),
          action("transform"),
          status("revised"),
        ],
        { revision: 2 },
      ),
    });
    expect(deriveComposerOperation(republished).conflict?.kind).toBe("stale-descriptor");

    const rebound = reduceComposerOperation(startState, {
      type: "binding",
      binding: { ...BINDING, hostGeneration: 8 },
    });
    expect(deriveComposerOperation(rebound).conflict?.kind).toBe("stale-binding");
  });

  it("ignores old, unknown and duplicate frames without changing state", () => {
    const base = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      { type: "descriptor", snapshot: snapshot(BASE_CONTRIBUTIONS) },
    );
    expect(reduceComposerOperation(base, null)).toBe(base);
    expect(reduceComposerOperation(base, { type: "legacy-frame", payload: 1 })).toBe(base);
    expect(reduceComposerOperation(base, { type: "progress", progress: { state: "???" } })).toBe(
      base,
    );
    expect(reduceComposerOperation(base, "not-an-object")).toBe(base);
    expect(reduceComposerOperation(base, { type: "descriptor", snapshot: { version: 9 } })).toBe(
      base,
    );

    let state = reduceComposerOperation(base, { type: "binding", binding: BINDING });
    state = reduceComposerOperation(state, {
      type: "arm",
      ownerId: OWNER,
      controlId: "alpha-composer",
      armed: true,
    });
    state = reduceComposerOperation(state, {
      type: "start",
      requestId: "req-1",
      ownerId: OWNER,
      controlId: "alpha-composer",
      binding: BINDING,
      descriptorGeneration: state.projection.controls[0]!.descriptorGeneration,
      baseRevision: 1,
    });
    state = reduceComposerOperation(state, {
      type: "started",
      receipt: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        status: "started",
        binding: BINDING,
        startedAt: 20,
      },
    });
    state = reduceComposerOperation(state, {
      type: "applied",
      operationId: "op-1",
      appliedRevision: 2,
      disposition: "replaced",
      appliedAt: 21,
    });
    // A duplicate apply receipt cannot apply twice or revive a newer operation.
    expect(
      reduceComposerOperation(state, {
        type: "applied",
        operationId: "op-1",
        appliedRevision: 2,
        disposition: "replaced",
        appliedAt: 21,
      }),
    ).toBe(state);

    const staleReceipt = reduceComposerOperation(state, {
      type: "progress",
      progress: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        state: "running",
        at: 22,
      },
    });
    expect(staleReceipt.operation?.status).toBe("applied");
  });

  it("explicit toggle-off cancels and disarms without applying the candidate", () => {
    let state = reduceComposerOperation(
      composerTabOperation(createComposerOperationRegistry(), "tab-1"),
      {
        type: "descriptor",
        snapshot: snapshot([
          control("alpha-composer", { checked: true }),
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
      baseRevision: 1,
    });
    state = reduceComposerOperation(state, {
      type: "started",
      receipt: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-1",
        operationId: "op-1",
        status: "started",
        binding: BINDING,
        startedAt: 20,
      },
    });
    state = reduceComposerOperation(state, {
      type: "arm",
      ownerId: OWNER,
      controlId: "alpha-composer",
      armed: false,
    });
    expect(state.operation?.status).toBe("cancelled");
    const derived = deriveComposerOperation(state);
    expect(derived.armed).toEqual([]);
    expect(derived.canApply).toBe(false);
  });

  it("keeps tabs isolated and drops one tab on close", () => {
    let registry = createComposerOperationRegistry();
    registry = reduceComposerOperationForTab(registry, "tab-1", {
      type: "descriptor",
      snapshot: snapshot(BASE_CONTRIBUTIONS),
    });
    registry = reduceComposerOperationForTab(registry, "tab-2", {
      type: "binding",
      binding: { ...BINDING, bindingId: "binding-2" },
    });
    expect(composerTabOperation(registry, "tab-1").binding).toBe(null);
    expect(composerTabOperation(registry, "tab-2").binding?.bindingId).toBe("binding-2");

    const dropped = dropComposerOperationTab(registry, "tab-1");
    expect(dropped.tabs["tab-1"]).toBe(undefined);
    expect(dropped.tabs["tab-2"]).not.toBe(undefined);
    // Unknown tabs and unknown frames are harmless.
    expect(reduceComposerOperationForTab(dropped, "tab-3", null)).toBe(dropped);
  });
});

describe("generic runtime has no extension identifiers", () => {
  function withoutComments(path: string): string {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  it("never branches on a publisher name in the projection or reducer", () => {
    for (const path of [
      "../../src/shared/composer-operation.ts",
      "../../src/shared/extension-contributions-view.ts",
    ]) {
      expect(withoutComments(path).toLowerCase()).not.toContain("workflow");
    }
  });
});
