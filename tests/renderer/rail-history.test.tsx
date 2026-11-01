import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistorySection, HISTORY_PAGE_SIZE } from "../../src/renderer/src/rail/HistorySection";
import {
  absoluteTime,
  COMMIT_ROW_CHIP_LIMIT,
  commitChipTone,
  commitRefs,
  commitRowChips,
  fullCommitMessage,
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
    body: "",
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

const originalClipboard = navigator.clipboard;

beforeEach(() => {
  seed();
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  vi.restoreAllMocks();
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

describe("commit refs", () => {
  it("keeps every decoration for the hover card", () => {
    const entry = commit({ refs: ["a", "b", "c", "d", "e"] });
    expect(commitRefs(entry)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("drops a symbolic remote HEAD", () => {
    const entry = commit({ refs: ["main", "origin/main", "origin/HEAD"] });
    expect(commitRefs(entry)).toEqual(["main", "origin/main"]);
  });

  it("does not invent an upstream for an unpushed head", () => {
    // The reported bug: `%D` said `HEAD -> main` (ahead 1), but the rail showed
    // `origin/main` on a commit the upstream does not point at.
    const entry = commit({ refs: ["main"], head: true });
    expect(commitRefs(entry)).toEqual(["main"]);
    expect(commitRowChips(entry, "main", ["origin"])).toEqual({
      chips: [{ key: "local:main", label: "main", remotes: [], local: true, tone: "accent" }],
      hidden: 0,
    });
  });
});

describe("row chips", () => {
  it("folds a local branch and its remote-tracking ref into one chip", () => {
    const entry = commit({ refs: ["main", "origin/main"], head: true });
    expect(commitRowChips(entry, "main", ["origin"])).toEqual({
      chips: [
        {
          key: "local:main",
          label: "main",
          remotes: ["origin/main"],
          local: true,
          tone: "accent",
        },
      ],
      hidden: 0,
    });
  });

  it("shows a remote-only ref as an info chip", () => {
    expect(commitRowChips(commit({ refs: ["origin/main"] }), "main", ["origin"])).toEqual({
      chips: [
        {
          key: "remote:main",
          label: "main",
          remotes: ["origin/main"],
          local: false,
          tone: "info",
        },
      ],
      hidden: 0,
    });
  });

  it("puts the current branch first and keeps tags neutral", () => {
    const entry = commit({ refs: ["v1.0", "main", "origin/main"] });
    expect(commitRowChips(entry, "main", ["origin"])).toEqual({
      chips: [
        {
          key: "local:main",
          label: "main",
          remotes: ["origin/main"],
          local: true,
          tone: "accent",
        },
        { key: "local:v1.0", label: "v1.0", remotes: [], local: true, tone: "neutral" },
      ],
      hidden: 0,
    });
  });

  it("folds another local branch with its remote", () => {
    expect(commitRowChips(commit({ refs: ["dev", "origin/dev"] }), "main", ["origin"])).toEqual({
      chips: [
        {
          key: "local:dev",
          label: "dev",
          remotes: ["origin/dev"],
          local: true,
          tone: "neutral",
        },
      ],
      hidden: 0,
    });
  });

  it("folds several remotes with the same leaf", () => {
    const entry = commit({ refs: ["main", "origin/main", "upstream/main"] });
    expect(commitRowChips(entry, "main", ["origin", "upstream"])).toEqual({
      chips: [
        {
          key: "local:main",
          label: "main",
          remotes: ["origin/main", "upstream/main"],
          local: true,
          tone: "accent",
        },
      ],
      hidden: 0,
    });
  });

  it("does not treat a tag with a slash as a remote ref", () => {
    expect(commitRowChips(commit({ refs: ["release/v1"] }), "main", ["origin"])).toEqual({
      chips: [
        {
          key: "local:release/v1",
          label: "release/v1",
          remotes: [],
          local: true,
          tone: "neutral",
        },
      ],
      hidden: 0,
    });
  });

  it("caps the row and counts the rest", () => {
    const entry = commit({ refs: ["main", "v1.0", "v2.0", "feat/x"] });
    const { chips, hidden } = commitRowChips(entry, "main", ["origin"]);
    expect(chips).toHaveLength(COMMIT_ROW_CHIP_LIMIT);
    expect(hidden).toBe(2);
  });
});

describe("the full commit message", () => {
  it("joins the subject and body with a blank line", () => {
    expect(fullCommitMessage(commit({ subject: "feat: x", body: "Body" }))).toBe("feat: x\n\nBody");
  });

  it("falls back to whichever part exists", () => {
    expect(fullCommitMessage(commit({ subject: "feat: x", body: "" }))).toBe("feat: x");
    expect(fullCommitMessage(commit({ subject: "", body: "Body" }))).toBe("Body");
    expect(fullCommitMessage(commit({ subject: "", body: "" }))).toBe("");
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
  it("draws one compact line with the subject and sr-only metadata", () => {
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");

    expect(row.className).toContain("h-6");
    expect(row.className).toContain("items-center");
    expect(row.className).not.toContain("flex-col");
    expect(row).not.toHaveAttribute("title");
    expect(screen.getByTestId("commit-subject")).toHaveTextContent("feat: add the rail");

    // The hash, author and exact time are still in the accessible name.
    expect(row).toHaveTextContent("Commit aaaaaaa by Ada");
    expect(row).not.toHaveTextContent("5m ago");
  });

  it("folds the local branch and its origin into one cloud chip", () => {
    seed({ entries: [commit({ refs: ["main", "origin/main", "v1.0"], head: true })] });
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");

    const branch = screen.getByTestId("commit-ref-main");
    expect(branch).toHaveTextContent("main");
    expect(branch).toHaveClass("text-accent");
    // The cloud is its own colour, even inside an accent chip.
    expect(screen.getByTestId("commit-ref-cloud-main")).toHaveClass("text-info");
    // The raw `origin/main` label became a cloud; it lives in the card now.
    expect(within(row).queryByText("origin/main")).not.toBeInTheDocument();
    expect(screen.getByTestId("commit-ref-v1.0")).toHaveClass("text-ink-muted");
  });

  it("shows a remote-only ref as a leading cloud in the info tone", () => {
    seed({ entries: [commit({ refs: ["origin/main"] })] });
    render(<HistorySection projectPath={PROJECT} />);

    const chip = screen.getByTestId("commit-ref-main");
    expect(chip).toHaveClass("text-info");
    expect(screen.getByTestId("commit-ref-cloud-main")).toHaveClass("text-info");
  });

  it("does not label an unpushed tip with the upstream", () => {
    seed({ entries: [commit({ refs: ["main"], head: true })] });
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");

    expect(screen.getByTestId("commit-ref-main")).toHaveTextContent("main");
    expect(screen.queryByTestId("commit-ref-cloud-main")).not.toBeInTheDocument();
    expect(within(row).queryByText("origin/main")).not.toBeInTheDocument();
  });

  it("keeps the full metadata in the hover card", async () => {
    const sha = "b".repeat(40);
    seed({
      entries: [
        commit({
          sha,
          shortSha: "bbbbbbb",
          body: "Body line one\nBody line two",
          refs: ["main", "origin/main", "v1.0"],
        }),
      ],
    });
    render(<HistorySection projectPath={PROJECT} />);

    await userEvent.hover(screen.getByTestId("commit-bbbbbbb"));
    const card = await screen.findByTestId("commit-hover-bbbbbbb", {}, { timeout: 3_000 });

    const message = within(card).getByTestId("commit-message-bbbbbbb");
    expect(message).toHaveTextContent("feat: add the rail");
    expect(message).toHaveTextContent("Body line one");
    expect(within(card).getByText("Ada")).toBeInTheDocument();
    expect(within(card).getByTestId("commit-hover-sha-bbbbbbb")).toHaveTextContent(sha);
    expect(within(card).getByTestId("commit-hover-ref-origin/main")).toHaveClass("text-info");
  });

  it("opens the card on keyboard focus and closes it on Escape", async () => {
    render(<HistorySection projectPath={PROJECT} />);
    screen.getByTestId("commit-aaaaaaa").focus();

    expect(
      await screen.findByTestId("commit-hover-aaaaaaa", {}, { timeout: 3_000 }),
    ).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("commit-hover-aaaaaaa")).not.toBeInTheDocument(),
    );
  });

  it("copies the hash from the card", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<HistorySection projectPath={PROJECT} />);

    await userEvent.hover(screen.getByTestId("commit-aaaaaaa"));
    const card = await screen.findByTestId("commit-hover-aaaaaaa", {}, { timeout: 3_000 });
    await userEvent.click(within(card).getByTestId("commit-copy-hash-aaaaaaa"));

    expect(writeText).toHaveBeenCalledWith("a".repeat(40));
  });

  it("caps the row at two chips and counts the rest", async () => {
    seed({ entries: [commit({ refs: ["main", "v1.0", "v2.0", "feat/x", "v3.0"] })] });
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-aaaaaaa");

    expect(within(row).getByTestId("commit-ref-main")).toBeInTheDocument();
    expect(within(row).getByTestId("commit-ref-v1.0")).toBeInTheDocument();
    expect(within(row).queryByTestId("commit-ref-v2.0")).not.toBeInTheDocument();
    expect(within(row).getByTestId("commit-ref-overflow")).toHaveTextContent("+3");

    await userEvent.hover(row);
    const card = await screen.findByTestId("commit-hover-aaaaaaa", {}, { timeout: 3_000 });
    expect(within(card).getByTestId("commit-hover-ref-v3.0")).toBeInTheDocument();
  });

  it("opens the commit diff on click and closes the card", async () => {
    const sha = "b".repeat(40);
    seed({ entries: [commit({ sha, shortSha: "bbbbbbb" })] });
    render(<HistorySection projectPath={PROJECT} />);
    const row = screen.getByTestId("commit-bbbbbbb");

    await userEvent.hover(row);
    expect(
      await screen.findByTestId("commit-hover-bbbbbbb", {}, { timeout: 3_000 }),
    ).toBeInTheDocument();

    await userEvent.click(row);

    await waitFor(() =>
      expect(handles.gitCalls.find((call) => call.kind === "diff")?.payload).toEqual({
        commit: sha,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("commit-hover-bbbbbbb")).not.toBeInTheDocument(),
    );
  });

  it("falls back to a placeholder for an empty subject", () => {
    seed({ entries: [commit({ subject: "" })] });
    render(<HistorySection projectPath={PROJECT} />);
    expect(screen.getByTestId("commit-subject")).toHaveTextContent("(no message)");
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
