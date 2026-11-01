import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GitBranchRow,
  GitSyncNote,
  GitSyncStatus,
  StashList,
} from "../../src/renderer/src/rail/GitSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  emptyGitSnapshot,
  type GitAction,
  type GitActionResult,
  type GitFileEntry,
  type GitRepoInfo,
  type GitSnapshot,
  type GitStashEntry,
} from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The Git section (git-checkpoint plan step 13).
 *
 * Branch state, the three sync verbs with the ref they would act on, the branch
 * menu, and stashes. Writes run directly now; the only confirmation here is
 * Drop stash, which deletes the entry.
 */

const PROJECT = "/work/app";

function repo(overrides: Partial<GitRepoInfo> = {}): GitRepoInfo {
  return {
    root: PROJECT,
    gitDir: `${PROJECT}/.git`,
    branch: "main",
    head: "abc1234",
    detached: false,
    empty: false,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    remotes: ["origin"],
    identity: { name: "Ada", email: "ada@example.com", source: "global" },
    ...overrides,
  };
}

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    ...emptyGitSnapshot(PROJECT),
    available: true,
    repo: repo(),
    ...overrides,
  };
}

/** A dirty file, so `Stash changes` has something to act on. */
const CHANGED: GitFileEntry = {
  path: "src/a.ts",
  origPath: null,
  status: "modified",
  staged: false,
  unstaged: true,
};

const STASH: GitStashEntry = {
  ref: "stash@{0}",
  index: 0,
  subject: "WIP on main: work in progress",
  at: 1_700_000_000_000,
};

let handles: ReturnType<typeof installBridge>;

function seed(
  value: GitSnapshot,
  options: {
    branches?: string[];
    action?: GitActionResult | ((action: GitAction) => Promise<GitActionResult>);
  } = {},
): void {
  handles = installBridge({
    git: value,
    branches: options.branches ?? ["main", "feat/x"],
    ...(options.action ? { gitAction: options.action } : {}),
  });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: { [PROJECT]: value },
    gitErrors: {},
    gitBranches: {},
  });
}

/**
 * Renders the git pieces the way the Source Control panel stacks them in its top
 * block: the compact branch row (which owns the sync buttons), the conditional
 * reason line, then the collapsible stash list.
 */
function renderGit(): void {
  render(
    <>
      <GitBranchRow projectPath={PROJECT} />
      <GitSyncStatus projectPath={PROJECT} />
      <GitSyncNote projectPath={PROJECT} />
      <StashList projectPath={PROJECT} />
    </>,
  );
}

function lastAction() {
  return [...handles.gitCalls].reverse().find((call) => call.kind === "action");
}

function actions() {
  return handles.gitCalls.filter((call) => call.kind === "action").map((call) => call.payload);
}

beforeEach(() => {
  seed(snapshot());
});

describe("branch state", () => {
  it("shows the branch, its upstream and the divergence", () => {
    renderGit();
    expect(screen.getByTestId("git-branch")).toHaveTextContent("main");
    expect(screen.getByTestId("git-upstream")).toHaveTextContent("origin/main");
    expect(screen.getByText("↑2")).toBeInTheDocument();
    expect(screen.getByText("↓1")).toBeInTheDocument();
  });

  it("says a detached HEAD is detached", () => {
    seed(snapshot({ repo: repo({ branch: null, detached: true, upstream: null }) }));
    renderGit();
    expect(screen.getByTestId("git-branch")).toHaveTextContent("detached at abc1234");
  });

  it("says an empty repository has no commits", () => {
    seed(
      snapshot({ repo: repo({ head: null, empty: true, upstream: null, ahead: 0, behind: 0 }) }),
    );
    renderGit();
    expect(screen.getByTestId("git-branch")).toHaveTextContent("no commits yet");
  });

  it("hides the chips when there is nothing to push or pull", () => {
    seed(
      snapshot({
        repo: repo({ ahead: 0, behind: 0 }),
      }),
    );
    renderGit();
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument();
  });

  it("renders nothing for an unavailable repository", () => {
    seed(emptyGitSnapshot(PROJECT, "not_a_repo"));
    renderGit();
    // All three pieces bail out, not just the branch bar that owns the id.
    expect(screen.queryByTestId("git-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-sync")).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-stashes-section")).not.toBeInTheDocument();
  });
});

describe("sync", () => {
  it("names the upstream in the pull and push labels", () => {
    renderGit();
    expect(screen.getByRole("button", { name: "Pull from origin/main" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Fetch from origin" })).toBeEnabled();
  });

  it("disables pull without an upstream and explains the first push", () => {
    seed(snapshot({ repo: repo({ upstream: null, ahead: 0, behind: 0 }) }));
    renderGit();
    expect(screen.getByRole("button", { name: "Pull from origin/main" })).toBeDisabled();
    // A branch with no upstream can still push: the first push sets it.
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toBeEnabled();
    expect(screen.getByTestId("git-sync-note")).toHaveTextContent(/first push sets origin\/main/);
  });

  it("disables every verb without a remote", () => {
    seed(snapshot({ repo: repo({ remotes: [], upstream: null }) }));
    renderGit();
    expect(screen.getByRole("button", { name: "Fetch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
    expect(screen.getByTestId("git-sync-note")).toHaveTextContent(/No remote is configured/);
  });

  it("fetches, pulls and pushes with the right action", async () => {
    renderGit();

    await userEvent.click(screen.getByRole("button", { name: "Fetch from origin" }));
    await userEvent.click(screen.getByRole("button", { name: "Pull from origin/main" }));
    await userEvent.click(screen.getByRole("button", { name: "Push to origin/main" }));

    expect(actions()).toEqual([
      { kind: "fetch", remote: "origin" },
      { kind: "pull" },
      { kind: "push" },
    ]);
  });

  it("runs a network verb directly", async () => {
    renderGit();

    await userEvent.click(screen.getByRole("button", { name: "Push to origin/main" }));

    expect(actions()).toEqual([{ kind: "push" }]);
  });

  it("shows a spinner and disables every verb while a network action runs", async () => {
    let resolveAction!: (value: GitActionResult) => void;
    const pending = new Promise<GitActionResult>((done) => {
      resolveAction = done;
    });
    seed(snapshot(), { action: () => pending });
    renderGit();

    await userEvent.click(screen.getByRole("button", { name: "Push to origin/main" }));

    expect(screen.getByTestId("git-sync")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("git-sync-spinner-push")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch from origin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull from origin/main" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toBeDisabled();
    expect(screen.getByTestId("git-sync-status")).toHaveTextContent("Pushing to origin/main…");

    resolveAction({ ok: true, message: "Pushed." });
    await waitFor(() =>
      expect(screen.queryByTestId("git-sync-spinner-push")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toBeEnabled();
    expect(screen.getByTestId("git-sync-status")).toHaveTextContent("Pushed.");
  });

  it("shows a failure with a Retry that replays the action", async () => {
    seed(snapshot(), {
      action: {
        ok: false,
        error: {
          code: "auth_required",
          message: "Authentication failed",
          fix: "Prime the credential helper.",
          recoverable: true,
        },
      },
    });
    renderGit();

    await userEvent.click(screen.getByRole("button", { name: "Push to origin/main" }));
    const line = await screen.findByTestId("git-sync-status");
    expect(line).toHaveAttribute("role", "alert");
    expect(line).toHaveTextContent("Authentication failed Prime the credential helper.");

    await userEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(actions()).toEqual([{ kind: "push" }, { kind: "push" }]));
  });

  it("dismisses the status line", async () => {
    seed(snapshot(), { action: { ok: true, message: "Pushed." } });
    renderGit();

    await userEvent.click(screen.getByRole("button", { name: "Push to origin/main" }));
    const line = await screen.findByTestId("git-sync-status");
    await userEvent.click(within(line).getByRole("button", { name: "Dismiss sync status" }));
    expect(screen.queryByTestId("git-sync-status")).not.toBeInTheDocument();
  });
});

describe("branch list", () => {
  it("lists the local branches and disables the current one", async () => {
    renderGit();
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));

    const current = await screen.findByRole("button", { name: "Switch to main" });
    expect(current).toBeDisabled();
    expect(current).toHaveTextContent("(current)");
    expect(screen.getByRole("button", { name: "Switch to feat/x" })).toBeEnabled();
    // Opening the list asks main for the branches.
    expect(handles.gitCalls.some((call) => call.kind === "branches")).toBe(true);
  });

  it("switches immediately when the tree is clean", async () => {
    renderGit();
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Switch to feat/x" }));

    await waitFor(() =>
      expect(lastAction()?.payload).toEqual({ kind: "checkout-branch", branch: "feat/x" }),
    );
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("confirms a switch when the tree is dirty", async () => {
    seed(
      snapshot({
        changed: [
          { path: "a.ts", origPath: null, status: "modified", staged: false, unstaged: true },
        ],
      }),
    );
    renderGit();
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Switch to feat/x" }));

    // Nothing dispatched until the user confirms.
    expect(actions()).toEqual([]);
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent("feat/x");

    await userEvent.click(screen.getByRole("button", { name: "Switch anyway" }));
    await waitFor(() =>
      expect(lastAction()?.payload).toEqual({ kind: "checkout-branch", branch: "feat/x" }),
    );
  });

  it("creates a branch from the list", async () => {
    renderGit();
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create branch…" }));

    await userEvent.type(screen.getByLabelText("New branch name"), "feat/new-thing");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(lastAction()?.payload).toEqual({
        kind: "create-branch",
        branch: "feat/new-thing",
      }),
    );
  });
});

describe("stashes", () => {
  /** Stashes start folded away; every body assertion has to open them first. */
  async function expand(): Promise<void> {
    await userEvent.click(screen.getByTestId("git-stashes-toggle"));
  }

  it("starts collapsed, with the header and count still visible", () => {
    seed(snapshot({ stashes: [STASH] }));
    renderGit();

    expect(screen.getByTestId("git-stashes-section")).toBeInTheDocument();
    expect(screen.getByTestId("git-stashes-toggle")).toHaveAttribute("aria-expanded", "false");
    // The facts that matter while folded: how many, and the action.
    expect(screen.getByTestId("git-stashes-section")).toHaveTextContent("Stashes");
    expect(screen.getByTestId("git-stashes-section")).toHaveTextContent("1");
    // Neither body form is rendered.
    expect(screen.queryByTestId("git-stashes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-stashes-empty")).not.toBeInTheDocument();
  });

  it("says when there is nothing stashed, once expanded", async () => {
    renderGit();
    await expand();
    expect(screen.getByTestId("git-stashes-empty")).toHaveTextContent("No stashes.");
  });

  it("reveals the list on click and remembers it stays open", async () => {
    seed(snapshot({ stashes: [STASH] }));
    renderGit();

    await expand();
    expect(screen.getByTestId("git-stashes-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("git-stashes")).toBeInTheDocument();
    // The fold is a preference, not component state.
    expect(useAppStore.getState().prefs.rail.collapsed.stashes).toBe(false);
  });

  it("collapses again on a second click", async () => {
    seed(snapshot({ stashes: [STASH] }));
    renderGit();

    await expand();
    await userEvent.click(screen.getByTestId("git-stashes-toggle"));
    expect(screen.queryByTestId("git-stashes")).not.toBeInTheDocument();
    expect(useAppStore.getState().prefs.rail.collapsed.stashes).toBe(true);
  });

  it("lists and restores a stash", async () => {
    seed(snapshot({ stashes: [STASH] }));
    renderGit();
    await expand();

    expect(screen.getByTestId("stash-0")).toHaveTextContent("WIP on main: work in progress");

    await userEvent.click(screen.getByRole("button", { name: "Restore stash@{0}" }));

    expect(actions()).toEqual([{ kind: "stash-pop", index: 0 }]);
  });

  it("confirms before dropping a stash", async () => {
    seed(snapshot({ stashes: [STASH] }));
    renderGit();
    await expand();

    await userEvent.click(screen.getByRole("button", { name: "Drop stash@{0}" }));

    // Nothing is deleted until the confirmation names the stash.
    expect(actions()).toEqual([]);
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(
      "Drop WIP on main: work in progress?",
    );

    await userEvent.click(screen.getByRole("button", { name: "Drop stash" }));

    expect(actions()).toEqual([{ kind: "stash-drop", index: 0 }]);
  });

  it("keeps the stash when the drop confirmation is cancelled", async () => {
    seed(snapshot({ stashes: [STASH] }));
    renderGit();
    await expand();

    await userEvent.click(screen.getByRole("button", { name: "Drop stash@{0}" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(actions()).toEqual([]);
  });

  it("stashes the working tree without expanding the list", async () => {
    // `Stash changes` is disabled with nothing to stash, so the tree must be dirty.
    seed(snapshot({ changed: [CHANGED] }));
    renderGit();
    // The header action stays outside the fold: stashing is what you do while
    // looking at a change, not after digging through a list.
    await userEvent.click(screen.getByRole("button", { name: "Stash changes" }));
    expect(lastAction()?.payload).toEqual({ kind: "stash-push", message: null });
    expect(useAppStore.getState().prefs.rail.collapsed.stashes).toBe(true);
  });

  it("disables Stash changes when there is nothing to stash", () => {
    seed(snapshot({ changed: [] }));
    renderGit();
    expect(screen.getByRole("button", { name: "Stash changes" })).toBeDisabled();
  });
});

describe("the compact branch row", () => {
  it("keeps the four facts on one line and the sync verbs beside them", () => {
    renderGit();
    const row = screen.getByTestId("git-section");
    // Where am I, how far off, how do I switch, how do I move.
    expect(within(row).getByTestId("git-branch")).toBeInTheDocument();
    expect(within(row).getByTestId("git-sync")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Switch branch" })).toBeInTheDocument();
    expect(within(row).getByText("↑2")).toBeInTheDocument();
    expect(within(row).getByText("↓1")).toBeInTheDocument();
  });

  it("makes the branch name itself the switch button", () => {
    renderGit();
    // One control, not a label plus a separate "Switch" link: that was a whole
    // row (and a 320 px column cannot spare it).
    const branchButton = screen.getByTestId("git-branch");
    expect(branchButton).toHaveAttribute("aria-label", "Switch branch");
    expect(branchButton).toHaveTextContent("main");
    expect(branchButton).toHaveAttribute("aria-expanded", "false");
    expect(branchButton.tagName).toBe("BUTTON");
  });

  it("keeps the upstream text in the DOM even though it is not a row", () => {
    renderGit();
    // Screen readers and the existing assertions still read it; visible space is
    // spent only on the note line, and only when something is blocked.
    expect(screen.getByTestId("git-upstream")).toHaveTextContent("origin/main");
    expect(screen.queryByTestId("git-sync-note")).not.toBeInTheDocument();
  });

  it("shows the reason line only when a verb is unavailable", () => {
    seed(snapshot({ repo: repo({ remotes: [], upstream: null }) }));
    renderGit();
    expect(screen.getByTestId("git-sync-note")).toHaveTextContent(/No remote is configured/);
  });

  it("puts the disabled reason in the button's title", () => {
    seed(snapshot({ repo: repo({ remotes: [], upstream: null }) }));
    renderGit();
    expect(screen.getByRole("button", { name: "Pull" })).toHaveAttribute(
      "title",
      expect.stringMatching(/No remote is configured/),
    );
  });

  it("names the visible frontier for each verb without a target", () => {
    seed(snapshot({ repo: repo({ upstream: null, ahead: 0, behind: 0 }) }));
    renderGit();
    // A branch with no upstream still knows where the first push would go.
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toHaveAttribute(
      "title",
      "Push to origin/main",
    );
  });
});

describe("the stash toggle contract", () => {
  it("points aria-controls at the body it folds", async () => {
    seed(snapshot({ stashes: [STASH] }));
    renderGit();
    const toggle = screen.getByTestId("git-stashes-toggle");
    const controlled = toggle.getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    await userEvent.click(toggle);
    const list = document.getElementById(controlled!);
    expect(list).not.toBeNull();
    expect(list!.getAttribute("data-testid")).toBe("git-stashes");
    expect(within(list!).getByTestId("stash-0")).toBeInTheDocument();
  });
});
