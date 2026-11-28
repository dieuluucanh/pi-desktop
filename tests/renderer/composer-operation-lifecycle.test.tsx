import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildContributionSnapshot,
  type ContributionSnapshot,
} from "../../src/shared/extension-contributions-view";
import type { ActionContribution, Contribution } from "../../src/shared/extension-contributions";
import {
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_EVENTS,
  type ComposerControlContribution,
  type ComposerTransformStartRequest,
} from "../../src/shared/composer-transform";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import {
  composerOperationDerivedFor,
  liveComposerOperationFor,
  useAppStore,
} from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * Composer-operation lifecycle (2026-11-22 prompt-refinement plan, row 22).
 *
 * A refinement is not a chat run: progress and results arrive as typed host
 * frames and are reduced into the tab's operation state, never into the
 * transcript. Esc/Stop reach the live refinement first (and never pause an
 * unrelated Review), a repeated key/click is consumed exactly once, and only an
 * applied receipt or an explicit toggle-off disarms.
 */

const OWNER = "refine.ext";
const TAB = "tab-1";
const REQUEST_ID = "req-alpha-0001";
const OPERATION_ID = "op-1";

function composerControl(
  over: Partial<ComposerControlContribution> = {},
): ComposerControlContribution {
  return {
    id: "refine",
    kind: "composer-control",
    slot: "composer-actions",
    tone: "accent",
    order: 0,
    label: "Refine prompt",
    description: "Returns a refined draft; never runs it.",
    icon: "sparkles",
    checked: true,
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

function action(id: string): ActionContribution {
  return {
    id,
    kind: "action",
    slot: "action",
    label: `Run ${id}`,
    tone: "neutral",
    order: 0,
    command: { name: "prompt" },
    enabled: true,
  };
}

function contributions(
  control: ComposerControlContribution | null = composerControl(),
): ContributionSnapshot {
  const list: Contribution[] = [
    ...(control ? [control] : []),
    action("toggle"),
    action("transform"),
  ];
  return buildContributionSnapshot(
    [{ ownerId: OWNER, epoch: 0, revision: 1, contributions: list }],
    {
      supported: true,
      updatedAt: 1,
    },
  );
}

function tab(status: TabRecord["status"] = "idle"): TabRecord {
  return {
    id: TAB,
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status,
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function startedReceipt(input: unknown): unknown {
  const request = input as ComposerTransformStartRequest;
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: request.requestId,
    operationId: OPERATION_ID,
    status: "started",
    binding: request.binding,
    startedAt: 1_700_000_000_000,
  };
}

interface StubOptions {
  snapshot?: ContributionSnapshot;
  cancel?: (input: unknown) => unknown;
  current?: (input: unknown) => unknown;
}

function stubRequest(options: StubOptions = {}) {
  const snapshot = options.snapshot ?? contributions();
  let cancelCalls = 0;
  let appliedCalls = 0;
  let transformCalls = 0;
  let currentCalls = 0;
  const methods: string[] = [];
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    methods.push(input.method);
    if (input.method === "contributions.state") {
      return useAppStore.getState().contributions[TAB] ?? snapshot;
    }
    if (input.method === "composer.transform") {
      transformCalls += 1;
      return startedReceipt(input.params);
    }
    if (input.method === "composer.current") {
      currentCalls += 1;
      if (options.current) return options.current(input.params);
      const params = input.params as { binding: unknown };
      return {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        binding: params.binding,
        operation: null,
      };
    }
    if (input.method === "composer.cancel") {
      cancelCalls += 1;
      const params = input.params as { requestId: string; operationId: string };
      if (options.cancel) return options.cancel(input.params);
      return {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: params.requestId,
        operationId: params.operationId,
        state: "cancelled",
        at: 1,
      };
    }
    if (input.method === "composer.applied") {
      appliedCalls += 1;
      return input.params;
    }
    if (input.method === "contributions.run") return { ran: true };
    return {};
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return {
    request,
    methods: () => [...methods],
    cancelCalls: () => cancelCalls,
    appliedCalls: () => appliedCalls,
    transformCalls: () => transformCalls,
    currentCalls: () => currentCalls,
  };
}

function resetStore(over: Record<string, unknown> = {}): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: TAB,
    transcripts: {},
    sessionStates: { [TAB]: { sessionId: "session-1" } },
    sessionEpochs: { [TAB]: 1 },
    contributions: { [TAB]: contributions() },
    composerDrafts: {},
    composerOperations: {},
    composerApplyReceipts: {},
    draftHistory: {},
    historyBrowse: {},
    pasteBodies: {},
    pasteCounter: 1,
    hint: null,
    ...over,
  });
}

function emit(event: string, payload: unknown): void {
  useAppStore.getState().applySessionEvents({
    tabId: TAB,
    seq: 1,
    sessionEpoch: 1,
    events: [{ event, payload, sessionEpoch: 1 }],
  });
}

async function startRefinement(text = "please fix it"): Promise<void> {
  useAppStore.getState().setDraft(TAB, text);
  await useAppStore.getState().sendPrompt(TAB, text);
  // The started receipt may open the host's bootstrap asynchronously.
  await Promise.resolve();
}

function progress(
  over: Partial<{ state: string; phase: string; message: string }> = {},
): Record<string, unknown> {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    state: "running",
    at: 1,
    ...over,
  };
}

function candidate(text = "Please fix the parser.", revision = 2): Record<string, unknown> {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    candidateRevision: revision,
    text,
    summary: "Clarified the request.",
    at: 2,
  };
}

beforeEach(() => {
  installBridge();
  resetStore();
});

describe("operation progress", () => {
  it("shows the stage and effective model without touching the transcript", async () => {
    stubRequest();
    await startRefinement();
    const before = useAppStore.getState().transcripts[TAB]?.items ?? [];

    emit(
      COMPOSER_TRANSFORM_EVENTS.progress,
      progress({ phase: "inspection", message: "test/model · inspecting the repository (grep)" }),
    );

    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    expect(derived.isRunning).toBe(true);
    expect(derived.stage).toBe("inspection");
    expect(derived.statusMessage).toContain("test/model");
    // A refinement frame never becomes a synthetic user/assistant turn and
    // never borrows the run status.
    expect(useAppStore.getState().transcripts[TAB]?.items ?? []).toEqual(before);
    expect(useAppStore.getState().tabs[0]?.status).toBe("idle");
    expect(useAppStore.getState().tabs[0]?.status).not.toBe("running");
  });

  it("reports awaiting-input while the extension question owns the overlay", async () => {
    stubRequest();
    await startRefinement();
    emit(
      COMPOSER_TRANSFORM_EVENTS.progress,
      progress({ state: "awaiting-input", phase: "question", message: "with test/model" }),
    );
    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    expect(derived.isAwaitingInput).toBe(true);
    expect(derived.canCancel).toBe(true);
  });
});

describe("candidate apply", () => {
  it("applies one candidate to the captured draft, keeps attachments and disarms once", async () => {
    const stub = stubRequest();
    useAppStore
      .getState()
      .addDraftImages(TAB, [
        { id: "image-1", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ]);
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.result, candidate());

    const state = useAppStore.getState();
    expect(state.prefs.drafts[TAB]).toBe("Please fix the parser.");
    expect(state.draftSnapshot(TAB).attachments.map((entry) => entry.id)).toEqual(["image-1"]);
    expect(state.composerApplyReceipts[TAB]?.map((entry) => entry.operationId)).toEqual([
      OPERATION_ID,
    ]);
    expect(stub.appliedCalls()).toBe(1);
    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    // The operation settled and disarmed; the control stays available for a
    // later explicit arm.
    expect(derived.uiState).toBe("eligible");
    expect(derived.armed).toHaveLength(0);
    expect(derived.isRunning).toBe(false);

    // A replayed result frame cannot apply twice or send a second receipt.
    emit(COMPOSER_TRANSFORM_EVENTS.result, candidate());
    expect(stub.appliedCalls()).toBe(1);
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("Please fix the parser.");
  });

  it("keeps a stale candidate recoverable instead of overwriting newer typing", async () => {
    const stub = stubRequest();
    await startRefinement();
    // The user keeps typing while the refiner works.
    useAppStore.getState().setDraft(TAB, "newer text");
    emit(COMPOSER_TRANSFORM_EVENTS.result, candidate());

    const state = useAppStore.getState();
    expect(state.prefs.drafts[TAB]).toBe("newer text");
    expect(stub.appliedCalls()).toBe(0);
    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    expect(derived.candidateText).toBe("Please fix the parser.");
    expect(derived.originalText).toBe("please fix it");
    expect(derived.isConflict).toBe(true);
    expect(derived.conflict?.kind).toBe("stale-base");
    // Failure/conflict keeps the one-shot toggle armed for a retry.
    expect(derived.armed).toHaveLength(1);
  });

  it("explicit replace applies the kept candidate against the live confirmed revision", async () => {
    const stub = stubRequest();
    await startRefinement();
    useAppStore.getState().setDraft(TAB, "newer text");
    emit(COMPOSER_TRANSFORM_EVENTS.result, candidate());

    const outcome = await useAppStore.getState().replaceComposerCandidate(TAB);
    expect(outcome?.status).toBe("applied");
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("Please fix the parser.");
    expect(stub.appliedCalls()).toBe(1);
    expect(composerOperationDerivedFor(useAppStore.getState(), TAB).armed).toHaveLength(0);
  });
});

describe("cancellation ownership", () => {
  it("Esc cancels the live refinement and never reaches the Review/terminal path", async () => {
    const stub = stubRequest();
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    await useAppStore.getState().interruptRun(TAB);

    expect(stub.cancelCalls()).toBe(1);
    expect(stub.methods()).not.toContain("tui.input");
    expect(stub.methods()).not.toContain("abort");
    expect(liveComposerOperationFor(useAppStore.getState(), TAB)).toBeUndefined();
    // Cancellation is not a disarm.
    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    expect(derived.armed).toHaveLength(1);
  });

  it("a double Esc sends exactly one cancel", async () => {
    const stub = stubRequest();
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    await Promise.all([
      useAppStore.getState().interruptRun(TAB),
      useAppStore.getState().interruptRun(TAB),
    ]);
    await useAppStore.getState().interruptRun(TAB);

    expect(stub.cancelCalls()).toBe(1);
    expect(stub.methods().filter((method) => method === "tui.input")).toHaveLength(0);
  });

  it("Stop cancels the refinement instead of clearing the queue and aborting", async () => {
    const stub = stubRequest();
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ state: "awaiting-input" }));

    await useAppStore.getState().stopRun(TAB);

    expect(stub.cancelCalls()).toBe(1);
    expect(stub.methods()).not.toContain("abort");
    expect(stub.methods()).not.toContain("clearQueue");
  });

  it("cancel during bootstrap settles locally without inventing a host operation id", async () => {
    const stub = stubRequest({
      // The started receipt never arrives: the operation stays in `starting`.
    });
    useAppStore.getState().setDraft(TAB, "please fix it");
    // Start without awaiting the host round-trip by reducing the local start
    // event the store emits before `composer.transform`.
    const transform = useAppStore.getState().sendPrompt(TAB, "please fix it");
    await Promise.resolve();
    // With the receipt already applied the host id exists; the bootstrap case
    // is the frame before it, so reduce that state directly.
    useAppStore.getState().applyComposerOperationEvent(TAB, {
      type: "start",
      requestId: "req-bootstrap",
      ownerId: OWNER,
      controlId: "refine",
      baseRevision: useAppStore.getState().draftSnapshot(TAB).revision,
      baseAttachmentRevision: useAppStore.getState().draftSnapshot(TAB).attachmentRevision,
      binding: {
        sessionId: "session-1",
        epoch: 1,
        bindingId: "tab:tab-1",
        hostGeneration: 1,
      },
      descriptorGeneration: { ownerId: OWNER, epoch: 0, revision: 1 },
    });
    expect(liveComposerOperationFor(useAppStore.getState(), TAB)?.operationId).toBeUndefined();
    await useAppStore.getState().interruptRun(TAB);
    expect(stub.cancelCalls()).toBe(0);
    expect(liveComposerOperationFor(useAppStore.getState(), TAB)).toBeUndefined();
    await transform;
  });

  it("a late result after cancellation is ignored", async () => {
    const stub = stubRequest();
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));
    await useAppStore.getState().interruptRun(TAB);
    emit(COMPOSER_TRANSFORM_EVENTS.result, candidate());

    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("please fix it");
    expect(stub.appliedCalls()).toBe(0);
    expect(composerOperationDerivedFor(useAppStore.getState(), TAB).candidateText).toBe(null);
  });

  it("a failed cancel is still consumed and never aborts an unrelated run", async () => {
    const stub = stubRequest({
      cancel: () => {
        throw new Error("host went away");
      },
    });
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    await useAppStore.getState().interruptRun(TAB);

    expect(stub.cancelCalls()).toBe(1);
    expect(stub.methods()).not.toContain("tui.input");
    expect(stub.methods()).not.toContain("abort");
    expect(useAppStore.getState().hint).toMatch(/could not be cancelled/);
  });

  it("Review-style input stays untouched when no refinement is live", async () => {
    const stub = stubRequest();
    resetStore({ tabs: [tab("running")] });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = stub.request;

    await useAppStore.getState().interruptRun(TAB);

    expect(stub.cancelCalls()).toBe(0);
    expect(stub.methods()).toContain("tui.input");
  });
});

describe("renderer/host lifecycle reconciliation (plan step 23)", () => {
  function currentOperation(over: Record<string, unknown> = {}) {
    return {
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      ownerId: OWNER,
      controlId: "refine",
      state: "running",
      revision: 3,
      updatedAt: 5,
      ...over,
    };
  }

  it("adopts a live operation after a reload instead of starting a second one", async () => {
    const stub = stubRequest({
      current: (input) => ({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        binding: (input as { binding: unknown }).binding,
        operation: currentOperation(),
      }),
    });
    // A fresh renderer lost the operation record but kept the draft.
    useAppStore.getState().setDraft(TAB, "please fix it");

    const live = await useAppStore.getState().reconcileComposerOperation(TAB);
    expect(live).toBe(true);
    expect(stub.currentCalls()).toBe(1);
    expect(stub.transformCalls()).toBe(0);
    expect(useAppStore.getState().composerOperations[TAB]?.operation?.operationId).toBe(
      OPERATION_ID,
    );
    expect(composerOperationDerivedFor(useAppStore.getState(), TAB).isRunning).toBe(true);

    // Send still refuses to mint a second provider call for the same composer.
    await useAppStore.getState().sendPrompt(TAB, "please fix it");
    expect(stub.transformCalls()).toBe(0);
    expect(useAppStore.getState().prefs.drafts[TAB] ?? "please fix it").toBe("please fix it");
  });

  it("adopts a live candidate but never auto-inserts it over the reloaded draft", async () => {
    const stub = stubRequest({
      current: (input) => ({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        binding: (input as { binding: unknown }).binding,
        operation: currentOperation({
          state: "candidate",
          revision: 5,
          candidate: {
            candidateRevision: 5,
            text: "Adopted refined prompt.",
            summary: "recovered",
            at: 4,
          },
        }),
      }),
    });
    useAppStore.getState().setDraft(TAB, "reloaded draft");

    await useAppStore.getState().reconcileComposerOperation(TAB);
    expect(stub.transformCalls()).toBe(0);
    emit(COMPOSER_TRANSFORM_EVENTS.result, {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      candidateRevision: 5,
      text: "Adopted refined prompt.",
      summary: "recovered",
      at: 4,
    });

    // The reload lost the captured base, so the candidate is recoverable but
    // the draft is untouched (one explicit replace remains possible).
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("reloaded draft");
    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    expect(derived.candidateText).toBe("Adopted refined prompt.");
    expect(derived.conflict?.kind).toBe("stale-base");
    expect(stub.appliedCalls()).toBe(0);
  });

  it("expires a lost host operation without restarting it or touching the draft", async () => {
    const stub = stubRequest();
    await startRefinement();
    useAppStore
      .getState()
      .addDraftImages(TAB, [
        { id: "image-1", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ]);
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    // The host restarted and knows nothing about this operation.
    const before = stub.currentCalls();
    const live = await useAppStore.getState().reconcileComposerOperation(TAB);
    expect(live).toBe(false);
    expect(stub.currentCalls()).toBe(before + 1);
    expect(stub.transformCalls()).toBe(1);
    expect(useAppStore.getState().composerOperations[TAB]?.operation?.status).toBe("expired");
    // The draft and in-memory attachments survive the host loss.
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("please fix it");
    expect(
      useAppStore
        .getState()
        .draftSnapshot(TAB)
        .attachments.map((entry) => entry.id),
    ).toEqual(["image-1"]);
  });

  it("replays an applied-but-ack-lost receipt once and never replaces the draft twice", async () => {
    const stub = stubRequest();
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.result, candidate());
    expect(stub.appliedCalls()).toBe(1);
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("Please fix the parser.");

    // Reconciliation finds the operation terminal on the host and replays the
    // idempotent receipt; the applied text is not written again.
    await useAppStore.getState().reconcileComposerOperation(TAB);
    await useAppStore.getState().recoverComposerAppliedReceipts(TAB);
    expect(stub.appliedCalls()).toBe(2);
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("Please fix the parser.");
    expect(useAppStore.getState().composerApplyReceipts[TAB]).toHaveLength(1);

    // The bounded replay memory makes a second recovery a no-op.
    await useAppStore.getState().recoverComposerAppliedReceipts(TAB);
    expect(stub.appliedCalls()).toBe(2);
  });

  it("cancels on a host restart while keeping draft text and attachments", async () => {
    stubRequest();
    await startRefinement();
    useAppStore
      .getState()
      .addDraftImages(TAB, [
        { id: "image-1", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ]);
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    emit("session.recovered", {});

    const operation = useAppStore.getState().composerOperations[TAB]?.operation;
    expect(operation?.status).toBe("cancelled");
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("please fix it");
    expect(
      useAppStore
        .getState()
        .draftSnapshot(TAB)
        .attachments.map((entry) => entry.id),
    ).toEqual(["image-1"]);
  });

  it("cancels when the publisher withdraws the control", async () => {
    stubRequest();
    await startRefinement();
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    useAppStore.setState({
      contributions: {
        [TAB]: buildContributionSnapshot(
          [
            {
              ownerId: OWNER,
              epoch: 0,
              revision: 2,
              contributions: [action("toggle"), action("transform")],
            },
          ],
          { supported: true, updatedAt: 11 },
        ),
      },
    });
    // The host also pushes the descriptor, which is what fences live work.
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "contributions.state",
      payload: buildContributionSnapshot(
        [
          {
            ownerId: OWNER,
            epoch: 0,
            revision: 2,
            contributions: [action("toggle"), action("transform")],
          },
        ],
        { supported: true, updatedAt: 11 },
      ),
    });

    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    expect(derived.conflict?.kind).toBe("publisher-withdrawn");
    expect(derived.canApply).toBe(false);
    expect(useAppStore.getState().composerOperations[TAB]?.operation?.status).toBe("cancelled");
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("please fix it");
  });

  it("treats a trust decision as cancellation, never an applicable result", async () => {
    stubRequest();
    await startRefinement();
    // Newer typing keeps the candidate recoverable rather than auto-applied.
    useAppStore.getState().setDraft(TAB, "newer text");
    emit(COMPOSER_TRANSFORM_EVENTS.result, candidate());
    const before = useAppStore.getState().prefs.drafts[TAB];

    useAppStore
      .getState()
      .invalidateComposerOperation(
        TAB,
        "invalidated",
        "The project trust decision changed, so this refinement was cancelled.",
      );

    const derived = composerOperationDerivedFor(useAppStore.getState(), TAB);
    expect(derived.canApply).toBe(false);
    expect(derived.candidateText).toBe("Please fix the parser.");
    expect(useAppStore.getState().composerOperations[TAB]?.operation?.status).toBe("cancelled");
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe(before);
  });

  it("cancels a live refinement when the host revokes project trust", async () => {
    stubRequest();
    await startRefinement();
    useAppStore
      .getState()
      .addDraftImages(TAB, [
        { id: "image-1", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ]);
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    emit("project_trust", {
      cwd: "/work/app",
      requiresTrust: true,
      decision: null,
      trusted: false,
      needsPrompt: true,
    });

    const operation = useAppStore.getState().composerOperations[TAB]?.operation;
    expect(operation?.status).toBe("cancelled");
    expect(operation?.conflict?.kind).toBe("invalidated");
    // Draft text and in-memory attachments survive the revocation.
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("please fix it");
    expect(
      useAppStore
        .getState()
        .draftSnapshot(TAB)
        .attachments.map((entry) => entry.id),
    ).toEqual(["image-1"]);
  });

  it("answering a trust prompt invalidates the tab's live refinement", async () => {
    const original = useAppStore.getState().invalidateComposerOperation;
    const invalidate = vi.fn();
    try {
      resetStore({
        invalidateComposerOperation: invalidate,
        trustPrompt: {
          cwd: "/work/app",
          tabId: TAB,
          status: {
            cwd: "/work/app",
            requiresTrust: true,
            decision: null,
            trusted: false,
            needsPrompt: true,
          },
        },
      });
      await useAppStore.getState().answerTrust("never");
      expect(invalidate).toHaveBeenCalledWith(TAB, "invalidated", expect.stringContaining("trust"));
    } finally {
      // `setState` merges: an overridden action would leak into later tests.
      useAppStore.setState({ invalidateComposerOperation: original });
    }
  });

  it("cancels on new/resume/fork/rewind (session replacement) while keeping the draft", async () => {
    stubRequest();
    await startRefinement();
    useAppStore
      .getState()
      .addDraftImages(TAB, [
        { id: "image-1", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ]);
    emit(COMPOSER_TRANSFORM_EVENTS.progress, progress({ phase: "model" }));

    emit("session_replaced", { sessionId: "session-2" });
    const operation = useAppStore.getState().composerOperations[TAB]?.operation;
    expect(operation?.status).toBe("cancelled");
    expect(operation?.conflict?.kind).toBe("stale-binding");
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("please fix it");
    expect(
      useAppStore
        .getState()
        .draftSnapshot(TAB)
        .attachments.map((entry) => entry.id),
    ).toEqual(["image-1"]);
  });

  it("does not reconcile against a stopped host: a refresh never wakes it", async () => {
    // Plan step 29: reconciliation is a refresh, not a user start. A stopped
    // (recycled) tab must not spend a `composer.current` read, and nothing may
    // be started from it; the draft and the local record stay untouched.
    const stub = stubRequest();
    useAppStore.getState().setDraft(TAB, "please fix it");
    useAppStore.setState({ tabs: [tab("stopped")] });

    const live = await useAppStore.getState().reconcileComposerOperation(TAB);

    expect(live).toBe(false);
    expect(stub.currentCalls()).toBe(0);
    expect(stub.transformCalls()).toBe(0);
    expect(stub.methods()).toEqual([]);
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("please fix it");

    // A caller that already ensured the host may read explicitly.
    useAppStore.setState({ tabs: [tab("running")] });
    await useAppStore.getState().reconcileComposerOperation(TAB, { wake: true });
    expect(stub.currentCalls()).toBe(1);
    expect(stub.transformCalls()).toBe(0);
  });

  it("drops a closed tab's operation and attachments but keeps the persisted text", async () => {
    stubRequest();
    await startRefinement();
    useAppStore
      .getState()
      .addDraftImages(TAB, [
        { id: "image-1", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ]);
    const text = useAppStore.getState().prefs.drafts[TAB];

    // The host reports the tab closed.
    useAppStore.setState({ tabs: [] });
    await useAppStore.getState().closeTab(TAB);

    expect(useAppStore.getState().composerOperations[TAB]).toBeUndefined();
    expect(useAppStore.getState().composerApplyReceipts[TAB]).toBeUndefined();
    expect(useAppStore.getState().composerDrafts[TAB]).toBeUndefined();
    // The persisted draft text survives; only the gone owner's live state dies.
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe(text);
  });
});
