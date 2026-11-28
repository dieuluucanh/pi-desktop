import { describe, expect, it } from "vitest";

import type {
  ComposerControlDescriptor,
  ComposerOperationDerived,
} from "../../src/shared/composer-operation";
import {
  matchComposerTransformCommand,
  planComposerCommandTransform,
  type ComposerCommandTransformInput,
} from "../../src/renderer/src/session/composer-command-route";

/**
 * Typed `/command <prompt>` routing into the structured composer operation
 * (2026-11-22 prompt-refinement plan step 24).
 *
 * The rules are pure and publisher-neutral: the match uses the advertised
 * transform command and the resolved command source, never a hard-coded name,
 * and every non-transform case stays on the caller's existing command path.
 */

const OWNER = "refine.ext";
const OTHER = "other.ext";

function control(over: Partial<ComposerControlDescriptor> = {}): ComposerControlDescriptor {
  return {
    ownerId: OWNER,
    id: "refine",
    label: "Refine prompt",
    tone: "accent",
    checked: false,
    enabled: true,
    behavior: "one-shot-return",
    actionRef: "toggle",
    transformActionRef: "transform",
    transformCommand: "prompt",
    descriptorGeneration: { ownerId: OWNER, epoch: 0, revision: 1 },
    ...over,
  };
}

function derived(over: Partial<ComposerOperationDerived> = {}): ComposerOperationDerived {
  return {
    uiState: "eligible",
    eligible: [],
    armed: [],
    armedControl: null,
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

function input(over: Partial<ComposerCommandTransformInput> = {}): ComposerCommandTransformInput {
  return {
    name: "prompt",
    argument: "please improve the child-session lifecycle",
    source: "extension",
    controls: [control()],
    operation: derived(),
    running: false,
    bashRunning: false,
    inputLocked: false,
    queued: false,
    ...over,
  };
}

describe("matchComposerTransformCommand", () => {
  it("matches only the exact advertised command name", () => {
    expect(matchComposerTransformCommand([control()], "prompt")).toHaveLength(1);
    expect(matchComposerTransformCommand([control()], "prompt-model")).toEqual([]);
    // An SDK collision invocation name is never the declared command.
    expect(matchComposerTransformCommand([control()], "prompt:2")).toEqual([]);
    expect(
      matchComposerTransformCommand([control({ transformCommand: "prompt:2" })], "prompt"),
    ).toEqual([]);
    expect(
      matchComposerTransformCommand([control({ transformCommand: undefined })], "prompt"),
    ).toEqual([]);
  });
});

describe("planComposerCommandTransform", () => {
  it("routes the literal argument text to the advertised control", () => {
    const route = planComposerCommandTransform(
      input({ argument: "Fix  the typo in `child-session`, keep my wording." }),
    );
    expect(route.kind).toBe("transform");
    if (route.kind !== "transform") return;
    expect(route.control.ownerId).toBe(OWNER);
    expect(route.control.actionRef).toBe("toggle");
    expect(route.text).toBe("Fix  the typo in `child-session`, keep my wording.");
  });

  it("keeps app commands, templates and skills on their existing path", () => {
    for (const source of ["app", "prompt", "skill", undefined]) {
      expect(planComposerCommandTransform(input({ source }))).toEqual({ kind: "not-transform" });
    }
  });

  it("ignores extension commands this composer does not advertise", () => {
    expect(planComposerCommandTransform(input({ name: "deploy" }))).toEqual({
      kind: "not-transform",
    });
    // Another command from the same publisher is not a transform either.
    expect(planComposerCommandTransform(input({ name: "prompt-model" }))).toEqual({
      kind: "not-transform",
    });
    // A collision-suffixed invocation of the advertised name is ambiguous.
    expect(planComposerCommandTransform(input({ name: "prompt:2" }))).toEqual({
      kind: "not-transform",
    });
  });

  it("matches the one control that declares the command among several publishers", () => {
    const route = planComposerCommandTransform(
      input({
        controls: [
          control(),
          control({
            ownerId: OTHER,
            id: "summarize",
            actionRef: "toggle-b",
            transformActionRef: "transform-b",
            transformCommand: "summarize",
          }),
        ],
      }),
    );
    expect(route.kind).toBe("transform");
    if (route.kind !== "transform") return;
    expect(route.control.ownerId).toBe(OWNER);
  });

  it("refuses when two publishers advertise the same command", () => {
    const route = planComposerCommandTransform(
      input({
        controls: [
          control(),
          control({
            ownerId: OTHER,
            id: "refine-b",
            actionRef: "toggle-b",
            transformActionRef: "transform-b",
          }),
        ],
      }),
    );
    expect(route).toMatchObject({ kind: "refuse", reason: "conflict" });
    if (route.kind !== "refuse") return;
    expect(route.hint).toMatch(/more than one refine control/);
  });

  it("refuses with the published reason when the control is disabled", () => {
    const route = planComposerCommandTransform(
      input({ controls: [control({ enabled: false, disabledReason: "Vision model required" })] }),
    );
    expect(route).toMatchObject({ kind: "refuse", reason: "disabled" });
    if (route.kind !== "refuse") return;
    expect(route.hint).toBe("Vision model required");
  });

  it("refuses a conflict before starting anything", () => {
    const route = planComposerCommandTransform(
      input({
        operation: derived({
          isConflict: true,
          conflict: { kind: "multiple-armed", message: "x" } as never,
        }),
      }),
    );
    expect(route).toMatchObject({ kind: "refuse", reason: "conflict" });
  });

  it("refuses while an operation owns the tab", () => {
    for (const operation of [
      derived({ isRunning: true }),
      derived({ isAwaitingInput: true }),
      derived({ hasCandidate: true }),
    ]) {
      expect(planComposerCommandTransform(input({ operation }))).toMatchObject({
        kind: "refuse",
        reason: "active-operation",
      });
    }
  });

  it("refuses a locked, running, shell-busy or queued composer", () => {
    expect(planComposerCommandTransform(input({ inputLocked: true }))).toMatchObject({
      kind: "refuse",
      reason: "input-locked",
    });
    expect(planComposerCommandTransform(input({ running: true }))).toMatchObject({
      kind: "refuse",
      reason: "busy",
    });
    expect(planComposerCommandTransform(input({ bashRunning: true }))).toMatchObject({
      kind: "refuse",
      reason: "busy",
    });
    expect(planComposerCommandTransform(input({ queued: true }))).toMatchObject({
      kind: "refuse",
      reason: "queued",
    });
  });

  it("shows usage instead of starting an empty refinement", () => {
    const route = planComposerCommandTransform(input({ argument: "   " }));
    expect(route).toMatchObject({ kind: "refuse", reason: "empty-text" });
    if (route.kind !== "refuse") return;
    expect(route.hint).toContain("/prompt needs a prompt to refine");
  });
});
