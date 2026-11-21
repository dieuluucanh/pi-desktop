import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionCore,
  type HostSession,
  type RuntimeLike,
  type SessionCoreDeps,
  type SessionRuntimeRequest,
} from "../../src/host/session-core";
import type { AttachmentDeliveryScope } from "../../src/shared/attachments";
import { createAttachmentTransferStore } from "../../src/host/attachment-transfer";
import { createAttachmentImagePreparationStore } from "../../src/host/attachment-image-preparation";
import type { HostMethod } from "../../src/shared/host-protocol";
import type { HostRequestContext } from "../../src/host/service";

/**
 * Session core tests against an injected fake runtime: the trust gate, the
 * protocol handlers, the event → frame bridge and rebinding after a fork.
 */

const CWD = "C:/work";
const AGENT_DIR = "C:/profile";

interface FakeSessionOptions {
  sessionId?: string;
  messages?: unknown[];
}

function fakeSession(options: FakeSessionOptions = {}) {
  const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
  const prompts: string[] = [];
  const state = {
    sessionId: options.sessionId ?? "session-1",
    sessionFile: `C:/profile/sessions/${options.sessionId ?? "session-1"}.jsonl`,
    sessionName: "Budget work",
    messages: options.messages ?? [],
    streaming: false,
    model: { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
    thinkingLevel: "medium",
  };

  const session: HostSession = {
    get sessionId() {
      return state.sessionId;
    },
    get sessionFile() {
      return state.sessionFile;
    },
    get sessionName() {
      return state.sessionName;
    },
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.thinkingLevel;
    },
    get isStreaming() {
      return state.streaming;
    },
    get isIdle() {
      return !state.streaming;
    },
    get messages() {
      return state.messages;
    },
    get pendingMessageCount() {
      return 0;
    },
    getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    getActiveToolNames: () => ["read"],
    getAllTools: () => [{}, {}],
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async prompt(text) {
      prompts.push(text);
      emit({ type: "agent_start" });
      state.streaming = true;
      emit({ type: "message_update", text: "hello" });
      state.streaming = false;
      state.messages = [
        ...state.messages,
        { role: "user", text },
        { role: "assistant", text: "hi" },
      ];
      emit({ type: "agent_end", messages: state.messages });
    },
    async abort() {
      state.streaming = false;
    },
    clearQueue: () => ({ steering: ["a"], followUp: [] }),
    async setModel(model) {
      state.model = model as typeof state.model;
    },
    setThinkingLevel(level) {
      state.thinkingLevel = level;
    },
    setActiveToolsByName() {},
  };

  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };

  return { session, prompts, emit, listeners, state };
}

function fakeRuntime(initial: HostSession, nextSession?: () => HostSession) {
  let current = initial;
  let rebind: (() => Promise<void>) | undefined;
  const forks: string[] = [];

  const runtime: RuntimeLike & { setCurrent(session: HostSession): void; rebind(): Promise<void> } =
    {
      get session() {
        return current;
      },
      get services() {
        return {
          cwd: CWD,
          settingsManager: {
            getGlobalSettings: () => ({ theme: "dark", npmCommand: ["node", "npm-cli.js"] }),
            getProjectSettings: () => ({ defaultTools: ["read"] }),
            drainErrors: () => [{ message: "one warning" }],
          },
        };
      },
      async fork(entryId) {
        forks.push(entryId);
        if (nextSession) current = nextSession();
        await rebind?.();
        return { cancelled: false, selectedText: "from the fork point" };
      },
      setRebindSession(fn) {
        rebind = fn;
      },
      async dispose() {},
      setCurrent(session) {
        current = session;
      },
      rebind: async () => {
        await rebind?.();
      },
    };

  return { runtime, forks };
}

function harness(deps: Partial<SessionCoreDeps> = {}) {
  const primary = fakeSession();
  const forked = fakeSession({ sessionId: "session-forked" });
  const { runtime, forks } = fakeRuntime(primary.session, () => forked.session);
  const emitted: Array<{ event: string; payload: unknown; sessionId?: string }> = [];
  const trustStore = new Map<string, boolean | null>();

  const core = createSessionCore({
    cwd: CWD,
    agentDir: AGENT_DIR,
    createRuntime: async () => ({ runtime, session: runtime.session }),
    newSessionManager: () => ({ id: "new" }),
    openSessionManager: () => ({ id: "opened" }),
    trustStore: {
      get: (cwd) => trustStore.get(cwd) ?? null,
      set: (cwd, decision) => {
        trustStore.set(cwd, decision);
      },
    },
    requiresTrust: () => false,
    emit: (event, payload, sessionId) => {
      emitted.push({ event, payload, sessionId: sessionId ?? "" });
    },
    ...deps,
  });

  const context: HostRequestContext = {
    method: "state.get" as HostMethod,
    requestId: 1,
    emit: () => {},
    readBlob: async () => null,
  };

  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = core.handlers()[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, { ...context, method });
  };

  const events = (): string[] => emitted.map((entry) => entry.event);

  return { core, call, emitted, events, trustStore, forks, primary, forked, runtime };
}

const RACE_IDS = {
  transferId: "123e4567-e89b-42d3-a456-426614174101",
  turnId: "123e4567-e89b-42d3-a456-426614174102",
  attemptId: "123e4567-e89b-42d3-a456-426614174103",
  planId: "123e4567-e89b-42d3-a456-426614174104",
  draftId: "123e4567-e89b-42d3-a456-426614174105",
  representationId: "123e4567-e89b-42d3-a456-426614174106",
  authorityId: "123e4567-e89b-42d3-a456-426614174107",
} as const;

async function stageAttachmentPlan(
  dispatchAttachmentPrompt: NonNullable<SessionCoreDeps["dispatchAttachmentPrompt"]>,
) {
  const h = harness({
    createAttachmentTransferStore: (current) =>
      createAttachmentTransferStore({
        now: () => 1_000,
        current,
        sha256: (value) => createHash("sha256").update(value).digest("hex"),
        schedule: () => () => {},
      }),
    newAttachmentId: () => RACE_IDS.planId,
    dispatchAttachmentPrompt,
  });
  await h.call("session.create");
  h.primary.state.model = {
    provider: "openai",
    id: "fixture-model",
    api: "openai-completions",
    input: ["text", "image"],
    inputLimits: { maxRequestBytes: 20_000_000 },
  } as never;
  h.primary.session.getContextUsage = () => ({ tokens: 100, contextWindow: 100_000 });
  const hostContext = (await h.call("attachments.context")) as {
    branchId: string | null;
    revision: string;
  };
  const bytes = new TextEncoder().encode("race-test attachment");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const scope: AttachmentDeliveryScope = {
    authorityId: RACE_IDS.authorityId,
    leaseId: RACE_IDS.transferId,
    profileKey: "a".repeat(64),
    tabId: "tab-1",
    draftId: RACE_IDS.draftId,
    hostGeneration: 1,
    processGeneration: 1,
    sessionId: "session-1",
    sessionEpoch: 1,
    branchId: hostContext.branchId,
    revision: hostContext.revision,
  };
  const asset = {
    original: {
      id: RACE_IDS.draftId,
      name: "race.txt",
      kind: "text" as const,
      bytes: bytes.length,
      sha256: digest,
    },
    representation: {
      id: RACE_IDS.representationId,
      attachmentId: RACE_IDS.draftId,
      modality: "text" as const,
      origin: "direct" as const,
      bytes: bytes.length,
      originalSha256: digest,
      representationSha256: digest,
      preparationVersion: "desktop-direct-v1",
      approved: true,
      warnings: [],
    },
    image: null,
    approvalDigest: null,
  };
  await h.call("attachments.transfer.begin", {
    id: RACE_IDS.transferId,
    scope,
    expiresAt: 20_000,
    assets: [asset],
  });
  await h.call("attachments.transfer.chunk", {
    id: RACE_IDS.transferId,
    representationId: RACE_IDS.representationId,
    offset: 0,
    encoded: Buffer.from(bytes).toString("base64"),
  });
  await h.call("attachments.transfer.seal", { id: RACE_IDS.transferId });
  const planned = (await h.call("attachments.plan", {
    id: RACE_IDS.transferId,
    text: "Read this attachment",
  })) as { outcome: string; plan?: { id: string } };
  expect(planned).toMatchObject({ outcome: "ready", plan: { id: RACE_IDS.planId } });
  return { h, planId: planned.plan!.id };
}

describe("private attachment transfer handlers", () => {
  it.each(["model", "context"] as const)(
    "blocks a plan when live %s changes before dispatch",
    async (change) => {
      const dispatch = vi.fn(async (input) => ({
        outcome: "accepted" as const,
        turnId: input.turnId,
        attemptId: input.attemptId,
        userEntryId: "user-entry",
        associationEntryId: "association-entry",
      }));
      const { h, planId } = await stageAttachmentPlan(dispatch);
      if (change === "model") {
        h.primary.state.model = {
          ...(h.primary.state.model as object),
          id: "different-model",
        } as never;
      } else {
        h.primary.emit({ type: "message_end" });
      }

      await expect(
        h.call("attachments.prompt", {
          version: 1,
          transferId: RACE_IDS.transferId,
          planId,
          turnId: RACE_IDS.turnId,
          attemptId: RACE_IDS.attemptId,
          text: "Read this attachment",
        }),
      ).resolves.toMatchObject({ outcome: "blocked", reasons: ["stale_plan"] });
      expect(dispatch).not.toHaveBeenCalled();
      await h.core.dispose();
    },
  );

  it("rechecks idle state after asynchronous staging and never dispatches into a streaming run", async () => {
    let makeBusy = (): void => {};
    const dispatch = vi.fn(async (input) => {
      makeBusy();
      expect(await input.revalidate()).toBe(false);
      return {
        outcome: "blocked" as const,
        reasons: ["busy"] as const,
        turnId: input.turnId,
        attemptId: input.attemptId,
      };
    });
    const { h, planId } = await stageAttachmentPlan(dispatch);
    makeBusy = () => {
      h.primary.state.streaming = true;
    };

    await expect(
      h.call("attachments.prompt", {
        version: 1,
        transferId: RACE_IDS.transferId,
        planId,
        turnId: RACE_IDS.turnId,
        attemptId: RACE_IDS.attemptId,
        text: "Read this attachment",
      }),
    ).resolves.toMatchObject({ outcome: "blocked", reasons: ["busy"] });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(h.primary.prompts).toEqual([]);
    await h.core.dispose();
  });

  it("binds begin to the live session epoch and only seals verified staged bytes", async () => {
    const h = harness({
      createAttachmentTransferStore: (current) =>
        createAttachmentTransferStore({
          now: () => 1_000,
          current,
          sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
          schedule: (delay, callback) => {
            const timer = setTimeout(callback, delay);
            return () => clearTimeout(timer);
          },
        }),
    });
    await h.call("session.create");
    const hostContext = (await h.call("attachments.context")) as {
      branchId: string | null;
      revision: string;
    };
    const bytes = Buffer.from("a");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const scope: AttachmentDeliveryScope = {
      authorityId: "123e4567-e89b-42d3-a456-426614174001",
      leaseId: "123e4567-e89b-42d3-a456-426614174011",
      profileKey: "a".repeat(64),
      tabId: "tab-1",
      draftId: "123e4567-e89b-42d3-a456-426614174002",
      hostGeneration: 1,
      processGeneration: 1,
      sessionId: "session-1",
      sessionEpoch: 1,
      branchId: hostContext.branchId,
      revision: hostContext.revision,
    };
    const id = "123e4567-e89b-42d3-a456-426614174011";
    const asset = {
      original: { id: scope.draftId, name: "note.txt", kind: "text", bytes: 1, sha256: digest },
      representation: {
        id: "123e4567-e89b-42d3-a456-426614174003",
        attachmentId: scope.draftId,
        modality: "text",
        origin: "direct",
        bytes: 1,
        originalSha256: digest,
        representationSha256: digest,
        preparationVersion: "desktop-direct-v1",
        approved: true,
        warnings: [],
      },
      image: null,
      approvalDigest: null,
    };
    const expiresAt = 20_000;
    await expect(
      h.call("attachments.transfer.begin", {
        id,
        scope: { ...scope, revision: "stale-revision" },
        expiresAt,
        assets: [asset],
      }),
    ).rejects.toThrow(/stale/);
    await expect(
      h.call("attachments.transfer.begin", {
        id,
        scope: { ...scope, sessionEpoch: 2 },
        expiresAt,
        assets: [asset],
      }),
    ).rejects.toThrow(/stale/);
    await expect(
      h.call("attachments.transfer.begin", { id, scope, expiresAt, assets: [asset] }),
    ).resolves.toEqual({ staged: true });
    await expect(
      h.call("attachments.transfer.chunk", {
        id,
        representationId: asset.representation.id,
        offset: 0,
        encoded: bytes.toString("base64"),
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(h.call("attachments.transfer.seal", { id })).resolves.toEqual({ sealed: true });
    h.primary.state.streaming = true;
    await expect(
      h.call("attachments.transfer.chunk", {
        id,
        representationId: asset.representation.id,
        offset: 1,
        encoded: "YQ==",
      }),
    ).rejects.toThrow(/unavailable/);
    await h.core.dispose();
  });

  it("plans sealed host assets and dispatches only after one-shot revalidation", async () => {
    const transferId = "123e4567-e89b-42d3-a456-426614174011";
    const turnId = "123e4567-e89b-42d3-a456-426614174012";
    const attemptId = "123e4567-e89b-42d3-a456-426614174016";
    const planId = "123e4567-e89b-42d3-a456-426614174015";
    const bytes = new TextEncoder().encode("private note");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const scope: AttachmentDeliveryScope = {
      authorityId: "123e4567-e89b-42d3-a456-426614174001",
      leaseId: transferId,
      profileKey: "a".repeat(64),
      tabId: "tab-1",
      draftId: "123e4567-e89b-42d3-a456-426614174002",
      hostGeneration: 1,
      processGeneration: 1,
      sessionId: "session-1",
      sessionEpoch: 1,
      branchId: null,
      revision: "revision-1",
    };
    const asset = {
      original: {
        id: scope.draftId,
        name: "note.txt",
        kind: "text",
        bytes: bytes.length,
        sha256: digest,
      },
      representation: {
        id: "123e4567-e89b-42d3-a456-426614174003",
        attachmentId: scope.draftId,
        modality: "text",
        origin: "direct",
        bytes: bytes.length,
        originalSha256: digest,
        representationSha256: digest,
        preparationVersion: "desktop-direct-v1",
        approved: true,
        warnings: [],
      },
      image: null,
      approvalDigest: null,
    };
    const dispatch = vi.fn(
      async (input: Parameters<NonNullable<SessionCoreDeps["dispatchAttachmentPrompt"]>>[0]) => {
        expect(await input.revalidate()).toBe(true);
        expect(input.isCurrent()).toBe(true);
        return {
          outcome: "accepted",
          turnId: input.turnId,
          attemptId: input.attemptId,
          userEntryId: "user-entry-1",
          associationEntryId: "association-entry-1",
        } as const;
      },
    );
    const h = harness({
      createAttachmentTransferStore: (current) =>
        createAttachmentTransferStore({
          now: () => 1_000,
          current,
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
          schedule: (_delay, _callback) => () => {},
        }),
      newAttachmentId: () => planId,
      dispatchAttachmentPrompt: dispatch,
    });
    await h.call("session.create");
    const hostContext = (await h.call("attachments.context")) as {
      branchId: string | null;
      revision: string;
    };
    Object.assign(scope, { branchId: hostContext.branchId, revision: hostContext.revision });
    h.primary.state.model = {
      provider: "openai",
      id: "fixture-model",
      api: "openai-completions",
      input: ["text", "image"],
      inputLimits: {
        maxRequestBytes: 20_000_000,
        images: {
          maxPerMessage: 10,
          maxPerRequest: 10,
          resize: { maxBytes: 12_000_000, maxWidth: 8_000, maxHeight: 8_000 },
        },
      },
    } as never;
    h.primary.session.getContextUsage = () => ({ tokens: 100, contextWindow: 100_000 });
    await h.call("attachments.transfer.begin", {
      id: transferId,
      scope,
      expiresAt: 20_000,
      assets: [asset],
    });
    await h.call("attachments.transfer.chunk", {
      id: transferId,
      representationId: asset.representation.id,
      offset: 0,
      encoded: Buffer.from(bytes).toString("base64"),
    });
    await h.call("attachments.transfer.seal", { id: transferId });
    const planned = (await h.call("attachments.plan", {
      id: transferId,
      text: "Read the note",
    })) as { outcome: string; plan?: { id: string } };
    expect(planned.outcome).toBe("ready");
    expect(planned.plan?.id).toBe(planId);
    await expect(
      h.call("attachments.prompt", {
        version: 1,
        transferId,
        planId,
        turnId,
        attemptId,
        text: "Read the note",
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      turnId,
      attemptId,
      userEntryId: "user-entry-1",
      associationEntryId: "association-entry-1",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].text).toContain("Read the note");
    await h.call("attachments.transfer.cancel", { id: transferId });
    await h.core.dispose();
  });

  it("fences ordinary sends and context mutations while an attachment dispatch is pending", async () => {
    const transferId = "123e4567-e89b-42d3-a456-426614174021";
    const turnId = "123e4567-e89b-42d3-a456-426614174022";
    const attemptId = "123e4567-e89b-42d3-a456-426614174026";
    const planId = "123e4567-e89b-42d3-a456-426614174025";
    const bytes = new TextEncoder().encode("private note");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const scope: AttachmentDeliveryScope = {
      authorityId: "123e4567-e89b-42d3-a456-426614174001",
      leaseId: transferId,
      profileKey: "a".repeat(64),
      tabId: "tab-1",
      draftId: "123e4567-e89b-42d3-a456-426614174002",
      hostGeneration: 1,
      processGeneration: 1,
      sessionId: "session-1",
      sessionEpoch: 1,
      branchId: null,
      revision: "revision-1",
    };
    const asset = {
      original: {
        id: scope.draftId,
        name: "note.txt",
        kind: "text",
        bytes: bytes.length,
        sha256: digest,
      },
      representation: {
        id: "123e4567-e89b-42d3-a456-426614174003",
        attachmentId: scope.draftId,
        modality: "text",
        origin: "direct",
        bytes: bytes.length,
        originalSha256: digest,
        representationSha256: digest,
        preparationVersion: "desktop-direct-v1",
        approved: true,
        warnings: [],
      },
      image: null,
      approvalDigest: null,
    };
    let releaseDispatch: () => void = () => {};
    const dispatch = vi.fn(
      async (input: Parameters<NonNullable<SessionCoreDeps["dispatchAttachmentPrompt"]>>[0]) => {
        expect(await input.revalidate()).toBe(true);
        await new Promise<void>((resolve) => (releaseDispatch = resolve));
        return {
          outcome: "accepted",
          turnId: input.turnId,
          attemptId: input.attemptId,
          userEntryId: "user-entry-1",
          associationEntryId: "association-entry-1",
        } as const;
      },
    );
    const h = harness({
      createAttachmentTransferStore: (current) =>
        createAttachmentTransferStore({
          now: () => 1_000,
          current,
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
          schedule: (_delay, _callback) => () => {},
        }),
      newAttachmentId: () => planId,
      dispatchAttachmentPrompt: dispatch,
    });
    await h.call("session.create");
    const hostContext = (await h.call("attachments.context")) as {
      branchId: string | null;
      revision: string;
    };
    Object.assign(scope, { branchId: hostContext.branchId, revision: hostContext.revision });
    h.primary.state.model = {
      provider: "openai",
      id: "fixture-model",
      api: "openai-completions",
      input: ["text", "image"],
      inputLimits: {
        maxRequestBytes: 20_000_000,
        images: {
          maxPerMessage: 10,
          maxPerRequest: 10,
          resize: { maxBytes: 12_000_000, maxWidth: 8_000, maxHeight: 8_000 },
        },
      },
    } as never;
    h.primary.session.getContextUsage = () => ({ tokens: 100, contextWindow: 100_000 });
    await h.call("attachments.transfer.begin", {
      id: transferId,
      scope,
      expiresAt: 20_000,
      assets: [asset],
    });
    await h.call("attachments.transfer.chunk", {
      id: transferId,
      representationId: asset.representation.id,
      offset: 0,
      encoded: Buffer.from(bytes).toString("base64"),
    });
    await h.call("attachments.transfer.seal", { id: transferId });
    expect(
      await h.call("attachments.plan", { id: transferId, text: "Read the note" }),
    ).toMatchObject({ outcome: "ready" });

    const managed = h.call("attachments.prompt", {
      version: 1,
      transferId,
      planId,
      turnId,
      attemptId,
      text: "Read the note",
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

    // While awaiting preflight, another Desktop send or a context/model change
    // must not interleave with the attachment turn.
    await expect(h.call("prompt", { text: "ordinary" })).rejects.toMatchObject({ code: "busy" });
    await expect(h.call("steer", { text: "steer" })).rejects.toMatchObject({ code: "busy" });
    await expect(h.call("model.set", { model: { provider: "x", id: "y" } })).rejects.toMatchObject({
      code: "busy",
    });
    await expect(h.call("session.reload")).rejects.toMatchObject({ code: "busy" });

    releaseDispatch();
    await expect(managed).resolves.toMatchObject({ outcome: "accepted" });
    // Accepted: the run is still active, so context mutations stay fenced but
    // ordinary text-only steering is native Pi behavior again.
    await expect(h.call("model.set", { model: { provider: "x", id: "y" } })).rejects.toMatchObject({
      code: "busy",
    });
    h.primary.emit({ type: "agent_settled" });
    await expect(h.call("prompt", { text: "ordinary" })).resolves.toBeTruthy();
    await h.core.dispose();
  });

  it("does not install private transfer methods when no receiver is configured", async () => {
    const h = harness();
    await h.call("session.create");
    await expect(h.call("attachments.transfer.begin", {})).rejects.toThrow(
      /invalid private attachment transfer/,
    );
    await h.core.dispose();
  });
});

describe("session core lifecycle", () => {
  it("creates a session and announces it", async () => {
    const { call, events, emitted, core } = harness();

    const snapshot = await call("session.create");

    expect(snapshot).toMatchObject({ sessionId: "session-1", cwd: CWD, toolCount: 2 });
    expect(events()).toContain("session_started");
    expect(events()).toContain("state");
    expect(emitted.find((entry) => entry.event === "session_started")?.sessionId).toBe("session-1");
    // The renderer and the service dedupe on the reason, so the payload says it
    // (2026-11-06 plan, step 15).
    expect(emitted.find((entry) => entry.event === "session_started")?.payload).toMatchObject({
      reason: "new",
      sessionId: "session-1",
    });
    expect(core.cwd()).toBe(CWD);
  });

  it("hands the live session and its runtime to bindSession", async () => {
    const bound: Array<{ session: HostSession; runtime: RuntimeLike }> = [];
    const { call, runtime } = harness({
      bindSession: async (session, boundRuntime) => {
        bound.push({ session, runtime: boundRuntime });
      },
    });

    await call("session.create");
    expect(bound).toHaveLength(1);
    expect(bound[0]!.session.sessionId).toBe("session-1");
    expect(bound[0]!.runtime).toBe(runtime);
  });

  it("refuses to act before a session exists", async () => {
    const { call } = harness();

    await expect(call("prompt", { text: "hi" })).rejects.toThrow(/no session is open/);
    await expect(call("abort")).rejects.toThrow(/no session is open/);
  });

  it("validates prompt input", async () => {
    const { call } = harness();
    await call("session.create");

    await expect(call("prompt", {})).rejects.toThrow(/text must be a non-empty string/);
  });
});

describe("project trust gate", () => {
  it("asks instead of loading project resources silently", async () => {
    const { call, events, emitted } = harness({ requiresTrust: () => true });

    await expect(call("session.create")).rejects.toThrow(/trust prompt/);

    expect(events()).toContain("project_trust");
    const prompt = emitted.find((entry) => entry.event === "project_trust");
    expect(prompt?.payload).toMatchObject({
      requiresTrust: true,
      needsPrompt: true,
      trusted: false,
    });
  });

  it("opens the project once the user trusts it, and remembers the decision", async () => {
    const trustStore = new Map<string, boolean | null>();
    const { call } = harness({
      requiresTrust: () => true,
      trustStore: {
        get: (cwd) => trustStore.get(cwd) ?? null,
        set: (cwd, decision) => {
          trustStore.set(cwd, decision);
        },
      },
    });

    const snapshot = await call("session.create", { trust: "trust" });

    expect(snapshot).toMatchObject({ sessionId: "session-1" });
    expect(trustStore.get(CWD)).toBe(true);
  });

  it("honours a remembered decision without prompting", async () => {
    const { call, events } = harness({
      requiresTrust: () => true,
      trustStore: { get: () => true, set: () => {} },
    });

    await call("session.create");

    expect(events()).not.toContain("project_trust");
  });
});

describe("session core conversation", () => {
  it("validates attachment prompt requests and fails closed without a live host plan", async () => {
    const { call, primary } = harness();
    await call("session.create");
    const request = {
      version: 1,
      transferId: "123e4567-e89b-42d3-a456-426614174011",
      planId: "123e4567-e89b-42d3-a456-426614174000",
      turnId: "123e4567-e89b-42d3-b456-426614174001",
      attemptId: "123e4567-e89b-42d3-b456-426614174002",
      text: "read this",
    };
    await expect(call("attachments.prompt", request)).resolves.toEqual({
      outcome: "blocked",
      reasons: ["stale_plan"],
      turnId: request.turnId,
      attemptId: request.attemptId,
    });
    await expect(call("attachments.prompt", { ...request, version: 2 })).rejects.toMatchObject({
      code: "unsupported_version",
    });
    await expect(call("attachments.prompt", { ...request, path: "/secret" })).rejects.toMatchObject(
      {
        code: "bad_request",
      },
    );
    expect(primary.prompts).toEqual([]);
  });

  it("rejects new references on legacy methods and validates old prompt images", async () => {
    const { call, primary } = harness();
    await call("session.create");
    for (const method of ["prompt", "steer", "followUp"] as const) {
      for (const key of ["attachments", "attachment", "attachmentDelivery", "attachmentPlan"]) {
        await expect(call(method, { text: "hello", [key]: [] })).rejects.toMatchObject({
          code: "bad_request",
        });
      }
    }
    for (const method of ["steer", "followUp"] as const) {
      await expect(call(method, { text: "hello", images: [] })).rejects.toMatchObject({
        code: "bad_request",
      });
    }
    await expect(
      call("prompt", {
        text: "hello",
        images: [{ type: "image", mimeType: "image/png", data: "abc" }],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(call("prompt", { text: "hello", image: {} })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(primary.prompts).toEqual([]);
    await call("prompt", { text: "ordinary text" });
    expect(primary.prompts).toEqual(["ordinary text"]);
  });

  it("forwards a prompt and mirrors SDK events as frames", async () => {
    const { call, events, primary } = harness();
    await call("session.create");

    await call("prompt", { text: "summarise the sheet" });

    expect(primary.prompts).toEqual(["summarise the sheet"]);
    expect(events()).toContain("agent_start");
    expect(events()).toContain("message_update");
    expect(events()).toContain("agent_end");
    // `agent_end` and `message_update` both trigger a fresh state snapshot.
    expect(events().filter((event) => event === "state").length).toBeGreaterThan(1);
  });

  it("reports state, stats and messages", async () => {
    const { call } = harness();
    await call("session.create");
    await call("prompt", { text: "hi" });

    const state = (await call("state.get")) as Record<string, unknown>;
    const stats = (await call("stats.get")) as Record<string, unknown>;
    const messages = (await call("messages.get", { limit: 1 })) as {
      messages: unknown[];
      total: number;
    };

    expect(state).toMatchObject({ streaming: false, thinkingLevel: "medium" });
    expect(stats).toMatchObject({ messageCount: 2, pendingMessages: 0 });
    expect(messages.total).toBe(2);
    expect(messages.messages).toHaveLength(1);
  });

  it("handles steering, follow-up, abort and clearQueue", async () => {
    const { call } = harness();
    await call("session.create");

    await expect(call("abort")).resolves.toEqual({ aborted: true });
    expect(await call("clearQueue")).toEqual({ cleared: { steering: ["a"], followUp: [] } });
    // The fake session exposes neither steer nor followUp.
    await expect(call("steer", { text: "stop" })).rejects.toThrow(/not supported/);
    await expect(call("followUp", { text: "then" })).rejects.toThrow(/not supported/);
  });
});

describe("extension model changes", () => {
  it("emits a state snapshot when an extension selects a model", async () => {
    let notify: (() => void) | null = null;
    const { call, emitted, primary } = harness({
      observeModelChanges: (_session, onChange) => {
        notify = onChange;
        return () => {
          notify = null;
        };
      },
    });
    await call("session.create");

    primary.state.model = { id: "gpt-5", provider: "openai", name: "GPT-5" };
    notify!();

    const states = emitted.filter((entry) => entry.event === "state");
    expect(states.at(-1)?.payload).toMatchObject({
      model: { id: "gpt-5", provider: "openai", name: "GPT-5" },
    });
  });

  it("emits a state snapshot for a thinking-level change on the session bus", async () => {
    const { call, emitted, primary } = harness();
    await call("session.create");

    primary.state.thinkingLevel = "high";
    primary.emit({ type: "thinking_level_changed", level: "high" });

    const states = emitted.filter((entry) => entry.event === "state");
    expect(states.at(-1)?.payload).toMatchObject({ thinkingLevel: "high" });
  });

  it("reinstalls the observer on rebind and disposes it with the core", async () => {
    const observers: Array<() => void> = [];
    const disposed = vi.fn();
    const { call, core } = harness({
      observeModelChanges: (_session, onChange) => {
        observers.push(onChange);
        return disposed;
      },
    });
    await call("session.create");
    expect(observers).toHaveLength(1);

    await call("session.reload");
    expect(observers).toHaveLength(2);
    expect(disposed).toHaveBeenCalledTimes(1);

    await core.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
  });
});

describe("session core configuration", () => {
  it("exposes settings and their errors", async () => {
    const { call } = harness();
    await call("session.create");

    expect(await call("settings.get")).toEqual({
      settings: {
        global: { theme: "dark", npmCommand: ["node", "npm-cli.js"] },
        project: { defaultTools: ["read"] },
      },
      errors: [{ message: "one warning" }],
    });
  });

  it("reports thinking levels, tools and tool selection", async () => {
    const { call } = harness();
    await call("session.create");

    expect(await call("thinking.levels")).toEqual({
      levels: ["off", "low", "medium", "high"],
      current: "medium",
    });
    const tools = (await call("tools.list")) as { tools: unknown[]; active: string[] };
    expect(tools.active).toEqual(["read"]);

    await expect(call("tools.setActive", { names: "read" })).rejects.toThrow(/names array/);
    await expect(call("tools.setActive", { names: ["bash"] })).resolves.toMatchObject({
      sessionId: "session-1",
    });
  });

  it("leaves the profile-wide session listing to the control host", () => {
    const { core } = harness();
    expect(core.handlers()["session.list"]).toBeUndefined();
  });
});

describe("session core replacement", () => {
  it("rebinds subscriptions after a fork and announces the replacement", async () => {
    const { call, events, forks, forked } = harness();
    await call("session.create");

    const snapshot = (await call("session.fork", { entryId: "entry-7" })) as Record<
      string,
      unknown
    >;

    expect(forks).toEqual(["entry-7"]);
    expect(snapshot).toMatchObject({ cancelled: false, selectedText: "from the fork point" });
    expect(events()).toContain("session_replaced");

    // Events from the new session are mirrored, not the old one.
    forked.emit({ type: "agent_start" });
    expect(events().filter((event) => event === "agent_start")).toHaveLength(1);
  });

  it("validates the fork target", async () => {
    const { call } = harness();
    await call("session.create");

    await expect(call("session.fork", {})).rejects.toThrow(/entryId must be a non-empty string/);
  });

  it("reloads and rebinds", async () => {
    const { call, events } = harness();
    await call("session.create");

    await expect(call("session.reload")).resolves.toMatchObject({ sessionId: "session-1" });
    expect(events()).toContain("session_replaced");
  });

  it("disposes without throwing", async () => {
    const { core, call } = harness();
    await call("session.create");
    await expect(core.dispose()).resolves.toBeUndefined();
    expect(core.session()).toBeNull();
  });
});

describe("session core emits via the injected emitter", () => {
  it("tags frames with the session id", async () => {
    const { call, emitted } = harness();
    await call("session.create");
    const withId = emitted.filter((entry) => entry.sessionId === "session-1");
    expect(withId.length).toBeGreaterThan(0);
  });

  it("never throws when the emitter fails", async () => {
    const failure = vi.fn();
    const { call } = harness({
      emit: () => {
        failure();
      },
    });
    await expect(call("session.create")).resolves.toBeDefined();
    expect(failure).toHaveBeenCalled();
  });
});

describe("session core safe mode (plan step 22)", () => {
  function runtimeWith(
    requests: SessionRuntimeRequest[],
    safeMode: boolean | undefined,
    deps: Partial<SessionCoreDeps> = {},
  ) {
    const session = fakeSession().session;
    const runtime: RuntimeLike = {
      get session() {
        return session;
      },
      get services() {
        return { cwd: CWD };
      },
    };
    const harnessed = harness({
      ...deps,
      ...(safeMode === undefined ? {} : { safeMode }),
      createRuntime: async (request) => {
        requests.push(request);
        return { runtime, session };
      },
    });
    return harnessed;
  }

  it("forwards safe mode to the runtime factory so no resources load", async () => {
    const requests: SessionRuntimeRequest[] = [];
    const { call } = runtimeWith(requests, true);
    await call("session.create");
    expect(requests[0]?.safeMode).toBe(true);
  });

  it("omits safe mode when it is off", async () => {
    const requests: SessionRuntimeRequest[] = [];
    const { call } = runtimeWith(requests, undefined);
    await call("session.create");
    expect(requests[0]).not.toHaveProperty("safeMode");
  });

  it("forwards the project trust decision to the runtime factory", async () => {
    const requests: SessionRuntimeRequest[] = [];
    const { call } = runtimeWith(requests, undefined, {
      requiresTrust: () => true,
      trustStore: {
        get: () => false,
        set: () => undefined,
      },
    });
    await call("session.create");
    expect(requests[0]?.projectTrusted).toBe(false);
  });
});

describe("session open timings (2026-11-07 host-singleton plan)", () => {
  function timingHarness() {
    let clock = 1_000;
    const session = fakeSession().session;
    const runtime: RuntimeLike = {
      get session() {
        return session;
      },
      get services() {
        return { cwd: CWD };
      },
    };
    const requests: SessionRuntimeRequest[] = [];
    const harnessed = harness({
      // Deterministic clock: the fake phases move it, so a recorded phase and
      // the end-to-end total describe the same timeline.
      now: () => clock,
      bindSession: async () => {
        clock += 30;
      },
      createRuntime: async (request) => {
        requests.push(request);
        clock += 400;
        request.onPhase?.("services", 400);
        clock += 25;
        request.onPhase?.("scope", 25);
        clock += 35;
        request.onPhase?.("session", 35);
        return { runtime, session };
      },
    });
    return { ...harnessed, requests };
  }

  it("records the phase breakdown of a create", async () => {
    const { call, core } = timingHarness();

    await call("session.create");

    const timings = core.lastOpenTimings?.() ?? null;
    expect(timings).not.toBeNull();
    expect(timings?.servicesMs).toBe(400);
    expect(timings?.scopeMs).toBe(25);
    expect(timings?.sessionMs).toBe(35);
    expect(timings?.bindMs).toBe(30);
    // End-to-end also covers legs the phases do not name (model apply,
    // snapshot); it must never be smaller than the measured legs.
    const legs =
      (timings?.trustMs ?? 0) +
      (timings?.servicesMs ?? 0) +
      (timings?.scopeMs ?? 0) +
      (timings?.sessionMs ?? 0) +
      (timings?.bindMs ?? 0) +
      (timings?.reconcileMs ?? 0);
    expect(timings?.totalMs).toBeGreaterThanOrEqual(legs);
    expect(timings?.totalMs).toBeGreaterThanOrEqual(490);
  });

  it("records a total for the in-place resume fast path", async () => {
    let clock = 1_000;
    const session = fakeSession().session;
    const runtime: RuntimeLike = {
      get session() {
        return session;
      },
      get services() {
        return { cwd: CWD };
      },
      async switchSession() {
        clock += 2_500;
        return { cancelled: false };
      },
    };
    const harnessed = harness({
      now: () => clock,
      createRuntime: async () => ({ runtime, session }),
    });
    await harnessed.call("session.create");

    await harnessed.call("session.resume", { sessionFile: "C:/sessions/one.jsonl" });

    const timings = harnessed.core.lastOpenTimings?.() ?? null;
    expect(timings).not.toBeNull();
    expect(timings?.totalMs).toBe(2_500);
    // The SDK owns the legs on this path; only the total is knowable here.
    expect(timings?.servicesMs).toBe(0);
  });

  it("has no timings before the first open", () => {
    const { core } = harness();
    expect(core.lastOpenTimings?.()).toBeNull();
  });
});

describe("session replacement rebinds once (2026-11-07 plan)", () => {
  function replacingHarness(runtimeCallsRebind: boolean) {
    const session = fakeSession().session;
    let rebind: (() => Promise<void>) | undefined;
    const runtime: RuntimeLike = {
      get session() {
        return session;
      },
      get services() {
        return { cwd: CWD };
      },
      setRebindSession(fn) {
        rebind = fn;
      },
      async newSession() {
        if (runtimeCallsRebind) await rebind?.();
        return { cancelled: false };
      },
    };
    const binds: string[] = [];
    const harnessed = harness({
      createRuntime: async () => ({ runtime, session }),
      bindSession: async () => {
        binds.push("bind");
      },
    });
    return { ...harnessed, binds };
  }

  it("binds once when the runtime reports the replacement itself", async () => {
    const { call, binds } = replacingHarness(true);
    await call("session.create");
    binds.length = 0;

    await call("session.new");

    // The SDK calls `rebindSession`; the handler must not run the whole bind a
    // second time (extension session_start, resources_discover, scope resolve).
    expect(binds).toHaveLength(1);
  });

  it("binds once as a fallback when the runtime does not report it", async () => {
    const { call, binds } = replacingHarness(false);
    await call("session.create");
    binds.length = 0;

    await call("session.new");

    expect(binds).toHaveLength(1);
  });
});

describe("the open path reads settings once (2026-11-07 plan)", () => {
  it("does not reload settings after the runtime factory already read them", async () => {
    const reloads: string[] = [];
    const settingsPort = {
      read: async () => ({ global: {}, project: {} }),
      files: async () => ({
        global: { path: "/g.json", exists: false, mtimeMs: 0 },
        project: { path: "/p.json", exists: false, mtimeMs: 0 },
      }),
      isProjectTrusted: () => true,
      write: async () => undefined,
      compareAndWrite: async () => undefined,
      writeMany: async () => undefined,
      writeScope: async () => undefined,
      flush: async () => undefined,
      reload: async () => {
        reloads.push("reload");
      },
    };
    const { call } = harness({
      createSettingsPort: () => settingsPort as never,
    });

    await call("session.create");

    expect(reloads).toEqual([]);
  });
});

describe("private image preparation handlers", () => {
  const IMAGE_ID = "123e4567-e89b-42d3-a456-426614174211";
  const IMAGE_ORIGINAL = "123e4567-e89b-42d3-a456-426614174212";
  const LIMITS = { maxWidth: 1568, maxHeight: 1568, maxEncodedBytes: 4 * 1024 * 1024 };

  function imageHarness() {
    const encode = vi.fn(
      async (input: { bytes: Uint8Array; limits: { maxWidth: number; maxHeight: number } }) => ({
        bytes: new Uint8Array(input.bytes),
        mime: "image/png" as const,
        original: {
          mime: "image/png" as const,
          width: input.limits.maxWidth,
          height: input.limits.maxHeight,
          encodedWidth: input.limits.maxWidth,
          encodedHeight: input.limits.maxHeight,
          orientation: 1,
          animated: false,
        },
        width: input.limits.maxWidth,
        height: input.limits.maxHeight,
        wasResized: false,
        wasReencoded: false,
        warnings: [],
        policy: { maxWidth: 1568, maxHeight: 1568, maxEncodedBytes: 4 * 1024 * 1024 },
      }),
    );
    const h = harness({
      createAttachmentImagePreparation: () =>
        createAttachmentImagePreparationStore({
          now: () => 1_000,
          schedule: () => () => {},
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
          encode,
        }),
    });
    return { h, encode };
  }

  it("stages, prepares and streams one bounded original through the private handlers", async () => {
    const { h, encode } = imageHarness();
    await h.call("session.create");
    const source = new TextEncoder().encode("bounded-image-bytes");
    const digest = createHash("sha256").update(source).digest("hex");
    await expect(
      h.call("attachments.image.begin", {
        id: IMAGE_ID,
        originalId: IMAGE_ORIGINAL,
        originalSha256: digest,
        bytes: source.byteLength,
        mime: "image/png",
        expiresAt: 20_000,
      }),
    ).resolves.toEqual({ staged: true });
    await expect(
      h.call("attachments.image.chunk", {
        id: IMAGE_ID,
        offset: 0,
        encoded: Buffer.from(source).toString("base64"),
      }),
    ).resolves.toEqual({ accepted: true });
    const description = (await h.call("attachments.image.prepare", {
      id: IMAGE_ID,
      limits: LIMITS,
    })) as Record<string, unknown>;
    expect(description).toMatchObject({ sha256: digest, bytes: source.byteLength });
    expect(encode).toHaveBeenCalled();
    const read = (await h.call("attachments.image.read", {
      id: IMAGE_ID,
      part: "prepared",
      offset: 0,
      length: 4,
    })) as { encoded: string };
    expect(Buffer.from(read.encoded, "base64")).toEqual(Buffer.from(source.subarray(0, 4)));
    await expect(h.call("attachments.image.cancel", { id: IMAGE_ID })).resolves.toEqual({
      cancelled: true,
    });
    await expect(
      h.call("attachments.image.read", { id: IMAGE_ID, part: "prepared", offset: 0, length: 1 }),
    ).rejects.toThrow();
  });

  it("refuses preparation while the session is busy and still requires exact requests", async () => {
    const { h } = imageHarness();
    await h.call("session.create");
    h.primary.state.streaming = true;
    await expect(
      h.call("attachments.image.begin", {
        id: IMAGE_ID,
        originalId: IMAGE_ORIGINAL,
        originalSha256: "a".repeat(64),
        bytes: 1,
        mime: "image/png",
        expiresAt: 20_000,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    h.primary.state.streaming = false;
    await expect(
      h.call("attachments.image.begin", {
        id: IMAGE_ID,
        originalId: IMAGE_ORIGINAL,
        originalSha256: "a".repeat(64),
        bytes: 1,
        mime: "image/png",
        expiresAt: 20_000,
        extra: true,
      } as never),
    ).rejects.toThrow();
    await expect(
      h.call("attachments.image.read", { id: IMAGE_ID, part: "other", offset: 0, length: 1 }),
    ).rejects.toThrow();
  });
});

describe("private attachment readiness handler", () => {
  const TEXT_ID = "123e4567-e89b-42d3-a456-426614174221";
  const IMAGE_ID = "123e4567-e89b-42d3-a456-426614174222";
  const PROFILE = "a".repeat(64);

  function textFile(id = TEXT_ID) {
    return {
      id,
      originalKind: "text",
      originalBytes: 5,
      modality: "text",
      representationBytes: 5,
      image: null,
    };
  }

  async function readyHarness(modelInput: readonly string[] = ["text", "image"]) {
    const h = harness();
    await h.call("session.create");
    h.primary.state.model = {
      provider: "openai",
      id: "fixture-model",
      api: "openai-completions",
      input: [...modelInput],
      inputLimits: {
        maxRequestBytes: 20_000_000,
        images: {
          maxPerMessage: 2,
          maxPerRequest: 4,
          resize: { maxBytes: 1_000_000, maxWidth: 1024, maxHeight: 1024 },
        },
      },
    } as never;
    h.primary.session.getContextUsage = () => ({ tokens: 100, contextWindow: 100_000 });
    return h;
  }

  it("evaluates metadata-only files against the live model and context", async () => {
    const h = await readyHarness();
    const result = (await h.call("attachments.readiness", {
      profileKey: PROFILE,
      text: "look",
      files: [textFile()],
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      model: { provider: "openai", id: "fixture-model", api: "openai-completions" },
      files: [{ id: TEXT_ID, reasons: [] }],
      reasons: [],
    });
    expect(typeof result.revision).toBe("string");
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
  });

  it("keeps busy aggregate-only and reports per-file model limits", async () => {
    const h = await readyHarness(["text"]);
    h.primary.state.streaming = true;
    const busy = (await h.call("attachments.readiness", {
      profileKey: PROFILE,
      text: "look",
      files: [textFile()],
    })) as { reasons: string[]; files: Array<{ reasons: string[] }> };
    expect(busy.reasons).toContain("busy");
    expect(busy.files[0]?.reasons).not.toContain("busy");
    h.primary.state.streaming = false;
    const image = (await h.call("attachments.readiness", {
      profileKey: PROFILE,
      text: "look",
      files: [
        {
          id: IMAGE_ID,
          originalKind: "image",
          originalBytes: 4000,
          modality: "image",
          representationBytes: 4000,
          image: { width: 10, height: 10 },
        },
      ],
    })) as { reasons: string[]; files: Array<{ reasons: string[] }> };
    expect(image.reasons).toContain("model_modality_unsupported");
    expect(image.files[0]?.reasons).toContain("model_modality_unsupported");
  });

  it("rejects malformed, duplicated and out-of-range requests", async () => {
    const h = await readyHarness();
    await expect(
      h.call("attachments.readiness", {
        profileKey: PROFILE,
        text: "look",
        files: [textFile(), textFile()],
      }),
    ).rejects.toThrow();
    await expect(
      h.call("attachments.readiness", {
        profileKey: "not-a-digest",
        text: "look",
        files: [textFile()],
      }),
    ).rejects.toThrow();
    await expect(
      h.call("attachments.readiness", {
        profileKey: PROFILE,
        text: "look",
        files: [{ ...textFile(), image: { width: 0, height: 10 } }],
      }),
    ).rejects.toThrow();
    await expect(
      h.call("attachments.readiness", {
        profileKey: PROFILE,
        text: "look",
        files: [{ ...textFile(), originalBytes: -1 }],
      }),
    ).rejects.toThrow();
    await expect(
      h.call("attachments.readiness", { profileKey: PROFILE, text: "look", files: [] }),
    ).rejects.toThrow();
  });
});

describe("attachment protocol support", () => {
  it("advertises support only when every required attachment port is wired", () => {
    const complete = harness({
      createAttachmentTransferStore: (current) =>
        createAttachmentTransferStore({
          now: () => 1_000,
          current,
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
          schedule: () => () => {},
        }),
      createAttachmentImagePreparation: () =>
        createAttachmentImagePreparationStore({
          now: () => 1_000,
          schedule: () => () => {},
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
          encode: async ({ bytes, limits }) => ({
            bytes: new Uint8Array(bytes),
            mime: "image/png",
            original: {
              mime: "image/png",
              width: limits.maxWidth,
              height: limits.maxHeight,
              encodedWidth: limits.maxWidth,
              encodedHeight: limits.maxHeight,
              orientation: 1,
              animated: false,
            },
            width: limits.maxWidth,
            height: limits.maxHeight,
            wasResized: false,
            wasReencoded: false,
            warnings: [],
            policy: limits,
          }),
        }),
      dispatchAttachmentPrompt: async () => ({
        outcome: "blocked",
        reasons: ["unavailable"],
        turnId: RACE_IDS.turnId,
        attemptId: RACE_IDS.attemptId,
      }),
      listAttachmentSubmissions: () => [],
    });
    expect(complete.core.attachmentDeliverySupport()).toBe(1);

    const missing = harness();
    expect(missing.core.attachmentDeliverySupport()).toBeNull();

    const partial = harness({ listAttachmentSubmissions: () => [] });
    expect(partial.core.attachmentDeliverySupport()).toBeNull();
  });
});

describe("Desktop model/context route policy", () => {
  const textModel = {
    provider: "openai",
    id: "text-only",
    api: "openai-completions",
    input: ["text"],
    inputLimits: {
      maxRequestBytes: 20_000_000,
      images: {
        maxPerMessage: 0,
        maxPerRequest: 0,
        resize: { maxBytes: 0, maxWidth: 0, maxHeight: 0 },
      },
    },
  };
  const visionModel = {
    provider: "openai",
    id: "vision",
    api: "openai-completions",
    input: ["text", "image"],
    inputLimits: {
      maxRequestBytes: 20_000_000,
      images: {
        maxPerMessage: 4,
        maxPerRequest: 8,
        resize: { maxBytes: 4 * 1024 * 1024, maxWidth: 2048, maxHeight: 2048 },
      },
    },
  };
  const imageHistory = () => [
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
  ];

  it("blocks an ordinary prompt when image history meets a text-only model", async () => {
    const h = harness();
    await h.call("session.create");
    h.primary.state.model = textModel as never;
    h.primary.state.messages = imageHistory();
    await expect(h.call("prompt", { text: "hello" })).rejects.toMatchObject({
      code: "model_modality_unsupported",
    });
    expect(h.primary.prompts).toHaveLength(0);

    h.primary.state.model = visionModel as never;
    await expect(h.call("prompt", { text: "hello" })).resolves.toBeTruthy();
    expect(h.primary.prompts).toHaveLength(1);
  });

  it("blocks steer and follow-up on the same rule", async () => {
    const h = harness();
    await h.call("session.create");
    h.primary.state.model = textModel as never;
    h.primary.state.messages = imageHistory();
    await expect(h.call("steer", { text: "go on" })).rejects.toMatchObject({
      code: "model_modality_unsupported",
    });
    await expect(h.call("followUp", { text: "and then" })).rejects.toMatchObject({
      code: "model_modality_unsupported",
    });
  });

  it("allows an idle model switch but refuses an incompatible target mid-run", async () => {
    const h = harness();
    await h.call("session.create");
    h.primary.state.model = visionModel as never;
    h.primary.state.messages = imageHistory();
    await expect(h.call("model.set", { model: textModel })).resolves.toBeTruthy();

    h.primary.state.streaming = true;
    await expect(h.call("model.set", { model: textModel })).rejects.toMatchObject({
      code: "model_modality_unsupported",
    });
  });

  it("refuses cycling models during an active image run", async () => {
    const h = harness();
    await h.call("session.create");
    h.primary.state.model = visionModel as never;
    h.primary.state.messages = imageHistory();
    h.primary.state.streaming = true;
    await expect(h.call("model.cycle", { direction: "forward" })).rejects.toMatchObject({
      code: "busy",
    });
  });
});
