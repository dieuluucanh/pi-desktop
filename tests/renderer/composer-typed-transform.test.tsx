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
import type { HostCommandEntry } from "../../src/renderer/src/completion/command-source";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import { installBridge } from "./fixtures";

/**
 * Typed `/command <prompt>` and the structured operation (2026-11-22
 * prompt-refinement plan step 24).
 *
 * A typed refinement command must be the same operation as the toggle/button:
 * the literal arguments become the transformation input, the draft and its
 * attachments are never consumed by the generic command clear rules, and the
 * command's own handler never runs (that path would drop images and report a
 * text-only result as success).
 *
 * Every case counts host methods: a typed transform may only reach
 * `composer.transform`, never `prompt`, `bash.run` or `commands.run`.
 */

const OWNER = "refine.ext";
const PUBLIC_COMMAND = "prompt";

const HOST_COMMANDS: HostCommandEntry[] = [
  { name: PUBLIC_COMMAND, description: "Refine the prompt", source: "extension" },
  { name: "prompt-model", description: "Refinement model", source: "extension" },
  { name: "deploy", description: "Deploy", source: "extension" },
  // A template and a skill that happen to share an advertised command name must
  // keep their own routing: only the `extension` source can be a transform.
  { name: "review", description: "Review a change", source: "prompt" },
  { name: "skill:refine", description: "Refine a skill", source: "skill" },
];

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
    checked: false,
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
  extra: Contribution[] = [],
): ContributionSnapshot {
  const all: Contribution[] = [
    ...(control ? [control] : []),
    action("toggle", "prompt-toggle"),
    action("transform"),
    ...extra,
  ];
  return buildContributionSnapshot(
    [{ ownerId: OWNER, epoch: 0, revision: 1, contributions: all }],
    {
      supported: true,
      updatedAt: 1,
    },
  );
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
  commands?: HostCommandEntry[];
  transform?: (input: unknown) => unknown;
}

function stubRequest(options: StubOptions = {}) {
  const snapshot = options.snapshot ?? contributions();
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    if (input.method === "contributions.state") {
      return useAppStore.getState().contributions["tab-1"] ?? snapshot;
    }
    if (input.method === "commands.list") return { commands: options.commands ?? HOST_COMMANDS };
    if (input.method === "commands.run") return { ran: true };
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
    completionCommands: {},
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

function transformParams(request: ReturnType<typeof stubRequest>): ComposerTransformStartRequest {
  const call = request.mock.calls.find((entry) => entry[0].method === "composer.transform");
  if (!call) throw new Error("expected one composer.transform request");
  return call[0].params as ComposerTransformStartRequest;
}

beforeEach(() => {
  installBridge();
  resetStore();
});

describe("typed refinement command", () => {
  it("routes the literal arguments through composer.transform while the toggle is off", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "/prompt please improve the child-session lifecycle");
    const before = useAppStore.getState().draftSnapshot("tab-1");

    await expect(
      useAppStore
        .getState()
        .sendPrompt("tab-1", "/prompt please improve the child-session lifecycle"),
    ).resolves.toBe("refining");

    expect(methods(request)).toContain("composer.transform");
    expect(methods(request)).not.toContain("prompt");
    expect(methods(request)).not.toContain("commands.run");
    expect(methods(request)).not.toContain("bash.run");
    expect(methods(request).filter((method) => method === "composer.transform")).toHaveLength(1);

    const params = transformParams(request);
    expect(params.ownerId).toBe(OWNER);
    expect(params.controlId).toBe("refine");
    expect(params.actionId).toBe("toggle");
    expect(params.transformActionId).toBe("transform");
    expect(params.snapshot).toMatchObject({
      draftRevision: before.revision,
      text: "please improve the child-session lifecycle",
      inputState: "idle",
    });
    // The literal text — not the `/prompt` prefix — is the refinement input.
    expect(params.snapshot.text.startsWith("/")).toBe(false);

    // Nothing was cleared, remembered or consumed.
    const after = useAppStore.getState();
    expect(after.prefs.drafts["tab-1"]).toBe("/prompt please improve the child-session lifecycle");
    expect(after.draftHistory["tab-1"] ?? []).toEqual([]);
    // An explicit typed command arms exactly this control for the operation.
    expect(composerOperationDerivedFor(after, "tab-1").isRunning).toBe(true);
    expect(after.composerOperations["tab-1"]?.operation?.baseText).toBe(
      "please improve the child-session lifecycle",
    );
  });

  it("is the same operation as the armed toggle/button", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "/prompt tighten this prompt");
    await useAppStore.getState().sendPrompt("tab-1", "/prompt tighten this prompt");
    const typed = transformParams(request);

    resetStore({ contributions: { "tab-1": contributions(composerControl({ checked: true })) } });
    const second = stubRequest({
      snapshot: contributions(composerControl({ checked: true })),
    });
    useAppStore.getState().setDraft("tab-1", "tighten this prompt");
    await useAppStore.getState().sendPrompt("tab-1", "tighten this prompt");
    const armedSend = transformParams(second);

    const stable = (value: ComposerTransformStartRequest) => ({
      contract: value.contract,
      ownerId: value.ownerId,
      controlId: value.controlId,
      actionId: value.actionId,
      transformActionId: value.transformActionId,
      contributionRevision: value.contributionRevision,
      binding: value.binding,
      text: value.snapshot.text,
      selection: value.snapshot.selection,
      attachments: value.snapshot.attachments,
    });
    expect(stable(typed)).toEqual(stable(armedSend));
    expect(methods(second)).not.toContain("prompt");
  });

  it("keeps images in the capture and out of the generic clear rules", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "/prompt describe this bug");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1"), image("image-2")]);

    await expect(
      useAppStore.getState().sendPrompt("tab-1", "/prompt describe this bug"),
    ).resolves.toBe("refining");

    const params = transformParams(request);
    expect(params.snapshot.attachments.map((entry) => entry.id)).toEqual(["image-1", "image-2"]);
    expect(params.images?.map((entry) => entry.id)).toEqual(["image-1", "image-2"]);
    expect(methods(request)).not.toContain("prompt");
    expect(
      useAppStore
        .getState()
        .draftSnapshot("tab-1")
        .attachments.map((entry) => entry.id),
    ).toEqual(["image-1", "image-2"]);
  });

  it("works while the toggle is already on without starting twice", async () => {
    const snapshot = contributions(composerControl({ checked: true }));
    const request = stubRequest({ snapshot });
    resetStore({
      contributions: { "tab-1": snapshot },
    });
    useAppStore.getState().setDraft("tab-1", "/prompt refine this");
    await useAppStore.getState().sendPrompt("tab-1", "/prompt refine this");

    expect(methods(request).filter((method) => method === "composer.transform")).toHaveLength(1);
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("/prompt refine this");
  });
});

describe("typed refinement refusals", () => {
  it("shows usage for an empty argument and keeps the draft and images", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "/prompt");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);

    await expect(useAppStore.getState().sendPrompt("tab-1", "/prompt")).resolves.toBe("refused");

    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).not.toContain("commands.run");
    expect(useAppStore.getState().hint).toMatch(/needs a prompt to refine/);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("/prompt");
    expect(useAppStore.getState().draftSnapshot("tab-1").attachments).toHaveLength(1);
  });

  it("refuses honestly when the host cannot run the operation, never falling back to a command run", async () => {
    const request = stubRequest({
      transform: () => {
        throw new Error("not implemented yet: composer.transform");
      },
    });
    useAppStore.getState().setDraft("tab-1", "/prompt refine this");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);

    await expect(useAppStore.getState().sendPrompt("tab-1", "/prompt refine this")).resolves.toBe(
      "refused",
    );

    expect(methods(request)).not.toContain("commands.run");
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().hint).toMatch(/Refinement could not start/);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("/prompt refine this");
    expect(useAppStore.getState().draftSnapshot("tab-1").attachments).toHaveLength(1);
  });

  it("refuses a disabled control with its published reason", async () => {
    const snapshot = contributions(
      composerControl({ enabled: false, disabledReason: "Vision model required" }),
    );
    const request = stubRequest({ snapshot });
    resetStore({ contributions: { "tab-1": snapshot } });
    useAppStore.getState().setDraft("tab-1", "/prompt describe this screenshot");

    await expect(
      useAppStore.getState().sendPrompt("tab-1", "/prompt describe this screenshot"),
    ).resolves.toBe("refused");

    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).not.toContain("commands.run");
    expect(useAppStore.getState().hint).toBe("Vision model required");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("/prompt describe this screenshot");
  });

  it("leaves an unknown or malformed command on the existing hint path", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "/promptx refine this");

    await expect(useAppStore.getState().sendPrompt("tab-1", "/promptx refine this")).resolves.toBe(
      "handled-command",
    );

    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).not.toContain("prompt");
    expect(useAppStore.getState().hint).toMatch(/Unknown command \/promptx/);
  });

  it("never treats a collision-suffixed registration as the advertised command", async () => {
    const request = stubRequest({
      commands: [
        { name: "prompt:1", description: "Refine", source: "extension" },
        { name: "prompt:2", description: "Other", source: "extension" },
      ],
    });
    useAppStore.getState().setDraft("tab-1", "/prompt:2 refine this");

    await useAppStore.getState().sendPrompt("tab-1", "/prompt:2 refine this");

    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).toContain("commands.run");
  });
});

describe("non-transform commands keep their routing", () => {
  it("runs another extension command directly instead of refining it", async () => {
    const request = stubRequest();
    useAppStore.getState().setDraft("tab-1", "/prompt-model status");

    await useAppStore.getState().sendPrompt("tab-1", "/prompt-model status");

    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).toContain("commands.run");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");
  });

  it("keeps a prompt template on the prompt path even when a control advertises its name", async () => {
    const extra: Contribution[] = [
      composerControl({
        id: "review-refine",
        actionRef: "review-toggle",
        transformActionRef: "review-transform",
      }),
      action("review-toggle", "review-toggle"),
      action("review-transform", "review"),
    ];
    const snapshot = contributions(undefined, extra);
    const request = stubRequest({ snapshot });
    resetStore({ contributions: { "tab-1": snapshot } });
    useAppStore.getState().setDraft("tab-1", "/review my change");

    await useAppStore.getState().sendPrompt("tab-1", "/review my change");

    expect(methods(request)).not.toContain("composer.transform");
    expect(methods(request)).toContain("prompt");
  });
});
