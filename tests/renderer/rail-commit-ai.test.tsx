import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitBox } from "../../src/renderer/src/rail/CommitBox";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  emptyGitSnapshot,
  type GitCommitContext,
  type GitFileEntry,
  type GitSnapshot,
} from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ModelChoice, TextGenerationModelCatalog } from "../../src/shared/text-generation";
import { installBridge, type BridgeHandles, type BridgeOptions } from "./fixtures";

/**
 * The commit box's AI control (2026-11-25 plan step 18).
 *
 * The sparkle is not a second `/commit`: it reads the **staged** diff, asks the
 * control host for a message, and puts the result in the composer. So the cases
 * that matter are the guardrails — nothing staged warns and never stages, a
 * draft is not replaced without a confirmation, a running generation is
 * cancellable, a host refusal leaves the draft alone — plus the model menu that
 * writes `prefs.commitMessage.model` and closes.
 */

const PROJECT = "/work/app";

const MODEL: ModelChoice = { provider: "openai", id: "gpt-5", name: "GPT-5" };
const OTHER_MODEL: ModelChoice = {
  provider: "anthropic",
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
};

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

/** Changes present, index empty: the case the sparkle must refuse. */
const UNSTAGED = snapshot({ changed: [file("src/a.ts")] });

const CONTEXT: GitCommitContext = {
  projectPath: PROJECT,
  branch: "main",
  stat: " src/a.ts | 2 ++\n 1 file changed, 2 insertions(+)",
  patch: "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;",
  truncated: false,
  files: 1,
  insertions: 2,
  deletions: 0,
  recentSubjects: ["feat: seed"],
};

const CATALOGUE: TextGenerationModelCatalog = {
  models: [MODEL, OTHER_MODEL],
  defaultModel: MODEL,
  defaultAvailable: true,
};

/**
 * The notifications the box raised. `vi.hoisted` keeps the arrays alive before
 * the mocked `sonner` factory runs, the same shape as `rail-commit.test.tsx`.
 */
const { notices, successes, failures } = vi.hoisted(() => ({
  notices: [] as string[],
  successes: [] as string[],
  failures: [] as string[],
}));
vi.mock("sonner", () => ({
  toast: {
    warning: (message: string) => {
      notices.push(message);
      return 0;
    },
    success: (message: string) => {
      successes.push(message);
      return 0;
    },
    error: (message: string) => {
      failures.push(message);
      return 0;
    },
    message: () => 0,
  },
}));

/** A `text.generate` answer for the request the store just posted. */
function generationReply(text: string, model: ModelChoice = MODEL) {
  return (input: { method: string; params?: unknown }): unknown => {
    if (input.method !== "text.generate") return {};
    const params = input.params as { requestId: string };
    return { requestId: params.requestId, text, model };
  };
}

function seed(value: GitSnapshot, options: BridgeOptions = {}): BridgeHandles {
  const handles = installBridge({ git: value, gitCommitContext: CONTEXT, ...options });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: { [PROJECT]: value },
    gitErrors: {},
    commitModels: {},
    commitGeneration: {},
  });
  return handles;
}

function messageBox(): HTMLTextAreaElement {
  return screen.getByLabelText("Commit message");
}

function generateRequests(handles: BridgeHandles) {
  return handles.hostRequests.filter((call) => call.method === "text.generate");
}

beforeEach(() => {
  notices.length = 0;
  successes.length = 0;
  failures.length = 0;
  seed(STAGED);
});

describe("the control", () => {
  it("puts the sparkle and the model chevron in the textarea's corner", () => {
    render(<CommitBox projectPath={PROJECT} />);

    const sparkle = screen.getByTestId("commit-generate");
    expect(sparkle).toHaveAttribute("aria-label", "Generate commit message");
    // The title names the two facts that matter: staged-only, and the model.
    expect(sparkle).toHaveAttribute("title", "Generate from staged changes (Default mode model)");

    const chevron = screen.getByTestId("commit-model");
    expect(chevron).toHaveAttribute("aria-label", "Commit message model");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(chevron).toHaveAttribute("aria-controls", "commit-model-menu");

    // Text never runs under the control.
    expect(messageBox()).toHaveClass("pr-12");
  });

  it("names the saved model in the sparkle's title", () => {
    seed(STAGED);
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        drafts: {},
        commitMessage: { model: { provider: "anthropic", id: "claude-sonnet-4" } },
      },
    });
    render(<CommitBox projectPath={PROJECT} />);

    expect(screen.getByTestId("commit-generate")).toHaveAttribute(
      "title",
      "Generate from staged changes (anthropic/claude-sonnet-4)",
    );
  });

  it("still commits with Ctrl+Enter and leaves generation to the button", async () => {
    const handles = seed(STAGED);
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(messageBox(), "feat: manual");
    fireEvent.keyDown(messageBox(), { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(handles.gitCalls.find((call) => call.kind === "action")?.payload).toEqual({
        kind: "commit",
        message: "feat: manual",
        amend: false,
      }),
    );
    expect(generateRequests(handles)).toHaveLength(0);
  });
});

describe("generating", () => {
  it("warns and never stages when nothing is staged", async () => {
    const handles = seed(UNSTAGED, { hostRequest: generationReply("feat: never") });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.click(screen.getByTestId("commit-generate"));

    expect(notices.at(-1)).toBe("Stage the changes you want to commit first.");
    // `git add` is the one thing the generator must never do.
    expect(handles.gitCalls.some((call) => call.kind === "action")).toBe(false);
    expect(generateRequests(handles)).toHaveLength(0);
    expect(messageBox()).toHaveValue("");
  });

  it("fills an empty draft from the staged prompt", async () => {
    const handles = seed(STAGED, { hostRequest: generationReply("feat: generated subject") });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.click(screen.getByTestId("commit-generate"));

    await waitFor(() => expect(messageBox()).toHaveValue("feat: generated subject"));

    const call = generateRequests(handles)[0];
    const params = call?.params as { cwd: string; model: unknown; prompt: string };
    expect(params.cwd).toBe(PROJECT);
    // Default: no saved pick, so the host resolves the settings default.
    expect(params.model).toBeNull();
    expect(params.prompt).toContain("Branch: main");
    expect(params.prompt).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(successes.at(-1)).toBe("Message generated with openai/gpt-5");
    // The message lands in the composer; the generator never commits or stages.
    expect(handles.gitCalls.some((call) => call.kind === "action")).toBe(false);
  });

  it("asks before replacing a draft and sends nothing when cancelled", async () => {
    const handles = seed(STAGED, { hostRequest: generationReply("feat: replaced") });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(messageBox(), "my own draft");
    await userEvent.click(screen.getByTestId("commit-generate"));

    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Replace the current commit message?");
    expect(screen.getByRole("button", { name: "Replace draft" })).toBeInTheDocument();
    // Nothing has been requested yet, and the draft is untouched.
    expect(generateRequests(handles)).toHaveLength(0);
    expect(messageBox()).toHaveValue("my own draft");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument());
    expect(messageBox()).toHaveValue("my own draft");
    expect(generateRequests(handles)).toHaveLength(0);
  });

  it("generates once the replacement is confirmed", async () => {
    const handles = seed(STAGED, { hostRequest: generationReply("feat: replaced") });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(messageBox(), "my own draft");
    await userEvent.click(screen.getByTestId("commit-generate"));
    await userEvent.click(await screen.findByRole("button", { name: "Replace draft" }));

    await waitFor(() => expect(messageBox()).toHaveValue("feat: replaced"));
    expect(generateRequests(handles)).toHaveLength(1);
  });

  it("becomes a cancel button while running and posts text.cancel", async () => {
    let resolveGenerate!: (value: unknown) => void;
    const handles = seed(STAGED, {
      hostRequest: (input) =>
        input.method === "text.generate"
          ? new Promise((resolve) => {
              resolveGenerate = resolve;
            })
          : {},
    });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.click(screen.getByTestId("commit-generate"));

    await waitFor(() =>
      expect(screen.getByTestId("commit-generate")).toHaveAttribute(
        "aria-label",
        "Cancel commit message generation",
      ),
    );
    expect(screen.getByTestId("commit-generate-spinner")).toHaveClass("animate-spin");

    const requestId = (generateRequests(handles)[0]?.params as { requestId: string }).requestId;
    await userEvent.click(screen.getByTestId("commit-generate"));

    await waitFor(() =>
      expect(
        handles.hostRequests.some(
          (call) =>
            call.method === "text.cancel" &&
            (call.params as { requestId: string }).requestId === requestId,
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId("commit-generate")).toHaveAttribute(
        "aria-label",
        "Generate commit message",
      ),
    );

    // Settle the aborted request so the test leaves nothing pending.
    resolveGenerate({ requestId, text: "feat: late", model: MODEL });
    await waitFor(() => expect(messageBox()).toHaveValue("feat: late"));
  });

  it("refuses to generate while a commit is in flight", async () => {
    seed(STAGED, {
      // A commit that never settles keeps `busy` true for the assertion.
      gitAction: () => new Promise(() => undefined),
    });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(messageBox(), "feat: mine");
    await userEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled());
    // One writer at a time: the box belongs to the commit it is running.
    expect(screen.getByTestId("commit-generate")).toBeDisabled();
  });

  it("surfaces a host refusal as a toast and leaves the draft intact", async () => {
    const handles = seed(STAGED, {
      hostRequest: (input) => {
        if (input.method === "text.generate") throw new Error("provider exploded");
        return {};
      },
    });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.type(messageBox(), "my own draft");
    await userEvent.click(screen.getByTestId("commit-generate"));
    await userEvent.click(await screen.findByRole("button", { name: "Replace draft" }));

    await waitFor(() => expect(failures.at(-1)).toBe("provider exploded"));
    expect(messageBox()).toHaveValue("my own draft");
    expect(generateRequests(handles)).toHaveLength(1);
    expect(successes).toHaveLength(0);
  });
});

describe("the model menu", () => {
  async function openMenu(): Promise<HTMLElement> {
    await userEvent.click(screen.getByTestId("commit-model"));
    return screen.findByTestId("commit-model-menu");
  }

  it("lists the default and the catalogue, and saves the pick", async () => {
    const handles = seed(STAGED, {
      hostRequest: (input) => (input.method === "text.models" ? CATALOGUE : {}),
    });
    render(<CommitBox projectPath={PROJECT} />);
    const chevron = screen.getByTestId("commit-model");

    await openMenu();
    expect(chevron).toHaveAttribute("aria-expanded", "true");

    const defaultRow = await screen.findByTestId("commit-model-default");
    expect(defaultRow).toHaveTextContent("Default (openai/gpt-5)");
    // Default is the current choice when no ref is saved.
    expect(defaultRow).toHaveAttribute("aria-pressed", "true");

    const row = await screen.findByTestId("commit-model-anthropic/claude-sonnet-4");
    expect(row).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(row);

    await waitFor(() =>
      expect(useAppStore.getState().prefs.commitMessage.model).toEqual({
        provider: "anthropic",
        id: "claude-sonnet-4",
      }),
    );
    expect(screen.queryByTestId("commit-model-menu")).not.toBeInTheDocument();
    // Persisted through the one writer (`prefs.set`), not a second copy.
    await waitFor(() =>
      expect(handles.prefs.commitMessage.model).toEqual({
        provider: "anthropic",
        id: "claude-sonnet-4",
      }),
    );
    // The request still names Default/the pick and never a hard-coded model.
    expect(generateRequests(handles)).toHaveLength(0);
  });

  it("restores Default from the Default row", async () => {
    const handles = seed(STAGED, {
      hostRequest: (input) => (input.method === "text.models" ? CATALOGUE : {}),
    });
    render(<CommitBox projectPath={PROJECT} />);

    await openMenu();
    await userEvent.click(await screen.findByTestId("commit-model-anthropic/claude-sonnet-4"));
    await waitFor(() => expect(useAppStore.getState().prefs.commitMessage.model).not.toBeNull());

    await openMenu();
    const defaultRow = await screen.findByTestId("commit-model-default");
    expect(defaultRow).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(defaultRow);

    await waitFor(() => expect(useAppStore.getState().prefs.commitMessage.model).toBeNull());
    await waitFor(() => expect(handles.prefs.commitMessage.model).toBeNull());
    expect(screen.queryByTestId("commit-model-menu")).not.toBeInTheDocument();
  });

  it("filters by name, provider or id", async () => {
    seed(STAGED, { hostRequest: (input) => (input.method === "text.models" ? CATALOGUE : {}) });
    render(<CommitBox projectPath={PROJECT} />);

    await openMenu();
    await screen.findByTestId("commit-model-openai/gpt-5");

    await userEvent.type(screen.getByLabelText("Filter models"), "claude");

    expect(screen.getByTestId("commit-model-anthropic/claude-sonnet-4")).toBeInTheDocument();
    expect(screen.queryByTestId("commit-model-openai/gpt-5")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the chevron", async () => {
    seed(STAGED, { hostRequest: (input) => (input.method === "text.models" ? CATALOGUE : {}) });
    render(<CommitBox projectPath={PROJECT} />);
    const chevron = screen.getByTestId("commit-model");

    await openMenu();
    expect(screen.getByTestId("commit-model-menu")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByTestId("commit-model-menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(chevron);
  });

  it("says the default is unavailable when the catalogue cannot resolve it", async () => {
    seed(STAGED, {
      hostRequest: (input) =>
        input.method === "text.models"
          ? {
              models: [OTHER_MODEL],
              defaultModel: { provider: "openai", id: "gpt-5", name: "gpt-5" },
              defaultAvailable: false,
            }
          : {},
    });
    render(<CommitBox projectPath={PROJECT} />);

    await openMenu();

    const defaultRow = await screen.findByTestId("commit-model-default");
    expect(defaultRow).toHaveTextContent("This model is unavailable");
  });

  it("names a saved model the catalogue no longer lists", async () => {
    seed(STAGED, {
      hostRequest: (input) =>
        input.method === "text.models"
          ? {
              models: [OTHER_MODEL],
              defaultModel: { provider: "openai", id: "gpt-5", name: "gpt-5" },
              defaultAvailable: false,
            }
          : {},
    });
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        drafts: {},
        commitMessage: { model: { provider: "openai", id: "gpt-5" } },
      },
    });
    render(<CommitBox projectPath={PROJECT} />);

    await openMenu();

    // The list still renders, and one line names the missing pick.
    expect(await screen.findByTestId("commit-model-anthropic/claude-sonnet-4")).toBeInTheDocument();
    expect(screen.getByTestId("commit-model-saved-missing")).toHaveTextContent(
      "The saved model openai/gpt-5 is unavailable",
    );
  });

  it("shows loading, then the error line and the Default row when the host fails", async () => {
    seed(STAGED, {
      hostRequest: () => {
        throw new Error("host refused");
      },
    });
    render(<CommitBox projectPath={PROJECT} />);

    await userEvent.click(screen.getByTestId("commit-model"));

    expect(await screen.findByTestId("commit-model-error")).toHaveTextContent(
      "The model list could not be loaded.",
    );
    // The Default row is still there, disabled because nothing could resolve.
    const defaultRow = screen.getByTestId("commit-model-default");
    expect(defaultRow).toBeInTheDocument();
    expect(defaultRow).toBeDisabled();
  });
});
