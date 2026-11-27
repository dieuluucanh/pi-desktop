import { describe, expect, it } from "vitest";

import type {
  ComposerControlDescriptor,
  ComposerOperationDerived,
} from "../../src/shared/composer-operation";
import type { ComposerTransformBinding } from "../../src/shared/composer-transform";
import {
  attachmentDigest,
  buildComposerTransformStart,
  composerSendConsumesDraft,
  composerSendPreservesDraft,
  composerTransformRequestId,
  decodedBase64Bytes,
  planComposerSend,
  type ComposerSendRouteInput,
} from "../../src/renderer/src/session/composer-send";
import type { ComposerDraftSnapshot } from "../../src/renderer/src/session/composer-draft";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";

/**
 * Send routing and dispositions (2026-11-22 prompt-refinement plan step 20).
 *
 * The rules are pure on purpose: one armed, enabled transform control turns an
 * ordinary agent-message submission into a draft transformation, and every
 * other state either sends normally or refuses honestly. Nothing here may ever
 * fall through to a prompt dispatch.
 */

const OWNER = "refine.ext";

function control(over: Partial<ComposerControlDescriptor> = {}): ComposerControlDescriptor {
  return {
    ownerId: OWNER,
    id: "refine",
    label: "Refine prompt",
    tone: "accent",
    checked: true,
    enabled: true,
    behavior: "one-shot-return",
    actionRef: "toggle",
    transformActionRef: "transform",
    descriptorGeneration: { ownerId: OWNER, epoch: 0, revision: 1 },
    ...over,
  };
}

function derived(over: Partial<ComposerOperationDerived> = {}): ComposerOperationDerived {
  const armed = over.armed ?? [control()];
  return {
    uiState: "armed",
    eligible: armed,
    armed,
    armedControl: armed.length === 1 ? (armed[0] ?? null) : null,
    runningControl: null,
    isRunning: false,
    isAwaitingInput: false,
    hasCandidate: false,
    candidateText: null,
    candidateSummary: null,
    stage: null,
    statusMessage: null,
    originalText: null,
    isConflict: false,
    conflict: null,
    canStart: true,
    canCancel: false,
    canApply: false,
    ...over,
  };
}

function input(over: Partial<ComposerSendRouteInput> = {}): ComposerSendRouteInput {
  return {
    text: "please improve the child-session lifecycle",
    imageCount: 0,
    running: false,
    bashRunning: false,
    inputLocked: false,
    queued: false,
    operation: derived(),
    ...over,
  };
}

const BINDING: ComposerTransformBinding = {
  sessionId: "session-1",
  epoch: 1,
  bindingId: "tab:tab-1",
  hostGeneration: 1,
};

function image(id: string, data = "AAAA"): ImageAttachment {
  return { id, name: "shot.png", mimeType: "image/png", data };
}

function draft(over: Partial<ComposerDraftSnapshot> = {}): ComposerDraftSnapshot {
  return {
    revision: 7,
    attachmentRevision: 9,
    text: "please fix the child session",
    expandedText: "please fix the child session",
    selection: { start: 4, end: 4 },
    attachments: [],
    ...over,
  };
}

describe("dispositions", () => {
  it("only sent/consumed commands follow the existing clear rules", () => {
    expect(composerSendConsumesDraft("sent")).toBe(true);
    expect(composerSendConsumesDraft("handled-command")).toBe(true);
    expect(composerSendConsumesDraft("refining")).toBe(false);
    expect(composerSendConsumesDraft("refined")).toBe(false);
    expect(composerSendConsumesDraft("refused")).toBe(false);
    for (const disposition of ["refining", "refined", "refused"] as const) {
      expect(composerSendPreservesDraft(disposition)).toBe(true);
    }
  });
});

describe("planComposerSend", () => {
  it("keeps ordinary sends normal when nothing is armed", () => {
    expect(planComposerSend(input({ operation: derived({ armed: [] }) }))).toEqual({
      kind: "normal",
    });
  });

  it("routes an armed prose submission to a transformation", () => {
    const route = planComposerSend(input());
    expect(route.kind).toBe("transform");
    if (route.kind !== "transform") return;
    expect(route.control.ownerId).toBe(OWNER);
  });

  it("refuses an active run instead of steering, queueing or prompting", () => {
    const route = planComposerSend(input({ running: true }));
    expect(route).toMatchObject({ kind: "refuse", reason: "busy" });
  });

  it("refuses a running shell command", () => {
    const route = planComposerSend(input({ bashRunning: true }));
    expect(route).toMatchObject({ kind: "refuse", reason: "busy" });
  });

  it("refuses while messages are queued", () => {
    const route = planComposerSend(input({ queued: true }));
    expect(route).toMatchObject({ kind: "refuse", reason: "queued" });
  });

  it("refuses when an extension owns the turn", () => {
    const route = planComposerSend(input({ inputLocked: true }));
    expect(route).toMatchObject({ kind: "refuse", reason: "input-locked" });
  });

  it("refuses an images-only draft rather than dispatching the task", () => {
    const route = planComposerSend(input({ text: "   ", imageCount: 1 }));
    expect(route).toMatchObject({ kind: "refuse", reason: "images-only" });
  });

  it("refuses an empty draft", () => {
    const route = planComposerSend(input({ text: "" }));
    expect(route).toMatchObject({ kind: "refuse", reason: "empty-text" });
  });

  it("refuses more than one armed control", () => {
    const second = control({ id: "other", actionRef: "toggle2", transformActionRef: "transform2" });
    const route = planComposerSend(
      input({ operation: derived({ armed: [control(), second], armedControl: null }) }),
    );
    expect(route).toMatchObject({ kind: "refuse", reason: "conflict" });
  });

  it("refuses a published conflict without starting anything", () => {
    const route = planComposerSend(
      input({
        operation: derived({
          isConflict: true,
          conflict: { kind: "stale-binding", message: "The binding changed." },
        }),
      }),
    );
    expect(route).toMatchObject({
      kind: "refuse",
      reason: "conflict",
      hint: "The binding changed.",
    });
  });

  it("refuses an armed but disabled control with its own reason", () => {
    const route = planComposerSend(
      input({
        operation: derived({
          armed: [control({ enabled: false, disabledReason: "Model has no vision" })],
        }),
      }),
    );
    expect(route).toMatchObject({
      kind: "refuse",
      reason: "disabled",
      hint: "Model has no vision",
    });
  });

  it("refuses while an operation is already running, awaiting input or holding a candidate", () => {
    for (const flag of ["isRunning", "isAwaitingInput", "hasCandidate"] as const) {
      expect(planComposerSend(input({ operation: derived({ [flag]: true }) }))).toMatchObject({
        kind: "refuse",
        reason: "active-operation",
      });
    }
  });
});

describe("buildComposerTransformStart", () => {
  it("carries the live capture, attachment metadata and in-band image bytes", () => {
    const built = buildComposerTransformStart({
      requestId: "cx-abcdef12",
      binding: BINDING,
      control: control(),
      draft: draft(),
      attachments: [image("image-1")],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const request = built.request;
    expect(request.contract).toBe("composer-transform-v1");
    expect(request.ownerId).toBe(OWNER);
    expect(request.controlId).toBe("refine");
    expect(request.actionId).toBe("toggle");
    expect(request.transformActionId).toBe("transform");
    expect(request.contributionRevision).toBe(1);
    expect(request.binding).toEqual(BINDING);
    expect(request.snapshot).toMatchObject({
      draftRevision: 7,
      text: "please fix the child session",
      expandedText: "please fix the child session",
      selection: { start: 4, end: 4 },
      inputState: "idle",
    });
    // `AAAA` decodes to three bytes, and the image bytes must agree with the
    // attachment metadata the same request carries.
    expect(request.snapshot.attachments).toEqual([
      {
        id: "image-1",
        digest: attachmentDigest("AAAA"),
        mimeType: "image/png",
        byteLength: 3,
      },
    ]);
    expect(request.images).toEqual([{ id: "image-1", mimeType: "image/png", dataBase64: "AAAA" }]);
  });

  it("omits the images field for a text-only draft", () => {
    const built = buildComposerTransformStart({
      requestId: "cx-abcdef12",
      binding: BINDING,
      control: control(),
      draft: draft(),
      attachments: [],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.images).toBeUndefined();
    expect(built.request.snapshot.attachments).toEqual([]);
  });

  it("refuses an unreadable image instead of sending mismatched metadata", () => {
    const built = buildComposerTransformStart({
      requestId: "cx-abcdef12",
      binding: BINDING,
      control: control(),
      draft: draft(),
      attachments: [image("image-1", "AAA")],
    });
    expect(built).toMatchObject({ ok: false });
  });

  it("refuses an oversized draft locally", () => {
    const built = buildComposerTransformStart({
      requestId: "cx-abcdef12",
      binding: BINDING,
      control: control(),
      draft: draft({ text: "x".repeat(300_000) }),
      attachments: [],
    });
    expect(built).toMatchObject({ ok: false });
  });
});

describe("base64 helpers", () => {
  it("computes decoded byte lengths with padding", () => {
    expect(decodedBase64Bytes("AAAA")).toBe(3);
    expect(decodedBase64Bytes("AAA=")).toBe(2);
    expect(decodedBase64Bytes("AA==")).toBe(1);
    expect(decodedBase64Bytes("AAA")).toBeUndefined();
    expect(decodedBase64Bytes("A$AA")).toBeUndefined();
  });

  it("produces a bounded, deterministic digest", () => {
    expect(attachmentDigest("AAAA")).toBe(attachmentDigest("AAAA"));
    expect(attachmentDigest("AAAA")).not.toBe(attachmentDigest("BBBB"));
    expect(attachmentDigest("AAAA").length).toBeLessThanOrEqual(128);
  });
});

describe("composerTransformRequestId", () => {
  it("prefixes a CSPRNG uuid", () => {
    const id = composerTransformRequestId(() => "0f7c2b1a-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(id).toBe("cx-0f7c2b1a-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(/^[A-Za-z0-9._-]{8,96}$/.test(id ?? "")).toBe(true);
  });

  it("refuses when the runtime cannot mint an unpredictable id", () => {
    expect(composerTransformRequestId(() => "a")).toBeNull();
    expect(composerTransformRequestId(() => "bad/id-with-a-slash-that-is-long-enough")).toBeNull();
  });
});
