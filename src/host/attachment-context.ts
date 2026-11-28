import {
  ATTACHMENT_LIMITS,
  type AttachmentDeliveryScope,
  type AttachmentModality,
  type AuthorizedAttachmentAsset,
} from "../shared/attachments";
import type {
  AttachmentPlanContext,
  AttachmentPlanInput,
  AttachmentPolicyContext,
} from "./attachment-plan";

const MAX_NODES = 100_000;
const MAX_DEPTH = 32;
const HISTORY_SAFETY_TOKENS = 4_096;

export interface AttachmentContextSource {
  readonly scope: Pick<
    AttachmentDeliveryScope,
    "profileKey" | "sessionId" | "sessionEpoch" | "branchId" | "revision"
  >;
  readonly model: unknown;
  readonly idle: boolean;
  readonly messages: readonly unknown[] | null;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly assets: readonly AuthorizedAttachmentAsset[];
  readonly text: string;
  readonly registeredCommand: boolean;
}

export interface AttachmentHistoryEstimate {
  readonly bytes: number | null;
  readonly imageCount: number | null;
}

function estimateValue(
  value: unknown,
  state: { bytes: number; nodes: number; images: number },
  seen: WeakSet<object>,
  depth: number,
): boolean {
  if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) return false;
  if (value === null || value === undefined) {
    state.bytes += 4;
    return true;
  }
  if (typeof value === "string") {
    state.bytes += value.length * 3 + 2;
    return (
      Number.isSafeInteger(state.bytes) && state.bytes <= ATTACHMENT_LIMITS.estimatedRequestBytes
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    state.bytes += 16;
    return true;
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    state.bytes += value.byteLength * 2 + 16;
    return (
      Number.isSafeInteger(state.bytes) && state.bytes <= ATTACHMENT_LIMITS.estimatedRequestBytes
    );
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return false;
  }
  const type = descriptors.type?.value;
  if (type === "image") state.images++;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) return false;
    state.bytes += key.length * 3 + 4;
    if (!estimateValue(descriptor.value, state, seen, depth + 1)) return false;
  }
  return (
    Number.isSafeInteger(state.bytes) && state.bytes <= ATTACHMENT_LIMITS.estimatedRequestBytes
  );
}

/** Conservative, bounded estimate of the active history without serializing/copying it. */
export function estimateAttachmentHistory(
  messages: readonly unknown[] | null,
): AttachmentHistoryEstimate {
  if (!Array.isArray(messages)) return { bytes: null, imageCount: null };
  const state = { bytes: 0, nodes: 0, images: 0 };
  try {
    if (!estimateValue(messages, state, new WeakSet(), 0)) return { bytes: null, imageCount: null };
    return { bytes: state.bytes, imageCount: state.images };
  } catch {
    return { bytes: null, imageCount: null };
  }
}

function availableTokens(used: number | null, window: number | null): number | null {
  if (
    !Number.isSafeInteger(used) ||
    used === null ||
    used < 0 ||
    !Number.isSafeInteger(window) ||
    window === null ||
    window <= 0
  )
    return null;
  return Math.max(
    0,
    Math.min(ATTACHMENT_LIMITS.promptTextEstimatedTokens, window - used - HISTORY_SAFETY_TOKENS),
  );
}

function estimateNewImageTokens(
  images: readonly {
    readonly modality: AttachmentModality;
    readonly image: { readonly width: number; readonly height: number } | null;
  }[],
): number | null {
  let estimate = 0;
  for (const entry of images) {
    if (entry.modality !== "image") continue;
    const image = entry.image;
    if (
      !image ||
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width <= 0 ||
      image.height <= 0
    )
      return null;
    const pixels = image.width * image.height;
    if (!Number.isSafeInteger(pixels) || pixels > ATTACHMENT_LIMITS.imagePixels) return null;
    // Deliberately conservative application estimate, not a provider promise.
    estimate += Math.ceil(pixels / 128) + 256;
    if (!Number.isSafeInteger(estimate)) return null;
  }
  return estimate;
}

/** Builds the host's actual-model/context policy input; unknown SDK data fails closed. */
export function createAttachmentPolicyContext(
  source: AttachmentContextSource,
): AttachmentPolicyContext {
  const history = estimateAttachmentHistory(source.messages);
  return {
    profileKey: source.scope.profileKey,
    sessionId: source.scope.sessionId,
    sessionEpoch: source.scope.sessionEpoch,
    branchId: source.scope.branchId,
    revision: source.scope.revision,
    idle: source.idle,
    model: source.model,
    availableContextTokens: availableTokens(source.contextTokens, source.contextWindow),
    estimatedNewImageTokens: estimateNewImageTokens(
      source.assets.map((asset) => ({
        modality: asset.representation.modality,
        image: asset.image,
      })),
    ),
    estimatedExistingRequestBytes: history.bytes,
    historyImageCount: history.imageCount,
    registeredCommand: source.registeredCommand,
  };
}

/** Plan input adds the lease identity used for the plan binding only. */
export function createAttachmentPlanInput(
  source: AttachmentContextSource & { readonly scope: AttachmentDeliveryScope },
): AttachmentPlanInput {
  const context: AttachmentPlanContext = {
    ...createAttachmentPolicyContext(source),
    leaseId: source.scope.leaseId,
  };
  return { context, assets: source.assets, text: source.text };
}

/** Readiness evaluates metadata-only descriptors, not authorized delivery assets. */
export interface AttachmentReadinessContextSource {
  readonly scope: Pick<
    AttachmentDeliveryScope,
    "profileKey" | "sessionId" | "sessionEpoch" | "branchId" | "revision"
  >;
  readonly model: unknown;
  readonly idle: boolean;
  readonly messages: readonly unknown[] | null;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly images: readonly {
    readonly modality: AttachmentModality;
    readonly image: { readonly width: number; readonly height: number } | null;
  }[];
  readonly registeredCommand: boolean;
}

export function createAttachmentReadinessPolicyContext(
  source: AttachmentReadinessContextSource,
): AttachmentPolicyContext {
  const history = estimateAttachmentHistory(source.messages);
  return {
    profileKey: source.scope.profileKey,
    sessionId: source.scope.sessionId,
    sessionEpoch: source.scope.sessionEpoch,
    branchId: source.scope.branchId,
    revision: source.scope.revision,
    idle: source.idle,
    model: source.model,
    availableContextTokens: availableTokens(source.contextTokens, source.contextWindow),
    estimatedNewImageTokens: estimateNewImageTokens(source.images),
    estimatedExistingRequestBytes: history.bytes,
    historyImageCount: history.imageCount,
    registeredCommand: source.registeredCommand,
  };
}
