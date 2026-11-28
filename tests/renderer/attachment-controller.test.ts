import { describe, expect, it, vi } from "vitest";
import {
  AttachmentController,
  attachmentDraftScopeKey,
  createPersistedAttachmentController,
} from "../../src/renderer/src/attachments/controller";
import type { AttachmentsBridge, PrefsBridge } from "../../src/shared/ipc";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { AttachmentSnapshot } from "../../src/shared/attachments";

const id = (n: number): string => `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
const grant = { tabId: "tab-1", draftId: id(1), token: id(2) };
const snapshot: AttachmentSnapshot = {
  id: id(3),
  name: "report.txt",
  mimeType: "text/plain",
  size: 42,
};

function harness() {
  const saved = new Map<string, string>();
  const bridge = {
    openDraft: vi.fn(async (tabId: string, draftId?: string) => ({
      tabId,
      draftId: draftId ?? grant.draftId,
      token: grant.token,
    })),
    list: vi.fn(async () => [snapshot]),
    closeDraft: vi.fn(async () => {}),
    begin: vi.fn(async () => ({ attachmentId: snapshot.id, token: id(4) })),
    append: vi.fn(
      async (_draft: unknown, _token: string, offset: number, bytes: Uint8Array) =>
        offset + bytes.length,
    ),
    commit: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pick: vi.fn(async () => null),
    preview: vi.fn(async () => ({ bytes: new Uint8Array(), size: 0, truncated: false })),
    submit: vi.fn(async (input) => ({
      outcome: "blocked" as const,
      reasons: ["busy" as const],
      turnId: input.turnId,
      attemptId: input.attemptId,
    })),
    status: vi.fn(async () => ({
      version: 1 as const,
      phase: "none" as const,
      turnId: null,
      attemptId: null,
      result: null,
      retryOfAttemptId: null,
      textMatches: false,
      filesMatch: false,
      originalIds: [],
      representationIds: [],
      updatedAt: null,
    })),
  } as unknown as AttachmentsBridge;
  let nextId = 100;
  const draftText = { value: "" };
  const controller = new AttachmentController({
    newId: () => id(nextId++),
    bridge,
    draftText: async () => draftText.value,
    identities: {
      read: async (tabId) => saved.get(tabId) ?? null,
      write: async (tabId, draftId) => {
        if (draftId === null) saved.delete(tabId);
        else saved.set(tabId, draftId);
      },
    },
  });
  return { controller, bridge, saved, draftText };
}

describe("per-tab attachment draft controller", () => {
  it("persists only the stable draft identity and restores its descriptors", async () => {
    const h = harness();
    const state = await h.controller.open("tab-1");
    expect(state).toMatchObject({
      phase: "ready",
      draftId: grant.draftId,
      descriptors: [snapshot],
    });
    expect(h.saved.get("tab-1")).toBe(grant.draftId);
    expect(state).not.toHaveProperty("token");
    expect(JSON.stringify(state)).not.toContain("base64");

    h.controller.forgetTab("tab-1");
    const restored = await h.controller.open("tab-1");
    expect(h.bridge.openDraft).toHaveBeenLastCalledWith("tab-1", grant.draftId);
    expect(restored.descriptors).toEqual([snapshot]);
  });

  it("persists stable identities through the validated app preference bridge", async () => {
    const h = harness();
    let prefs = { ...DEFAULT_PREFS, attachmentDraftIds: {} as Record<string, string> };
    const prefsBridge: PrefsBridge = {
      get: async () => prefs,
      set: async (patch) => {
        prefs = { ...prefs, ...patch };
        return prefs;
      },
    };
    const controller = createPersistedAttachmentController({
      attachments: h.bridge,
      prefs: prefsBridge,
      profileScope: "C:/profile",
    });
    await controller.open("tab-1");
    // Identity is scoped by the canonical profile; the legacy tab key is retired.
    expect(prefs.attachmentDraftIds[attachmentDraftScopeKey("C:/profile", "tab-1")]).toBe(
      grant.draftId,
    );
    expect(prefs.attachmentDraftIds["tab-1"]).toBeUndefined();
    expect(prefs).not.toHaveProperty("attachmentGrant");
  });

  it("keeps import state and metadata in the originating tab only", async () => {
    const h = harness();
    const file = {
      name: "report.txt",
      type: "text/plain",
      size: 3,
      slice: () => new Blob([new Uint8Array([97, 98, 99])]),
    };
    const result = await h.controller.importFile("tab-1", file, {
      readSlice: async () => new Uint8Array([97, 98, 99]).buffer,
    });
    expect(result.descriptors).toEqual([snapshot]);
    expect(result.imports).toEqual([]);
    expect(h.bridge.commit).toHaveBeenCalledOnce();
    expect(h.controller.get("tab-2").descriptors).toEqual([]);
  });

  it("retains blocked and uncertain sends and requires an explicit same-turn retry", async () => {
    const h = harness();
    const results = [
      {
        outcome: "blocked" as const,
        reasons: ["model_modality_unsupported" as const],
        turnId: grant.draftId,
        attemptId: id(100),
      },
      { outcome: "uncertain" as const, turnId: grant.draftId, attemptId: id(101) },
      {
        outcome: "accepted" as const,
        turnId: grant.draftId,
        attemptId: id(102),
        userEntryId: "entry-user",
        associationEntryId: "entry-association",
      },
    ];
    vi.mocked(h.bridge.submit).mockImplementation(async () => results.shift()!);

    await h.controller.open("tab-1");
    const blocked = await h.controller.submit("tab-1", "Inspect this file");
    expect(blocked?.outcome).toBe("blocked");
    expect(h.controller.get("tab-1").descriptors).toEqual([snapshot]);
    expect(h.controller.get("tab-1").submission).toEqual({
      phase: "blocked",
      reasons: ["model_modality_unsupported"],
    });

    const uncertain = await h.controller.submit("tab-1", "Inspect this file");
    expect(uncertain?.outcome).toBe("uncertain");
    expect(h.controller.get("tab-1").submission).toMatchObject({
      phase: "uncertain",
      text: "Inspect this file",
      turnId: grant.draftId,
    });
    expect(await h.controller.submit("tab-1", "changed text")).toBeNull();
    expect(await h.controller.remove("tab-1", snapshot.id)).toBe(false);
    expect(await h.controller.pick("tab-1")).toBeNull();
    expect(h.bridge.submit).toHaveBeenCalledTimes(2);

    const accepted = await h.controller.retryDelivery("tab-1");
    expect(accepted?.outcome).toBe("accepted");
    expect(h.bridge.submit).toHaveBeenCalledTimes(3);
    const initialRequest = vi.mocked(h.bridge.submit).mock.calls[1]?.[0];
    const retryRequest = vi.mocked(h.bridge.submit).mock.calls[2]?.[0];
    expect(retryRequest).toMatchObject({
      turnId: initialRequest?.turnId,
      explicitRetry: true,
      text: "Inspect this file",
    });
    expect(retryRequest?.attemptId).not.toBe(initialRequest?.attemptId);
    expect(h.controller.get("tab-1")).toMatchObject({
      generation: 1,
      phase: "idle",
      descriptors: [],
    });
  });

  it("does not apply a late draft-open result after the generation advances", async () => {
    const h = harness();
    let resolveOpen: (value: typeof grant) => void = () => {};
    vi.mocked(h.bridge.openDraft).mockImplementation(
      () => new Promise((resolve) => (resolveOpen = resolve)),
    );
    const opening = h.controller.open("tab-1");
    await vi.waitFor(() => expect(h.bridge.openDraft).toHaveBeenCalledOnce());
    const advancing = h.controller.advanceGeneration("tab-1");
    resolveOpen(grant);
    const advanced = await advancing;
    expect(advanced).toBe(true);
    await opening;
    expect(h.bridge.list).not.toHaveBeenCalled();
    expect(h.bridge.closeDraft).toHaveBeenCalledWith(grant);
    expect(h.controller.get("tab-1")).toMatchObject({
      generation: 1,
      phase: "idle",
      draftId: null,
      descriptors: [],
    });
  });

  it("retains an actionable import failure without accepting a stale descriptor", async () => {
    const h = harness();
    vi.mocked(h.bridge.begin).mockRejectedValue(new Error("attachments: unsupported_format"));
    const file = {
      name: "sound.mp3",
      type: "audio/mpeg",
      size: 0,
      slice: () => new Blob(),
    };
    const state = await h.controller.importFile("tab-1", file);
    expect(state.imports).toMatchObject([{ phase: "failed", reason: "unsupported" }]);
    expect(state.descriptors).toEqual([snapshot]);
    expect(h.bridge.append).not.toHaveBeenCalled();
  });

  it("reads only a bounded preview and copies the returned bytes", async () => {
    const h = harness();
    const source = new Uint8Array([97, 98, 99]);
    vi.mocked(h.bridge.preview).mockResolvedValue({
      bytes: source,
      size: 3,
      truncated: false,
      kind: "text",
      mimeType: "text/plain",
    });
    const result = await h.controller.preview("tab-1", snapshot.id);
    expect(h.bridge.preview).toHaveBeenCalledWith(grant, snapshot.id, 64 * 1024);
    expect(result?.bytes).toEqual(source);
    expect(result?.bytes).not.toBe(source);
  });

  it("restores a durable uncertain attempt after restart and refuses changed text", async () => {
    const h = harness();
    h.draftText.value = "Inspect this file";
    const status = vi.mocked(h.bridge.status);
    status.mockResolvedValue({
      version: 1,
      phase: "uncertain",
      turnId: grant.draftId,
      attemptId: id(200),
      result: { outcome: "uncertain", turnId: grant.draftId, attemptId: id(200) },
      retryOfAttemptId: null,
      textMatches: true,
      filesMatch: true,
      originalIds: [snapshot.id],
      representationIds: [id(201)],
      updatedAt: 1_000,
    });

    const state = await h.controller.open("tab-1");
    expect(state.submission).toMatchObject({
      phase: "uncertain",
      text: "Inspect this file",
      turnId: grant.draftId,
    });
    // Freezing is restored from disk, so a normal send cannot create a new attempt.
    expect(await h.controller.submit("tab-1", "different text")).toBeNull();
    expect(await h.controller.remove("tab-1", snapshot.id)).toBe(false);
    expect(h.bridge.submit).not.toHaveBeenCalled();

    vi.mocked(h.bridge.submit).mockImplementation(async (input) => ({
      outcome: "accepted",
      turnId: input.turnId,
      attemptId: input.attemptId,
      userEntryId: "entry-user",
      associationEntryId: "entry-association",
    }));
    const retried = await h.controller.retryDelivery("tab-1");
    expect(retried?.outcome).toBe("accepted");
    expect(vi.mocked(h.bridge.submit).mock.calls[0]?.[0]).toMatchObject({
      turnId: grant.draftId,
      explicitRetry: true,
      text: "Inspect this file",
    });
  });

  it("starts a clean draft after restart when the journal proves acceptance", async () => {
    const h = harness();
    vi.mocked(h.bridge.status).mockResolvedValue({
      version: 1,
      phase: "accepted",
      turnId: grant.draftId,
      attemptId: id(210),
      result: {
        outcome: "accepted",
        turnId: grant.draftId,
        attemptId: id(210),
        userEntryId: "entry-user",
        associationEntryId: "entry-association",
      },
      retryOfAttemptId: null,
      textMatches: true,
      filesMatch: true,
      originalIds: [snapshot.id],
      representationIds: [id(211)],
      updatedAt: 1_000,
    });

    const state = await h.controller.open("tab-1");
    expect(state).toMatchObject({
      generation: 1,
      phase: "idle",
      draftId: null,
      descriptors: [],
    });
    expect(h.bridge.closeDraft).toHaveBeenCalledWith(grant);
    expect(h.saved.has("tab-1")).toBe(false);
  });

  it("requires explicit review when the shown draft no longer matches the journaled attempt", async () => {
    const h = harness();
    h.draftText.value = "rewritten text";
    vi.mocked(h.bridge.status).mockResolvedValue({
      version: 1,
      phase: "uncertain",
      turnId: grant.draftId,
      attemptId: id(220),
      result: { outcome: "uncertain", turnId: grant.draftId, attemptId: id(220) },
      retryOfAttemptId: null,
      textMatches: false,
      filesMatch: true,
      originalIds: [snapshot.id],
      representationIds: [id(221)],
      updatedAt: 1_000,
    });

    const state = await h.controller.open("tab-1");
    expect(state.submission).toEqual({
      phase: "review_required",
      turnId: grant.draftId,
      reason: "text_changed",
    });
    expect(await h.controller.submit("tab-1", "rewritten text")).toBeNull();
    expect(await h.controller.resetDraft("tab-1")).toBe(true);
    expect(h.controller.get("tab-1")).toMatchObject({
      generation: 1,
      phase: "idle",
      descriptors: [],
    });
  });

  it("keeps a definitive blocked explicit retry blocked instead of uncertain", async () => {
    const h = harness();
    vi.mocked(h.bridge.submit)
      .mockImplementationOnce(async (input) => ({
        outcome: "uncertain",
        turnId: input.turnId,
        attemptId: input.attemptId,
      }))
      .mockImplementationOnce(async (input) => ({
        outcome: "blocked",
        reasons: ["format_unsupported"],
        turnId: input.turnId,
        attemptId: input.attemptId,
      }));

    await h.controller.open("tab-1");
    await h.controller.submit("tab-1", "Inspect");
    const retried = await h.controller.retryDelivery("tab-1");
    expect(retried?.outcome).toBe("blocked");
    expect(h.controller.get("tab-1").submission).toEqual({
      phase: "blocked",
      reasons: ["format_unsupported"],
    });
  });

  it("lets users dismiss failed imports and picker issues without hiding active work", async () => {
    const h = harness();
    vi.mocked(h.bridge.begin).mockRejectedValue(new Error("attachments: unsupported_format"));
    vi.mocked(h.bridge.pick).mockResolvedValue([
      { ok: false, name: "movie.mp4", reason: "unsupported_format" },
    ]);
    const file = { name: "bad.zip", type: "application/zip", size: 0, slice: () => new Blob() };
    let state = await h.controller.importFile("tab-1", file);
    const failed = state.imports[0];
    expect(failed?.phase).toBe("failed");
    h.controller.dismissImport("tab-1", failed?.operationId ?? -1);
    state = await h.controller.open("tab-1");
    expect(state.imports).toEqual([]);

    await h.controller.pick("tab-1");
    expect(h.controller.get("tab-1").issues).toHaveLength(1);
    h.controller.dismissIssue("tab-1", 0);
    expect(h.controller.get("tab-1").issues).toEqual([]);
  });
});

describe("profile-scoped draft identity", () => {
  it("keys a persisted draft by canonical profile and tab", async () => {
    const { attachmentDraftScopeKey } =
      await import("../../src/renderer/src/attachments/controller");
    expect(attachmentDraftScopeKey("C:/profile", "tab-1")).not.toBe(
      attachmentDraftScopeKey("D:/profile", "tab-1"),
    );
    expect(attachmentDraftScopeKey("C:/profile", "tab-1")).toBe(
      attachmentDraftScopeKey("C:/profile", "tab-1"),
    );
    expect(attachmentDraftScopeKey(undefined, "tab-1")).toContain("tab-1");
    expect(attachmentDraftScopeKey("  ", "tab-2")).toContain("tab-2");
  });
});
