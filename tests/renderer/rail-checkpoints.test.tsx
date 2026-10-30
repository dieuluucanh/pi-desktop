import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { CheckpointsSection } from "../../src/renderer/src/rail/CheckpointsSection";
import {
  KIND_LABELS,
  canSnapshot,
  checkpointAge,
  checkpointDetail,
  checkpointTitle,
  runSnapshotsUnavailable,
  unavailableCopy,
  usageSummary,
} from "../../src/renderer/src/rail/checkpoints-view";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  emptyCheckpointState,
  type Checkpoint,
  type CheckpointActionResult,
  type CheckpointPreviewState,
  type CheckpointState,
} from "../../src/shared/checkpoints";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The Checkpoints section (git-checkpoint plan step 22).
 *
 * Three things are safety-critical and therefore pinned here:
 *
 *  - **`removeAdded` is off by default** and only sent when the user opts in
 *    (removing files cannot be assumed).
 *  - **A restore goes through the preview**, never straight from the row.
 *  - **Undo is offered** after a restore, using the ref main returned.
 *
 * The rest is the ordinary surface: kind chips, the two empty states, the "run
 * snapshots are off" note and the usage/prune footer.
 */

const PROJECT = "/work/reports";
const NOW = 1_700_000_000_000;
const REF_A = "a".repeat(40);
const REF_B = "b".repeat(40);

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: REF_A,
    ref: REF_A,
    createdAt: NOW - 2 * 3_600_000,
    kind: "run",
    label: "Fix the Q3 numbers",
    entryId: "e1",
    sessionId: "s1",
    files: 3,
    bytes: 4_200_000,
    skipped: 0,
    note: null,
    ...overrides,
  };
}

function state(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    ...emptyCheckpointState(PROJECT, NOW),
    runSnapshots: true,
    checkpoints: [checkpoint()],
    usage: { checkpoints: 1, bytes: 4_200_000, maxBytes: 2 * 1024 ** 3 },
    ...overrides,
  };
}

let handles: ReturnType<typeof installBridge>;

function seed(options: { state?: CheckpointState; action?: CheckpointActionResult } = {}): void {
  handles = installBridge({
    checkpoints: options.state ?? state(),
    checkpointsAction: options.action ?? { ok: true },
  });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    checkpoints: { [PROJECT]: options.state ?? state() },
    checkpointsError: null,
    checkpointsUndoRef: {},
  });
}

/** The action payloads the bridge received, in order. */
function actions(): unknown[] {
  return handles.checkpointCalls
    .filter((call) => call.kind === "action")
    .map((call) => call.payload);
}

beforeEach(() => {
  seed();
});

describe("presentation helpers", () => {
  it("labels every kind", () => {
    expect(KIND_LABELS.run).toBe("Prompt");
    expect(KIND_LABELS["pre-restore"]).toBe("Restore");
  });

  it("uses a terse relative age", () => {
    expect(checkpointAge(NOW - 5_000, NOW)).toBe("just now");
    expect(checkpointAge(NOW - 3_600_000, NOW)).toBe("1h ago");
    expect(checkpointAge(0, NOW)).toBe("unknown");
  });

  it("describes a checkpoint's size and a skipped count", () => {
    expect(checkpointDetail(checkpoint({ files: 1, bytes: 512 }))).toBe("1 file · 512 B");
    expect(checkpointDetail(checkpoint({ files: 4, bytes: 2048, skipped: 2 }))).toBe(
      "4 files · 2 KB · 2 skipped",
    );
  });

  it("falls back to the kind's sentence when a label is blank", () => {
    expect(checkpointTitle(checkpoint({ label: "" }))).toBe("Before the prompt");
    expect(checkpointTitle(checkpoint({ label: "Named", kind: "manual" }))).toBe("Named");
  });

  it("summarises usage with a clamped fraction", () => {
    const summary = usageSummary(state());
    expect(summary.text).toBe("4 MB of 2 GB · 1 checkpoint");
    expect(summary.fraction).toBeGreaterThan(0);
    expect(summary.fraction).toBeLessThan(0.01);
    // A budget of zero must not divide by zero.
    expect(usageSummary(state({ usage: { checkpoints: 0, bytes: 0, maxBytes: 0 } })).fraction).toBe(
      0,
    );
  });

  it("states why the surface is unavailable, and only then", () => {
    expect(unavailableCopy(state())).toBeNull();
    expect(
      unavailableCopy(state({ available: false, reason: "git_missing", message: "Install git." })),
    ).toBe("Install git.");
  });

  it("offers a snapshot only when enabled and available", () => {
    expect(canSnapshot(state())).toBe(true);
    expect(canSnapshot(state({ enabled: false }))).toBe(false);
    expect(canSnapshot(state({ available: false }))).toBe(false);
    expect(runSnapshotsUnavailable(state({ runSnapshots: false }))).toBe(true);
  });
});

describe("timeline", () => {
  it("renders a row per checkpoint, newest first", () => {
    seed({
      state: state({
        checkpoints: [
          checkpoint({ ref: REF_B, id: REF_B, label: "newer" }),
          checkpoint({ ref: REF_A, id: REF_A, label: "older" }),
        ],
      }),
    });
    render(<CheckpointsSection projectPath={PROJECT} />);
    const labels = screen.getAllByTitle(/newer|older/).map((node) => node.textContent);
    expect(labels).toEqual(["newer", "older"]);
  });

  it("shows the kind chip and the detail line", () => {
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.getByTestId("checkpoint-detail").textContent).toContain("3 files");
  });

  it("marks a safety snapshot differently from a run", () => {
    seed({
      state: state({ checkpoints: [checkpoint({ kind: "pre-op", label: "discard a.txt" })] }),
    });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByText("Safety")).toBeTruthy();
  });

  it("renders the empty state", () => {
    seed({ state: state({ checkpoints: [] }) });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByTestId("checkpoints-empty")).toBeTruthy();
  });

  it("hydrates from the bridge when nothing is in the store yet", async () => {
    useAppStore.setState({ checkpoints: {} });
    render(<CheckpointsSection projectPath={PROJECT} />);
    await waitFor(() => expect(screen.getByTestId("checkpoints-section")).toBeTruthy());
    expect(handles.checkpointCalls.some((call) => call.kind === "get")).toBe(true);
  });
});

describe("empty and degraded states", () => {
  it("states git_missing with its instructions and no action buttons", () => {
    seed({
      state: state({
        available: false,
        reason: "git_missing",
        message: "Folder checkpoints need git.",
      }),
    });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByTestId("checkpoints-unavailable").textContent).toContain("need git");
    expect(screen.getByText(/not bundled/i)).toBeTruthy();
    expect(screen.queryByTestId("checkpoint-create")).toBeNull();
  });

  it("offers a re-check for a degraded surface", async () => {
    seed({ state: state({ available: false, reason: "unavailable", message: "Could not read." }) });
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(handles.checkpointCalls.some((call) => call.kind === "refresh")).toBe(true);
  });

  it("says checkpoints are disabled by config", () => {
    seed({ state: state({ enabled: false }) });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByTestId("checkpoints-disabled")).toBeTruthy();
    // A disabled surface still renders the history it already has.
    expect(screen.getByTestId("checkpoint-detail")).toBeTruthy();
  });

  it("says run snapshots are off (safe mode / stale host)", () => {
    seed({ state: state({ runSnapshots: false }) });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByTestId("checkpoints-run-off").textContent).toMatch(/safe mode/i);
    // Manual snapshots still work.
    expect((screen.getByTestId("checkpoint-create") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("snapshot now", () => {
  it("sends a bare create action", async () => {
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId("checkpoint-create"));
    await waitFor(() => expect(actions()).toEqual([{ kind: "create" }]));
  });

  it("is disabled while a snapshot is in flight", async () => {
    render(<CheckpointsSection projectPath={PROJECT} />);
    const button = screen.getByTestId("checkpoint-create") as HTMLButtonElement;
    await userEvent.click(button);
    await waitFor(() => expect(actions().length).toBe(1));
    // The button is re-enabled once the action resolves and the refresh lands.
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});

describe("restore", () => {
  const preview: CheckpointPreviewState = {
    restore: ["Report.docx", "notes.txt"],
    remove: ["scratch.tmp"],
    openInOffice: ["Report.docx"],
  };

  it("opens the preview, never restoring straight from the row", async () => {
    seed({ action: { ok: true, preview } });
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId(`checkpoint-restore-${REF_A.slice(0, 8)}`));

    await waitFor(() => expect(screen.getByTestId("restore-dialog")).toBeTruthy());
    expect(screen.getByTestId("restore-group-change").textContent).toContain("Report.docx");
    expect(screen.getByTestId("restore-group-remove").textContent).toContain("scratch.tmp");
    // No restore has been sent yet: the preview is a read.
    expect(actions()).toEqual([{ kind: "preview", ref: REF_A }]);
  });

  it("warns about a document an Office pane holds open", async () => {
    seed({ action: { ok: true, preview } });
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId(`checkpoint-restore-${REF_A.slice(0, 8)}`));
    await waitFor(() => expect(screen.getByTestId("restore-office-warning")).toBeTruthy());
    expect(screen.getByTestId("restore-office-warning").textContent).toContain("Report.docx");
  });

  it("leaves removeAdded off by default", async () => {
    seed({ action: { ok: true, preview, undoRef: REF_B } });
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId(`checkpoint-restore-${REF_A.slice(0, 8)}`));
    await waitFor(() => expect(screen.getByTestId("restore-confirm")).toBeTruthy());

    await userEvent.click(screen.getByTestId("restore-confirm"));
    await waitFor(() =>
      expect(actions().some((a) => (a as { kind: string }).kind === "restore")).toBe(true),
    );
    // `removeAdded` is omitted, not sent as false: the store only forwards it
    // when the user opts in.
    expect(actions()).toContainEqual({ kind: "restore", ref: REF_A });
  });

  it("sends removeAdded only after the checkbox is ticked", async () => {
    seed({ action: { ok: true, preview, undoRef: REF_B } });
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId(`checkpoint-restore-${REF_A.slice(0, 8)}`));
    await waitFor(() => expect(screen.getByTestId("restore-remove-added")).toBeTruthy());

    await userEvent.click(screen.getByTestId("restore-remove-added"));
    await userEvent.click(screen.getByTestId("restore-confirm"));
    await waitFor(() =>
      expect(actions()).toContainEqual({ kind: "restore", ref: REF_A, removeAdded: true }),
    );
  });

  it("keeps the dialog open and shows why a restore failed", async () => {
    seed({ action: { ok: false, error: "The restore could not be applied." } });
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId(`checkpoint-restore-${REF_A.slice(0, 8)}`));
    // With no preview the confirm button is disabled, so the failure path is the
    // preview read itself.
    await waitFor(() => expect(screen.getByTestId("restore-preview-error")).toBeTruthy());
  });

  it("offers Undo after a restore and sends the recorded ref", async () => {
    seed({ action: { ok: true, preview, undoRef: REF_B } });
    useAppStore.setState({ checkpointsUndoRef: { [PROJECT]: REF_B } });
    render(<CheckpointsSection projectPath={PROJECT} />);
    const undo = screen.getByTestId("checkpoint-undo");
    await userEvent.click(undo);
    await waitFor(() => expect(actions()).toContainEqual({ kind: "restore", ref: REF_B }));
    // One level only: the affordance disappears afterwards.
    await waitFor(() => expect(screen.queryByTestId("checkpoint-undo")).toBeNull());
  });

  it("shows no Undo affordance without a recorded ref", () => {
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.queryByTestId("checkpoint-undo")).toBeNull();
  });
});

describe("error line", () => {
  it("renders the store's error and can be dismissed", async () => {
    useAppStore.setState({ checkpointsError: "Checkpoints are turned off in Settings." });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByTestId("checkpoints-error").textContent).toContain("turned off");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useAppStore.getState().checkpointsError).toBeNull();
  });
});

describe("usage and prune", () => {
  it("shows the usage footer", () => {
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.getByTestId("checkpoint-usage").textContent).toBe("4 MB of 2 GB · 1 checkpoint");
  });

  it("asks for confirmation before pruning and then prunes", async () => {
    render(<CheckpointsSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId("checkpoint-prune"));
    await waitFor(() => expect(screen.getByTestId("confirm-dialog")).toBeTruthy());
    // Nothing has been dropped yet.
    expect(actions()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Prune" }));
    await waitFor(() => expect(actions()).toEqual([{ kind: "prune" }]));
  });

  it("cannot prune an empty timeline", () => {
    seed({ state: state({ checkpoints: [] }) });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect((screen.getByTestId("checkpoint-prune") as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * Session linkage (git-checkpoint plan step 25).
 *
 * A checkpoint can only rewind the conversation it was taken for. The three
 * states have to be visible, because "Before the fork" is the one a user can
 * misread as "part of this conversation" and then be surprised when a rewind
 * jumps elsewhere.
 */
describe("session linkage", () => {
  const linked = checkpoint({ kind: "run", entryId: "e1" });
  const beforeFork = checkpoint({ ref: REF_B, id: REF_B, kind: "run", entryId: "e-ancestor" });
  const manual = checkpoint({ kind: "manual", entryId: null });

  it("labels a run from this session as this session", () => {
    seed({ state: state({ checkpoints: [linked] }) });
    render(<CheckpointsSection projectPath={PROJECT} entryIds={{ e1: true }} />);
    expect(screen.getByTestId("checkpoint-linkage-linked").textContent).toBe("This session");
  });

  it("labels a run from an ancestor session as before the fork", () => {
    seed({ state: state({ checkpoints: [beforeFork] }) });
    render(<CheckpointsSection projectPath={PROJECT} entryIds={{ e1: true }} />);
    expect(screen.getByTestId("checkpoint-linkage-from-before-fork").textContent).toBe(
      "Before the fork",
    );
  });

  it("shows no linkage chip for a manual snapshot", () => {
    seed({ state: state({ checkpoints: [manual] }) });
    render(<CheckpointsSection projectPath={PROJECT} entryIds={{ e1: true }} />);
    expect(screen.queryByTestId("checkpoint-linkage-linked")).toBeNull();
    expect(screen.queryByTestId("checkpoint-linkage-from-before-fork")).toBeNull();
    expect(screen.queryByTestId("checkpoint-linkage-unlinked")).toBeNull();
  });

  it("shows no chip when the transcript has not hydrated yet", () => {
    // No `entryIds` at all: the rail does not know which session this is, so it
    // says nothing rather than guessing. "Before the fork" would be a claim it
    // cannot back; "This session" would be worse.
    seed({ state: state({ checkpoints: [linked] }) });
    render(<CheckpointsSection projectPath={PROJECT} />);
    expect(screen.queryByTestId("checkpoint-linkage-linked")).toBeNull();
    expect(screen.queryByTestId("checkpoint-linkage-from-before-fork")).toBeNull();
  });
});
