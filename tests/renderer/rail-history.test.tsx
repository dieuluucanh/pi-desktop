import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { HistorySection, HISTORY_PAGE_SIZE } from "../../src/renderer/src/rail/HistorySection";
import { absoluteTime, commitChips, relativeTime } from "../../src/renderer/src/rail/history-view";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyGitSnapshot, type GitCommitEntry, type GitSnapshot } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The History section (git-checkpoint plan step 15).
 *
 * The log is a paged list whose rows are the entry point to the diff viewer, so
 * the tests check what a row says, that a click opens the right commit, and that
 * "Load more" advances the cursor rather than reloading page one.
 */

const PROJECT = "/work/app";
const NOW = 1_700_000_000_000;

function commit(overrides: Partial<GitCommitEntry> = {}): GitCommitEntry {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    subject: "feat: add the rail",
    author: "Ada",
    at: NOW - 5 * 60_000,
    refs: [],
    head: false,
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
      head: "aaaaaaa",
      detached: false,
      empty: false,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      remotes: ["origin"],
      identity: { name: "Ada", email: "ada@example.com", source: "global" },
    },
    ...overrides,
  };
}

let handles: ReturnType<typeof installBridge>;

function seed(
  options: {
    snapshot?: GitSnapshot;
    entries?: GitCommitEntry[];
    hasMore?: boolean;
    loading?: boolean;
  } = {},
): void {
  handles = installBridge({ gitLog: options.entries ?? [commit()] });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: { [PROJECT]: options.snapshot ?? snapshot() },
    gitLog: {
      [PROJECT]: {
        entries: options.entries ?? [commit()],
        loading: options.loading ?? false,
        hasMore: options.hasMore ?? false,
      },
    },
    gitConsentGranted: true,
    gitConsentPrompt: null,
    gitError: null,
  });
}

beforeEach(() => {
  seed();
});

describe("relative time", () => {
  it("uses a terse scale", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
    expect(relativeTime(NOW - 3 * 7 * 86_400_000, NOW)).toBe("3w ago");
    expect(relativeTime(NOW - 90 * 86_400_000, NOW)).toBe("3mo ago");
    expect(relativeTime(NOW - 800 * 86_400_000, NOW)).toBe("2y ago");
  });

  it("never reports a negative age", () => {
    expect(relativeTime(NOW + 60_000, NOW)).toBe("just now");
  });

  it("says unknown for a missing timestamp", () => {
    expect(relativeTime(0, NOW)).toBe("unknown");
    expect(relativeTime(Number.NaN, NOW)).toBe("unknown");
    expect(absoluteTime(0)).toBe("unknown");
  });
});

describe("commit chips", () => {
  it("keeps the refs and adds the upstream to the head commit", () => {
    const entry = commit({ refs: ["main"], head: true });
    expect(commitChips(entry, "origin/main")).toEqual(["main", "origin/main"]);
  });

  it("does not duplicate an upstream already in the refs", () => {
    const entry = commit({ refs: ["main", "origin/main"], head: true });
    expect(commitChips(entry, "origin/main")).toEqual(["main", "origin/main"]);
  });

  it("caps the chips", () => {
    const entry = commit({ refs: ["a", "b", "c", "d", "e"] });
    expect(commitChips(entry, null)).toHaveLength(4);
  });
});

describe("the log list", () => {
  it("shows the subject, sha, author and relative time", () => {
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");
    expect(row).toHaveTextContent("feat: add the rail");
    expect(row).toHaveTextContent("aaaaaaa");
    expect(row).toHaveTextContent("Ada");
    expect(row).toHaveTextContent(/ago|just now/);
  });

  it("shows branch chips", () => {
    seed({ entries: [commit({ refs: ["main"], head: true })] });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.getByTestId("commit-aaaaaaa")).toHaveTextContent("main");
    expect(screen.getByTestId("commit-aaaaaaa")).toHaveTextContent("origin/main");
  });

  it("puts the exact time in the row's title", () => {
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");
    expect(row).toHaveAttribute("title", new Date(NOW - 5 * 60_000).toLocaleString());
  });

  it("opens the commit diff on click", async () => {
    const sha = "b".repeat(40);
    seed({ entries: [commit({ sha, shortSha: "bbbbbbb" })] });
    render(<HistorySection projectPath={PROJECT} />);

    await userEvent.click(screen.getByTestId("commit-bbbbbbb"));

    await waitFor(() =>
      expect(handles.gitCalls.find((call) => call.kind === "diff")?.payload).toEqual({
        commit: sha,
      }),
    );
  });

  it("falls back to a placeholder for an empty subject", () => {
    seed({ entries: [commit({ subject: "" })] });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.getByTestId("commit-aaaaaaa")).toHaveTextContent("(no message)");
  });
});

describe("paging", () => {
  it("asks for the next page with a skip cursor", async () => {
    seed({ entries: [commit()], hasMore: true });
    render(<HistorySection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: `Load ${HISTORY_PAGE_SIZE} more` }));

    await waitFor(() =>
      expect(handles.gitCalls.find((call) => call.kind === "log")?.payload).toEqual({
        limit: HISTORY_PAGE_SIZE,
        skip: 1,
      }),
    );
  });

  it("hides the button when there is nothing more", () => {
    seed({ entries: [commit()], hasMore: false });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.queryByRole("button", { name: /Load .* more/ })).not.toBeInTheDocument();
  });

  it("disables the button while a page is loading", () => {
    seed({ entries: [commit()], hasMore: true, loading: true });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });
});

describe("empty states", () => {
  it("says a repository with no commits has none", () => {
    seed({ snapshot: snapshot({ repo: { ...snapshot().repo!, empty: true, head: null } }) });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.getByTestId("history-empty")).toHaveTextContent("No commits yet.");
  });

  it("says when a page arrived empty", () => {
    seed({ entries: [] });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.getByTestId("history-empty")).toHaveTextContent("No commits to show.");
  });

  it("renders nothing for an unavailable repository", () => {
    seed({ snapshot: emptyGitSnapshot(PROJECT, "git_missing") });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.queryByTestId("history-section")).not.toBeInTheDocument();
  });
});
