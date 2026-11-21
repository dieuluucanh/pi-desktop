import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_SUBMISSION_CUSTOM_TYPE,
  isAttachmentId,
  validateAttachmentSubmissionMetadata,
  type AttachmentDeliveryScope,
  type AttachmentSubmissionAssociation,
  type AttachmentSubmissionImageDigest,
  type AttachmentSubmissionMetadata,
  type AttachmentSubmissionRepresentation,
  type AuthorizedAttachmentAsset,
} from "../../shared/attachments";

export type AttachmentSubmissionSession = Pick<AgentSession, "sessionManager">;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function imageDigests(message: unknown): Array<{ mimeType: string; sha256: string }> | null {
  const value = record(message);
  if (!value || value.role !== "user" || !Array.isArray(value.content)) return null;
  const images: Array<{ mimeType: string; sha256: string }> = [];
  for (const item of value.content) {
    const block = record(item);
    if (!block) return null;
    if (block.type === "text" && typeof block.text === "string") continue;
    if (
      block.type !== "image" ||
      typeof block.mimeType !== "string" ||
      typeof block.data !== "string" ||
      block.data.length === 0
    )
      return null;
    const bytes = Buffer.from(block.data, "base64");
    if (bytes.toString("base64") !== block.data) return null;
    images.push({ mimeType: block.mimeType, sha256: sha256(bytes) });
  }
  return images;
}

export function messageMatchesSubmission(
  message: unknown,
  text: string,
  expectedImages: readonly ImageContent[],
): boolean {
  const value = record(message);
  if (!value || value.role !== "user" || !Array.isArray(value.content)) return false;
  const textBlocks: string[] = [];
  const imageBlocks: Array<{ mimeType: string; data: string }> = [];
  let sawImage = false;
  for (const item of value.content) {
    const block = record(item);
    if (!block) return false;
    if (block.type === "text" && typeof block.text === "string") {
      if (sawImage) return false;
      textBlocks.push(block.text);
    } else if (
      block.type === "image" &&
      typeof block.mimeType === "string" &&
      typeof block.data === "string"
    ) {
      sawImage = true;
      imageBlocks.push({ mimeType: block.mimeType, data: block.data });
    } else {
      return false;
    }
  }
  return (
    textBlocks.length === 1 &&
    textBlocks[0] === text &&
    imageBlocks.length === expectedImages.length &&
    imageBlocks.every(
      (image, index) =>
        image.mimeType === expectedImages[index]?.mimeType &&
        image.data === expectedImages[index]?.data,
    )
  );
}

/**
 * Read the SDK's append-only entries after a message_end event. The event itself
 * is only a wake-up signal: acceptance requires the exact message object to be
 * present in SessionManager's persisted entries.
 */
export function findPersistedUserEntry(
  session: AttachmentSubmissionSession,
  baselineEntryCount: number,
  message: unknown,
): { readonly id: string; readonly message: unknown } | null {
  try {
    const entries = session.sessionManager.getEntries();
    const newEntries = entries.slice(baselineEntryCount);
    const matches = newEntries.filter((candidate) => {
      const entry = record(candidate);
      return (
        entry?.type === "message" &&
        typeof entry.id === "string" &&
        entry.message === message &&
        record(entry.message)?.role === "user"
      );
    });
    if (matches.length !== 1) return null;
    const entry = record(matches[0]);
    return entry && typeof entry.id === "string" ? { id: entry.id, message: entry.message } : null;
  } catch {
    return null;
  }
}

interface DeliveredUserContent {
  readonly text: string;
  readonly images: AttachmentSubmissionImageDigest[];
}

/**
 * Read the persisted user content that Pi actually stored. This is the
 * authoritative delivered representation: trusted extensions may rewrite the
 * text or image set before persistence, and the association must describe what
 * is really in history rather than what the plan hoped to send.
 */
function readDeliveredUserContent(message: unknown): DeliveredUserContent | null {
  const value = record(message);
  if (!value || value.role !== "user") return null;
  const images: AttachmentSubmissionImageDigest[] = [];
  let textBlocks: string[] = [];
  let sawImage = false;
  if (typeof value.content === "string") {
    textBlocks = [value.content];
  } else if (Array.isArray(value.content) && value.content.length > 0) {
    for (const item of value.content) {
      const block = record(item);
      if (!block) return null;
      if (block.type === "text" && typeof block.text === "string") {
        if (sawImage) return null;
        textBlocks.push(block.text);
      } else if (
        block.type === "image" &&
        typeof block.mimeType === "string" &&
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType) &&
        typeof block.data === "string" &&
        block.data.length > 0
      ) {
        const bytes = Buffer.from(block.data, "base64");
        if (bytes.length === 0 || bytes.toString("base64") !== block.data) return null;
        sawImage = true;
        images.push({ mimeType: block.mimeType, sha256: sha256(bytes) });
      } else {
        return null;
      }
    }
  } else {
    return null;
  }
  if (textBlocks.length !== 1) return null;
  if (images.length > ATTACHMENT_LIMITS.filesPerDraft) return null;
  return { text: textBlocks[0]!, images };
}

export function appendAttachmentSubmissionAssociation(
  session: AttachmentSubmissionSession,
  input: {
    readonly planId: string;
    readonly turnId: string;
    readonly attemptId: string;
    readonly sourceTextSha256: string;
    readonly scope: AttachmentDeliveryScope;
    readonly text: string;
    readonly images: readonly ImageContent[];
    readonly assets: readonly AuthorizedAttachmentAsset[];
    readonly userEntryId: string;
    readonly createdAt: number;
    /**
     * Accept content that trusted SDK extensions rewrote before persistence.
     * The association then records the delivered text/image digests, while the
     * approved representation provenance stays bound to the plan.
     */
    readonly allowTransformedContent?: boolean;
  },
): AttachmentSubmissionAssociation | null {
  if (
    !isAttachmentId(input.planId) ||
    !isAttachmentId(input.turnId) ||
    !isAttachmentId(input.attemptId) ||
    !/^[0-9a-f]{64}$/.test(input.sourceTextSha256)
  )
    return null;
  const manager = session.sessionManager;
  const userEntry = manager.getEntries().find((entry) => {
    const candidate = record(entry);
    return candidate?.id === input.userEntryId && candidate.type === "message";
  });
  if (!userEntry || record(userEntry)?.id !== input.userEntryId || manager.isPersisted() !== true)
    return null;
  const persistedMessage = record(userEntry)?.message;
  const delivered = readDeliveredUserContent(persistedMessage);
  if (!delivered) return null;
  const exact = messageMatchesSubmission(persistedMessage, input.text, input.images);
  if (!exact && input.allowTransformedContent !== true) return null;
  const representations: AttachmentSubmissionRepresentation[] = [];
  for (const asset of input.assets) {
    const modality = asset.representation.modality;
    if ((modality !== "text" && modality !== "image") || asset.original.kind !== modality)
      return null;
    representations.push({
      representationId: asset.representation.id,
      representationSha256: asset.representation.representationSha256,
      originalId: asset.original.id,
      originalSha256: asset.original.sha256,
      modality,
      display: {
        name: asset.original.name,
        originalKind: modality,
        originalBytes: asset.original.bytes,
        representationBytes: asset.representation.bytes,
        origin: asset.representation.origin,
        preparationVersion: asset.representation.preparationVersion,
        warnings: [...asset.representation.warnings],
        coverage: { kind: "entire-file" },
        image: asset.image
          ? { mime: asset.image.mime, width: asset.image.width, height: asset.image.height }
          : null,
      },
    });
  }
  const metadata: AttachmentSubmissionMetadata = {
    version: 1,
    planId: input.planId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    scope: { ...input.scope },
    sourceTextSha256: input.sourceTextSha256,
    userEntryId: input.userEntryId,
    // Delivered content, not necessarily the planned text/images.
    textSha256: sha256(delivered.text),
    images: delivered.images,
    representations,
    createdAt: input.createdAt,
  };
  const checked = validateAttachmentSubmissionMetadata(metadata);
  if (!checked) return null;
  const associationEntryId = manager.appendCustomEntry(ATTACHMENT_SUBMISSION_CUSTOM_TYPE, checked);
  const associationEntry = manager.getEntries().find((entry) => {
    const candidate = record(entry);
    return (
      candidate?.id === associationEntryId &&
      candidate.customType === ATTACHMENT_SUBMISSION_CUSTOM_TYPE
    );
  });
  const associationRecord = record(associationEntry);
  if (
    manager.isPersisted() !== true ||
    !associationRecord ||
    !isDeepStrictEqual(associationRecord.data, checked)
  )
    return null;
  return { metadata: checked, associationEntryId };
}

export interface AttachmentSubmissionHistoryRecord {
  readonly association: AttachmentSubmissionAssociation;
  readonly message: unknown;
}

/** Bound for the renderer's transcript projection, not for recovery. */
const MAX_TRANSCRIPT_HISTORY_RECORDS = 512;

/**
 * Read validated SDK associations.
 *
 * `branch` is the bounded display/transcript view: it only contains entries on
 * the active branch. `all` is the recovery/reconciliation view: an asset may
 * still be referenced by another live branch, so dropping older entries here
 * would make retention unsafe. Scope and content digests are revalidated in
 * both modes; this function never trusts a stored association by ID alone.
 */
export function readAttachmentSubmissionHistory(
  session: AttachmentSubmissionSession,
  scope: "branch" | "all" = "branch",
): readonly AttachmentSubmissionHistoryRecord[] {
  try {
    const entries =
      scope === "all" ? session.sessionManager.getEntries() : session.sessionManager.getBranch();
    const byId = new Map<string, unknown>();
    for (const entry of entries) {
      const candidate = record(entry);
      if (candidate && typeof candidate.id === "string") byId.set(candidate.id, entry);
    }
    const output: AttachmentSubmissionHistoryRecord[] = [];
    for (const entry of entries) {
      const candidate = record(entry);
      if (
        !candidate ||
        candidate.type !== "custom" ||
        candidate.customType !== ATTACHMENT_SUBMISSION_CUSTOM_TYPE ||
        typeof candidate.id !== "string"
      )
        continue;
      const metadata = validateAttachmentSubmissionMetadata(candidate.data);
      if (!metadata) continue;
      // A Pi fork/clone copies entries verbatim and gets a new session id, while
      // the association keeps the original scope. Recovery and display therefore
      // validate structure, entry identity and content digests, not the current
      // session id; ownership is granted separately by main (plan step 12) from
      // app-owned journal evidence, never from this host read alone.
      const userEntry = record(byId.get(metadata.userEntryId));
      if (
        userEntry?.type !== "message" ||
        (!messageMatchesSubmission(userEntry.message, "", []) &&
          !messageMatchesPersistedDigests(userEntry.message, metadata))
      )
        continue;
      output.push({
        association: { metadata, associationEntryId: candidate.id },
        message: userEntry.message,
      });
      if (scope === "branch" && output.length > MAX_TRANSCRIPT_HISTORY_RECORDS) output.shift();
    }
    return output;
  } catch {
    return [];
  }
}

export function readAttachmentSubmissionAssociations(
  session: AttachmentSubmissionSession,
): readonly AttachmentSubmissionAssociation[] {
  // Recovery must include every live branch, not only the active transcript.
  return readAttachmentSubmissionHistory(session, "all").map((record) => record.association);
}

function messageMatchesPersistedDigests(
  message: unknown,
  metadata: AttachmentSubmissionMetadata,
): boolean {
  const value = record(message);
  if (!value || value.role !== "user" || !Array.isArray(value.content)) return false;
  const textBlocks: string[] = [];
  let sawImage = false;
  for (const item of value.content) {
    const block = record(item);
    if (!block) return false;
    if (block.type === "text" && typeof block.text === "string") {
      if (sawImage) return false;
      textBlocks.push(block.text);
    } else if (
      block.type === "image" &&
      typeof block.mimeType === "string" &&
      typeof block.data === "string"
    ) {
      sawImage = true;
    } else {
      return false;
    }
  }
  const images = imageDigests(message);
  return (
    textBlocks.length === 1 &&
    sha256(textBlocks[0]!) === metadata.textSha256 &&
    images !== null &&
    isDeepStrictEqual(images, metadata.images)
  );
}
