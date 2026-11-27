import { beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ModelChoice, TextGenerationModelCatalog } from "../../src/shared/text-generation";
import type { GitCommitContext } from "../../src/shared/git";
import { installBridge, type BridgeHandles } from "./fixtures";

/**
 * The renderer's AI commit-message slice (2026-11-25 plan step 17).
 *
 * The host and the prompt are proven elsewhere; this suite pins the store's
 * bookkeeping: the catalogue is cached per folder, a generation carries the
 * staged context's prompt and the saved model, nothing staged never reaches the
 * host, a refusal lands in `commitGeneration.error`, and Cancel aborts the live
 * request id.
 *
 * It runs with no component mounted — the commit box (step 18) is only a view.
 */

const PROJECT = "/work/app";
const OTHER = "/work/other";

const MODEL: ModelChoice = { provider: "openai", id: "gpt-5", name: "GPT-5" };

function context(overrides: Partial<GitCommitContext> = {}): GitCommitContext {
  return {
    projectPath: PROJECT,
    branch: "main",
    stat: " src/a.ts | 2 ++\n 1 file changed, 2 insertions(+)",
    patch: "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;",
    truncated: false,
    files: 1,
    insertions: 2,
    deletions: 0,
    recentSubjects: ["feat: seed"],
    ...overrides,
  };
}

function catalogue(
  overrides: Partial<TextGenerationModelCatalog> = {},
): TextGenerationModelCatalog {
  return { models: [MODEL], defaultModel: MODEL, defaultAvailable: true, ...overrides };
}

function resetStore(): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    commitModels: {},
    commitGeneration: {},
  });
}

let handles: BridgeHandles;

beforeEach(() => {
  resetStore();
  handles = installBridge({ gitCommitContext: context() });
});

describe("loadCommitModels", () => {
  it("asks the control host with the folder and caches per folder", async () => {
    handles = installBridge({
      hostRequest: (input) =>
        input.method === "text.models"
          ? { ...catalogue(), models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }
          : {},
    });

    const first = await useAppStore.getState().loadCommitModels(PROJECT);
    expect(first).toEqual(catalogue());
    expect(useAppStore.getState().commitModels[PROJECT]).toEqual(catalogue());

    const models = handles.hostRequests.filter((call) => call.method === "text.models");
    expect(models).toEqual([{ tabId: "control", method: "text.models", params: { cwd: PROJECT } }]);

    // A second open is free: the folder already has a catalogue.
    const again = await useAppStore.getState().loadCommitModels(PROJECT);
    expect(again).toEqual(catalogue());
    expect(handles.hostRequests.filter((call) => call.method === "text.models")).toHaveLength(1);

    // Another folder gets its own entry, leaving the first alone.
    await useAppStore.getState().loadCommitModels(OTHER);
    expect(useAppStore.getState().commitModels[OTHER]).toEqual(catalogue());
    expect(useAppStore.getState().commitModels[PROJECT]).toEqual(catalogue());
  });

  it("returns null and records the failure when the reply is not a catalogue", async () => {
    handles = installBridge({ hostRequest: () => ({ models: "nope" }) });

    const result = await useAppStore.getState().loadCommitModels(PROJECT);
    expect(result).toBeNull();
    expect(useAppStore.getState().commitModels[PROJECT]).toBeUndefined();
    expect(useAppStore.getState().hint).toBeTruthy();
  });
});

describe("generateCommitMessage", () => {
  it("posts the staged prompt and returns the cleaned message and model", async () => {
    handles = installBridge({
      gitCommitContext: context(),
      hostRequest: () => ({ text: "```\nfeat: add a thing\n\nbody line\n```", model: MODEL }),
    });

    const result = await useAppStore.getState().generateCommitMessage(PROJECT);

    const call = handles.hostRequests.find((entry) => entry.method === "text.generate");
    expect(call).toBeDefined();
    expect(call?.tabId).toBe("control");
    const params = call?.params as {
      requestId: string;
      cwd: string;
      model: unknown;
      system: string;
      prompt: string;
    };
    expect(params.cwd).toBe(PROJECT);
    // Default: no saved pick, so the host resolves the settings default.
    expect(params.model).toBeNull();
    expect(params.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(params.system).toContain("commit messages");
    expect(params.prompt).toContain("Branch: main");
    expect(params.prompt).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(params.prompt).toContain("Recent commit subjects:");

    expect(result).toEqual({ ok: true, message: "feat: add a thing\n\nbody line", model: MODEL });
    expect(useAppStore.getState().commitGeneration[PROJECT]).toEqual({
      phase: "idle",
      requestId: null,
      error: null,
    });
  });

  it("forwards the saved model instead of Default", async () => {
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        commitMessage: { model: { provider: "anthropic", id: "claude-sonnet-4" } },
      },
    });
    handles = installBridge({
      gitCommitContext: context(),
      hostRequest: () => ({ text: "fix: x", model: MODEL }),
    });

    await useAppStore.getState().generateCommitMessage(PROJECT);

    const call = handles.hostRequests.find((entry) => entry.method === "text.generate");
    expect((call?.params as { model: unknown }).model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4",
    });
  });

  it("refuses when nothing is staged and never reaches the host", async () => {
    handles = installBridge({ gitCommitContext: context({ files: 0, stat: "", patch: "" }) });

    const result = await useAppStore.getState().generateCommitMessage(PROJECT);

    expect(result).toEqual({
      ok: false,
      error: "Stage the changes you want to commit first.",
    });
    expect(handles.hostRequests.some((call) => call.method === "text.generate")).toBe(false);
    // A refusal is not a run: no generation entry was written.
    expect(useAppStore.getState().commitGeneration[PROJECT]).toBeUndefined();
  });

  it("records a host refusal on the folder's generation state", async () => {
    handles = installBridge({
      gitCommitContext: context(),
      hostRequest: () => {
        throw new Error("provider exploded");
      },
    });

    const result = await useAppStore.getState().generateCommitMessage(PROJECT);

    expect(result).toEqual({ ok: false, error: "provider exploded" });
    expect(useAppStore.getState().commitGeneration[PROJECT]).toEqual({
      phase: "idle",
      requestId: null,
      error: "provider exploded",
    });
  });

  it("refuses a second generation while one is running", async () => {
    let resolveGenerate!: (value: unknown) => void;
    handles = installBridge({
      gitCommitContext: context(),
      hostRequest: () =>
        new Promise((resolve) => {
          resolveGenerate = resolve;
        }),
    });

    const running = useAppStore.getState().generateCommitMessage(PROJECT);
    await waitFor(() =>
      expect(useAppStore.getState().commitGeneration[PROJECT]?.phase).toBe("running"),
    );

    const second = await useAppStore.getState().generateCommitMessage(PROJECT);
    expect(second).toEqual({ ok: false, error: "already running" });
    expect(handles.hostRequests.filter((call) => call.method === "text.generate")).toHaveLength(1);

    resolveGenerate({ text: "feat: done", model: MODEL });
    await running;
  });
});

describe("cancelCommitMessage", () => {
  it("aborts the live request id and returns the phase to idle", async () => {
    let resolveGenerate!: (value: unknown) => void;
    handles = installBridge({
      gitCommitContext: context(),
      hostRequest: (input) =>
        input.method === "text.generate"
          ? new Promise((resolve) => {
              resolveGenerate = resolve;
            })
          : {},
    });

    const running = useAppStore.getState().generateCommitMessage(PROJECT);
    await waitFor(() =>
      expect(useAppStore.getState().commitGeneration[PROJECT]?.phase).toBe("running"),
    );
    const live = useAppStore.getState().commitGeneration[PROJECT]?.requestId;

    await useAppStore.getState().cancelCommitMessage(PROJECT);

    const cancel = handles.hostRequests.find((call) => call.method === "text.cancel");
    expect(cancel?.params).toEqual({ requestId: live });
    expect(useAppStore.getState().commitGeneration[PROJECT]).toEqual({
      phase: "idle",
      requestId: null,
      error: null,
    });

    resolveGenerate({ text: "feat: late", model: MODEL });
    await running;
  });

  it("is a no-op when nothing is running", async () => {
    await useAppStore.getState().cancelCommitMessage(PROJECT);

    expect(handles.hostRequests.some((call) => call.method === "text.cancel")).toBe(false);
    expect(useAppStore.getState().commitGeneration[PROJECT]).toBeUndefined();
  });
});

describe("setCommitMessageModel", () => {
  it("writes the pick through prefs.set and keeps it on the store", () => {
    useAppStore.getState().setCommitMessageModel({ provider: "openai", id: "gpt-5" });

    expect(useAppStore.getState().prefs.commitMessage.model).toEqual({
      provider: "openai",
      id: "gpt-5",
    });
    expect(handles.prefs.commitMessage.model).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it("restores Default with null", () => {
    useAppStore.getState().setCommitMessageModel({ provider: "openai", id: "gpt-5" });
    useAppStore.getState().setCommitMessageModel(null);

    expect(useAppStore.getState().prefs.commitMessage.model).toBeNull();
    expect(handles.prefs.commitMessage.model).toBeNull();
  });
});
