import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDirectAttachment } from "../../src/attachments/prepare";
import { createAttachmentStore, type AssetOwner } from "../../src/attachments/store";
import type {
  AttachmentDeliveryScope,
  AuthorizedAttachmentAsset,
} from "../../src/shared/attachments";
import { renderAttachmentTextSections } from "../../src/attachments/text";
import { materializeAttachmentPrompt } from "../../src/host/attachment-materialize";
import { createAttachmentPlanner, type AttachmentPlanInput } from "../../src/host/attachment-plan";
import { createSdkSessionRuntime, SessionManager } from "../../src/host/sdk";
import {
  dispatchSdkAttachments as dispatchSdkAttachmentsImpl,
  type SdkAttachmentDispatch,
} from "../../src/host/sdk/attachments";
import { readAttachmentSubmissionAssociations } from "../../src/host/sdk/attachment-submission";
import { openDirectDeliveryReader } from "../../src/main/attachment-delivery-assets";
import { createNodeAttachmentStoreIo } from "../../src/main/attachment-store-io";
import { createFakeProvider, type FakeProvider } from "./fixtures/fake-provider";
import { createFixtureProfile, type FixtureProfile } from "./fixtures/fixture-profile";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

const attachmentId = "123e4567-e89b-42d3-a456-426614174001";
const turnId = "123e4567-e89b-42d3-a456-426614174002";
let provider: FakeProvider | null = null;
let profile: FixtureProfile | null = null;
let runtime: AgentSessionRuntime | null = null;

type IntegrationDispatchInput = Omit<
  SdkAttachmentDispatch,
  "isCurrent" | "attemptId" | "planId" | "sourceTextSha256" | "scope" | "assets"
> & {
  isCurrent?: () => boolean;
  attemptId?: string;
  planId?: string;
  sourceTextSha256?: string;
  scope?: AttachmentDeliveryScope;
  assets?: readonly AuthorizedAttachmentAsset[];
};

function integrationScope(sessionId: string): AttachmentDeliveryScope {
  return {
    authorityId: randomUUID(),
    leaseId: randomUUID(),
    profileKey: "b".repeat(64),
    tabId: "integration-test-tab",
    draftId: randomUUID(),
    hostGeneration: 1,
    processGeneration: 1,
    sessionId,
    sessionEpoch: 1,
    branchId: null,
    revision: "integration-test-revision",
  };
}

function integrationAssets(
  input: Pick<SdkAttachmentDispatch, "images" | "text">,
): readonly AuthorizedAttachmentAsset[] {
  if (input.images.length > 0) {
    return input.images.map((image) => {
      const id = randomUUID();
      const representationId = randomUUID();
      return {
        original: {
          id,
          name: "fixture-image.gif",
          kind: "image",
          bytes: image.bytes.length,
          sha256: image.representationSha256,
        },
        representation: {
          id: representationId,
          attachmentId: id,
          modality: "image",
          origin: "direct",
          bytes: image.bytes.length,
          originalSha256: image.representationSha256,
          representationSha256: image.representationSha256,
          preparationVersion: "integration-test-v1",
          approved: true,
          warnings: [],
        },
        image: { mime: image.mimeType, width: 1, height: 1 },
        approvalDigest: null,
      };
    });
  }
  const bytes = new TextEncoder().encode(input.text || "fixture text");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const id = randomUUID();
  return [
    {
      original: { id, name: "fixture.txt", kind: "text", bytes: bytes.length, sha256: digest },
      representation: {
        id: randomUUID(),
        attachmentId: id,
        modality: "text",
        origin: "direct",
        bytes: bytes.length,
        originalSha256: digest,
        representationSha256: digest,
        preparationVersion: "integration-test-v1",
        approved: true,
        warnings: [],
      },
      image: null,
      approvalDigest: null,
    },
  ];
}

function dispatchSdkAttachments(input: IntegrationDispatchInput) {
  return dispatchSdkAttachmentsImpl({
    ...input,
    attemptId: input.attemptId ?? randomUUID(),
    planId: input.planId ?? randomUUID(),
    sourceTextSha256:
      input.sourceTextSha256 ?? createHash("sha256").update(input.text).digest("hex"),
    scope: input.scope ?? integrationScope(input.session.sessionManager.getSessionId()),
    assets: input.assets ?? integrationAssets(input),
    isCurrent: input.isCurrent ?? (() => true),
  });
}

afterEach(async () => {
  await runtime?.dispose();
  await provider?.close();
  profile?.remove();
  runtime = null;
  provider = null;
  profile = null;
});

async function start(
  options: { extension?: string; modelIds?: string[]; autoResize?: boolean } = {},
) {
  provider = await createFakeProvider();
  profile = createFixtureProfile({
    baseUrl: provider.baseUrl,
    settings: { images: { autoResize: options.autoResize ?? false } },
    ...(options.modelIds ? { modelIds: options.modelIds } : {}),
  });
  if (options.extension) profile.writeExtension("attachment-hook.js", options.extension);
  const created = await createSdkSessionRuntime({
    cwd: profile.projectDir,
    agentDir: profile.dir,
    sessionManager: SessionManager.create(profile.projectDir, profile.sessionsDir),
    projectTrusted: true,
  });
  runtime = created.runtime;
  const session = created.session;
  if (options.extension) await session.bindExtensions({});
  if (!session.model) throw new Error("fixture model missing");
  const expectedModel = {
    provider: session.model.provider,
    id: session.model.id,
    api: session.model.api,
  };
  return { session, provider, expectedModel };
}

describe("attachment adapter against the real SDK", () => {
  it("delivers main-resolved and host-verified text using a simulated lease", async () => {
    const h = await start();
    if (!profile) throw new Error("fixture profile missing");
    const profileKey = "a".repeat(64);
    const store = createAttachmentStore({
      profile: profileKey,
      io: createNodeAttachmentStoreIo({ root: join(profile.dir, "attachment-fixture") }),
      newId: randomUUID,
      now: () => 1_000,
    });
    const owner: AssetOwner = { kind: "draft", id: randomUUID() };
    const data = new TextEncoder().encode("secret from a verified local snapshot");
    const shaBytes = (value: Uint8Array): string =>
      createHash("sha256").update(value).digest("hex");
    const digest = async (value: Uint8Array): Promise<string> => shaBytes(value);
    const originalId = await store.beginOriginal({
      owner,
      name: "fixture.txt",
      mimeType: "text/plain",
      size: data.length,
    });
    await store.append(originalId, owner, 0, data);
    await store.commit(originalId, owner, shaBytes(data));
    const prepared = await prepareDirectAttachment(
      { store, encoder: { prepare: async () => null }, sha256: digest },
      owner,
      originalId,
    );
    if (prepared.status !== "ready") throw new Error("expected text preparation");
    // This fake demonstrates the data path, not production lease authorization.
    let live = true;
    const reader = await openDirectDeliveryReader({
      store,
      owner,
      representationIds: [prepared.asset.id],
      leaseCurrent: async () => live,
      sha256: digest,
    });
    const assets = reader.assets;
    const leaseId = randomUUID();
    const input: AttachmentPlanInput = {
      context: {
        profileKey,
        sessionId: h.session.sessionManager.getSessionId(),
        sessionEpoch: 1,
        branchId: null,
        revision: "fixture-revision",
        leaseId,
        idle: true,
        model: h.session.model,
        availableContextTokens: 100_000,
        estimatedNewImageTokens: null,
        estimatedExistingRequestBytes: 1_000,
        historyImageCount: 0,
        registeredCommand: false,
      },
      assets,
      text: "Summarize this.",
    };
    const planner = createAttachmentPlanner({
      newId: randomUUID,
      now: () => 1_000,
      sha256: (value) => createHash("sha256").update(value).digest("hex"),
    });
    const planned = planner.plan(input);
    if (planned.outcome !== "ready") throw new Error(`fixture plan blocked: ${planned.reasons}`);
    const materialized = await materializeAttachmentPrompt(
      {
        isCurrent: async (planId, currentAssets, text) =>
          (await reader.isCurrent()) &&
          planner.isCurrent(planId, { ...input, assets: currentAssets, text }),
        readChunk: reader.readChunk,
        sha256: digest,
      },
      planned.plan,
      assets,
      input.text,
    );
    h.provider.enqueue({ kind: "text", text: "read it" });
    const result = await dispatchSdkAttachments({
      session: h.session,
      expectedModel: h.expectedModel,
      turnId,
      scope: {
        authorityId: randomUUID(),
        leaseId,
        profileKey,
        tabId: "integration-test-tab",
        draftId: owner.id,
        hostGeneration: 1,
        processGeneration: 1,
        sessionId: h.session.sessionManager.getSessionId(),
        sessionEpoch: 1,
        branchId: null,
        revision: "fixture-revision",
      },
      assets,
      ...materialized,
      revalidate: async () => (await reader.isCurrent()) && planner.consume(planned.plan.id, input),
    });
    live = false;
    reader.close();
    expect(result).toMatchObject({
      outcome: "accepted",
      turnId,
      attemptId: expect.any(String),
      userEntryId: expect.any(String),
      associationEntryId: expect.any(String),
    });
    await h.session.waitForIdle();
    const messages = h.provider.requests[0]?.body.messages as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === "user");
    expect(JSON.stringify(user)).toContain("secret from a verified local snapshot");
    expect(JSON.stringify(user)).not.toContain(profile.dir);
  }, 30_000);

  it("accepts a trusted input transformation and records delivered provenance", async () => {
    const h = await start({
      extension: `export default function (pi) {
        pi.on("input", async () => ({ action: "transform", text: "rewritten by a trusted extension" }));
      }`,
    });
    h.provider.enqueue({ kind: "text", text: "the transformed turn answered" });
    const result = await dispatchSdkAttachments({
      session: h.session,
      expectedModel: h.expectedModel,
      turnId,
      text: "approved attachment text",
      images: [],
      revalidate: async () => true,
    });
    expect(result).toMatchObject({
      outcome: "accepted",
      turnId,
      attemptId: expect.any(String),
      userEntryId: expect.any(String),
      associationEntryId: expect.any(String),
    });
    await h.session.waitForIdle();
    // Trusted extensions are native Pi semantics: the turn is accepted, and the
    // association must describe what was actually persisted, not the plan.
    const [association] = readAttachmentSubmissionAssociations(h.session);
    expect(association?.metadata.sourceTextSha256).toBe(
      createHash("sha256").update("approved attachment text").digest("hex"),
    );
    expect(association?.metadata.textSha256).toBe(
      createHash("sha256").update("rewritten by a trusted extension").digest("hex"),
    );
    expect(JSON.stringify(h.provider.requests[0]?.body.messages)).toContain(
      "rewritten by a trusted extension",
    );
  }, 30_000);

  it("allows Pi's default image auto-resize instead of requiring a special setting", async () => {
    const h = await start({ autoResize: true });
    expect(h.session.settingsManager.getImageAutoResize()).toBe(true);
    const gif = new Uint8Array(
      Buffer.from("R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==", "base64"),
    );
    const digest = createHash("sha256").update(gif).digest("hex");
    h.provider.enqueue({ kind: "text", text: "image received" });
    const result = await dispatchSdkAttachments({
      session: h.session,
      expectedModel: h.expectedModel,
      turnId,
      text: "describe this image",
      images: [{ bytes: gif, mimeType: "image/gif", representationSha256: digest }],
      revalidate: async () => true,
    });
    expect(result).toMatchObject({ outcome: "accepted", turnId });
    await h.session.waitForIdle();
    expect(h.provider.requests).toHaveLength(1);
  }, 30_000);

  it("keeps the session usable when Pi defers a prompt during agent_settled", async () => {
    function gate() {
      let resolve = (): void => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const entered = gate();
    const resume = gate();
    const key = `attachment-settled-${randomUUID()}`;
    const state = { enabled: true, enter: entered.resolve, wait: resume.promise };
    Reflect.set(globalThis, key, state);
    try {
      const h = await start({
        extension: `export default function (pi) {
          pi.on("agent_settled", async () => {
            const gate = globalThis[${JSON.stringify(key)}];
            if (gate?.enabled) {
              gate.enabled = false;
              gate.enter();
              await gate.wait;
            }
          });
        }`,
      });
      const initial = h.session.prompt("initial ordinary turn");
      await entered.promise;
      const notice = vi.fn();
      const result = await dispatchSdkAttachments({
        session: h.session,
        expectedModel: h.expectedModel,
        turnId,
        text: "deferred private attachment",
        images: [],
        revalidate: async () => true,
        onLateFailure: notice,
      });
      // A deferred prompt is not acceptance. It is ambiguity, not a reason to
      // dispose a healthy session.
      expect(result).toMatchObject({ outcome: "uncertain", turnId });
      resume.resolve();
      await initial;
      await h.session.waitForIdle();
      h.provider.enqueue({ kind: "text", text: "session still works" });
      await h.session.prompt("ordinary text after the deferred turn");
      await h.session.waitForIdle();
      expect(JSON.stringify(h.provider.requests.at(-1)?.body.messages)).toContain(
        "ordinary text after the deferred turn",
      );
    } finally {
      resume.resolve();
      Reflect.deleteProperty(globalThis, key);
    }
  }, 30_000);

  it("rejects lone-surrogate prompt text before an official provider can sanitize it", async () => {
    const h = await start();
    const revalidate = vi.fn(async () => true);
    expect(
      await dispatchSdkAttachments({
        session: h.session,
        expectedModel: h.expectedModel,
        turnId,
        text: "approved\ud800text",
        images: [],
        revalidate,
      }),
    ).toMatchObject({
      outcome: "blocked",
      turnId,
      attemptId: expect.any(String),
      reasons: ["unavailable"],
    });
    expect(revalidate).not.toHaveBeenCalled();
    expect(h.provider.requests).toHaveLength(0);
  }, 30_000);

  it("delivers a framed text representation through the official prompt API", async () => {
    const h = await start();
    h.provider.enqueue({ kind: "text", text: "read it" });
    const framed = renderAttachmentTextSections([
      {
        id: attachmentId,
        name: "note.txt",
        representationSha256: "a".repeat(64),
        text: "bounded secret content",
      },
    ]);
    const result = await dispatchSdkAttachments({
      session: h.session,
      expectedModel: h.expectedModel,
      turnId,
      text: `Summarize this.\n\n${framed}`,
      images: [],
      revalidate: async () => true,
    });
    expect(result).toMatchObject({
      outcome: "accepted",
      turnId,
      attemptId: expect.any(String),
      userEntryId: expect.any(String),
      associationEntryId: expect.any(String),
    });
    await h.session.waitForIdle();
    const body = JSON.stringify(h.provider.requests[0]?.body);
    expect(body).toContain("bounded secret content");
    expect(body).toContain("Untrusted attachment data");
    // The SDK's system prompt legitimately contains the project cwd; the
    // attachment's user message must not contain a local source path.
    const messages = h.provider.requests[0]?.body.messages as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === "user");
    expect(JSON.stringify(user)).not.toContain("pi-desktop-fixture-project-");
  }, 30_000);

  it("delivers a verified image as a normal SDK image block without a second resize", async () => {
    const h = await start();
    h.provider.enqueue({ kind: "text", text: "image seen" });
    const gif = new Uint8Array(
      Buffer.from("R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==", "base64"),
    );
    const result = await dispatchSdkAttachments({
      session: h.session,
      expectedModel: h.expectedModel,
      turnId,
      text: "",
      images: [
        {
          bytes: gif,
          mimeType: "image/gif",
          representationSha256: createHash("sha256").update(gif).digest("hex"),
        },
      ],
      revalidate: async () => true,
    });
    expect(result).toMatchObject({
      outcome: "accepted",
      turnId,
      attemptId: expect.any(String),
      userEntryId: expect.any(String),
      associationEntryId: expect.any(String),
    });
    await h.session.waitForIdle();
    const body = JSON.stringify(h.provider.requests[0]?.body);
    expect(body).toContain("Please consider the attached files.");
    expect(body).toContain(`data:image/gif;base64,${Buffer.from(gif).toString("base64")}`);
  }, 30_000);
});
