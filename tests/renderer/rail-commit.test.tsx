import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
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

  it("disables the button while there is nothing staged", () => {
    seed(snapshot({ changed: [file("a.ts")] }));
    render(<CommitBox projectPath={PROJECT} />);
    // The label is actionable, but an empty message keeps it disabled.
    expect(screen.getByRole("button", { name: "Stage all and commit" })).toBeDisabled();
    expect(screen.getByTestId("commit-reason")).toHaveTextContent("Write a commit message.");
  });
});

describe("amend", () => {
  it("prefills HEAD's whole message", async () => {
    seed(STAGED, "feat: subject\n\nA body that must survive.");
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.click(screen.getByRole("switch", { name: "Amend last commit" }));

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

    await userEvent.click(screen.getByRole("switch", { name: "Amend last commit" }));
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
    await userEvent.click(screen.getByRole("switch", { name: "Amend last commit" }));

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

  it("disables committing and explains why", () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);
    expect(screen.getByTestId("commit-reason")).toHaveTextContent("Tell git who you are.");
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it("needs an explicit checkbox before writing the repository config", async () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);

    // The form is not in the way until the user asks for it.
    expect(screen.queryByTestId("identity-form")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set identity" }));

    expect(screen.getByTestId("identity-form")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save identity" })).toBeDisabled();
  });

  it("writes the identity repo-locally, only after consent", async () => {
    seed(NO_IDENTITY);
    render(<CommitBox projectPath={PROJECT} />);

    // A user with no identity is offered the form instead of a dead button.
    await userEvent.click(screen.getByRole("button", { name: "Set identity" }));

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
