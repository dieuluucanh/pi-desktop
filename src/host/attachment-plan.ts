import { DEFAULT_IMAGE_PREPARATION_LIMITS } from "../attachments/prepare-image";
import {
  ATTACHMENT_DELIVERY_VERSION,
  ATTACHMENT_LIMITS,
  attachmentRepresentationReason,
  isAttachmentId,
  isWellFormedAttachmentText,
  resolveAttachmentCapability,
  type AttachmentDeliveryPlan,
  type AttachmentModality,
  type AttachmentOriginalKind,
  type AttachmentReason,
  type AuthorizedAttachmentAsset,
} from "../shared/attachments";

/**
 * The policy context is the host's own live model/context snapshot. It is also
 * used by the non-submitting readiness pass (which has no lease and no plan).
 */
export interface AttachmentPolicyContext {
  readonly profileKey: string;
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly branchId: string | null;
  readonly revision: string;
  readonly idle: boolean;
  readonly model: unknown;
  readonly availableContextTokens: number | null;
  /** Trusted model-aware upper estimate for newly attached images; null is unknown. */
  readonly estimatedNewImageTokens: number | null;
  readonly estimatedExistingRequestBytes: number | null;
  /** Number of image blocks in the active context; null means unknown. */
  readonly historyImageCount: number | null;
  /** Determined against app/SDK commands, templates and skills, not by renderer. */
  readonly registeredCommand: boolean;
}

export interface AttachmentPlanContext extends AttachmentPolicyContext {
  /** Main-issued authorization lease; the caller must check its liveness. */
  readonly leaseId: string;
}

/**
 * Metadata-only projection of one asset for policy evaluation. Readiness has no
 * staged bytes and no representation grant, so it never uses the full
 * `AuthorizedAttachmentAsset` shape.
 */
export interface AttachmentPolicyAsset {
  readonly originalId: string;
  readonly representationId: string;
  readonly originalKind: AttachmentOriginalKind;
  readonly originalBytes: number;
  readonly modality: AttachmentModality;
  readonly representationBytes: number;
  readonly origin: "direct" | "converted";
  readonly approved: boolean;
  readonly image: { readonly width: number; readonly height: number } | null;
}

export interface AttachmentPolicyResult {
  readonly reasons: readonly AttachmentReason[];
  readonly model: { provider: string; id: string; api: string } | null;
  readonly estimatedTokens: number;
}

/** Supplied by the main-owned authority, never accepted from the renderer. */
export type AuthorizedPlanAsset = AuthorizedAttachmentAsset;

export interface AttachmentPlanInput {
  readonly context: AttachmentPlanContext;
  readonly assets: readonly AuthorizedPlanAsset[];
  readonly text: string;
}

export type AttachmentPlanningResult =
  | { readonly outcome: "blocked"; readonly reasons: readonly AttachmentReason[] }
  | { readonly outcome: "ready"; readonly plan: AttachmentDeliveryPlan };

export interface AttachmentPlannerDeps {
  newId(): string;
  now(): number;
  /** Lowercase SHA-256. The implementation must not log its input. */
  sha256(value: string): string;
}

interface StoredPlan {
  readonly digest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

const DIGEST = /^[0-9a-f]{64}$/;
const PLAN_TTL_MS = 60_000;
const MAX_PLANS = 100;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const KINDS = new Set<AttachmentOriginalKind>([
  "text",
  "image",
  "pdf",
  "word",
  "spreadsheet",
  "presentation",
  "audio",
  "video",
  "other",
]);

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function identifier(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}
/** Structural validation only; callers must separately authenticate ownership/approval. */
export function isAuthorizedAttachmentAsset(value: unknown): value is AuthorizedPlanAsset {
  const asset = value as AuthorizedPlanAsset | null | undefined;
  const source = asset?.original;
  const rep = asset?.representation;
  if (
    !source ||
    !rep ||
    !isAttachmentId(source.id) ||
    !identifier(source.name, 255) ||
    source.name.includes("/") ||
    source.name.includes("\\") ||
    !KINDS.has(source.kind) ||
    !count(source.bytes) ||
    typeof source.sha256 !== "string" ||
    !DIGEST.test(source.sha256) ||
    !isAttachmentId(rep.id) ||
    rep.attachmentId !== source.id ||
    rep.originalSha256 !== source.sha256 ||
    typeof rep.representationSha256 !== "string" ||
    !DIGEST.test(rep.representationSha256) ||
    !count(rep.bytes) ||
    !identifier(rep.preparationVersion, 128) ||
    typeof rep.approved !== "boolean" ||
    !["direct", "converted"].includes(rep.origin) ||
    !["text", "image", "document"].includes(rep.modality) ||
    !Array.isArray(rep.warnings) ||
    rep.warnings.length > 64 ||
    rep.warnings.some((warning) => typeof warning !== "string" || warning.length > 512)
  )
    return false;
  if (
    rep.origin === "converted" &&
    rep.approved &&
    (typeof asset.approvalDigest !== "string" || !DIGEST.test(asset.approvalDigest))
  )
    return false;
  if (
    asset.approvalDigest !== null &&
    (typeof asset.approvalDigest !== "string" || !DIGEST.test(asset.approvalDigest))
  )
    return false;
  if (rep.modality === "image") {
    return (
      rep.bytes > 0 &&
      asset.image !== null &&
      asset.image !== undefined &&
      IMAGE_MIMES.has(asset.image.mime) &&
      count(asset.image.width) &&
      count(asset.image.height) &&
      asset.image.width > 0 &&
      asset.image.height > 0
    );
  }
  return asset.image === null;
}

function contextValid(context: AttachmentPolicyContext): boolean {
  return (
    context !== null &&
    context !== undefined &&
    typeof context.profileKey === "string" &&
    DIGEST.test(context.profileKey) &&
    identifier(context.sessionId) &&
    count(context.sessionEpoch) &&
    (context.branchId === null || identifier(context.branchId)) &&
    identifier(context.revision) &&
    typeof context.idle === "boolean" &&
    typeof context.registeredCommand === "boolean" &&
    (context.historyImageCount === null || count(context.historyImageCount)) &&
    (context.availableContextTokens === null || count(context.availableContextTokens)) &&
    (context.estimatedNewImageTokens === null || count(context.estimatedNewImageTokens)) &&
    (context.estimatedExistingRequestBytes === null || count(context.estimatedExistingRequestBytes))
  );
}

function planContextValid(context: AttachmentPlanContext): boolean {
  return contextValid(context) && isAttachmentId(context.leaseId);
}

function add(reasons: Set<AttachmentReason>, reason: AttachmentReason | null): void {
  if (reason) reasons.add(reason);
}

function originalByteLimit(kind: AttachmentOriginalKind): number {
  if (kind === "text") return ATTACHMENT_LIMITS.textOriginalBytes;
  if (kind === "image") return ATTACHMENT_LIMITS.imageOriginalBytes;
  return ATTACHMENT_LIMITS.documentOriginalBytes;
}

interface Evaluation {
  readonly reasons: readonly AttachmentReason[];
  readonly model: { provider: string; id: string; api: string } | null;
  readonly estimatedTokens: number;
  readonly binding: string | null;
}

/**
 * Pure host-owned eligibility policy over metadata only. Delivery planning and
 * the non-submitting readiness pass share this function, so a file cannot be
 * "ready" in the tray and blocked at dispatch (or vice versa) for a policy
 * reason one path forgot.
 */
export function evaluateAttachmentPolicy(
  context: AttachmentPolicyContext,
  assets: readonly AttachmentPolicyAsset[],
  text: string,
): AttachmentPolicyResult {
  const reasons = new Set<AttachmentReason>();
  if (
    !context ||
    !contextValid(context) ||
    !Array.isArray(assets) ||
    typeof text !== "string" ||
    !isWellFormedAttachmentText(text)
  ) {
    return { reasons: ["unavailable"], model: null, estimatedTokens: 0 };
  }
  if (!context.idle) add(reasons, "busy");
  if (context.registeredCommand) add(reasons, "command_unsupported");
  if (
    context.historyImageCount === null ||
    context.availableContextTokens === null ||
    context.estimatedExistingRequestBytes === null
  )
    add(reasons, "unavailable");
  if (context.historyImageCount !== null && context.historyImageCount > 1_000)
    add(reasons, "image_limit_exceeded");
  if (assets.length === 0 || assets.length > ATTACHMENT_LIMITS.filesPerDraft)
    add(reasons, "too_many_files");
  const textCapability = resolveAttachmentCapability(context.model, "text");
  if (textCapability.state !== "supported") add(reasons, textCapability.reason);
  const hasImages =
    (context.historyImageCount ?? 0) > 0 || assets.some((asset) => asset?.modality === "image");
  const imageCapability = hasImages ? resolveAttachmentCapability(context.model, "image") : null;
  if (imageCapability && imageCapability.state !== "supported")
    add(reasons, imageCapability.reason);
  if (reasons.has("unavailable") || reasons.has("too_many_files")) {
    return {
      reasons: [...reasons],
      model: textCapability.state === "supported" ? textCapability.model : null,
      estimatedTokens: 0,
    };
  }
  const uniqueOriginals = new Set<string>();
  const uniqueRepresentations = new Set<string>();
  let originals = 0;
  let textBytes = 0;
  let encodedImages = 0;
  let imageCount = 0;
  for (const asset of assets) {
    if (!asset || !count(asset.originalBytes) || !count(asset.representationBytes))
      add(reasons, "unavailable");
    if (uniqueOriginals.has(asset.originalId) || uniqueRepresentations.has(asset.representationId))
      add(reasons, "unavailable");
    uniqueOriginals.add(asset.originalId);
    uniqueRepresentations.add(asset.representationId);
    originals += asset.originalBytes;
    add(
      reasons,
      attachmentRepresentationReason({
        originalKind: asset.originalKind,
        modality: asset.modality,
        origin: asset.origin,
        approved: asset.approved,
      }),
    );
    if (asset.originalBytes > originalByteLimit(asset.originalKind))
      add(reasons, "original_too_large");
    if (asset.modality === "text") {
      textBytes += asset.representationBytes;
      if (asset.representationBytes > ATTACHMENT_LIMITS.promptTextBytesPerFile)
        add(reasons, "text_limit_exceeded");
    }
    if (asset.modality === "image" && asset.image) {
      imageCount++;
      const encoded = Math.ceil(asset.representationBytes / 3) * 4;
      encodedImages += encoded;
      const limits = imageCapability?.state === "supported" ? imageCapability.limits : null;
      const maxWidth = Math.min(
        DEFAULT_IMAGE_PREPARATION_LIMITS.maxWidth,
        limits?.maxImageWidth ?? Infinity,
      );
      const maxHeight = Math.min(
        DEFAULT_IMAGE_PREPARATION_LIMITS.maxHeight,
        limits?.maxImageHeight ?? Infinity,
      );
      const maxBytes = Math.min(
        DEFAULT_IMAGE_PREPARATION_LIMITS.maxEncodedBytes,
        limits?.maxImageBytes ?? Infinity,
      );
      if (
        asset.image.width > maxWidth ||
        asset.image.height > maxHeight ||
        encoded > maxBytes ||
        asset.image.width * asset.image.height > ATTACHMENT_LIMITS.imagePixels
      )
        add(reasons, "image_limit_exceeded");
    }
  }
  if (originals > ATTACHMENT_LIMITS.draftOriginalBytes) add(reasons, "draft_too_large");
  if (textBytes > ATTACHMENT_LIMITS.promptTextBytesTotal) add(reasons, "text_limit_exceeded");
  if (encodedImages > ATTACHMENT_LIMITS.imageEncodedBytesTotal)
    add(reasons, "image_limit_exceeded");
  if (imageCapability?.state === "supported") {
    const { maxImagesPerMessage, maxImagesPerRequest } = imageCapability.limits;
    const maxMessage = Math.min(
      maxImagesPerMessage ?? ATTACHMENT_LIMITS.filesPerDraft,
      ATTACHMENT_LIMITS.filesPerDraft,
    );
    const maxRequest = Math.min(
      maxImagesPerRequest ?? ATTACHMENT_LIMITS.filesPerDraft,
      ATTACHMENT_LIMITS.filesPerDraft,
    );
    if (imageCount > maxMessage || imageCount + (context.historyImageCount ?? 0) > maxRequest)
      add(reasons, "image_limit_exceeded");
  }
  if (text.length > 4 * 1024 * 1024)
    return { reasons: ["context_limit_exceeded"], model: null, estimatedTokens: 0 };
  const userBytes = new TextEncoder().encode(text).byteLength;
  // Validated attachment text can double under JSON escaping; arbitrary user
  // text can expand sixfold (e.g. a control byte as an escaped sequence).
  // Reserve per-file envelope/name bytes and estimate one token per UTF-8 byte.
  const estimatedAttachmentTokens = 2 * textBytes + assets.length * 2048;
  const estimatedTextTokens = estimatedAttachmentTokens + 6 * userBytes;
  if (
    userBytes + estimatedAttachmentTokens >
    ATTACHMENT_LIMITS.promptTextBytesTotal + ATTACHMENT_LIMITS.promptTextEstimatedTokens
  ) {
    add(reasons, "text_limit_exceeded");
  }
  if (
    imageCount > 0 &&
    (context.estimatedNewImageTokens === null || context.estimatedNewImageTokens === 0)
  )
    add(reasons, "unavailable");
  let estimatedTokens = estimatedTextTokens;
  if (imageCount > 0) estimatedTokens += context.estimatedNewImageTokens ?? 0;
  if (
    !Number.isSafeInteger(estimatedTokens) ||
    estimatedAttachmentTokens > ATTACHMENT_LIMITS.promptTextEstimatedTokens ||
    estimatedTokens > (context.availableContextTokens ?? 0)
  )
    add(reasons, "context_limit_exceeded");
  const providerMax =
    textCapability.state === "supported" ? textCapability.limits.maxRequestBytes : null;
  const maxRequestBytes = Math.min(
    providerMax ?? ATTACHMENT_LIMITS.estimatedRequestBytes,
    ATTACHMENT_LIMITS.estimatedRequestBytes,
  );
  if (
    context.estimatedExistingRequestBytes !== null &&
    context.estimatedExistingRequestBytes + encodedImages + estimatedTextTokens > maxRequestBytes
  ) {
    add(reasons, "context_limit_exceeded");
  }
  const model = textCapability.state === "supported" ? textCapability.model : null;
  return { reasons: [...reasons], model, estimatedTokens };
}

function toPolicyAsset(asset: AuthorizedPlanAsset): AttachmentPolicyAsset {
  return {
    originalId: asset.original.id,
    representationId: asset.representation.id,
    originalKind: asset.original.kind,
    originalBytes: asset.original.bytes,
    modality: asset.representation.modality,
    representationBytes: asset.representation.bytes,
    origin: asset.representation.origin,
    approved: asset.representation.approved,
    image: asset.image ? { width: asset.image.width, height: asset.image.height } : null,
  };
}

/** Pure preflight over already-authorized records; no content or paths are returned. */
function evaluate(input: AttachmentPlanInput): Evaluation {
  if (
    !input ||
    !planContextValid(input.context) ||
    !Array.isArray(input.assets) ||
    typeof input.text !== "string" ||
    !isWellFormedAttachmentText(input.text)
  ) {
    return { reasons: ["unavailable"], model: null, estimatedTokens: 0, binding: null };
  }
  if (input.assets.some((asset) => !isAuthorizedAttachmentAsset(asset)))
    return { reasons: ["unavailable"], model: null, estimatedTokens: 0, binding: null };
  const { context, assets, text } = input;
  const policy = evaluateAttachmentPolicy(context, assets.map(toPolicyAsset), text);
  const model = policy.model;
  const binding =
    policy.reasons.length === 0 && model
      ? JSON.stringify({
          version: ATTACHMENT_DELIVERY_VERSION,
          profileKey: context.profileKey,
          sessionId: context.sessionId,
          sessionEpoch: context.sessionEpoch,
          branchId: context.branchId,
          revision: context.revision,
          leaseId: context.leaseId,
          idle: context.idle,
          model,
          textCapability: resolveAttachmentCapability(context.model, "text"),
          imageCapability:
            (context.historyImageCount ?? 0) > 0 ||
            assets.some((asset) => asset?.representation?.modality === "image")
              ? resolveAttachmentCapability(context.model, "image")
              : null,
          availableContextTokens: context.availableContextTokens,
          estimatedNewImageTokens: context.estimatedNewImageTokens,
          estimatedExistingRequestBytes: context.estimatedExistingRequestBytes,
          historyImageCount: context.historyImageCount,
          registeredCommand: context.registeredCommand,
          assets: assets.map(({ original, representation, image, approvalDigest }) => ({
            original: {
              id: original.id,
              name: original.name,
              kind: original.kind,
              bytes: original.bytes,
              sha256: original.sha256,
            },
            representation: {
              id: representation.id,
              attachmentId: representation.attachmentId,
              modality: representation.modality,
              origin: representation.origin,
              bytes: representation.bytes,
              originalSha256: representation.originalSha256,
              representationSha256: representation.representationSha256,
              preparationVersion: representation.preparationVersion,
              approved: representation.approved,
              warnings: representation.warnings,
            },
            image: image ? { mime: image.mime, width: image.width, height: image.height } : null,
            approvalDigest,
          })),
          text,
        })
      : null;
  return { reasons: policy.reasons, model, estimatedTokens: policy.estimatedTokens, binding };
}

/**
 * In-memory plan bindings are private to one host instance. Callers MUST obtain
 * freshly authorized records and a live lease again before `isCurrent`, then
 * repeat the idle/model/context check immediately before actual dispatch.
 */
export function createAttachmentPlanner(deps: AttachmentPlannerDeps): {
  plan(input: AttachmentPlanInput): AttachmentPlanningResult;
  isCurrent(id: string, input: AttachmentPlanInput): boolean;
  /** Revalidate and consume synchronously; a plan cannot authorize two sends. */
  consume(id: string, input: AttachmentPlanInput): boolean;
  invalidate(id: string): void;
} {
  const plans = new Map<string, StoredPlan>();
  const now = (): number | null => {
    try {
      const value = deps.now();
      return count(value) ? value : null;
    } catch {
      return null;
    }
  };
  const hash = (value: string): string | null => {
    try {
      const digest = deps.sha256(value);
      return typeof digest === "string" && DIGEST.test(digest) ? digest : null;
    } catch {
      return null;
    }
  };
  const isCurrent = (id: string, input: AttachmentPlanInput): boolean => {
    if (!isAttachmentId(id)) return false;
    const stored = plans.get(id);
    const time = now();
    if (!stored || time === null || time < stored.createdAt || time >= stored.expiresAt) {
      plans.delete(id);
      return false;
    }
    const result = evaluate(input);
    return (
      result.reasons.length === 0 &&
      result.binding !== null &&
      hash(result.binding) === stored.digest
    );
  };
  return {
    plan(input) {
      const result = evaluate(input);
      if (result.reasons.length || !result.binding || !result.model)
        return {
          outcome: "blocked",
          reasons: result.reasons.length ? result.reasons : ["unavailable"],
        };
      const time = now();
      const digest = hash(result.binding);
      if (time === null || time > Number.MAX_SAFE_INTEGER - PLAN_TTL_MS || !digest)
        return { outcome: "blocked", reasons: ["unavailable"] };
      for (const [id, entry] of plans)
        if (time < entry.createdAt || time >= entry.expiresAt) plans.delete(id);
      if (plans.size >= MAX_PLANS) return { outcome: "blocked", reasons: ["unavailable"] };
      let id: string;
      try {
        id = deps.newId();
      } catch {
        return { outcome: "blocked", reasons: ["unavailable"] };
      }
      if (!isAttachmentId(id) || plans.has(id))
        return { outcome: "blocked", reasons: ["unavailable"] };
      plans.set(id, { digest, createdAt: time, expiresAt: time + PLAN_TTL_MS });
      return {
        outcome: "ready",
        plan: {
          version: ATTACHMENT_DELIVERY_VERSION,
          id,
          model: result.model,
          representationIds: input.assets.map((asset) => asset.representation.id),
          estimatedTokens: result.estimatedTokens,
          blockingReasons: [],
        },
      };
    },
    isCurrent,
    consume(id, input) {
      if (!isCurrent(id, input)) return false;
      plans.delete(id);
      return true;
    },
    invalidate(id) {
      plans.delete(id);
    },
  };
}
