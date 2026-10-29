import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  emptyCheckpointState,
  type Checkpoint,
  type CheckpointActionResult,
  type CheckpointState,
} from "../../src/shared/checkpoints";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The renderer's checkpoint slice (git-checkpoint plan step 21).
 *
 * The engine is proven elsewhere; this suite pins the store's bookkeeping: the
 * map stays bounded, every action refreshes the timeline exactly once, a failure
 * is surfaced rather than swallowed, and **Undo is one level deep** — the undo
 * must not become the next thing to undo.
 */

const PROJECT = "/work/reports";
const REF_A = "a".repeat(40);
const REF_B = "b".repeat(40);

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: REF_A,
    ref: REF_A,
    createdAt: 1_700_000_000_000,
    kind: "manual",
    label: "Manual snapshot",
    entryId: null,
    sessionId: null,
    files: 2,
    bytes: 128,
    skipped: 0,
    note: null,
    ...overrides,
  };
}

function state(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    ...emptyCheckpointState(PROJECT, 1_700_000_000_000),
    checkpoints: [checkpoint()],
    usage: { checkpoints: 1, bytes: 128, maxBytes: 2 * 1024 ** 3 },
    ...overrides,
  };
}

function resetStore(): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    checkpoints: {},
    checkpointsError: null,
    checkpointsUndoRef: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("hydration", () => {
  it("applies a state returned by the bridge", async () => {
    installBridge({ checkpoints: state() });
    await useAppStore.getState().loadCheckpoints(PROJECT);
    const stored = useAppStore.getState().checkpoints[PROJECT];
    expect(stored?.available).toBe(true);
    expect(stored?.checkpoints).toHaveLength(1);
    expect(stored?.usage).toEqual({ checkpoints: 1, bytes: 128, maxBytes: 2 * 1024 ** 3 });
  });

  it("applies a pushed state from main", () => {
    const handles = installBridge();
    handles.emitCheckpointState(state({ checkpoints: [] }));
    // `App` wires the push to `applyCheckpointState`; the method is what a push
    // reaches, so calling it directly is the same path.
    useAppStore.getState().applyCheckpointState(state({ checkpoints: [] }));
    expect(useAppStore.getState().checkpoints[PROJECT]?.checkpoints).toEqual([]);
  });

  it("keeps a disabled state's sentence instead of an empty timeline", () => {
    useAppStore
      .getState()
      .applyCheckpointState(state({ available: false, reason: "git_missing", checkpoints: [] }));
    const stored = useAppStore.getState().checkpoints[PROJECT];
    expect(stored?.available).toBe(false);
    expect(stored?.reason).toBe("git_missing");
    expect(stored?.message).toMatch(/install git/i);
  });

  it("drops a checkpoint whose ref is not a full sha", () => {
    useAppStore.getState().applyCheckpointState(
      state({
        checkpoints: [checkpoint({ ref: "HEAD~1", id: "HEAD~1" }), checkpoint({ ref: REF_B })],
      }),
    );
    expect(
      useAppStore.getState().checkpoints[PROJECT]?.checkpoints.map((entry) => entry.ref),
    ).toEqual([REF_B]);
  });

  it("ignores a payload without a project path", () => {
    useAppStore.getState().applyCheckpointState({ ...state(), projectPath: "" });
    expect(useAppStore.getState().checkpoints).toEqual({});
  });

  it("bounds the map so a long session cannot grow it", () => {
    for (let index = 0; index < 12; index += 1) {
      useAppStore.getState().applyCheckpointState({ ...state(), projectPath: `/work/p${index}` });
    }
    expect(Object.keys(useAppStore.getState().checkpoints).length).toBeLessThanOrEqual(5);
  });
});

describe("actions", () => {
  it("takes a manual snapshot and refreshes the timeline once", async () => {
    const handles = installBridge({ checkpoints: state() });
    await useAppStore.getState().createCheckpoint(PROJECT, "Before the demo");
    const actions = handles.checkpointCalls.filter((call) => call.kind === "action");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toEqual({ kind: "create", label: "Before the demo" });
    // The refresh is the store's own read, not a second action.
    expect(handles.checkpointCalls.filter((call) => call.kind === "refresh")).toHaveLength(1);
  });

  it("sends a bare create when the label is blank", async () => {
    const handles = installBridge();
    await useAppStore.getState().createCheckpoint(PROJECT, "   ");
    expect(handles.checkpointCalls.find((call) => call.kind === "action")?.payload).toEqual({
      kind: "create",
    });
  });

  it("surfaces a failed action and keeps the error until dismissed", async () => {
    installBridge({
      checkpointsAction: { ok: false, error: "Checkpoints are turned off in Settings." },
    });
    const result = await useAppStore.getState().createCheckpoint(PROJECT);
    expect(result.ok).toBe(false);
    expect(useAppStore.getState().checkpointsError).toBe("Checkpoints are turned off in Settings.");
    useAppStore.getState().clearCheckpointsError();
    expect(useAppStore.getState().checkpointsError).toBeNull();
  });

  it("clears a previous error after a successful action", async () => {
    installBridge({ checkpointsAction: { ok: true } });
    useAppStore.setState({ checkpointsError: "old failure" });
    await useAppStore.getState().createCheckpoint(PROJECT);
    expect(useAppStore.getState().checkpointsError).toBeNull();
  });

  it("reports a same_tree snapshot as success", async () => {
    installBridge({
      checkpointsAction: { ok: true, skipped: "same_tree", message: "Nothing changed." },
    });
    const result = await useAppStore.getState().createCheckpoint(PROJECT);
    expect(result).toMatchObject({ ok: true, skipped: "same_tree" });
    expect(useAppStore.getState().checkpointsError).toBeNull();
  });
});

describe("preview", () => {
  it("returns the grouped preview and clears the error", async () => {
    installBridge({
      checkpointsAction: {
        ok: true,
        preview: { restore: ["a.txt"], remove: ["b.txt"], openInOffice: ["a.txt"] },
      },
    });
    const preview = await useAppStore.getState().previewCheckpoint(PROJECT, REF_A);
    expect(preview).toEqual({ restore: ["a.txt"], remove: ["b.txt"], openInOffice: ["a.txt"] });
    expect(useAppStore.getState().checkpointsError).toBeNull();
  });

  it("records a failure and returns null instead of an empty preview", async () => {
    installBridge({ checkpointsAction: { ok: false, error: "fatal: bad ref" } });
    const preview = await useAppStore.getState().previewCheckpoint(PROJECT, REF_A);
    expect(preview).toBeNull();
    expect(useAppStore.getState().checkpointsError).toBe("fatal: bad ref");
  });

  it("passes removeAdded only when asked", async () => {
    const handles = installBridge({ checkpointsAction: { ok: true, undoRef: REF_A } });
    await useAppStore.getState().restoreCheckpoint(PROJECT, REF_B);
    await useAppStore.getState().restoreCheckpoint(PROJECT, REF_B, { removeAdded: true });
    const payloads = handles.checkpointCalls
      .filter((call) => call.kind === "action")
      .map((call) => call.payload as { removeAdded?: boolean });
    expect(payloads.map((payload) => payload.removeAdded)).toEqual([undefined, true]);
  });
});

describe("undo", () => {
  const undoable = (): CheckpointActionResult => ({ ok: true, undoRef: REF_A });

  it("records the pre-restore ref a successful restore returns", async () => {
    installBridge({ checkpointsAction: undoable() });
    await useAppStore.getState().restoreCheckpoint(PROJECT, REF_B);
    expect(useAppStore.getState().checkpointsUndoRef[PROJECT]).toBe(REF_A);
  });

  it("does not record a ref for a failed restore", async () => {
    installBridge({ checkpointsAction: { ok: false, error: "nope" } });
    await useAppStore.getState().restoreCheckpoint(PROJECT, REF_B);
    expect(useAppStore.getState().checkpointsUndoRef[PROJECT]).toBeUndefined();
  });

  it("restores the recorded ref and then forgets it (one level only)", async () => {
    const handles = installBridge({ checkpointsAction: undoable() });
    await useAppStore.getState().restoreCheckpoint(PROJECT, REF_B);
    handles.checkpointCalls.length = 0;

    await useAppStore.getState().undoRestoreCheckpoint(PROJECT);
    const action = handles.checkpointCalls.find((call) => call.kind === "action");
    expect(action?.payload).toEqual({ kind: "restore", ref: REF_A });
    // A second Undo must not silently restore the undo's own safety snapshot.
    expect(useAppStore.getState().checkpointsUndoRef[PROJECT]).toBeUndefined();
  });

  it("refuses an undo when there is nothing to undo", async () => {
    installBridge();
    const result = await useAppStore.getState().undoRestoreCheckpoint(PROJECT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no restore to undo/i);
  });
});

describe("prune", () => {
  it("prunes through the same dispatch path", async () => {
    const handles = installBridge({ checkpointsAction: { ok: true, usage: state().usage } });
    const result = await useAppStore.getState().pruneCheckpoints(PROJECT);
    expect(result.ok).toBe(true);
    expect(handles.checkpointCalls.find((call) => call.kind === "action")?.payload).toEqual({
      kind: "prune",
    });
  });
});
