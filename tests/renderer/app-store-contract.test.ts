import { describe, expect, it } from "vitest";

import { useAppStore, type AppStateShape } from "../../src/renderer/src/state/app-store";

/**
 * The store's cross-cutting contract for the 2026-11-06 tab-switch / model plan.
 *
 * These keys are read by other modules (SessionView's picker warning, the tab
 * chip's attention dot) and are easy to drop in a refactor without any test
 * failing — a missing field is `undefined`, which renders as "no warning".
 * Pinning their presence here is cheap and makes the contract explicit.
 */

describe("app-store contract", () => {
  it("types the default-model problem on the store shape", () => {
    // Compile-time proof that the key other modules read is declared; a rename
    // fails `npm run typecheck:web` instead of rendering as `undefined`.
    const shape: Pick<AppStateShape, "defaultModelProblem" | "modelScopeDiagnostics"> = {
      defaultModelProblem: null,
      modelScopeDiagnostics: {},
    };
    expect(shape.defaultModelProblem).toBeNull();
  });

  it("exposes the default-model problem and its one writer", () => {
    const state = useAppStore.getState();
    expect(state.defaultModelProblem).toBeNull();
    expect(typeof state.noteDefaultModelProblem).toBe("function");
  });

  it("exposes per-tab scope diagnostics and dialog attention", () => {
    const state = useAppStore.getState();
    expect(state.modelScopeDiagnostics).toEqual({});
    expect(state.dialogAttention).toEqual({});
    expect(typeof state.markDialogAttention).toBe("function");
    expect(typeof state.clearDialogAttention).toBe("function");
  });

  it("records one default-model incident per distinct id", () => {
    const recorded: Array<{ message: string }> = [];
    (
      window as unknown as {
        pi: { diagnostics: { record: (value: { message: string }) => Promise<boolean> } };
      }
    ).pi = {
      diagnostics: {
        record: async (value: { message: string }) => {
          recorded.push(value);
          return true;
        },
      },
    } as never;

    const problem = {
      provider: "synthetic",
      id: "hf:gone",
      message: "Saved default model synthetic/hf:gone is not in the catalogue.",
    };
    useAppStore.getState().noteDefaultModelProblem(problem);
    useAppStore.getState().noteDefaultModelProblem(problem);

    expect(useAppStore.getState().defaultModelProblem).toEqual(problem);
    expect(recorded).toHaveLength(1);
    useAppStore.getState().noteDefaultModelProblem(null);
  });
});
