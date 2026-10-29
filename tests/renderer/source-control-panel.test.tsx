import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SourceControlPanel } from "../../src/renderer/src/rail/SourceControlPanel";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyGitSnapshot, type GitRepoInfo, type GitSnapshot } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The Source Control menu body.
 *
 * The composition is the contract here, not the git behaviour (that lives in
 * `rail-git`/`rail-changes`/`rail-commit`/`rail-history`): VS Code's order —
 * composer, sync verbs, changes, stashes, history — with only the list region
 * scrolling, so the message box and Fetch/Pull/Push cannot be scrolled away.
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
    ahead: 1,
    behind: 0,
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

function seed(value: GitSnapshot): void {
  installBridge({ git: value });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: { [PROJECT]: value },
    gitError: null,
    gitLog: {},
    gitConsentGranted: true,
  });
}

beforeEach(() => {
  seed(snapshot());
});

describe("composition", () => {
  it("stacks the regions in VS Code's order", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);

    const ids = ["git-section", "commit-box", "git-sync", "changes-section", "git-stashes-section"];
    const nodes = ids.map((id) => screen.getByTestId(id));

    for (let i = 0; i < nodes.length - 1; i += 1) {
      const before = nodes[i]!;
      const after = nodes[i + 1]!;
      // DOCUMENT_POSITION_FOLLOWING: `after` comes later in document order.
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${ids[i]} must precede ${ids[i + 1]}`,
      ).toBeTruthy();
    }
  });

  it("puts the branch line above the composer", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    const branch = screen.getByTestId("git-branch");
    const composer = screen.getByTestId("commit-box");
    expect(
      branch.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("names the panel for tests and for assistive technology", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    expect(screen.getByTestId("source-control-panel")).toBeInTheDocument();
  });
});

describe("scrolling", () => {
  it("keeps the composer and the sync verbs outside the scroll container", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    const scroller = screen.getByTestId("source-control-scroll");

    for (const id of ["git-section", "commit-box", "git-sync"]) {
      // A pinned region must not live inside the scroller, or it scrolls away.
      expect(scroller.contains(screen.getByTestId(id)), id).toBe(false);
    }
  });

  it("puts the lists inside it", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    const scroller = screen.getByTestId("source-control-scroll");
    for (const id of ["changes-section", "git-stashes-section"]) {
      expect(scroller.contains(screen.getByTestId(id)), id).toBe(true);
    }
    expect(scroller).toHaveClass("overflow-y-auto");
  });

  it("has exactly one scroll container of its own", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    expect(
      screen.getByTestId("source-control-panel").querySelectorAll(".overflow-y-auto"),
    ).toHaveLength(1);
  });
});

describe("degraded repositories", () => {
  it("still renders the panel shell when git cannot read the folder", () => {
    seed(emptyGitSnapshot(PROJECT, "not_a_repo"));
    render(<SourceControlPanel projectPath={PROJECT} />);
    // The shell stays so the menu is never a blank column; the bodies explain.
    expect(screen.getByTestId("source-control-panel")).toBeInTheDocument();
    expect(screen.getByTestId("changes-empty")).toBeInTheDocument();
    // The git facts that need a repository are absent.
    expect(screen.queryByTestId("git-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-sync")).not.toBeInTheDocument();
  });

  it("keeps the commit box's reason when no identity is configured", () => {
    seed(
      snapshot({
        // `identity` is `| null`: an empty object is still truthy, and only a
        // null identity makes the box say who git needs.
        repo: repo({ identity: null }),
        // Readiness checks the tree, then the message, then the identity — so the
        // fixture needs a change *and* a typed message to reach this reason.
        changed: [
          { path: "a.ts", origPath: null, status: "modified", staged: false, unstaged: true },
        ],
      }),
    );
    render(<SourceControlPanel projectPath={PROJECT} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "fix: x" } });
    expect(screen.getByTestId("commit-reason")).toHaveTextContent("Tell git who you are.");
  });
});
