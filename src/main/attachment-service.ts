import { isKnownUnsupportedAttachment } from "../attachments/format-hints";
import { classificationForAttachment } from "../attachments/classify";
import type { AssetOwner, AssetRecord, AttachmentStore } from "../attachments/store";
import {
  describeAttachment,
  originalKindForClassification,
  preparedImageRepresentation,
  preparedRepresentation,
} from "./attachment-descriptors";
import {
  ATTACHMENT_CLASSIFICATION_VERSION,
  ATTACHMENT_LIMITS,
  isAttachmentId,
  isWellFormedAttachmentText,
  type AttachmentClassification,
  type AttachmentDescriptor,
  type AttachmentDraftGrant,
  type AttachmentImportGrant,
  type AttachmentImportRequest,
  type AttachmentModelIdentity,
  type AttachmentPreview,
  type AttachmentReadiness,
  type AttachmentReadinessAsset,
  type AttachmentReadinessFile,
  type AttachmentReason,
  type AttachmentSnapshot,
} from "../shared/attachments";

/**
 * Main-owned import grants. All platform, hashing, session and file operations
 * are injected. A grant authorizes bytes for one renderer/draft only; neither a
 * renderer-supplied path nor an attachment ID by itself authorizes a read.
 */
const IMPORT_GRANT_TTL_MS = 10 * 60_000;

export class UnsupportedAttachmentError extends Error {
  readonly code = "unsupported_format";
  constructor() {
    super("attachments: unsupported_format");
    this.name = "UnsupportedAttachmentError";
  }
}

export interface AttachmentHash {
  update(bytes: Uint8Array): void;
  digest(): string;
}

export interface AttachmentServiceDeps {
  store: AttachmentStore;
  /** Main-owned direct preparation; the callback must never trust renderer metadata. */
  prepareDirect?(
    owner: AssetOwner,
    attachmentId: string,
    context: { readonly tabId: string },
  ): Promise<
    | { readonly status: "ready"; readonly representationId: string }
    | { readonly status: "needs_conversion" }
  >;
  /** Bounded thumbnail from an already validated prepared image, by digest. */
  imageThumbnail?(representationSha256: string): {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
  } | null;
  /**
   * Host-owned, non-submitting model/context verdict over metadata only. It
   * never stages bytes, creates a dispatch attempt or consumes send authority.
   */
  evaluateReadiness?(
    assets: readonly AttachmentReadinessAsset[],
    text: string,
    context: { readonly tabId: string },
  ): Promise<
    | {
        readonly ok: true;
        readonly verdict: {
          readonly model: AttachmentModelIdentity | null;
          readonly revision: string;
          readonly files: readonly {
            readonly id: string;
            readonly reasons: readonly AttachmentReason[];
          }[];
          readonly reasons: readonly AttachmentReason[];
          readonly estimatedTokens: number;
        };
      }
    | { readonly ok: false; readonly reason: AttachmentReason }
  >;
  /** Verifies a trusted app sender and a still-live, host-backed session tab. */
  authorize(senderId: number, tabId: string): boolean;
  newId(): string;
  now(): number;
  createHash(): AttachmentHash;
}

interface DraftState {
  senderId: number;
  tabId: string;
  token: string;
  owner: AssetOwner;
}

interface ImportState {
  draft: DraftState;
  id: string;
  token: string;
  size: number;
  offset: number;
  expiresAt: number;
  hasher: AttachmentHash;
  digest: string | null;
  busy: boolean;
  operation: "append" | "commit" | "cancel" | null;
  idle: Promise<void> | null;
  releaseIdle: (() => void) | null;
  cancelRequested: boolean;
  poisoned: boolean;
}

/** Main-only authenticated draft fence, never a renderer-visible grant. */
export interface AttachmentDraftAuthority {
  readonly tabId: string;
  readonly owner: AssetOwner;
  /** Revocation is permanent once observed, even if the tab later reappears. */
  isCurrent(): boolean;
}

export interface AttachmentService {
  openDraft(senderId: number, tabId: string, draftId?: unknown): AttachmentDraftGrant;
  /** Authenticate a delivery scope without exposing store owners over IPC. */
  authorizeDeliveryDraft(senderId: number, draft: AttachmentDraftGrant): AttachmentDraftAuthority;
  /** Prepare owner-checked original IDs and return only immutable representation IDs. */
  prepareForDelivery(
    senderId: number,
    draft: AttachmentDraftGrant,
    attachmentIds: readonly string[],
  ): Promise<
    | { readonly representationIds: readonly string[] }
    | { readonly reasons: readonly AttachmentReason[] }
  >;
  begin(senderId: number, input: AttachmentImportRequest): Promise<AttachmentImportGrant>;
  append(
    senderId: number,
    draft: AttachmentDraftGrant,
    token: string,
    offset: number,
    chunk: Uint8Array,
  ): Promise<number>;
  commit(senderId: number, draft: AttachmentDraftGrant, token: string): Promise<AttachmentSnapshot>;
  cancel(senderId: number, draft: AttachmentDraftGrant, token: string): Promise<void>;
  list(senderId: number, draft: AttachmentDraftGrant): Promise<readonly AttachmentDescriptor[]>;
  /** Non-submitting per-file + aggregate readiness against the live model/context. */
  readiness(
    senderId: number,
    draft: AttachmentDraftGrant,
    attachmentIds: readonly string[],
    text: string,
  ): Promise<AttachmentReadiness>;
  /** Verify the grant is live for this sender and tab without reading assets. */
  authorizeDraft(senderId: number, draft: AttachmentDraftGrant): void;
  preview(
    senderId: number,
    draft: AttachmentDraftGrant,
    id: string,
    maxBytes: number,
  ): Promise<AttachmentPreview>;
  remove(senderId: number, draft: AttachmentDraftGrant, id: string): Promise<void>;
  /** Cancel incomplete imports belonging to tabs which no longer exist. */
  reconcileTabs(liveTabIds: readonly string[]): Promise<void>;
  /** Called by main on draft reset; incomplete stages are cancelled. */
  closeDraft(senderId: number, draft: AttachmentDraftGrant): Promise<void>;
}

function error(message: string): never {
  throw new Error(`attachments: ${message}`);
}

function validTabId(tabId: unknown): tabId is string {
  return (
    typeof tabId === "string" &&
    tabId.length > 0 &&
    tabId.length <= 128 &&
    Array.from(tabId).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(
  value: AttachmentDraftGrant | AttachmentImportRequest,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function snapshot(asset: AssetRecord): AttachmentSnapshot {
  return { id: asset.id, name: asset.name, mimeType: asset.mimeType, size: asset.size };
}

/** Map a preparation failure to the same bounded reason used for delivery. */
function preparationReason(cause: unknown): AttachmentReason {
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "";
  if (code === "original_too_large" || code === "image_too_large") return "original_too_large";
  if (code === "format_unsupported" || code === "format_mismatch") return "format_unsupported";
  if (code === "preparation_failed") return "image_pipeline_unsafe";
  return "unavailable";
}

/** Reuse an immutable direct representation of the current original only. */
function preparationInFlightKey(owner: AssetOwner, originalId: string): string {
  return `${owner.kind}:${owner.id}:${originalId}`;
}

export function createAttachmentService(deps: AttachmentServiceDeps): AttachmentService {
  const drafts = new Map<string, DraftState>();
  const imports = new Map<string, ImportState>();
  const pendingTokens = new Set<string>();
  const chunkWindows = new Map<number, { start: number; count: number }>();
  /** One host preparation per draft original, even under repeated preview clicks. */
  const preparationsInFlight = new Map<string, Promise<void>>();
  // Includes begin() calls that are waiting for the storage port's lock.
  let importSlots = 0;

  const time = (): number => {
    const now = deps.now();
    if (!safeCount(now)) return error("invalid clock");
    return now;
  };
  const reserveChunk = (senderId: number): void => {
    const now = time();
    let window = chunkWindows.get(senderId);
    if (!window || now < window.start || now - window.start >= 60_000) {
      window = { start: now, count: 0 };
      chunkWindows.set(senderId, window);
    }
    if (window.count >= ATTACHMENT_LIMITS.importChunksPerMinute) {
      error("import rate limit reached; try again shortly");
    }
    window.count++;
  };
  const newToken = (): string => {
    const token = deps.newId();
    if (
      !isAttachmentId(token) ||
      imports.has(token) ||
      pendingTokens.has(token) ||
      [...drafts.values()].some((draft) => draft.token === token)
    ) {
      return error("invalid or repeated grant ID");
    }
    return token;
  };
  const authorize = (senderId: number, tabId: string): void => {
    if (!safeCount(senderId) || !validTabId(tabId) || !deps.authorize(senderId, tabId)) {
      error("the renderer or session is not authorized");
    }
  };
  const requireDraft = (senderId: number, value: AttachmentDraftGrant): DraftState => {
    if (
      !value ||
      typeof value !== "object" ||
      !exactKeys(value, ["tabId", "draftId", "token"]) ||
      !validTabId(value.tabId) ||
      !isAttachmentId(value.draftId) ||
      !isAttachmentId(value.token)
    ) {
      return error("invalid draft grant");
    }
    authorize(senderId, value.tabId);
    const draft = drafts.get(value.token);
    if (
      !draft ||
      draft.senderId !== senderId ||
      draft.tabId !== value.tabId ||
      draft.owner.id !== value.draftId
    ) {
      return error("draft grant is not authorized");
    }
    return draft;
  };
  const requireImport = (
    senderId: number,
    value: AttachmentDraftGrant,
    token: string,
    allowPoisoned = false,
    allowBusy = false,
  ): ImportState => {
    const draft = requireDraft(senderId, value);
    if (!isAttachmentId(token)) return error("invalid import grant");
    const state = imports.get(token);
    if (!state || state.draft !== draft) return error("import grant is not authorized");
    if (state.expiresAt <= time() && !allowPoisoned) return error("import grant has expired");
    if (state.busy && !allowBusy) return error("another operation is in progress for this upload");
    if (state.poisoned && !allowPoisoned) return error("the failed import must be cancelled");
    return state;
  };
  const beginOperation = (state: ImportState, operation: "append" | "commit" | "cancel"): void => {
    state.busy = true;
    state.operation = operation;
    state.idle = new Promise<void>((resolve) => {
      state.releaseIdle = resolve;
    });
  };
  const endOperation = (state: ImportState): void => {
    state.busy = false;
    state.operation = null;
    state.releaseIdle?.();
    state.releaseIdle = null;
    state.idle = null;
  };
  const removeState = (state: ImportState): void => {
    if (imports.delete(state.token)) importSlots--;
  };
  const cancelInternal = async (state: ImportState): Promise<void> => {
    await deps.store.cancel(state.id, state.draft.owner);
    removeState(state);
  };
  const cancelExpired = async (): Promise<void> => {
    const now = time();
    for (const state of imports.values()) {
      if (state.expiresAt > now || state.busy) continue;
      // A storage failure retains the reservation for an explicit later retry.
      state.busy = true;
      try {
        await cancelInternal(state).catch(() => undefined);
      } finally {
        state.busy = false;
      }
    }
  };
  const stillAuthorized = (draft: DraftState): void => {
    authorize(draft.senderId, draft.tabId);
    if (drafts.get(draft.token) !== draft) error("draft grant is no longer active");
  };
  /** Classification runs once per original; a failure is recorded, never guessed. */
  const classificationsInFlight = new Map<string, Promise<AttachmentClassification>>();
  const classifyOriginal = async (
    draft: DraftState,
    original: AssetRecord,
  ): Promise<AttachmentClassification> => {
    if (original.classification) return original.classification;
    const key = preparationInFlightKey(draft.owner, original.id);
    let pending = classificationsInFlight.get(key);
    if (!pending) {
      pending = (async () => {
        let classification: AttachmentClassification;
        try {
          const { bytes } = await deps.store.readForPreparation(
            original.id,
            draft.owner,
            ATTACHMENT_LIMITS.documentOriginalBytes,
          );
          classification = classificationForAttachment({
            name: original.name,
            declaredMime: original.mimeType,
            bytes,
          });
        } catch {
          classification = {
            version: ATTACHMENT_CLASSIFICATION_VERSION,
            kind: "failed",
            format: null,
            detectedMime: null,
            warnings: [],
            text: null,
            image: null,
            failure: "classification_failed",
          };
        }
        try {
          await deps.store.recordClassification(original.id, draft.owner, classification);
        } catch {
          // A persistence failure must not lose the original or fabricate access.
        }
        return classification;
      })().finally(() => classificationsInFlight.delete(key));
      classificationsInFlight.set(key, pending);
    }
    return pending;
  };
  const cancelImport = async (
    senderId: number,
    draftGrant: AttachmentDraftGrant,
    token: string,
  ): Promise<void> => {
    const state = requireImport(senderId, draftGrant, token, true, true);
    if (state.busy) {
      if (state.operation !== "append" || !state.idle)
        return error("cannot cancel during finalization");
      state.cancelRequested = true;
      await state.idle;
      if (!imports.has(state.token)) return;
      stillAuthorized(state.draft);
      if (state.busy) return error("another operation is in progress for this upload");
    }
    beginOperation(state, "cancel");
    try {
      await cancelInternal(state);
    } finally {
      endOperation(state);
    }
  };

  return {
    openDraft(senderId, tabId, requestedDraftId) {
      authorize(senderId, tabId);
      if (requestedDraftId !== undefined && !isAttachmentId(requestedDraftId)) {
        return error("invalid draft identity");
      }
      const previous = [...drafts.values()].find(
        (draft) => draft.senderId === senderId && draft.tabId === tabId,
      );
      if (previous) {
        if (requestedDraftId !== undefined && requestedDraftId !== previous.owner.id) {
          return error("a different draft is already open for this tab");
        }
        return { tabId, draftId: previous.owner.id, token: previous.token };
      }
      const token = newToken();
      const draftId = requestedDraftId ?? token;
      const draft: DraftState = {
        senderId,
        tabId,
        token,
        owner: { kind: "draft", id: draftId },
      };
      drafts.set(token, draft);
      return { tabId, draftId, token };
    },
    authorizeDeliveryDraft(senderId, grant) {
      const draft = requireDraft(senderId, grant);
      let revoked = false;
      return Object.freeze({
        tabId: draft.tabId,
        owner: Object.freeze({ ...draft.owner }),
        isCurrent: () => {
          if (revoked) return false;
          try {
            stillAuthorized(draft);
            return true;
          } catch {
            revoked = true;
            return false;
          }
        },
      });
    },
    async begin(senderId, input) {
      if (
        !input ||
        typeof input !== "object" ||
        !exactKeys(input, ["draft", "name", "mimeType", "size"])
      ) {
        return error("invalid import request");
      }
      const draft = requireDraft(senderId, input.draft);
      if (
        typeof input.name !== "string" ||
        typeof input.mimeType !== "string" ||
        !safeCount(input.size)
      ) {
        return error("invalid import metadata");
      }
      if (isKnownUnsupportedAttachment(input.name, input.mimeType))
        throw new UnsupportedAttachmentError();
      await cancelExpired();
      stillAuthorized(draft);
      if (importSlots >= ATTACHMENT_LIMITS.concurrentImports)
        return error("too many active imports");
      const token = newToken();
      pendingTokens.add(token);
      importSlots++;
      let id: string | null = null;
      try {
        const hasher = deps.createHash();
        id = await deps.store.beginOriginal({
          owner: draft.owner,
          name: input.name,
          mimeType: input.mimeType,
          size: input.size,
        });
        stillAuthorized(draft);
        const state: ImportState = {
          draft,
          id,
          token,
          size: input.size,
          offset: 0,
          expiresAt: time() + IMPORT_GRANT_TTL_MS,
          hasher,
          digest: null,
          busy: false,
          operation: null,
          idle: null,
          releaseIdle: null,
          cancelRequested: false,
          poisoned: false,
        };
        imports.set(token, state);
        return { attachmentId: id, token };
      } catch (cause) {
        if (id) await deps.store.cancel(id, draft.owner).catch(() => undefined);
        importSlots--;
        throw cause;
      } finally {
        pendingTokens.delete(token);
      }
    },
    async append(senderId, draftGrant, token, offset, chunk) {
      const state = requireImport(senderId, draftGrant, token);
      if (
        !safeCount(offset) ||
        offset !== state.offset ||
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength === 0 ||
        chunk.byteLength > ATTACHMENT_LIMITS.importChunkBytes ||
        offset + chunk.byteLength > state.size ||
        state.digest !== null
      ) {
        return error("invalid import chunk");
      }
      reserveChunk(senderId);
      // Buffer.slice() is a view; this constructor copies even a Buffer input.
      const copy = new Uint8Array(chunk);
      beginOperation(state, "append");
      try {
        const next = await deps.store.append(state.id, state.draft.owner, offset, copy);
        if (state.cancelRequested) return error("import was cancelled");
        stillAuthorized(state.draft);
        if (next !== offset + copy.byteLength) return error("unexpected import offset");
        state.hasher.update(copy);
        state.offset = next;
        state.expiresAt = time() + IMPORT_GRANT_TTL_MS;
        return next;
      } catch (cause) {
        // A partial write makes the incremental hash unreliable: do not resume it.
        state.poisoned = true;
        await cancelInternal(state).catch(() => undefined);
        throw cause;
      } finally {
        endOperation(state);
      }
    },
    async commit(senderId, draftGrant, token) {
      const state = requireImport(senderId, draftGrant, token);
      if (state.offset !== state.size) return error("import is incomplete");
      beginOperation(state, "commit");
      try {
        state.digest ??= state.hasher.digest();
        const asset = await deps.store.commit(state.id, state.draft.owner, state.digest);
        removeState(state);
        stillAuthorized(state.draft);
        // Classify once, right after the immutable snapshot exists. Failure here
        // never fails the import: the descriptor reconstructs lazily instead.
        await classifyOriginal(state.draft, asset).catch(() => undefined);
        return snapshot(asset);
      } finally {
        endOperation(state);
      }
    },
    cancel: cancelImport,
    async prepareForDelivery(senderId, draftGrant, attachmentIds) {
      const draft = requireDraft(senderId, draftGrant);
      if (
        !Array.isArray(attachmentIds) ||
        attachmentIds.length === 0 ||
        attachmentIds.length > ATTACHMENT_LIMITS.filesPerDraft ||
        attachmentIds.some((id) => !isAttachmentId(id)) ||
        new Set(attachmentIds).size !== attachmentIds.length
      ) {
        return { reasons: ["unavailable"] };
      }
      const assets = await deps.store.list(draft.owner);
      stillAuthorized(draft);
      const originals = new Map(
        assets.filter((asset) => asset.kind === "original").map((asset) => [asset.id, asset]),
      );
      const representationIds: string[] = [];
      for (const attachmentId of attachmentIds) {
        const original = originals.get(attachmentId);
        if (!original) return { reasons: ["unavailable"] };
        const existing = preparedRepresentation(assets, original);
        if (existing) {
          representationIds.push(existing.id);
          continue;
        }
        if (!deps.prepareDirect) return { reasons: ["image_pipeline_unsafe"] };
        try {
          const prepared = await deps.prepareDirect(draft.owner, original.id, {
            tabId: draft.tabId,
          });
          stillAuthorized(draft);
          if (prepared.status === "needs_conversion") {
            return { reasons: ["conversion_required"] };
          }
          if (!isAttachmentId(prepared.representationId)) {
            return { reasons: ["unavailable"] };
          }
          representationIds.push(prepared.representationId);
        } catch (cause) {
          const code =
            cause && typeof cause === "object" && "code" in cause
              ? String((cause as { code: unknown }).code)
              : "";
          const reason: AttachmentReason =
            code === "original_too_large" || code === "image_too_large"
              ? "original_too_large"
              : code === "format_unsupported" || code === "format_mismatch"
                ? "format_unsupported"
                : code === "preparation_failed"
                  ? "image_pipeline_unsafe"
                  : "unavailable";
          return { reasons: [reason] };
        }
      }
      return { representationIds };
    },
    async list(senderId, draftGrant) {
      const draft = requireDraft(senderId, draftGrant);
      const assets = await deps.store.list(draft.owner);
      stillAuthorized(draft);
      const descriptors: AttachmentDescriptor[] = [];
      for (const original of assets.filter((asset) => asset.kind === "original")) {
        const classification = await classifyOriginal(draft, original);
        stillAuthorized(draft);
        descriptors.push(describeAttachment(original, assets, classification));
      }
      return descriptors;
    },
    async readiness(senderId, draftGrant, attachmentIds, text) {
      const localReasons = new Set<AttachmentReason>();
      const blockedFiles = new Map<string, AttachmentReason[]>();
      const rejected = (reason: AttachmentReason): AttachmentReadiness => ({
        version: 1,
        outcome: "blocked",
        files: [],
        reasons: [reason],
        estimatedTokens: 0,
        model: null,
        revision: "unavailable",
      });
      const draft = requireDraft(senderId, draftGrant);
      if (
        !Array.isArray(attachmentIds) ||
        attachmentIds.length === 0 ||
        attachmentIds.length > ATTACHMENT_LIMITS.filesPerDraft ||
        attachmentIds.some((id) => !isAttachmentId(id)) ||
        new Set(attachmentIds).size !== attachmentIds.length ||
        typeof text !== "string" ||
        !isWellFormedAttachmentText(text)
      ) {
        return rejected("unavailable");
      }
      const assets = await deps.store.list(draft.owner);
      stillAuthorized(draft);
      const originals = new Map(
        assets.filter((asset) => asset.kind === "original").map((asset) => [asset.id, asset]),
      );
      const classifications = new Map<string, AttachmentClassification>();
      for (const id of attachmentIds) {
        const original = originals.get(id);
        if (!original) {
          blockedFiles.set(id, ["unavailable"]);
          continue;
        }
        const classification = await classifyOriginal(draft, original);
        stillAuthorized(draft);
        classifications.set(id, classification);
        if (classification.kind === "unsupported" || classification.kind === "failed") {
          blockedFiles.set(id, [classification.failure ?? "classification_failed"]);
          continue;
        }
        if (classification.kind === "document") {
          blockedFiles.set(id, ["conversion_required"]);
          continue;
        }
        if (!preparedRepresentation(assets, original)) {
          if (!deps.prepareDirect) {
            blockedFiles.set(id, ["image_pipeline_unsafe"]);
            continue;
          }
          try {
            const prepared = await deps.prepareDirect(draft.owner, original.id, {
              tabId: draft.tabId,
            });
            stillAuthorized(draft);
            if (prepared.status !== "ready") blockedFiles.set(id, ["conversion_required"]);
          } catch (cause) {
            blockedFiles.set(id, [preparationReason(cause)]);
          }
        }
      }
      // The metadata-only host pass is bounded to files that produced a
      // representation; nothing is staged and no dispatch attempt is created.
      const refreshed = await deps.store.list(draft.owner);
      stillAuthorized(draft);
      const refreshedOriginals = new Map(
        refreshed.filter((asset) => asset.kind === "original").map((asset) => [asset.id, asset]),
      );
      const readinessAssets: AttachmentReadinessAsset[] = [];
      for (const id of attachmentIds) {
        if (blockedFiles.has(id)) continue;
        const original = refreshedOriginals.get(id);
        const classification = classifications.get(id);
        const representation = original ? preparedRepresentation(refreshed, original) : null;
        if (!original || !classification || !representation?.preparation) {
          blockedFiles.set(id, ["unavailable"]);
          continue;
        }
        const details = representation.preparation.details;
        readinessAssets.push({
          id,
          originalKind: originalKindForClassification(classification),
          originalBytes: original.size,
          modality: representation.preparation.modality,
          representationBytes: representation.size,
          image: details.kind === "image" ? { width: details.width, height: details.height } : null,
        });
      }
      let verdict: {
        readonly model: AttachmentModelIdentity | null;
        readonly revision: string;
        readonly files: readonly {
          readonly id: string;
          readonly reasons: readonly AttachmentReason[];
        }[];
        readonly reasons: readonly AttachmentReason[];
        readonly estimatedTokens: number;
      } | null = null;
      if (readinessAssets.length > 0) {
        if (!deps.evaluateReadiness) localReasons.add("unavailable");
        else {
          try {
            const result = await deps.evaluateReadiness(readinessAssets, text, {
              tabId: draft.tabId,
            });
            if (result.ok) verdict = result.verdict;
            else localReasons.add(result.reason);
          } catch {
            localReasons.add("unavailable");
          }
        }
      }
      if (verdict) {
        const byId = new Map(verdict.files.map((file) => [file.id, file.reasons]));
        for (const asset of readinessAssets) {
          const reasons = byId.get(asset.id) ?? ["unavailable"];
          if (reasons.length > 0) blockedFiles.set(asset.id, [...reasons]);
        }
        for (const reason of verdict.reasons) localReasons.add(reason);
      }
      for (const reasons of blockedFiles.values()) {
        for (const reason of reasons) localReasons.add(reason);
      }
      const files: AttachmentReadinessFile[] = attachmentIds.map((id) => {
        const reasons = blockedFiles.get(id);
        return reasons && reasons.length > 0
          ? { id, status: "blocked", reasons: reasons as AttachmentReason[] }
          : { id, status: "ready" };
      });
      return {
        version: 1,
        outcome:
          files.every((file) => file.status === "ready") && localReasons.size === 0
            ? "ready"
            : "blocked",
        files,
        reasons: [...localReasons],
        estimatedTokens: verdict?.estimatedTokens ?? 0,
        model: verdict?.model ?? null,
        revision: verdict?.revision ?? "unavailable",
      };
    },
    authorizeDraft(senderId, draftGrant) {
      // Authenticated, live grant only; deliberately reads no assets or bytes.
      requireDraft(senderId, draftGrant);
    },
    async preview(senderId, draftGrant, id, maxBytes) {
      const draft = requireDraft(senderId, draftGrant);
      if (!isAttachmentId(id) || !safeCount(maxBytes) || maxBytes <= 0) {
        return error("invalid attachment preview");
      }
      const assets = await deps.store.list(draft.owner);
      stillAuthorized(draft);
      const original = assets.find((asset) => asset.id === id && asset.kind === "original");
      if (!original) return error("attachment is not owned by this draft");
      if (!original.mimeType.startsWith("image/")) {
        const result = await deps.store.readPreview(id, draft.owner, maxBytes);
        stillAuthorized(draft);
        return { ...result, kind: "text", mimeType: original.mimeType };
      }
      // Images are never decoded from the raw original by the renderer. Only a
      // host-validated prepared representation may produce a preview thumbnail.
      let representation = preparedImageRepresentation(assets, original);
      if (!representation && deps.prepareDirect) {
        const prepare = deps.prepareDirect.bind(deps);
        const key = `${draft.owner.id}:${original.id}`;
        let pending = preparationsInFlight.get(key);
        if (!pending) {
          pending = (async () => {
            try {
              await prepare(draft.owner, original.id, { tabId: draft.tabId });
            } catch {
              // A preview never surfaces preparation internals or source paths.
            }
          })().finally(() => preparationsInFlight.delete(key));
          preparationsInFlight.set(key, pending);
        }
        await pending;
        stillAuthorized(draft);
        representation = preparedImageRepresentation(await deps.store.list(draft.owner), original);
        stillAuthorized(draft);
      }
      const thumbnail = representation
        ? (deps.imageThumbnail?.(representation.sha256) ?? null)
        : null;
      if (!thumbnail || !(thumbnail.bytes instanceof Uint8Array) || thumbnail.bytes.length === 0) {
        return error("image preview is not ready");
      }
      return {
        bytes: new Uint8Array(thumbnail.bytes),
        size: thumbnail.bytes.byteLength,
        truncated: false,
        kind: "image",
        mimeType: thumbnail.mimeType,
      };
    },
    async remove(senderId, draftGrant, id) {
      const draft = requireDraft(senderId, draftGrant);
      const assets = await deps.store.list(draft.owner);
      const original = assets.find((asset) => asset.id === id && asset.kind === "original");
      if (!original) return error("attachment is not owned by this draft");
      for (const representation of assets) {
        if (representation.kind === "representation" && representation.originalId === id) {
          await deps.store.releaseOwner(representation.id, draft.owner);
        }
      }
      await deps.store.releaseOwner(id, draft.owner);
    },
    async reconcileTabs(liveTabIds) {
      const live = new Set(liveTabIds);
      const orphaned = [...imports.values()].filter((state) => !live.has(state.draft.tabId));
      await Promise.all(
        orphaned.map(async (state) => {
          if (state.busy) {
            if (state.operation === "append") state.cancelRequested = true;
            if (!state.idle) return;
            await state.idle;
          }
          if (!imports.has(state.token) || state.busy) return;
          beginOperation(state, "cancel");
          try {
            await cancelInternal(state);
          } finally {
            endOperation(state);
          }
        }),
      );
    },
    async closeDraft(senderId, draftGrant) {
      const draft = requireDraft(senderId, draftGrant);
      const active = [...imports.values()].filter((state) => state.draft === draft);
      for (const state of active) await cancelImport(senderId, draftGrant, state.token);
      drafts.delete(draft.token);
    },
  };
}
