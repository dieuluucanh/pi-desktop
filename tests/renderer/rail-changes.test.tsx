import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ChangesSection } from "../../src/renderer/src/rail/ChangesSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyGitSnapshot, type GitFileEntry, type GitSnapshot } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The Changes section (git-checkpoint plan step 11).
 *
 * The two lists, the letters, the group actions and — most importantly — the
 * confirmations: a discard must never run before the user has seen the exact
 * file, and an untracked discard must say it moves the file to the trash rather
 * than deleting it.
 */

const PROJECT = "/work/app";

function file(path: string, overrides: Partial<GitFileEntry> = {}): GitFileEntry {
  return {
    path,
    origPath: null,
    status: "modified",
    staged: false,
    unstaged: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  const base = emptyGitSnapshot(PROJECT);
  return {
    ...base,
    available: true,
    repo: {
      root: PROJECT,
      gitDir: `${PROJECT}/.git`,
      branch: "main",
      head: "abc1234",
      detached: false,
      empty: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      remotes: [],
      identity: { name: "Ada", email: "ada@example.com", source: "global" },
    },
    ...overrides,
  };
}

/** Puts a snapshot in the store under the project the section reads. */
function seed(value: GitSnapshot, gitError: string | null = null): void {
  useAppStore.setState({
    git: { [PROJECT]: value },
    gitError,
  });
}

let handles: ReturnType<typeof installBridge>;

/**
 * The last *mutating* call the UI dispatched. A successful action is followed by
 * a refresh, so the very last bridge call is not the action under test.
 */
function lastAction() {
  return [...handles.gitCalls].reverse().find((call) => call.kind === "action");
}

beforeEach(() => {
  // One bridge per test: its `gitCalls` record is how the assertions read the
  // action the UI dispatched.
  handles = installBridge({ git: snapshot() });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: {},
    gitError: null,
    // These cases exercise the section's own behaviour; the consent gate has its
    // own test in `rail-git.test.tsx`.
    gitConsentGranted: true,
    gitConsentPrompt: null,
  });
});

describe("grouping", () => {
  it("shows both groups with their counts", () => {
    seed(
      snapshot({
        staged: [file("src/a.ts", { staged: true, unstaged: false })],
        changed: [file("src/b.ts"), file("src/c.ts")],
      }),
    );
    render(<ChangesSection projectPath={PROJECT} />);

    expect(screen.getByTestId("changes-group-staged")).toHaveTextContent("Staged Changes");
    expect(screen.getByTestId("changes-group-staged")).toHaveTextContent("1");
    expect(screen.getByTestId("changes-group-changed")).toHaveTextContent("Changes");
    expect(screen.getByTestId("changes-group-changed")).toHaveTextContent("2");
  });

  it("omits a group that has no files", () => {
    seed(snapshot({ changed: [file("src/b.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.queryByTestId("changes-group-staged")).not.toBeInTheDocument();
    expect(screen.getByTestId("changes-group-changed")).toBeInTheDocument();
  });

  it("renders the status letter for each file", () => {
    seed(
      snapshot({
        staged: [
          file("a.ts", { status: "added", staged: true, unstaged: false }),
          file("d.ts", { status: "deleted", staged: true, unstaged: false }),
        ],
        changed: [
          file("m.ts"),
          file("u.ts", { status: "untracked" }),
          file("r.ts", { status: "renamed", origPath: "old-r.ts" }),
        ],
      }),
    );
    render(<ChangesSection projectPath={PROJECT} />);

    expect(screen.getByTestId("status-a.ts")).toHaveTextContent("A");
    expect(screen.getByTestId("status-d.ts")).toHaveTextContent("D");
    expect(screen.getByTestId("status-m.ts")).toHaveTextContent("M");
    expect(screen.getByTestId("status-u.ts")).toHaveTextContent("U");
    expect(screen.getByTestId("status-r.ts")).toHaveTextContent("R");
  });

  it("shows both names for a rename", () => {
    seed(
      snapshot({
        staged: [file("new.ts", { status: "renamed", origPath: "old.ts", staged: true })],
      }),
    );
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("change-row-new.ts")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("change-row-new.ts")).toHaveTextContent("new.ts");
  });
});

describe("per-file actions", () => {
  it("stages one file", async () => {
    seed(snapshot({ changed: [file("src/a.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Stage src/a.ts" }));

    expect(lastAction()).toEqual({
      kind: "action",
      projectPath: PROJECT,
      payload: { kind: "stage", paths: ["src/a.ts"] },
    });
  });

  it("unstages one file from the staged group", async () => {
    seed(snapshot({ staged: [file("src/a.ts", { staged: true, unstaged: false })] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Unstage src/a.ts" }));

    expect(lastAction()?.payload).toEqual({
      kind: "unstage",
      paths: ["src/a.ts"],
    });
  });

  it("opens the working-tree diff for a tracked file", async () => {
    seed(snapshot({ changed: [file("src/a.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Show diff for src/a.ts" }));

    expect(handles.gitCalls.at(-1)).toEqual({
      kind: "diff",
      projectPath: PROJECT,
      payload: { path: "src/a.ts", staged: false },
    });
  });

  it("opens the staged diff from the staged group", async () => {
    seed(snapshot({ staged: [file("src/a.ts", { staged: true, unstaged: false })] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Show diff for src/a.ts" }));

    expect(handles.gitCalls.at(-1)?.payload).toEqual({
      path: "src/a.ts",
      staged: true,
    });
  });

  it("does not offer a diff for an untracked file", () => {
    seed(snapshot({ changed: [file("new.ts", { status: "untracked" })] }));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.queryByRole("button", { name: "Show diff for new.ts" })).not.toBeInTheDocument();
  });

  it("does not offer a discard on a staged-only row", () => {
    seed(snapshot({ staged: [file("src/a.ts", { staged: true, unstaged: false })] }));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(
      screen.queryByRole("button", { name: "Discard changes in src/a.ts" }),
    ).not.toBeInTheDocument();
  });
});

describe("group actions", () => {
  it("stages every changed file", async () => {
    seed(snapshot({ changed: [file("a.ts"), file("b.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Stage all" }));

    expect(lastAction()?.payload).toEqual({
      kind: "stage",
      paths: ["a.ts", "b.ts"],
    });
  });

  it("unstages every staged file", async () => {
    seed(
      snapshot({
        staged: [file("a.ts", { staged: true }), file("b.ts", { staged: true })],
      }),
    );
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Unstage all" }));

    expect(lastAction()?.payload).toEqual({
      kind: "unstage",
      paths: ["a.ts", "b.ts"],
    });
  });
});

describe("discard", () => {
  it("asks before touching a tracked file", async () => {
    seed(snapshot({ changed: [file("src/a.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes in src/a.ts" }));

    // Nothing dispatched yet: the dialog names the exact file first.
    expect(handles.gitCalls.some((call) => call.kind === "action")).toBe(false);
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(/returns to the version/i);
  });

  it("dispatches a tracked discard on confirmation", async () => {
    seed(snapshot({ changed: [file("src/a.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes in src/a.ts" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(lastAction()?.payload).toEqual({
      kind: "discard",
      paths: ["src/a.ts"],
      untracked: false,
    });
  });

  it("cancels without dispatching", async () => {
    seed(snapshot({ changed: [file("src/a.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes in src/a.ts" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(handles.gitCalls.some((call) => call.kind === "action")).toBe(false);
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("says 'Move to trash' for an untracked file", async () => {
    seed(snapshot({ changed: [file("scratch.ts", { status: "untracked" })] }));
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes in scratch.ts" }));

    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(/system trash/i);
    await userEvent.click(screen.getByRole("button", { name: "Move to trash" }));

    expect(lastAction()?.payload).toEqual({
      kind: "discard",
      paths: ["scratch.ts"],
      untracked: true,
    });
  });
});

describe("empty states", () => {
  it("says the tree is clean", () => {
    seed(snapshot());
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-empty")).toHaveTextContent("No changes");
  });

  it("says a repository with no commits has nothing tracked", () => {
    seed(snapshot({ repo: { ...snapshot().repo!, empty: true, head: null } }));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-empty")).toHaveTextContent("No commits yet");
  });

  it("offers to initialize a plain folder", async () => {
    seed(emptyGitSnapshot(PROJECT, "not_a_repo"));
    render(<ChangesSection projectPath={PROJECT} />);

    expect(screen.getByTestId("changes-empty")).toHaveTextContent("Not a git repository");
    await userEvent.click(screen.getByRole("button", { name: "Initialize repository" }));

    expect(lastAction()?.payload).toEqual({
      kind: "init",
    });
  });

  it("explains a missing git binary without offering init", () => {
    seed(emptyGitSnapshot(PROJECT, "git_missing"));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-empty")).toHaveTextContent("Git is not installed");
    expect(screen.queryByRole("button", { name: "Initialize repository" })).not.toBeInTheDocument();
  });

  it("explains a bare repository", () => {
    seed(emptyGitSnapshot(PROJECT, "bare_repo"));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-empty")).toHaveTextContent("Bare repository");
  });

  it("explains an in-flight git operation", () => {
    seed({
      ...emptyGitSnapshot(PROJECT, "operation_in_progress"),
      message: "a rebase is in progress",
    });
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-empty")).toHaveTextContent("Git is busy");
    expect(screen.getByTestId("changes-empty")).toHaveTextContent(/rebase/);
  });

  it("explains a missing folder", () => {
    seed(emptyGitSnapshot(PROJECT, "no_folder"));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-empty")).toHaveTextContent("Folder not found");
  });
});

describe("notices", () => {
  it("warns that the list is capped", () => {
    seed(snapshot({ changed: [file("a.ts")], truncated: true }));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-truncated")).toHaveTextContent(/more changed paths/i);
  });

  it("shows and dismisses a git error", async () => {
    seed(snapshot({ changed: [file("a.ts")] }), "index.lock exists");
    render(<ChangesSection projectPath={PROJECT} />);

    expect(screen.getByTestId("git-error")).toHaveTextContent("index.lock exists");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss git error" }));
    expect(screen.queryByTestId("git-error")).not.toBeInTheDocument();
  });

  it("refreshes on demand", async () => {
    seed(snapshot({ changed: [file("a.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    expect(handles.gitCalls.at(-1)?.kind).toBe("refresh");
  });

  it("no longer owns the commit composer", () => {
    // The Source Control panel pins the composer above the lists (VS Code's
    // order), so the section must not render it a second time.
    seed(snapshot({ changed: [file("a.ts")] }));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.getByTestId("changes-section")).toBeInTheDocument();
    expect(screen.queryByTestId("commit-box")).not.toBeInTheDocument();
  });
});
