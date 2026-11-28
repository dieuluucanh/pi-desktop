import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { displayRasterDimensions, inspectRaster } from "../../attachments/image";
import { verifyPngInflation } from "../../attachments/png-inflate";
import { DEFAULT_IMAGE_PREPARATION_LIMITS } from "../../attachments/prepare-image";
import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  isWellFormedAttachmentText,
  resolveAttachmentCapability,
  type AttachmentAttemptId,
  type AttachmentDeliveryScope,
  type AttachmentPlanId,
  type AttachmentModelIdentity,
  type AttachmentPromptResult,
  type AttachmentReason,
  type AttachmentTurnId,
  type AuthorizedAttachmentAsset,
} from "../../shared/attachments";
import {
  appendAttachmentSubmissionAssociation,
  findPersistedUserEntry,
} from "./attachment-submission";

export type SdkAttachmentSession = Pick<
  AgentSession,
  "prompt" | "model" | "isIdle" | "settingsManager" | "subscribe" | "sessionManager"
>;

export interface MaterializedSdkImage {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Digest from the authenticated plan, not one calculated from caller bytes. */
  readonly representationSha256: string;
}

export interface SdkAttachmentDispatch {
  readonly session: SdkAttachmentSession;
  readonly turnId: AttachmentTurnId;
  readonly attemptId: AttachmentAttemptId;
  readonly planId: AttachmentPlanId;
  readonly sourceTextSha256: string;
  readonly scope: AttachmentDeliveryScope;
  readonly assets: readonly AuthorizedAttachmentAsset[];
  readonly expectedModel: AttachmentModelIdentity;
  /** The complete text, including the already-framed text representations. */
  readonly text: string;
  /** Already authorized, digest-verified host-local representations. */
  readonly images: readonly MaterializedSdkImage[];
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Recheck and consume the plan immediately before dispatch. */
  revalidate(): Promise<boolean>;
  /** Synchronous live authority check immediately before invoking the SDK. */
  isCurrent(): boolean;
  /** Emits a generic notice only; do not log source paths or content. */
  onLateFailure?(): void;
}

/**
 * How long to wait for Pi's public preflight disposition plus the persisted user
 * entry. This is a dispatch/acknowledgement bound, never a run-duration bound:
 * once the entry is durable the handler returns and the agent run continues.
 */
const DEFAULT_ACKNOWLEDGEMENT_MS = 10_000;
const PERSISTENCE_POLL_MS = 10;
const PERSISTENCE_WINDOW_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modelMatches(session: SdkAttachmentSession, expected: AttachmentModelIdentity): boolean {
  const actual = session.model;
  return (
    actual !== undefined &&
    actual.provider === expected.provider &&
    actual.id === expected.id &&
    actual.api === expected.api
  );
}

function blockedResult(
  input: Pick<SdkAttachmentDispatch, "turnId" | "attemptId">,
  reasons: readonly AttachmentReason[],
): AttachmentPromptResult {
  return { outcome: "blocked", reasons, turnId: input.turnId, attemptId: input.attemptId };
}

function uncertainResult(
  input: Pick<SdkAttachmentDispatch, "turnId" | "attemptId">,
): AttachmentPromptResult {
  return { outcome: "uncertain", turnId: input.turnId, attemptId: input.attemptId };
}

/**
 * Validate the transport shape and the Desktop safety rules that still apply.
 * Provider APIs are not allowlisted: plain text and images use Pi's public
 * prompt contract, and trusted extension transformations are native semantics.
 */
function sdkReady(input: SdkAttachmentDispatch): AttachmentPromptResult | null {
  const { session, expectedModel, images } = input;
  if (
    !isAttachmentId(input.turnId) ||
    !isAttachmentId(input.attemptId) ||
    !isAttachmentId(input.planId) ||
    typeof input.sourceTextSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.sourceTextSha256) ||
    typeof input.text !== "string" ||
    !isWellFormedAttachmentText(input.text) ||
    !Array.isArray(images) ||
    !Array.isArray(input.assets) ||
    input.assets.length === 0 ||
    input.assets.length > ATTACHMENT_LIMITS.filesPerDraft ||
    typeof input.revalidate !== "function" ||
    typeof input.isCurrent !== "function" ||
    typeof session.subscribe !== "function" ||
    typeof session.sessionManager?.getEntryCount !== "function" ||
    typeof session.sessionManager?.appendCustomEntry !== "function"
  ) {
    return blockedResult(input, ["unavailable"]);
  }
  const imageAssetCount = input.assets.filter(
    (asset) => asset.representation?.modality === "image",
  ).length;
  if (imageAssetCount !== images.length) return blockedResult(input, ["unavailable"]);
  const maxText =
    ATTACHMENT_LIMITS.promptTextBytesTotal + ATTACHMENT_LIMITS.promptTextEstimatedTokens;
  if (input.text.length > maxText || new TextEncoder().encode(input.text).byteLength > maxText) {
    return blockedResult(input, ["text_limit_exceeded"]);
  }
  if (images.length === 0 && input.text.trim().length === 0)
    return blockedResult(input, ["unavailable"]);
  if (session.isIdle !== true) return blockedResult(input, ["busy"]);
  if (!modelMatches(session, expectedModel)) return blockedResult(input, ["stale_plan"]);
  const textCapability = resolveAttachmentCapability(session.model, "text");
  if (textCapability.state !== "supported") return blockedResult(input, [textCapability.reason]);
  if (images.length) {
    const capability = resolveAttachmentCapability(session.model, "image");
    if (capability.state !== "supported") return blockedResult(input, [capability.reason]);
    // `blockImages` is an explicit user setting. Native auto-resize is allowed:
    // Pi normalizes images through its public prompt path like terminal Pi.
    if (session.settingsManager.getBlockImages() === true) {
      return blockedResult(input, ["image_pipeline_unsafe"]);
    }
  }
  return null;
}

function snapshotDispatch(input: SdkAttachmentDispatch): SdkAttachmentDispatch | null {
  let encodedTotal = 0;
  for (const image of input.images) {
    if (
      !(image?.bytes instanceof Uint8Array) ||
      image.bytes.length === 0 ||
      image.bytes.length > ATTACHMENT_LIMITS.imageOriginalBytes ||
      typeof image.representationSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(image.representationSha256)
    )
      return null;
    encodedTotal += Math.ceil(image.bytes.length / 3) * 4;
    if (encodedTotal > ATTACHMENT_LIMITS.imageEncodedBytesTotal) return null;
  }
  return {
    ...input,
    expectedModel: { ...input.expectedModel },
    images: input.images.map((image) => ({
      mimeType: image.mimeType,
      representationSha256: image.representationSha256,
      bytes: new Uint8Array(image.bytes),
    })),
  };
}

function capabilityFingerprint(input: SdkAttachmentDispatch): string {
  return JSON.stringify({
    text: resolveAttachmentCapability(input.session.model, "text"),
    image: input.images.length ? resolveAttachmentCapability(input.session.model, "image") : null,
  });
}

async function prepareSdkImages(input: SdkAttachmentDispatch): Promise<ImageContent[] | null> {
  const model = resolveAttachmentCapability(input.session.model, "image");
  if (input.images.length && model.state !== "supported") return null;
  const limits = model.state === "supported" ? model.limits : null;
  const maximumWidth = Math.min(
    DEFAULT_IMAGE_PREPARATION_LIMITS.maxWidth,
    limits?.maxImageWidth ?? Infinity,
  );
  const maximumHeight = Math.min(
    DEFAULT_IMAGE_PREPARATION_LIMITS.maxHeight,
    limits?.maxImageHeight ?? Infinity,
  );
  const maximumBytes = Math.min(
    DEFAULT_IMAGE_PREPARATION_LIMITS.maxEncodedBytes,
    limits?.maxImageBytes ?? Infinity,
  );
  const output: ImageContent[] = [];
  let total = 0;
  for (const item of input.images) {
    if (
      !(item?.bytes instanceof Uint8Array) ||
      item.bytes.length === 0 ||
      item.bytes.length > ATTACHMENT_LIMITS.imageOriginalBytes
    )
      return null;
    // Copy first so another owner cannot change bytes while PNG validation awaits.
    const bytes = new Uint8Array(item.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== item.representationSha256) return null;
    const image = inspectRaster(bytes);
    const display = displayRasterDimensions(image);
    const encoded = Math.ceil(bytes.length / 3) * 4;
    if (
      image.mime !== item.mimeType ||
      image.width > maximumWidth ||
      image.height > maximumHeight ||
      display.width > maximumWidth ||
      display.height > maximumHeight ||
      encoded > maximumBytes
    )
      return null;
    if (image.mime === "image/png") await verifyPngInflation(image);
    total += encoded;
    if (total > ATTACHMENT_LIMITS.imageEncodedBytesTotal) return null;
    output.push({
      type: "image",
      mimeType: image.mime,
      data: Buffer.from(bytes).toString("base64"),
    });
  }
  if (
    limits?.maxImagesPerMessage !== null &&
    limits?.maxImagesPerMessage !== undefined &&
    output.length > limits.maxImagesPerMessage
  )
    return null;
  return output;
}

/**
 * Invoke Pi through the public prompt contract after revalidating the host plan.
 *
 * Acceptance is `preflightResult("started")` plus a persisted, associated user
 * entry — not the end of the agent run and not a provider-receipt claim. The
 * handler returns at that boundary, so a long run or tool continuation does not
 * depend on the staging lease. `handled` keeps the draft; a missing
 * acknowledgement remains `uncertain` and is never retried automatically.
 */
export async function dispatchSdkAttachments(
  input: SdkAttachmentDispatch,
): Promise<AttachmentPromptResult> {
  let blocked: AttachmentPromptResult | null;
  try {
    blocked = sdkReady(input);
  } catch {
    return blockedResult(input, ["unavailable"]);
  }
  if (blocked) return blocked;
  let safe: SdkAttachmentDispatch | null;
  let fingerprint: string;
  try {
    safe = snapshotDispatch(input);
    if (!safe) return blockedResult(input, ["image_limit_exceeded"]);
    fingerprint = capabilityFingerprint(safe);
  } catch {
    return blockedResult(input, ["unavailable"]);
  }
  let images: ImageContent[] | null;
  try {
    images = await prepareSdkImages(safe);
  } catch {
    images = null;
  }
  if (!images) return blockedResult(safe, ["image_limit_exceeded"]);
  try {
    if (!(await safe.revalidate())) return blockedResult(safe, ["stale_plan"]);
  } catch {
    return blockedResult(safe, ["unavailable"]);
  }
  try {
    blocked = sdkReady(safe);
    if (!blocked && capabilityFingerprint(safe) !== fingerprint)
      blocked = blockedResult(safe, ["stale_plan"]);
  } catch {
    return blockedResult(safe, ["unavailable"]);
  }
  if (blocked) return blocked;

  const text = safe.text.trim().length ? safe.text : "Please consider the attached files.";
  const now = safe.now ?? Date.now;
  const sleep =
    safe.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let baselineEntryCount: number;
  try {
    baselineEntryCount = safe.session.sessionManager.getEntryCount();
  } catch {
    return blockedResult(safe, ["unavailable"]);
  }

  return new Promise<AttachmentPromptResult>((resolve) => {
    let settled = false;
    let handled = false;
    let multipleUserEntries = false;
    let persistedMessage: unknown = null;
    let association: ReturnType<typeof appendAttachmentSubmissionAssociation> = null;
    let persistence: Promise<void> | null = null;
    let notified = false;
    let unsubscribe: (() => void) | null = null;
    let deadlineTimer: (() => void) | null = null;

    const finish = (result: AttachmentPromptResult): void => {
      if (settled) return;
      settled = true;
      deadlineTimer?.();
      deadlineTimer = null;
      unsubscribe?.();
      resolve(result);
    };
    const notice = (): void => {
      if (notified) return;
      notified = true;
      try {
        safe!.onLateFailure?.();
      } catch {
        /* Notices cannot turn a safe failure into an unhandled rejection. */
      }
    };

    // Persist the association for the correlated user entry, then report
    // acceptance without waiting for the run to settle.
    const attachAssociation = async (message: unknown): Promise<void> => {
      try {
        const deadline = now() + PERSISTENCE_WINDOW_MS;
        for (;;) {
          const entry = findPersistedUserEntry(safe!.session, baselineEntryCount, message);
          if (entry) {
            association = appendAttachmentSubmissionAssociation(safe!.session, {
              planId: safe!.planId,
              turnId: safe!.turnId,
              attemptId: safe!.attemptId,
              sourceTextSha256: safe!.sourceTextSha256,
              scope: safe!.scope,
              text,
              images,
              assets: safe!.assets,
              userEntryId: entry.id,
              createdAt: now(),
              // Trusted extensions may rewrite text/images before persistence;
              // record what Pi actually stored instead of guessing.
              allowTransformedContent: true,
            });
            break;
          }
          const current = now();
          if (!Number.isSafeInteger(current) || current >= deadline) break;
          await sleep(Math.min(PERSISTENCE_POLL_MS, deadline - current));
        }
      } catch {
        association = null;
      }
      if (settled) return;
      if (association) {
        finish({
          outcome: "accepted",
          turnId: safe!.turnId,
          attemptId: safe!.attemptId,
          userEntryId: association.metadata.userEntryId,
          associationEntryId: association.associationEntryId,
        });
        return;
      }
      notice();
      finish(uncertainResult(safe!));
    };

    const deadlineAt = now() + DEFAULT_ACKNOWLEDGEMENT_MS;
    try {
      const remaining = Math.max(0, deadlineAt - now());
      const timer = setTimeout(() => {
        // The prompt may still be deferred inside the SDK; keep the draft and
        // report uncertainty rather than claiming acceptance or destroying the
        // session.
        if (persistedMessage !== null && persistence === null) {
          persistence = attachAssociation(persistedMessage);
        }
        notice();
        finish(uncertainResult(safe!));
      }, remaining);
      deadlineTimer = () => clearTimeout(timer);
    } catch {
      return finish(blockedResult(safe, ["unavailable"]));
    }

    try {
      unsubscribe = safe.session.subscribe((event: { type: string; [key: string]: unknown }) => {
        if (event.type === "message_end" && record(event.message)?.role === "user") {
          if (persistedMessage !== null && persistedMessage !== event.message) {
            multipleUserEntries = true;
            return;
          }
          persistedMessage = event.message;
          persistence ??= attachAssociation(event.message);
        }
      });
    } catch {
      return finish(blockedResult(safe, ["unavailable"]));
    }

    let promptRun: Promise<void>;
    try {
      promptRun = safe.session.prompt(text, {
        source: "rpc",
        expandPromptTemplates: false,
        ...(images.length ? { images } : {}),
        preflightResult: (disposition) => {
          if (settled) return;
          if (disposition === "handled") {
            handled = true;
            finish({ outcome: "handled", turnId: safe!.turnId, attemptId: safe!.attemptId });
          } else if (disposition === "started") {
            // Acceptance is still gated on durable association; a deferred
            // persistence promise reports through `attachAssociation`.
            if (!safe!.isCurrent()) {
              notice();
              persistence ??= Promise.resolve();
            }
          }
          // A surprise `queued` is not idle-only delivery: fall through to the
          // bounded acknowledgement/association and never claim success here.
        },
      });
    } catch {
      notice();
      return finish(uncertainResult(safe));
    }

    void promptRun.then(
      () => {
        // `prompt()` resolves after the run, not at acceptance. If we already
        // returned at preflight/persistence this is a no-op.
        if (settled) return;
        if (handled) {
          finish({ outcome: "handled", turnId: safe!.turnId, attemptId: safe!.attemptId });
          return;
        }
        if (multipleUserEntries) {
          notice();
          finish(uncertainResult(safe!));
          return;
        }
        if (persistedMessage !== null) {
          persistence ??= attachAssociation(persistedMessage);
          return;
        }
        // No disposition and no persisted entry: the prompt may have been
        // deferred or dropped. That is ambiguity, not a definitive refusal.
        notice();
        finish(uncertainResult(safe!));
      },
      () => {
        if (settled) return;
        if (handled) {
          finish({ outcome: "handled", turnId: safe!.turnId, attemptId: safe!.attemptId });
          return;
        }
        notice();
        // The SDK was invoked; do not claim acceptance without an association.
        finish(uncertainResult(safe!));
      },
    );
  });
}
