import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { GitSection } from "../../src/renderer/src/rail/GitSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  emptyGitSnapshot,
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
 * menu, stashes — and the write-consent gate, which must ask exactly once per
 * session and never intercept fetch/pull/push.
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

const STASH: GitStashEntry = {
  ref: "stash@{0}",
  index: 0,
  subject: "WIP on main: work in progress",
  at: 1_700_000_000_000,
};

let handles: ReturnType<typeof installBridge>;

function seed(
  value: GitSnapshot,
  options: { consented?: boolean; branches?: string[] } = {},
): void {
  handles = installBridge({ git: value, branches: options.branches ?? ["main", "feat/x"] });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: { [PROJECT]: value },
    gitError: null,
    gitBranches: {},
    gitConsentGranted: options.consented ?? true,
    gitConsentPrompt: null,
  });
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
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.getByTestId("git-branch")).toHaveTextContent("main");
    expect(screen.getByTestId("git-upstream")).toHaveTextContent("origin/main");
    expect(screen.getByText("↑2")).toBeInTheDocument();
    expect(screen.getByText("↓1")).toBeInTheDocument();
  });

  it("says a detached HEAD is detached", () => {
    seed(snapshot({ repo: repo({ branch: null, detached: true, upstream: null }) }));
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.getByTestId("git-branch")).toHaveTextContent("detached at abc1234");
  });

  it("says an empty repository has no commits", () => {
    seed(
      snapshot({ repo: repo({ head: null, empty: true, upstream: null, ahead: 0, behind: 0 }) }),
    );
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.getByTestId("git-branch")).toHaveTextContent("no commits yet");
  });

  it("hides the chips when there is nothing to push or pull", () => {
    seed(
      snapshot({
        repo: repo({ ahead: 0, behind: 0 }),
      }),
    );
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument();
  });

  it("renders nothing for an unavailable repository", () => {
    seed(emptyGitSnapshot(PROJECT, "not_a_repo"));
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.queryByTestId("git-section")).not.toBeInTheDocument();
  });
});

describe("sync", () => {
  it("names the upstream in the pull and push labels", () => {
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.getByRole("button", { name: "Pull from origin/main" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Fetch from origin" })).toBeEnabled();
  });

  it("disables pull without an upstream and explains the first push", () => {
    seed(snapshot({ repo: repo({ upstream: null, ahead: 0, behind: 0 }) }));
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.getByRole("button", { name: "Pull from origin/main" })).toBeDisabled();
    // A branch with no upstream can still push: the first push sets it.
    expect(screen.getByRole("button", { name: "Push to origin/main" })).toBeEnabled();
    expect(screen.getByTestId("git-sync-note")).toHaveTextContent(/first push sets origin\/main/);
  });

  it("disables every verb without a remote", () => {
    seed(snapshot({ repo: repo({ remotes: [], upstream: null }) }));
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.getByRole("button", { name: "Fetch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
    expect(screen.getByTestId("git-sync-note")).toHaveTextContent(/No remote is configured/);
  });

  it("fetches, pulls and pushes with the right action", async () => {
    render(<GitSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch from origin" }));
    await userEvent.click(screen.getByRole("button", { name: "Pull from origin/main" }));
    await userEvent.click(screen.getByRole("button", { name: "Push to origin/main" }));

    expect(actions()).toEqual([
      { kind: "fetch", remote: null },
      { kind: "pull" },
      { kind: "push" },
    ]);
  });

  it("never asks for consent before a network verb", async () => {
    seed(snapshot(), { consented: false });
    render(<GitSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Push to origin/main" }));

    expect(useAppStore.getState().gitConsentPrompt).toBeNull();
    expect(actions()).toEqual([{ kind: "push" }]);
  });
});

describe("branch list", () => {
  it("lists the local branches and disables the current one", async () => {
    render(<GitSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));

    const current = await screen.findByRole("button", { name: "Switch to main" });
    expect(current).toBeDisabled();
    expect(current).toHaveTextContent("(current)");
    expect(screen.getByRole("button", { name: "Switch to feat/x" })).toBeEnabled();
    // Opening the list asks main for the branches.
    expect(handles.gitCalls.some((call) => call.kind === "branches")).toBe(true);
  });

  it("switches immediately when the tree is clean", async () => {
    render(<GitSection projectPath={PROJECT} />);
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
    render(<GitSection projectPath={PROJECT} />);
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
    render(<GitSection projectPath={PROJECT} />);
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
  it("says when there is nothing stashed", () => {
    render(<GitSection projectPath={PROJECT} />);
    expect(screen.getByTestId("git-stashes-empty")).toHaveTextContent("No stashes.");
  });

  it("lists, restores and drops a stash", async () => {
    seed(snapshot({ stashes: [STASH] }));
    render(<GitSection projectPath={PROJECT} />);

    expect(screen.getByTestId("stash-0")).toHaveTextContent("WIP on main: work in progress");

    await userEvent.click(screen.getByRole("button", { name: "Restore stash@{0}" }));
    await userEvent.click(screen.getByRole("button", { name: "Drop stash@{0}" }));

    expect(actions()).toEqual([
      { kind: "stash-pop", index: 0 },
      { kind: "stash-drop", index: 0 },
    ]);
  });

  it("stashes the working tree on request", async () => {
    render(<GitSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Stash changes" }));
    expect(lastAction()?.payload).toEqual({ kind: "stash-push", message: null });
  });
});

describe("write consent", () => {
  it("asks once and does not dispatch before the answer", async () => {
    seed(snapshot(), { consented: false });
    render(<GitSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Stash changes" }));

    expect(actions()).toEqual([]);
    expect(useAppStore.getState().gitConsentPrompt).toEqual({
      projectPath: PROJECT,
      action: { kind: "stash-push", message: null },
    });
  });

  it("runs the waiting write when consent is confirmed, and remembers", async () => {
    seed(snapshot({ stashes: [STASH] }), { consented: false });
    render(<GitSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Stash changes" }));
    await useAppStore.getState().confirmGitConsent();

    expect(useAppStore.getState().gitConsentGranted).toBe(true);
    expect(actions()).toEqual([{ kind: "stash-push", message: null }]);

    // The next write runs without a prompt.
    await userEvent.click(screen.getByRole("button", { name: "Restore stash@{0}" }));
    expect(useAppStore.getState().gitConsentPrompt).toBeNull();
  });

  it("drops the pending write when the user declines", () => {
    seed(snapshot(), { consented: false });
    useAppStore.setState({
      gitConsentPrompt: { projectPath: PROJECT, action: { kind: "init" } },
    });
    useAppStore.getState().cancelGitConsent();
    expect(useAppStore.getState().gitConsentPrompt).toBeNull();
    expect(useAppStore.getState().gitConsentGranted).toBe(false);
  });
});
