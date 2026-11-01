import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { DiffDialog } from "../../src/renderer/src/rail/DiffDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { GitDiff, GitDiffFile, GitDiffHunk } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The diff viewer (git-checkpoint plan step 14).
 *
 * The viewer itself is simple; what needs pinning is the hunk action. A staged
 * hunk must be a patch containing *only* that hunk, with git's original headers,
 * because a recomputed header is how a hunk silently lands in the wrong place.
 */

const PROJECT = "/work/app";

function hunk(overrides: Partial<GitDiffHunk> = {}): GitDiffHunk {
  return {
    header: "-1,3 +1,4",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    lines: [
      { kind: "context", oldLine: 1, newLine: 1, text: "line one" },
      { kind: "remove", oldLine: 2, newLine: null, text: "line two" },
      { kind: "add", oldLine: null, newLine: 2, text: "line TWO" },
      { kind: "context", oldLine: 3, newLine: 3, text: "line three" },
    ],
    ...overrides,
  };
}

function file(overrides: Partial<GitDiffFile> = {}): GitDiffFile {
  return {
    path: "src/a.ts",
    origPath: null,
    status: "modified",
    binary: false,
    added: 1,
    removed: 1,
    hunks: [hunk()],
    patchOldPath: "a/src/a.ts",
    patchNewPath: "b/src/a.ts",
    ...overrides,
  };
}

function diff(overrides: Partial<GitDiff> = {}): GitDiff {
  return { scope: "working", files: [file()], tooLarge: false, truncated: false, ...overrides };
}

let handles: ReturnType<typeof installBridge>;

function seed(overrides: Partial<GitDiff> = {}, loading = false): void {
  handles = installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    gitDiff: { projectPath: PROJECT, request: { path: "src/a.ts" }, diff: diff(overrides) },
    gitDiffLoading: loading,
    gitErrors: {},
  });
}

function lastAction() {
  return [...handles.gitCalls].reverse().find((call) => call.kind === "action");
}

beforeEach(() => {
  seed();
});

describe("rendering", () => {
  it("renders nothing without a diff", () => {
    useAppStore.setState({ gitDiff: null, gitDiffLoading: false });
    render(<DiffDialog />);
    expect(screen.queryByTestId("diff-dialog")).not.toBeInTheDocument();
  });

  it("shows a loading line", () => {
    useAppStore.setState({
      gitDiff: { projectPath: PROJECT, request: {}, diff: diff({ files: [] }) },
      gitDiffLoading: true,
    });
    render(<DiffDialog />);
    expect(screen.getByText("Loading diff…")).toBeInTheDocument();
  });

  it("shows the file, its letter and the add/remove counts", () => {
    render(<DiffDialog />);
    expect(screen.getByTestId("diff-file-src/a.ts")).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("diff-file-src/a.ts")).toHaveTextContent("M");
    expect(screen.getByTestId("diff-file-src/a.ts")).toHaveTextContent("+1");
    expect(screen.getByTestId("diff-file-src/a.ts")).toHaveTextContent("−1");
  });

  it("numbers both sides of a hunk", () => {
    render(<DiffDialog />);
    const hunkRow = screen.getByTestId("hunk-src/a.ts-0");
    expect(hunkRow).toHaveTextContent("line TWO");
    expect(hunkRow).toHaveTextContent("line two");
    // Old line 2 on the removed row, new line 2 on the added one.
    expect(hunkRow.textContent).toContain("2");
  });

  it("shows a rename with both names", () => {
    seed({ files: [file({ status: "renamed", origPath: "old/a.ts", path: "src/a.ts" })] });
    render(<DiffDialog />);
    expect(screen.getByTestId("diff-file-src/a.ts")).toHaveTextContent("old/a.ts → src/a.ts");
  });

  it("labels a binary file instead of drawing an empty diff", () => {
    seed({ files: [file({ binary: true, hunks: [], added: 0, removed: 0 })] });
    render(<DiffDialog />);
    expect(screen.getByTestId("binary-src/a.ts")).toHaveTextContent(/Binary file changed/);
  });

  it("explains an oversized diff", () => {
    seed({ tooLarge: true, files: [] });
    render(<DiffDialog />);
    expect(screen.getByTestId("diff-too-large")).toHaveTextContent(/too large/i);
  });

  it("explains an empty side", () => {
    seed({ files: [] });
    render(<DiffDialog />);
    expect(screen.getByTestId("diff-empty")).toHaveTextContent("No differences on this side.");
  });

  it("warns when the file list was capped", () => {
    seed({ truncated: true });
    render(<DiffDialog />);
    expect(screen.getByText(/Only the first files are shown/)).toBeInTheDocument();
  });

  it("closes from the header button", async () => {
    render(<DiffDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(useAppStore.getState().gitDiff).toBeNull();
  });
});

describe("hunk staging", () => {
  it("stages one hunk with a patch containing only that hunk", async () => {
    const second = hunk({
      header: "-20,2 +20,2",
      oldStart: 20,
      newStart: 20,
      lines: [
        { kind: "remove", oldLine: 20, newLine: null, text: "old tail" },
        { kind: "add", oldLine: null, newLine: 20, text: "new tail" },
      ],
    });
    seed({ files: [file({ hunks: [hunk(), second] })] });
    render(<DiffDialog />);

    await userEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of src/a.ts" }));

    await waitFor(() => expect(lastAction()?.payload).toBeDefined());
    const payload = lastAction()?.payload as {
      kind: string;
      path: string;
      patch: string;
    };
    expect(payload.kind).toBe("stage-hunk");
    expect(payload.path).toBe("src/a.ts");
    expect(payload.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(payload.patch).toContain("--- a/src/a.ts");
    expect(payload.patch).toContain("+++ b/src/a.ts");
    expect(payload.patch).toContain("@@ -1,3 +1,4 @@");
    expect(payload.patch).toContain("+line TWO");
    // The second hunk must not travel with it.
    expect(payload.patch).not.toContain("new tail");
    expect(payload.patch).not.toContain("@@ -20,2 +20,2 @@");
  });

  it("unstages a hunk when the staged side is shown", async () => {
    seed({ scope: "staged" });
    render(<DiffDialog />);

    await userEvent.click(screen.getByRole("button", { name: "Unstage hunk 1 of src/a.ts" }));

    await waitFor(() =>
      expect((lastAction()?.payload as { kind: string }).kind).toBe("unstage-hunk"),
    );
  });

  it("re-reads the same diff side after applying a hunk", async () => {
    render(<DiffDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of src/a.ts" }));

    await waitFor(() => expect(handles.gitCalls.some((call) => call.kind === "diff")).toBe(true));
    const diffCall = handles.gitCalls.find((call) => call.kind === "diff");
    expect(diffCall?.payload).toEqual({ path: "src/a.ts" });
  });

  it("offers no hunk action for a commit diff", () => {
    seed({ scope: "commit" });
    render(<DiffDialog />);
    expect(screen.queryByRole("button", { name: /Stage hunk/i })).not.toBeInTheDocument();
    expect(screen.getByText("Commit")).toBeInTheDocument();
  });
});
