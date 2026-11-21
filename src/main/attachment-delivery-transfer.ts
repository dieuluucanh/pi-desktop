import {
  ATTACHMENT_DELIVERY_VERSION,
  ATTACHMENT_LIMITS,
  isAttachmentId,
  validateAttachmentSubmissionMetadata,
  isWellFormedAttachmentText,
  type AttachmentAttemptId,
  type AttachmentDeliveryPlan,
  type AttachmentPromptResult,
  type AttachmentReason,
  type AttachmentSubmissionAssociation,
  type AttachmentTurnId,
  type AttachmentDeliveryScope,
  type AuthorizedAttachmentAsset,
} from "../shared/attachments";
import { MAX_FRAME_BYTES, type AttachmentPrivateHostMethod } from "../shared/host-protocol";
import type { AttachmentDeliveryLease } from "./attachment-delivery-leases";
import type { AttachmentSubmissionJournal } from "./attachment-submission-journal";
import type { AttachmentOwnershipReconciler } from "./attachment-ownership";
import type { SessionHostPin } from "./session-service";

const CHUNK = ATTACHMENT_LIMITS.importChunkBytes;

export class AttachmentTransferError extends Error {
  constructor() {
    super("attachment transfer is unavailable");
    this.name = "AttachmentTransferError";
  }
}

type AttachmentPlanningResult =
  | { readonly outcome: "ready"; readonly plan: AttachmentDeliveryPlan }
  | { readonly outcome: "blocked"; readonly reasons: readonly AttachmentReason[] };

export interface StagedAttachmentTransfer {
  readonly transferId: string;
  plan(text: string): Promise<AttachmentPlanningResult>;
  dispatch(input: {
    readonly planId: string;
    readonly turnId: AttachmentTurnId;
    readonly attemptId: AttachmentAttemptId;
    readonly text: string;
    readonly explicitRetry?: boolean;
  }): Promise<AttachmentPromptResult>;
  /** Idempotent; releases host staging and the parent lease. */
  cancel(): Promise<void>;
}

function validAssets(assets: readonly AuthorizedAttachmentAsset[]): boolean {
  if (assets.length === 0 || assets.length > ATTACHMENT_LIMITS.filesPerDraft) return false;
  let originalsBytes = 0;
  let representationBytes = 0;
  let textBytes = 0;
  let encodedImages = 0;
  const originalIds = new Set<string>();
  const representationIds = new Set<string>();
  for (const asset of assets) {
    const original = asset?.original;
    const representation = asset?.representation;
    if (
      !original ||
      !representation ||
      !isAttachmentId(original.id) ||
      !isAttachmentId(representation.id) ||
      typeof original.name !== "string" ||
      original.name.length === 0 ||
      original.name.length > 255 ||
      original.name.includes("/") ||
      original.name.includes("\\") ||
      !/^[0-9a-f]{64}$/.test(original.sha256) ||
      representation.attachmentId !== original.id ||
      representation.originalSha256 !== original.sha256 ||
      !/^[0-9a-f]{64}$/.test(representation.representationSha256) ||
      representation.origin !== "direct" ||
      representation.approved !== true ||
      !["text", "image"].includes(representation.modality) ||
      originalIds.has(original.id) ||
      representationIds.has(representation.id) ||
      !Number.isSafeInteger(original.bytes) ||
      original.bytes < 0 ||
      !Number.isSafeInteger(representation.bytes) ||
      representation.bytes < 0
    )
      return false;
    originalIds.add(original.id);
    representationIds.add(representation.id);
    originalsBytes += original.bytes;
    representationBytes += representation.bytes;
    if (representation.modality === "text") {
      if (
        original.kind !== "text" ||
        original.bytes > ATTACHMENT_LIMITS.textOriginalBytes ||
        representation.bytes > ATTACHMENT_LIMITS.promptTextBytesPerFile
      )
        return false;
      textBytes += representation.bytes;
    } else {
      if (
        original.kind !== "image" ||
        original.bytes > ATTACHMENT_LIMITS.imageOriginalBytes ||
        representation.bytes === 0 ||
        representation.bytes > ATTACHMENT_LIMITS.imageOriginalBytes ||
        !asset.image ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.image.mime)
      )
        return false;
      encodedImages += Math.ceil(representation.bytes / 3) * 4;
    }
  }
  return (
    originalsBytes <= ATTACHMENT_LIMITS.draftOriginalBytes &&
    representationBytes <= ATTACHMENT_LIMITS.estimatedRequestBytes &&
    textBytes <= ATTACHMENT_LIMITS.promptTextBytesTotal &&
    encodedImages <= ATTACHMENT_LIMITS.imageEncodedBytesTotal
  );
}

const REASONS: readonly AttachmentReason[] = [
  "format_unsupported",
  "conversion_required",
  "approval_required",
  "sdk_document_unsupported",
  "model_unknown",
  "model_modality_unsupported",
  "model_limits_unknown",
  "original_too_large",
  "draft_too_large",
  "too_many_files",
  "image_limit_exceeded",
  "image_pipeline_unsafe",
  "sdk_hook_unsafe",
  "sdk_pipeline_unsafe",
  "text_limit_exceeded",
  "context_limit_exceeded",
  "invalid_budget",
  "unavailable",
  "busy",
  "command_unsupported",
  "stale_plan",
];
const isReason = (value: unknown): value is AttachmentReason =>
  typeof value === "string" && REASONS.includes(value as AttachmentReason);

function parsePlan(
  value: unknown,
  assets: readonly AuthorizedAttachmentAsset[],
): AttachmentDeliveryPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const model = result.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) return null;
  const modelRecord = model as Record<string, unknown>;
  const representationIds = result.representationIds;
  const blockingReasons = result.blockingReasons;
  if (
    result.version !== ATTACHMENT_DELIVERY_VERSION ||
    !isAttachmentId(result.id) ||
    Object.keys(result).length !== 6 ||
    Object.keys(modelRecord).length !== 3 ||
    typeof modelRecord.provider !== "string" ||
    typeof modelRecord.id !== "string" ||
    typeof modelRecord.api !== "string" ||
    !Array.isArray(representationIds) ||
    representationIds.length !== assets.length ||
    !representationIds.every((id, index) => id === assets[index]?.representation.id) ||
    !Number.isSafeInteger(result.estimatedTokens) ||
    (result.estimatedTokens as number) < 0 ||
    !Array.isArray(blockingReasons) ||
    blockingReasons.length !== 0
  )
    return null;
  return value as AttachmentDeliveryPlan;
}

function parseBlockedReasons(value: unknown): readonly AttachmentReason[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 || !value.every(isReason)) {
    return null;
  }
  return Object.freeze([...new Set(value)]);
}

function hostContextMatches(value: unknown, scope: AttachmentDeliveryScope): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return (
    Object.keys(context).length === 4 &&
    Object.keys(context).every((key) =>
      ["sessionId", "sessionEpoch", "branchId", "revision"].includes(key),
    ) &&
    context.sessionId === scope.sessionId &&
    context.sessionEpoch === scope.sessionEpoch &&
    context.branchId === scope.branchId &&
    context.revision === scope.revision
  );
}

function parsePromptResult(
  value: unknown,
  turnId: AttachmentTurnId,
  attemptId: AttachmentAttemptId,
): AttachmentPromptResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    result.turnId !== turnId ||
    result.attemptId !== attemptId ||
    typeof result.turnId !== "string" ||
    typeof result.attemptId !== "string"
  )
    return null;
  if (result.outcome === "blocked" && Object.keys(result).length === 4) {
    const reasons = parseBlockedReasons(result.reasons);
    return reasons ? { outcome: "blocked", reasons, turnId, attemptId } : null;
  }
  if (result.outcome === "handled" && Object.keys(result).length === 3)
    return { outcome: "handled", turnId, attemptId };
  if (result.outcome === "uncertain" && Object.keys(result).length === 3) {
    return { outcome: "uncertain", turnId, attemptId };
  }
  if (
    result.outcome === "accepted" &&
    Object.keys(result).length === 5 &&
    validEntryId(result.userEntryId) &&
    validEntryId(result.associationEntryId)
  ) {
    return {
      outcome: "accepted",
      turnId,
      attemptId,
      userEntryId: result.userEntryId,
      associationEntryId: result.associationEntryId,
    };
  }
  return null;
}

function validEntryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function parseSubmissionAssociations(value: unknown): AttachmentSubmissionAssociation[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== 2 ||
    !Object.keys(result).every((key) => ["version", "associations"].includes(key)) ||
    result.version !== 1 ||
    !Array.isArray(result.associations) ||
    result.associations.length > 512
  )
    return null;
  const associations: AttachmentSubmissionAssociation[] = [];
  for (const value of result.associations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const association = value as Record<string, unknown>;
    if (
      Object.keys(association).length !== 2 ||
      !Object.keys(association).every((key) => ["metadata", "associationEntryId"].includes(key)) ||
      !validEntryId(association.associationEntryId)
    )
      return null;
    const metadata = validateAttachmentSubmissionMetadata(association.metadata);
    if (!metadata) return null;
    associations.push({ metadata, associationEntryId: association.associationEntryId });
  }
  return associations;
}

export function attachmentTransferFrameFits(
  method: AttachmentPrivateHostMethod,
  params: unknown,
): boolean {
  try {
    return Buffer.byteLength(JSON.stringify({ id: 1, method, params })) < MAX_FRAME_BYTES;
  } catch {
    return false;
  }
}

/**
 * Push one main-authorized lease over the private, bounded parent→host channel,
 * verify the host's live branch/revision, then expose host planning and a single
 * plan-bound dispatch. Main never sees materialized bytes or calls the SDK. A
 * prompt timeout is ambiguous; the caller retains the lease until settlement or
 * explicit cancellation, while host TTL cleanup is the final backstop.
 */
function validScope(scope: AttachmentDeliveryScope): boolean {
  const keys = [
    "authorityId",
    "leaseId",
    "profileKey",
    "tabId",
    "draftId",
    "hostGeneration",
    "processGeneration",
    "sessionId",
    "sessionEpoch",
    "branchId",
    "revision",
  ];
  const label = (value: unknown, max = 512): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    );
  return (
    Boolean(scope) &&
    Object.keys(scope).length === keys.length &&
    Object.keys(scope).every((key) => keys.includes(key)) &&
    isAttachmentId(scope.authorityId) &&
    isAttachmentId(scope.leaseId) &&
    /^[0-9a-f]{64}$/.test(scope.profileKey) &&
    label(scope.tabId, 128) &&
    isAttachmentId(scope.draftId) &&
    Number.isSafeInteger(scope.hostGeneration) &&
    scope.hostGeneration >= 0 &&
    Number.isSafeInteger(scope.processGeneration) &&
    scope.processGeneration > 0 &&
    label(scope.sessionId) &&
    Number.isSafeInteger(scope.sessionEpoch) &&
    scope.sessionEpoch > 0 &&
    (scope.branchId === null || label(scope.branchId)) &&
    label(scope.revision)
  );
}

export async function stageAttachmentDelivery(input: {
  readonly pin: SessionHostPin;
  readonly lease: AttachmentDeliveryLease;
  readonly journal: AttachmentSubmissionJournal;
  /**
   * Best-effort durable ownership (plan step 12). A failure here must never
   * change the dispatch disposition: acceptance stays durable and the next
   * startup/status sweep repairs promotion.
   */
  readonly ownership?: Pick<AttachmentOwnershipReconciler, "adopt" | "promote">;
}): Promise<StagedAttachmentTransfer> {
  const { pin, lease, journal, ownership } = input;
  let active = true;
  let staged = false;
  let plannedId: string | null = null;
  let plannedText: string | null = null;
  let cancelPromise: Promise<void> | null = null;
  const bindingMatches =
    validScope(lease.scope) &&
    lease.scope.leaseId === lease.id &&
    lease.scope.tabId === pin.tabId &&
    lease.scope.hostGeneration === pin.generation &&
    lease.scope.processGeneration === pin.processGeneration &&
    lease.scope.sessionId === pin.sessionId &&
    lease.scope.sessionEpoch === pin.sessionEpoch;

  const assertCurrent = async (): Promise<void> => {
    if (
      !bindingMatches ||
      !active ||
      !pin.isCurrent() ||
      !lease.authorized() ||
      !(await lease.isCurrent())
    ) {
      throw new AttachmentTransferError();
    }
  };
  const request = async (
    method: AttachmentPrivateHostMethod,
    params: unknown,
  ): Promise<unknown> => {
    if (!attachmentTransferFrameFits(method, params)) throw new AttachmentTransferError();
    await assertCurrent();
    const response = await pin.request(method, params);
    await assertCurrent();
    return response;
  };
  const adoptOwnership = async (associations: readonly AttachmentSubmissionAssociation[]) => {
    if (!ownership) return;
    try {
      await ownership.adopt({
        sessionId: lease.scope.sessionId,
        branchId: lease.scope.branchId,
        associations,
      });
    } catch {
      // Retention is repaired by the next sweep; dispatch authority is unchanged.
    }
  };
  const plan = async (text: string): Promise<AttachmentPlanningResult> => {
    plannedId = null;
    plannedText = null;
    if (typeof text !== "string" || !isWellFormedAttachmentText(text) || !active) {
      return { outcome: "blocked", reasons: ["unavailable"] };
    }
    try {
      const response = await request("attachments.plan", { id: lease.id, text });
      if (response && typeof response === "object" && !Array.isArray(response)) {
        const result = response as Record<string, unknown>;
        if (result.outcome === "blocked") {
          const reasons = parseBlockedReasons(result.reasons);
          if (reasons) return { outcome: "blocked", reasons };
        }
        if (result.outcome === "ready") {
          const readyPlan = parsePlan(result.plan, lease.assets);
          if (readyPlan) {
            plannedId = readyPlan.id;
            plannedText = text;
            return { outcome: "ready", plan: readyPlan };
          }
        }
      }
      return { outcome: "blocked", reasons: ["unavailable"] };
    } catch {
      return { outcome: "blocked", reasons: ["unavailable"] };
    }
  };
  const dispatch = async (input: {
    readonly planId: string;
    readonly turnId: AttachmentTurnId;
    readonly attemptId: AttachmentAttemptId;
    readonly text: string;
    readonly explicitRetry?: boolean;
  }): Promise<AttachmentPromptResult> => {
    const blocked = (reason: AttachmentReason): AttachmentPromptResult => ({
      outcome: "blocked",
      reasons: [reason],
      turnId: input.turnId,
      attemptId: input.attemptId,
    });
    const uncertain = (): AttachmentPromptResult => ({
      outcome: "uncertain",
      turnId: input.turnId,
      attemptId: input.attemptId,
    });
    if (
      !active ||
      !isAttachmentId(input.planId) ||
      !isAttachmentId(input.turnId) ||
      !isAttachmentId(input.attemptId) ||
      !isWellFormedAttachmentText(input.text) ||
      plannedId !== input.planId ||
      plannedText !== input.text
    )
      return blocked("stale_plan");
    const params = {
      version: ATTACHMENT_DELIVERY_VERSION,
      transferId: lease.id,
      planId: input.planId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      text: input.text,
    };
    if (!attachmentTransferFrameFits("attachments.prompt", params)) return blocked("unavailable");

    let begun: Awaited<ReturnType<AttachmentSubmissionJournal["begin"]>>;
    try {
      const currentAssociations = parseSubmissionAssociations(
        await request("attachments.submissions.list", {}),
      );
      if (!currentAssociations) return blocked("unavailable");
      await journal.reconcile(lease.scope, currentAssociations);
      await adoptOwnership(currentAssociations);
      begun = await journal.begin({
        planId: input.planId,
        turnId: input.turnId,
        attemptId: input.attemptId,
        scope: lease.scope,
        sourceText: input.text,
        assets: lease.assets,
        ...(input.explicitRetry === true ? { explicitRetry: true } : {}),
      });
    } catch {
      return blocked("unavailable");
    }
    if (begun.kind === "conflict") return blocked("stale_plan");
    if (begun.kind === "existing") return begun.entry.result ?? uncertain();

    try {
      await assertCurrent();
    } catch {
      const result = blocked("stale_plan");
      try {
        await journal.complete(input.turnId, input.attemptId, result);
        return result;
      } catch {
        return uncertain();
      }
    }

    let responseResult: AttachmentPromptResult | null = null;
    try {
      const response = await pin.request("attachments.prompt", params);
      responseResult = parsePromptResult(response, input.turnId, input.attemptId);
    } catch {
      // A lost reply does not establish whether Pi accepted the turn.
    }

    try {
      const persistedAssociations = parseSubmissionAssociations(
        await request("attachments.submissions.list", {}),
      );
      if (!persistedAssociations) throw new AttachmentTransferError();
      await journal.reconcile(lease.scope, persistedAssociations);
      const recovered = await journal.get(input.turnId, input.attemptId);
      if (recovered?.state === "accepted" && recovered.result?.outcome === "accepted") {
        // Promote the exact accepted generation before the caller can clear the
        // draft. An incomplete promotion is retried by the durable sweep.
        try {
          await ownership?.promote(recovered);
        } catch {
          // Durable acceptance is still authoritative; never resend.
        }
        await adoptOwnership(persistedAssociations);
        return recovered.result;
      }
    } catch {
      // Fall through to the response disposition; acceptance still requires a
      // SessionManager association proven by the private read method.
    }

    if (responseResult?.outcome === "blocked" || responseResult?.outcome === "handled") {
      try {
        await journal.complete(input.turnId, input.attemptId, responseResult);
        return responseResult;
      } catch {
        return uncertain();
      }
    }
    try {
      await journal.complete(input.turnId, input.attemptId, uncertain());
    } catch {
      // The durable dispatching record is reconciled as uncertain after restart.
    }
    return uncertain();
  };
  const cancel = (): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    if (!active) return Promise.resolve();
    active = false;
    cancelPromise = (async () => {
      try {
        if (staged && pin.isCurrent()) {
          await pin.request("attachments.transfer.cancel", { id: lease.id });
        }
      } catch {
        // The host's fixed expiry handles a lost/late cancel. Do not retry a host
        // operation whose timeout might mean it already executed.
      } finally {
        lease.signal.removeEventListener("abort", onLeaseAbort);
        lease.close();
      }
    })();
    return cancelPromise;
  };
  const onLeaseAbort = (): void => {
    void cancel();
  };
  lease.signal.addEventListener("abort", onLeaseAbort, { once: true });
  if (lease.signal.aborted) onLeaseAbort();

  try {
    const assets = lease.assets;
    if (!Array.isArray(assets) || !validAssets(assets)) {
      throw new AttachmentTransferError();
    }
    if (!bindingMatches || !pin.isCurrent() || !lease.authorized()) {
      throw new AttachmentTransferError();
    }
    const hostContext = await request("attachments.context", {});
    if (!hostContextMatches(hostContext, lease.scope)) throw new AttachmentTransferError();
    // A timeout is ambiguous: the host may have consumed begin even though the
    // response was lost. Mark cleanup necessary before sending the request.
    staged = true;
    await request("attachments.transfer.begin", {
      id: lease.id,
      scope: lease.scope,
      expiresAt: lease.expiresAt,
      assets,
    });
    for (const asset of assets) {
      if (!asset || !asset.representation || !Number.isSafeInteger(asset.representation.bytes)) {
        throw new AttachmentTransferError();
      }
      const { id, bytes } = asset.representation;
      if (bytes < 0 || bytes > ATTACHMENT_LIMITS.estimatedRequestBytes) {
        throw new AttachmentTransferError();
      }
      for (let offset = 0; offset < bytes; offset += CHUNK) {
        const length = Math.min(CHUNK, bytes - offset);
        await assertCurrent();
        const temporary = await lease.readChunk(id, offset, length);
        try {
          if (!(temporary instanceof Uint8Array) || temporary.byteLength !== length) {
            throw new AttachmentTransferError();
          }
          const encoded = Buffer.from(
            temporary.buffer,
            temporary.byteOffset,
            temporary.byteLength,
          ).toString("base64");
          await request("attachments.transfer.chunk", {
            id: lease.id,
            representationId: id,
            offset,
            encoded,
          });
        } finally {
          temporary.fill(0);
        }
      }
    }
    await request("attachments.transfer.seal", { id: lease.id });
    return Object.freeze({ transferId: lease.id, plan, dispatch, cancel });
  } catch {
    await cancel();
    throw new AttachmentTransferError();
  }
}
