import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitBox } from "../../src/renderer/src/rail/CommitBox";
import {
  commitReadiness,
  identitySourceLabel,
  identitySummary,
  messageCount,
  primaryActionLabel,
} from "../../src/renderer/src/rail/commit-view";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyGitSnapshot, type GitFileEntry, type GitSnapshot } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The commit box (git-checkpoint plan step 12).
 *
 * The behaviours that matter: Ctrl+Enter commits and Enter does not, Escape
 * gives the keyboard back without discarding the message, an amend prefills
 * HEAD's *whole* message, and writing the identity to `.git/config` needs an
 * explicit checkbox.
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

const STAGED = snapshot({
  staged: [file("src/a.ts", { staged: true, unstaged: false })],
});

let handles: ReturnType<typeof installBridge>;

/**
 * The warnings the box raised, newest last. The box no longer prints its
 * blockers inline (2026-10-30 plan), so the notification is the observable.
 * `vi.hoisted` keeps the array alive before the mocked factory runs.
 */
const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("sonner", () => ({
  toast: {
    warning: (message: string) => {
      notices.push(message);
      return 0;
    },
    success: () => 0,
    error: () => 0,
    message: () => 0,
  },
}));

function published(): string[] {
  return notices;
}

function seed(value: GitSnapshot, headMessage: string | null = null): void {
  handles = installBridge({
    git: value,
    headMessage,
    gitAction: { ok: true, message: "Committed." },
  });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: { [PROJECT]: value },
    gitError: null,
    // Consent is granted so these cases test the box, not the gate.
    gitConsentGranted: true,
    gitConsentPrompt: null,
  });
}

/** The last mutating git call the box dispatched. */
function lastAction() {
  return [...handles.gitCalls].reverse().find((call) => call.kind === "action");
}

beforeEach(() => {
  notices.length = 0;
  seed(STAGED);
});

describe("readiness", () => {
  it("stops at a clean tree", () => {
    expect(
      commitReadiness(snapshot(), "msg", { name: "A", email: "a@b.co", source: "global" }),
    ).toEqual({
      canCommit: false,
      reason: "No changes to commit.",
    });
  });

  it("allows committing with only unstaged changes (it stages them itself)", () => {
    expect(
      commitReadiness(snapshot({ changed: [file("a.ts")] }), "feat: x", {
        name: "A",
        email: "a@b.co",
        source: "global",
      }),
    ).toEqual({ canCommit: true, reason: null });
  });

  it("then asks for a message", () => {
    expect(
      commitReadiness(STAGED, "   ", { name: "A", email: "a@b.co", source: "global" }),
    ).toEqual({ canCommit: false, reason: "Write a commit message." });
  });

  it("then asks for an identity", () => {
    expect(commitReadiness(STAGED, "feat: x", null)).toEqual({
      canCommit: false,
      reason: "Tell git who you are.",
    });
  });

  it("is ready when all three are present", () => {
    expect(
      commitReadiness(STAGED, "feat: x", { name: "A", email: "a@b.co", source: "global" }),
    ).toEqual({ canCommit: true, reason: null });
  });

  it("is never ready for an unavailable repository", () => {
    expect(commitReadiness(emptyGitSnapshot(PROJECT, "git_missing"), "x", null)).toEqual({
      canCommit: false,
      reason: null,
    });
  });
});

describe("identity summary", () => {
  it("labels the person and the config level", () => {
    expect(identitySummary({ name: "Ada", email: "ada@example.com", source: "repo" })).toEqual({
      label: "Ada <ada@example.com>",
      sourceLabel: "this repo",
      local: true,
    });
    expect(identitySourceLabel("global")).toBe("global");
    expect(identitySourceLabel("system")).toBe("system");
    expect(identitySourceLabel("unknown")).toBe("unknown");
  });
});

describe("message counter", () => {
  it("counts characters against the limit", () => {
    expect(messageCount("abc")).toEqual({ text: "3 / 20000", over: false });
    expect(messageCount("x".repeat(20_001)).over).toBe(true);
  });
});

describe("primary action label", () => {
  it("names what the click will do", () => {
    expect(primaryActionLabel(STAGED, false)).toBe("Commit");
    expect(primaryActionLabel(snapshot({ changed: [file("a.ts")] }), false)).toBe(
      "Stage all and commit",
    );
    expect(primaryActionLabel(STAGED, true)).toBe("Amend commit");
  });
});

describe("committing", () => {
  it("commits with Ctrl+Enter", async () => {
    seed(STAGED);
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(screen.getByLabelText("Commit message"), "feat: the rail");
    fireEvent.keyDown(screen.getByLabelText("Commit message"), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() =>
      expect(lastAction()?.payload).toEqual({
        kind: "commit",
        message: "feat: the rail",
        amend: false,
      }),
    );
  });

  it("does not commit on a plain Enter (it inserts a newline)", async () => {
    seed(STAGED);
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(screen.getByLabelText("Commit message"), "line one{Enter}line two");

    expect(handles.gitCalls.some((call) => call.kind === "action")).toBe(false);
    expect(screen.getByLabelText("Commit message")).toHaveValue("line one\nline two");
  });

  it("clears the message after a successful commit", async () => {
    seed(STAGED);
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(screen.getByLabelText("Commit message"), "feat: x");
    await userEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(screen.getByLabelText("Commit message")).toHaveValue(""));
  });

  it("keeps the message when the commit is refused", async () => {
    handles = installBridge({
      git: STAGED,
      gitAction: {
        ok: false,
        error: { code: "index_locked", message: "index.lock exists", recoverable: true },
      },
    });
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, drafts: {} },
      git: { [PROJECT]: STAGED },
      gitError: null,
      gitConsentGranted: true,
      gitConsentPrompt: null,
    });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(screen.getByLabelText("Commit message"), "feat: x");
    await userEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(useAppStore.getState().gitError).toMatch(/index\.lock/));
    // The text is the user's work, not the failed attempt's.
    expect(screen.getByLabelText("Commit message")).toHaveValue("feat: x");
  });

  it("stages everything first when nothing is staged", async () => {
    seed(snapshot({ changed: [file("a.ts"), file("b.ts")] }));
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(screen.getByLabelText("Commit message"), "feat: both");
    await userEvent.click(screen.getByRole("button", { name: "Stage all and commit" }));

    await waitFor(() =>
      expect(
        handles.gitCalls.filter((call) => call.kind === "action").map((call) => call.payload),
      ).toEqual([
        { kind: "stage", paths: ["a.ts", "b.ts"] },
        { kind: "commit", message: "feat: both", amend: false },
      ]),
    );
  });

  it("keeps the button clickable when only the message is missing", () => {
    seed(snapshot({ changed: [file("a.ts")] }));
    render(<CommitBox projectPath={PROJECT} />);
    // Nothing staged but changes present: the label promises to stage first.
    const button = screen.getByRole("button", { name: "Stage all and commit" });
    // Logical blockers stay pressable so the press can explain itself; the box
    // spends no row on a permanent warning (2026-10-30 plan).
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTestId("commit-reason")).not.toBeInTheDocument();
  });

  it("explains a missing message only when Commit is pressed", async () => {
    seed(snapshot({ changed: [file("a.ts")] }));
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Stage all and commit" }));

    expect(published().at(-1)).toMatch(/write a commit message first/i);
    // Nothing was dispatched: the click never stages a half-applied intention.
    expect(handles.gitCalls.filter((call) => call.kind === "action")).toEqual([]);
  });
});

describe("amend", () => {
  /** Amend lives in the inline `⋯` list now; open it first. */
  async function openOptions(): Promise<void> {
    await userEvent.click(screen.getByRole("button", { name: "Commit options" }));
  }

  async function clickAmend(): Promise<void> {
    await openOptions();
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Amend last commit" }));
  }

  it("prefills HEAD's whole message", async () => {
    seed(STAGED, "feat: subject\n\nA body that must survive.");
    render(<CommitBox projectPath={PROJECT} />);

    await clickAmend();

    await waitFor(() =>
      expect(screen.getByLabelText("Commit message")).toHaveValue(
        "feat: subject\n\nA body that must survive.",
      ),
    );
    expect(handles.gitCalls.map((call) => call.kind)).toContain("head-message");
  });

  it("commits with --amend once switched on", async () => {
    seed(STAGED, "old message");
    render(<CommitBox projectPath={PROJECT} />);

    await clickAmend();
    await waitFor(() => expect(screen.getByLabelText("Commit message")).toHaveValue("old message"));
    await userEvent.click(screen.getByRole("button", { name: "Amend commit" }));

    await waitFor(() =>
      expect(lastAction()?.payload).toEqual({
        kind: "commit",
        message: "old message",
        amend: true,
      }),
    );
  });

  it("leaves the message alone when HEAD has none yet", async () => {
    seed(STAGED, null);
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(screen.getByLabelText("Commit message"), "first commit");
    await clickAmend();

    await waitFor(() =>
      expect(handles.gitCalls.some((call) => call.kind === "head-message")).toBe(true),
    );
    expect(screen.getByLabelText("Commit message")).toHaveValue("first commit");
  });
});

describe("identity", () => {
  const NO_IDENTITY = snapshot({
    staged: [file("src/a.ts", { staged: true, unstaged: false })],
    repo: { ...snapshot().repo!, identity: null },
  });

  it("explains the missing identity when Commit is pressed, and opens the form", async () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);
    // No warning row while the user is still working.
    expect(screen.queryByTestId("commit-reason")).not.toBeInTheDocument();
    expect(screen.queryByTestId("identity-form")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Commit" }));

    expect(published().at(-1)).toMatch(/tell git who you are/i);
    // The toast names the menu; opening the form saves the user a hunt.
    expect(screen.getByTestId("identity-form")).toBeInTheDocument();
  });

  it("needs an explicit checkbox before writing the repository config", async () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);

    // The form is not in the way until the user asks for it.
    expect(screen.queryByTestId("identity-form")).not.toBeInTheDocument();
    // A user with no identity reaches the form from the always-present `⋯` list.
    await userEvent.click(screen.getByRole("button", { name: "Commit options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Set identity" }));

    expect(screen.getByTestId("identity-form")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save identity" })).toBeDisabled();
  });

  it("writes the identity repo-locally, only after consent", async () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);

    // A user with no identity is offered the form instead of a dead button.
    await userEvent.click(screen.getByRole("button", { name: "Commit options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Set identity" }));

    expect(screen.getByTestId("identity-form")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save identity" });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Commit name"), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Commit email"), "ada@example.com");
    // Still disabled: filling the fields is not consent.
    expect(save).toBeDisabled();

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Write identity to this repository" }),
    );
    expect(save).toBeEnabled();

    await userEvent.click(save);

    await waitFor(() =>
      expect(lastAction()?.payload).toEqual({
        kind: "set-identity",
        name: "Ada Lovelace",
        email: "ada@example.com",
      }),
    );
  });
});

describe("keyboard", () => {
  it("Escape blurs without discarding the message", async () => {
    seed(STAGED);
    render(<CommitBox projectPath={PROJECT} />);
    const textarea = screen.getByLabelText("Commit message");

    await userEvent.type(textarea, "work in progress");
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(textarea).toHaveValue("work in progress");
  });
});

describe("the compact composer", () => {
  const NO_IDENTITY = snapshot({
    staged: [file("src/a.ts", { staged: true, unstaged: false })],
    repo: { ...snapshot().repo!, identity: null },
  });

  async function openOptions(): Promise<void> {
    await userEvent.click(screen.getByRole("button", { name: "Commit options" }));
  }

  it("is two rows tall and does not resize", () => {
    render(<CommitBox projectPath={PROJECT} />);
    const textarea = screen.getByLabelText("Commit message");
    expect(textarea).toHaveAttribute("rows", "2");
    // A free-resizing box would push the button out of a 500 px block.
    expect(textarea).toHaveClass("resize-none");
  });

  it("keeps the counter and the identity on one meta row", () => {
    render(<CommitBox projectPath={PROJECT} />);
    const counter = screen.getByTestId("commit-counter");
    const identity = screen.getByTestId("commit-identity");
    // Same parent: one row, not two stacked lines.
    expect(counter.parentElement).toBe(identity.parentElement);
    expect(identity).toHaveTextContent("Ada <ada@example.com>");
    expect(identity).toHaveAttribute("title", "Ada <ada@example.com>");
  });

  it("truncates a long identity but keeps the whole text in the title", () => {
    seed(
      snapshot({
        staged: [file("src/a.ts", { staged: true, unstaged: false })],
        repo: {
          ...snapshot().repo!,
          identity: { name: "A Very Long Name", email: "a.long@example.com", source: "repo" },
        },
      }),
    );
    render(<CommitBox projectPath={PROJECT} />);
    const identity = screen.getByTestId("commit-identity");
    expect(identity).toHaveAttribute("title", "A Very Long Name <a.long@example.com>");
    // The visible span is the truncating one, so the badge never gets pushed out.
    expect(identity.querySelector(".truncate")).not.toBeNull();
  });

  it("says so when there is no identity at all", () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);
    expect(screen.getByTestId("commit-identity")).toHaveTextContent("No identity");
  });

  it("opens the options list with the state it is in", async () => {
    render(<CommitBox projectPath={PROJECT} />);
    const trigger = screen.getByRole("button", { name: "Commit options" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("commit-options")).not.toBeInTheDocument();

    await openOptions();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("commit-options")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-controls", "commit-options");
    expect(screen.getByRole("menuitemcheckbox", { name: "Amend last commit" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("offers Change identity when one exists, Set identity when not", async () => {
    render(<CommitBox projectPath={PROJECT} />);
    await openOptions();
    expect(screen.getByRole("menuitem", { name: "Change identity" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Set identity" })).not.toBeInTheDocument();
    cleanup();

    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);
    await openOptions();
    expect(screen.getByRole("menuitem", { name: "Set identity" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Change identity" })).not.toBeInTheDocument();
  });

  it("opens the identity form from the options list", async () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);
    expect(screen.queryByTestId("identity-form")).not.toBeInTheDocument();

    await openOptions();
    await userEvent.click(screen.getByRole("menuitem", { name: "Set identity" }));

    expect(screen.getByTestId("identity-form")).toBeInTheDocument();
    // Choosing it closes the list; two open panels in one column is clutter.
    expect(screen.queryByTestId("commit-options")).not.toBeInTheDocument();
    // Consent is still required before the write is dispatched.
    expect(screen.getByRole("button", { name: "Save identity" })).toBeDisabled();
  });

  it("still requires the consent checkbox after entering the form this way", async () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);
    await openOptions();
    await userEvent.click(screen.getByRole("menuitem", { name: "Set identity" }));

    await userEvent.type(screen.getByLabelText("Commit name"), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Commit email"), "ada@example.com");
    expect(screen.getByRole("button", { name: "Save identity" })).toBeDisabled();
    expect(handles.gitCalls.some((call) => call.kind === "action")).toBe(false);

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Write identity to this repository" }),
    );
    expect(screen.getByRole("button", { name: "Save identity" })).toBeEnabled();
  });

  it("closes the list on Escape and returns focus to the trigger", async () => {
    render(<CommitBox projectPath={PROJECT} />);
    const trigger = screen.getByRole("button", { name: "Commit options" });
    await openOptions();
    expect(screen.getByTestId("commit-options")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByTestId("commit-options")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("marks amend as a checkbox in the list and reflects it back", async () => {
    seed(STAGED, "old message");
    render(<CommitBox projectPath={PROJECT} />);
    await openOptions();
    const amendItem = screen.getByRole("menuitemcheckbox", { name: "Amend last commit" });
    await userEvent.click(amendItem);

    await waitFor(() => expect(screen.getByLabelText("Commit message")).toHaveValue("old message"));
    // The list closes on use; reopening shows the mode is on.
    await openOptions();
    expect(screen.getByRole("menuitemcheckbox", { name: "Amend last commit" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: "Amend commit" })).toBeInTheDocument();
  });

  it("keeps Set identity reachable from the options list", () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);
    // The route to the form is the `⋯` list, which is always present.
    expect(screen.getByRole("button", { name: "Commit options" })).toBeInTheDocument();
  });

  it("keeps the primary button full width and computed", () => {
    seed(snapshot({ changed: [file("src/a.ts")] }));
    render(<CommitBox projectPath={PROJECT} />);
    // Nothing staged but changes present: the label promises to stage first.
    expect(screen.getByRole("button", { name: "Stage all and commit" })).toBeInTheDocument();
  });
});
