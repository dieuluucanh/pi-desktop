import { render, screen, within } from "@testing-library/react";
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
    gitErrors: gitError ? { [PROJECT]: gitError } : {},
  });
}

/** Seeds a persisted collapse state for the two change groups. */
function seedCollapsed(collapsed: { staged?: boolean; changed?: boolean }): void {
  useAppStore.setState({
    prefs: {
      ...useAppStore.getState().prefs,
      rail: {
        ...useAppStore.getState().prefs.rail,
        collapsed: { ...useAppStore.getState().prefs.rail.collapsed, ...collapsed },
      },
    },
  });
}

/** The persisted collapse state, i.e. what a relaunch would read back. */
function persistedCollapsed(): { staged: boolean; changed: boolean; stashes: boolean } {
  return { ...useAppStore.getState().prefs.rail.collapsed };
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
    gitErrors: {},
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
  it("spends no paragraph on a clean tree", () => {
    seed(snapshot());
    render(<ChangesSection projectPath={PROJECT} />);
    // The header's count says it; a two-line "nothing changed" body would cost two
    // rows to repeat an empty list (2026-10-30 project-scoped rail plan).
    expect(screen.queryByTestId("changes-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("changes-count")).toHaveTextContent("0");
  });

  it("spends no paragraph on a repository with no commits", () => {
    seed(snapshot({ repo: { ...snapshot().repo!, empty: true, head: null } }));
    render(<ChangesSection projectPath={PROJECT} />);
    expect(screen.queryByTestId("changes-empty")).not.toBeInTheDocument();
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

describe("collapsible groups", () => {
  function seedBoth(): void {
    seed(
      snapshot({
        staged: [file("src/a.ts", { staged: true, unstaged: false })],
        changed: [file("src/b.ts"), file("src/c.ts")],
      }),
    );
  }

  it("starts both groups expanded", () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);

    expect(screen.getByTestId("change-row-src/a.ts")).toBeInTheDocument();
    expect(screen.getByTestId("change-row-src/b.ts")).toBeInTheDocument();
    expect(screen.getByTestId("changes-group-toggle-staged")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("changes-group-toggle-changed")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("hides the rows and remembers the fold when a header is clicked", async () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByTestId("changes-group-toggle-staged"));

    expect(screen.queryByTestId("change-row-src/a.ts")).not.toBeInTheDocument();
    // The group itself survives, with its count, so the user can reopen it.
    expect(screen.getByTestId("changes-group-staged")).toHaveTextContent("Staged Changes");
    expect(screen.getByTestId("changes-group-staged")).toHaveTextContent("1");
    expect(persistedCollapsed().staged).toBe(true);
    // The sibling group is untouched.
    expect(screen.getByTestId("change-row-src/b.ts")).toBeInTheDocument();
    expect(persistedCollapsed().changed).toBe(false);
  });

  it("restores the rows when the header is clicked again", async () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);

    const toggle = screen.getByTestId("changes-group-toggle-staged");
    await userEvent.click(toggle);
    expect(screen.queryByTestId("change-row-src/a.ts")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByTestId("change-row-src/a.ts")).toBeInTheDocument();
    expect(persistedCollapsed().staged).toBe(false);
  });

  it("renders a group folded from persisted state, header and count intact", () => {
    seedBoth();
    seedCollapsed({ changed: true });
    render(<ChangesSection projectPath={PROJECT} />);

    expect(screen.getByTestId("changes-group-changed")).toHaveTextContent("Changes");
    expect(screen.getByTestId("changes-group-changed")).toHaveTextContent("2");
    expect(screen.queryByTestId("change-row-src/b.ts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("change-row-src/c.ts")).not.toBeInTheDocument();
    // Staged is still open.
    expect(screen.getByTestId("change-row-src/a.ts")).toBeInTheDocument();
  });

  it("points aria-controls at the list it hides", async () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);

    const toggle = screen.getByTestId("changes-group-toggle-changed");
    const listId = toggle.getAttribute("aria-controls");
    expect(listId).toBeTruthy();
    const list = document.getElementById(listId!);
    expect(list).not.toBeNull();
    expect(list!.tagName).toBe("UL");
    expect(within(list!).getByTestId("change-row-src/b.ts")).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The controlled element is gone from the DOM while folded.
    expect(document.getElementById(listId!)).toBeNull();
  });

  it("stages all without toggling the group", async () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Stage all" }));

    // The action ran…
    expect(lastAction()?.payload).toEqual({ kind: "stage", paths: ["src/b.ts", "src/c.ts"] });
    // …and the header was not treated as part of it: clicking *Stage all* must
    // never fold the group (the change the user is working through would vanish).
    expect(persistedCollapsed().changed).toBe(false);
  });

  it("unstages all without toggling the group", async () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Unstage all" }));

    expect(lastAction()?.payload).toEqual({ kind: "unstage", paths: ["src/a.ts"] });
    expect(persistedCollapsed().staged).toBe(false);
  });

  it("keeps the refresh in the header, not below the groups", () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);
    // One refresh for both groups, reachable without scrolling past them, and
    // icon-only: the label beside a refresh arrow was pure repetition.
    const refresh = screen.getByRole("button", { name: "Refresh changes" });
    expect(refresh.textContent?.trim()).toBe("");
    const header = screen.getByTestId("changes-header");
    expect(header).toHaveTextContent("Changes");
    expect(
      header.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    // ...and above the first group.
    const firstGroup = screen.getByTestId("changes-group-staged");
    expect(
      refresh.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the combined count in the header", () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);
    // One staged plus two changed.
    expect(screen.getByTestId("changes-count")).toHaveTextContent("3");
  });

  it("pins the header so it stays while the file list scrolls", () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);
    // The block's scroller is the parent; `sticky top-0` + an opaque surface is
    // what keeps the title, count and refresh visible over a long change list.
    const header = screen.getByTestId("changes-header");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    expect(header.className).toContain("bg-surface");
  });

  it("pins each group header under the block header", () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);
    // `top-7` is the `h-7` block header; an opaque surface keeps rows from
    // ghosting through while the group's files scroll under it.
    for (const id of ["staged", "changed"] as const) {
      const header = screen.getByTestId(`changes-group-header-${id}`);
      expect(header.className).toContain("sticky");
      expect(header.className).toContain("top-7");
      expect(header.className).toContain("bg-surface");
      expect(header.className).toContain("border-b");
      expect(header.className).not.toContain("top-0");
    }
  });

  it("keeps a collapsed group's header pinned", async () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);
    await userEvent.click(screen.getByTestId("changes-group-toggle-staged"));
    const header = screen.getByTestId("changes-group-header-staged");
    expect(header.className).toContain("sticky");
    expect(screen.queryByTestId("changes-list-staged")).toBeNull();
  });

  it("keeps the header outside the gap column that holds the lists", () => {
    seedBoth();
    render(<ChangesSection projectPath={PROJECT} />);
    // A `gap-1` scroll column would leave a transparent 4 px strip between the
    // sticky header and the first row, letting rows travel under the header.
    const section = screen.getByTestId("changes-section");
    const header = screen.getByTestId("changes-header");
    const firstGroup = screen.getByTestId("changes-group-staged");
    expect(section.firstElementChild).toBe(header);
    expect(
      header.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(header.className).not.toContain("gap-1");
  });
});
