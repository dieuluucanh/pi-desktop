import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { HistorySection, HISTORY_PAGE_SIZE } from "../../src/renderer/src/rail/HistorySection";
import {
  absoluteTime,
  commitChipTone,
  commitChips,
  historyKey,
  relativeTime,
} from "../../src/renderer/src/rail/history-view";
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
    key?: string | null;
  } = {},
): void {
  const snap = options.snapshot ?? snapshot();
  handles = installBridge({ gitLog: options.entries ?? [commit()] });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: { [PROJECT]: snap },
    gitLog: {
      [PROJECT]: {
        entries: options.entries ?? [commit()],
        loading: options.loading ?? false,
        hasMore: options.hasMore ?? false,
        key: options.key === undefined ? historyKey(snap.repo) : options.key,
        seq: 0,
      },
    },
    gitErrors: {},
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
  it("does not invent an upstream for an unpushed head", () => {
    // The reported bug: `%D` said `HEAD -> main` (ahead 1), but the rail showed
    // `origin/main` on a commit the upstream does not point at.
    const entry = commit({ refs: ["main"], head: true });
    expect(commitChips(entry)).toEqual(["main"]);
  });

  it("keeps the upstream git reported on the commit it points at", () => {
    const entry = commit({ refs: ["main", "origin/main"], head: true });
    expect(commitChips(entry)).toEqual(["main", "origin/main"]);
  });

  it("drops a symbolic remote HEAD", () => {
    const entry = commit({ refs: ["main", "origin/main", "origin/HEAD"] });
    expect(commitChips(entry)).toEqual(["main", "origin/main"]);
  });

  it("caps the chips", () => {
    const entry = commit({ refs: ["a", "b", "c", "d", "e"] });
    expect(commitChips(entry)).toHaveLength(4);
  });
});

describe("chip tones", () => {
  it("accents the current branch", () => {
    expect(commitChipTone("main", "main", ["origin"])).toBe("accent");
  });

  it("highlights a remote-tracking ref", () => {
    expect(commitChipTone("origin/main", "main", ["origin"])).toBe("info");
    expect(commitChipTone("upstream/feature", "main", ["origin", "upstream"])).toBe("info");
  });

  it("leaves tags and other local branches neutral", () => {
    expect(commitChipTone("v1.0", "main", ["origin"])).toBe("neutral");
    expect(commitChipTone("feat/other", "main", ["origin"])).toBe("neutral");
  });

  it("does not call a tag with a slash a remote ref", () => {
    // `release/v1` starts with a slash segment, but `release` is not a remote.
    expect(commitChipTone("release/v1", "main", ["origin"])).toBe("neutral");
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
    seed({ entries: [commit({ refs: ["main", "origin/main", "v1.0"], head: true })] });
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");
    expect(row).toHaveTextContent("main");
    expect(row).toHaveTextContent("origin/main");

    // The upstream is easy to spot; the current branch and tags keep their own tones.
    expect(screen.getByText("main")).toHaveClass("text-accent");
    expect(screen.getByText("origin/main")).toHaveClass("text-info");
    expect(screen.getByText("v1.0")).toHaveClass("text-ink-muted");
  });

  it("does not label an unpushed tip with the upstream", () => {
    seed({ entries: [commit({ refs: ["main"], head: true })] });
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");
    expect(row).toHaveTextContent("main");
    expect(row).not.toHaveTextContent("origin/main");
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

describe("freshness", () => {
  it("does not refetch a page that is current for the repo state", () => {
    seed({ entries: [commit()] });
    render(<HistorySection projectPath={PROJECT} />);
    expect(handles.gitCalls.filter((call) => call.kind === "log")).toHaveLength(0);
  });

  it("reloads the first page when HEAD moves", async () => {
    seed({ entries: [commit()] });
    const { rerender } = render(<HistorySection projectPath={PROJECT} />);
    useAppStore.setState({
      git: { [PROJECT]: snapshot({ repo: { ...snapshot().repo!, head: "bbbbbbb" } }) },
    });
    rerender(<HistorySection projectPath={PROJECT} />);
    await waitFor(() =>
      expect(handles.gitCalls.find((call) => call.kind === "log")?.payload).toEqual({
        limit: HISTORY_PAGE_SIZE,
      }),
    );
  });

  it("reloads when a push changes the divergence", async () => {
    seed({
      snapshot: snapshot({ repo: { ...snapshot().repo!, ahead: 1 } }),
      entries: [commit()],
    });
    const { rerender } = render(<HistorySection projectPath={PROJECT} />);
    useAppStore.setState({
      git: { [PROJECT]: snapshot({ repo: { ...snapshot().repo!, ahead: 0 } }) },
    });
    rerender(<HistorySection projectPath={PROJECT} />);
    await waitFor(() => expect(handles.gitCalls.some((call) => call.kind === "log")).toBe(true));
  });

  it("reloads a page that was read for an older state", async () => {
    seed({ entries: [commit()], key: "stale" });
    render(<HistorySection projectPath={PROJECT} />);
    await waitFor(() =>
      expect(handles.gitCalls.find((call) => call.kind === "log")?.payload).toEqual({
        limit: HISTORY_PAGE_SIZE,
      }),
    );
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

describe("the pinned header", () => {
  it("pins Commit History above the log", () => {
    render(<HistorySection projectPath={PROJECT} />);
    // The block's own scroller is the parent; an opaque surface stops rows
    // ghosting through while the list scrolls under it.
    const header = screen.getByTestId("history-header");
    expect(header).toHaveTextContent("Commit History");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    expect(header.className).toContain("bg-surface");
  });

  it("counts the loaded commits and marks a further page", () => {
    seed({
      entries: [commit(), commit({ sha: "b".repeat(40), shortSha: "bbbbbbb" })],
      hasMore: true,
    });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.getByTestId("history-count")).toHaveTextContent("2+");
  });

  it("refreshes from the first page, not the current cursor", async () => {
    seed({ entries: [commit()], hasMore: true });
    render(<HistorySection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Refresh commit history" }));

    await waitFor(() =>
      expect(handles.gitCalls.find((call) => call.kind === "log")?.payload).toEqual({
        limit: HISTORY_PAGE_SIZE,
      }),
    );
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

  it("keeps its header and names why an unavailable repository has no log", () => {
    seed({ snapshot: emptyGitSnapshot(PROJECT, "git_missing") });
    render(<HistorySection projectPath={PROJECT} />);

    // A titled block that vanishes is the same class of bug as a vanishing
    // Documents menu, so the header survives and only the reason changes.
    expect(screen.getByTestId("history-header")).toHaveTextContent("Commit History");
    expect(screen.getByTestId("history-empty")).toHaveTextContent("Git is not installed");
    // There is nothing to reload on an unavailable repository.
    expect(
      screen.queryByRole("button", { name: "Refresh commit history" }),
    ).not.toBeInTheDocument();
  });
});
