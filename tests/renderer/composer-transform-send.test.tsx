import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildContributionSnapshot,
  type ContributionSnapshot,
} from "../../src/shared/extension-contributions-view";
import type { ActionContribution, Contribution } from "../../src/shared/extension-contributions";
import {
  COMPOSER_TRANSFORM_CONTRACT,
  type ComposerControlContribution,
  type ComposerTransformStartRequest,
} from "../../src/shared/composer-transform";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { composerOperationDerivedFor, useAppStore } from "../../src/renderer/src/state/app-store";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import { installBridge } from "./fixtures";

/**
 * Armed Send is a transformation, not a chat send (2026-11-22 prompt-refinement
 * plan step 20).
 *
 * Every case counts host methods: a transformation may only reach
 * `composer.transform`, never `prompt`, `bash.run` or a steer/follow-up prompt.
 * The draft, its attachments and its prompt history stay untouched until the
 * CAS apply in step 19/22.
 */

const OWNER = "refine.ext";
const PUBLIC_COMMAND = "prompt";

function composerControl(
  over: Partial<ComposerControlContribution> = {},
): ComposerControlContribution {
  return {
    id: "refine",
    kind: "composer-control",
    slot: "composer-actions",
    tone: "accent",
    order: 0,
    label: "Refine prompt",
    description: "Returns a refined draft; never runs it.",
    icon: "sparkles",
    checked: true,
    enabled: true,
    behavior: "one-shot-return",
    actionRef: "toggle",
    transformActionRef: "transform",
    operation: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      publicCommand: PUBLIC_COMMAND,
      companionCommand: "prompt-companion",
    },
    ...over,
  };
}

function action(id: string, name = PUBLIC_COMMAND): ActionContribution {
  return {
    id,
    kind: "action",
    slot: "action",
    label: `Run ${id}`,
    tone: "neutral",
    order: 0,
    command: { name },
    enabled: true,
  };
}

function contributions(
  control: ComposerControlContribution | null = composerControl(),
): ContributionSnapshot {
  const contributions: Contribution[] = [
    ...(control ? [control] : []),
    action("toggle", "prompt-toggle"),
    action("transform"),
  ];
  return buildContributionSnapshot([{ ownerId: OWNER, epoch: 0, revision: 1, contributions }], {
    supported: true,
    updatedAt: 1,
  });
}

function tab(status: TabRecord["status"] = "idle"): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status,
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function image(id: string, data = "AAAA"): ImageAttachment {
  return { id, name: "shot.png", mimeType: "image/png", data };
}

function startedReceipt(input: unknown): unknown {
  const request = input as ComposerTransformStartRequest;
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: request.requestId,
    operationId: "op-1",
    status: "started",
    binding: request.binding,
    startedAt: 1_700_000_000_000,
  };
}

interface StubOptions {
  snapshot?: ContributionSnapshot;
  transform?: (input: unknown) => unknown;
}

function stubRequest(options: StubOptions = {}) {
  const snapshot = options.snapshot ?? contributions();
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    if (input.method === "contributions.state") {
      // Echo whatever snapshot the test installed, so an ensure/wake cannot
      // disarm a control the case just published.
      return useAppStore.getState().contributions["tab-1"] ?? snapshot;
    }
    if (input.method === "composer.transform") {
      return options.transform ? options.transform(input.params) : startedReceipt(input.params);
    }
    return {};
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function resetStore(over: Partial<Parameters<typeof useAppStore.setState>[0]> = {}): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: "tab-1",
    transcripts: {},
    sessionStates: { "tab-1": { sessionId: "session-1" } },
    sessionEpochs: { "tab-1": 1 },
    contributions: { "tab-1": contributions() },
    composerDrafts: {},
    composerOperations: {},
    composerApplyReceipts: {},
    draftHistory: {},
    historyBrowse: {},
    pasteBodies: {},
    pasteCounter: 1,
    hint: null,
    ...over,
  });
}

function methods(request: ReturnType<typeof stubRequest>): string[] {
  return request.mock.calls.map((call) => call[0].method);
}

beforeEach(() => {
  installBridge();
  resetStore();
});

describe("armed Send", () => {
  it("starts a transformation and preserves text, images and history", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "please fix it");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);
    const before = useAppStore.getState().draftSnapshot("tab-1");

    await expect(useAppStore.getState().sendPrompt("tab-1", "please fix it")).resolves.toBe(
      "refining",
    );

    expect(methods(request)).not.toContain("prompt");
    expect(methods(request)).not.toContain("bash.run");
    expect(methods(request)).toContain("composer.transform");
    const transform = request.mock.calls.find((call) => call[0].method === "composer.transform");
    const params = transform?.[0].params as ComposerTransformStartRequest;
    expect(params.snapshot).toMatchObject({
      draftRevision: before.revision,
      text: "please fix it",
      inputState: "idle",
    });
    expect(params.binding).toMatchObject({ sessionId: "session-1", epoch: 1 });
    expect(params.ownerId).toBe(OWNER);
    expect(params.snapshot.attachments.map((entry) => entry.id)).toEqual(["image-1"]);
    expect(params.images?.map((entry) => entry.id)).toEqual(["image-1"]);

    // Nothing was cleared, remembered or consumed.
    const after = useAppStore.getState();
    expect(after.prefs.drafts["tab-1"]).toBe("please fix it");
    expect(after.draftSnapshot("tab-1").attachments.map((entry) => entry.id)).toEqual(["image-1"]);
    expect(after.draftHistory["tab-1"] ?? []).toEqual([]);
    expect(after.composerOperationView("tab-1").isRunning).toBe(true);
  });

  it("refuses a second Send while the operation is active", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "please fix it");
    await useAppStore.getState().sendPrompt("tab-1", "please fix it");

    await expect(useAppStore.getState().sendPrompt("tab-1", "please fix it")).resolves.toBe(
      "refused",
    );
    expect(methods(request).filter((method) => method === "composer.transform")).toHaveLength(1);
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("please fix it");
  });

  it("keeps the draft and the toggle armed when the host refuses to start", async () => {
    const request = stubRequest({
      transform: () => {
        throw new Error("no companion");
      },
    });
    useAppStore.getState().setDraft("tab-1", "please fix it");

    await expect(useAppStore.getState().sendPrompt("tab-1", "please fix it")).resolves.toBe(
      "refused",
    );
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("please fix it");
    expect(useAppStore.getState().hint).toMatch(/Refinement could not start/);
    // A failed start leaves the user able to retry.
    expect(composerOperationDerivedFor(useAppStore.getState(), "tab-1").armed).toHaveLength(1);
  });
});

describe("armed Send refusals", () => {
  it("refuses an active run instead of steering or queueing the task", async () => {
    const request = stubRequest();
    resetStore({ tabs: [tab("running")] });
    useAppStore.getState().setDraft("tab-1", "please fix it");

    await expect(useAppStore.getState().sendPrompt("tab-1", "please fix it")).resolves.toBe(
      "refused",
    );
    expect(methods(request)).not.toContain("prompt");
    expect(methods(request)).not.toContain("composer.transform");
    expect(useAppStore.getState().hint).toMatch(/idle session/);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("please fix it");
  });

  it("refuses an images-only draft rather than dispatching the task", async () => {
    const request = stubRequest();
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);

    await expect(useAppStore.getState().sendPrompt("tab-1", "")).resolves.toBe("refused");
    expect(methods(request)).not.toContain("prompt");
    expect(methods(request)).not.toContain("composer.transform");
    expect(useAppStore.getState().draftSnapshot("tab-1").attachments).toHaveLength(1);
    expect(useAppStore.getState().hint).toMatch(/needs prompt text/);
  });

  it("refuses a disabled armed control with its published reason", async () => {
    const request = stubRequest();
    resetStore({
      contributions: {
        "tab-1": contributions(
          composerControl({ enabled: false, disabledReason: "Vision model required" }),
        ),
      },
    });
    useAppStore.getState().setDraft("tab-1", "describe this screenshot");

    await expect(
      useAppStore.getState().sendPrompt("tab-1", "describe this screenshot"),
    ).resolves.toBe("refused");
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().hint).toBe("Vision model required");
  });

  it("refuses when two transform controls are armed", async () => {
    const request = stubRequest();
    resetStore({
      contributions: {
        "tab-1": contributions(
          composerControl({
            id: "refine-a",
            actionRef: "toggle",
            transformActionRef: "transform",
          }),
        ),
      },
    });
    // A second publisher-controlled armed row, sharing no action ids.
    const second = buildContributionSnapshot(
      [
        {
          ownerId: "other.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            composerControl({
              id: "refine-b",
              actionRef: "toggle-b",
              transformActionRef: "transform-b",
            }),
            action("toggle-b", "prompt-toggle"),
            action("transform-b"),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const first = useAppStore.getState().contributions["tab-1"]!;
    useAppStore.setState({
      contributions: {
        "tab-1": {
          ...first,
          owners: [...first.owners, ...second.owners],
          contributions: [...first.contributions, ...second.contributions],
        },
      },
    });
    useAppStore.getState().setDraft("tab-1", "please fix it");

    await expect(useAppStore.getState().sendPrompt("tab-1", "please fix it")).resolves.toBe(
      "refused",
    );
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().hint).toMatch(/choose one/);
  });

  it("refuses refinement while messages are queued", async () => {
    const request = stubRequest();
    resetStore({
      transcripts: {
        "tab-1": { queue: { steering: ["later"], followUp: [] } } as never,
      },
    });
    useAppStore.getState().setDraft("tab-1", "please fix it");

    await expect(useAppStore.getState().sendPrompt("tab-1", "please fix it")).resolves.toBe(
      "refused",
    );
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().hint).toMatch(/queued/);
  });
});

describe("normal routing is untouched", () => {
  it("sends a prompt normally when refinement is off", async () => {
    const request = stubRequest();
    resetStore({ contributions: { "tab-1": contributions(composerControl({ checked: false })) } });
    useAppStore.getState().setDraft("tab-1", "just send");

    await expect(useAppStore.getState().sendPrompt("tab-1", "just send")).resolves.toBe("sent");
    const prompt = request.mock.calls.find((call) => call[0].method === "prompt");
    expect(prompt?.[0].params).toMatchObject({ text: "just send" });
    expect(methods(request)).not.toContain("composer.transform");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");
  });

  it("keeps a steer/follow-up send normal when refinement is off", async () => {
    const request = stubRequest();
    resetStore({
      tabs: [tab("running")],
      contributions: { "tab-1": contributions(composerControl({ checked: false })) },
    });
    useAppStore.getState().setDraft("tab-1", "then commit");

    await expect(
      useAppStore.getState().sendPrompt("tab-1", "then commit", { mode: "followUp" }),
    ).resolves.toBe("sent");
    const prompt = request.mock.calls.find((call) => call[0].method === "prompt");
    expect(prompt?.[0].params).toMatchObject({
      text: "then commit",
      streamingBehavior: "followUp",
    });
    expect(methods(request)).not.toContain("composer.transform");
  });

  it("keeps a shell command on the bash path while the toggle stays armed", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "!git status");

    await expect(useAppStore.getState().sendPrompt("tab-1", "!git status")).resolves.toBe("sent");
    expect(methods(request)).toContain("bash.run");
    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).not.toContain("prompt");
    expect(composerOperationDerivedFor(useAppStore.getState(), "tab-1").armed).toHaveLength(1);
  });

  it("keeps a slash command consumed while the toggle stays armed", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "/new");

    await expect(useAppStore.getState().sendPrompt("tab-1", "/new")).resolves.toBe(
      "handled-command",
    );
    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).not.toContain("prompt");
    expect(composerOperationDerivedFor(useAppStore.getState(), "tab-1").armed).toHaveLength(1);
  });
});
