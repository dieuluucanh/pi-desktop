import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  isAttachmentReason,
  type AttachmentModelIdentity,
  type AttachmentReason,
} from "../shared/attachments";

/**
 * Strict parser for the host's metadata-only readiness verdict. Main already
 * owns the policy; this module only proves the reply is bounded, correlated to
 * exactly the requested attachment IDs, and composed of known reasons. It never
 * authorizes delivery: `attachments.prompt` revalidates and replans.
 */

export interface AttachmentReadinessVerdict {
  readonly model: AttachmentModelIdentity | null;
  readonly revision: string;
  readonly files: readonly {
    readonly id: string;
    readonly reasons: readonly AttachmentReason[];
  }[];
  readonly reasons: readonly AttachmentReason[];
  readonly estimatedTokens: number;
}

function label(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reasonList(value: unknown): readonly AttachmentReason[] | null {
  if (!Array.isArray(value) || value.length > 16 || !value.every(isAttachmentReason)) return null;
  return Object.freeze([...new Set(value as AttachmentReason[])]);
}

function modelIdentity(value: unknown): AttachmentModelIdentity | null {
  if (value === null) return null;
  const model = record(value);
  if (
    !model ||
    Object.keys(model).length !== 3 ||
    !Object.keys(model).every((key) => ["provider", "id", "api"].includes(key)) ||
    !label(model.provider) ||
    !label(model.id) ||
    !label(model.api)
  )
    return null;
  return { provider: model.provider, id: model.id, api: model.api };
}

export function parseAttachmentReadinessVerdict(
  value: unknown,
  expectedIds: readonly string[],
): AttachmentReadinessVerdict | null {
  const input = record(value);
  const files = input?.files;
  const reasons = reasonList(input?.reasons);
  if (
    !input ||
    Object.keys(input).length !== 5 ||
    !Object.keys(input).every((key) =>
      ["model", "revision", "files", "reasons", "estimatedTokens"].includes(key),
    ) ||
    !label(input.revision) ||
    !reasons ||
    !Number.isSafeInteger(input.estimatedTokens) ||
    Number(input.estimatedTokens) < 0 ||
    !Array.isArray(files) ||
    files.length !== expectedIds.length ||
    files.length > ATTACHMENT_LIMITS.filesPerDraft
  )
    return null;
  const model = modelIdentity(input.model ?? undefined);
  if (input.model !== null && !model) return null;
  const parsed = files.map((value, index) => {
    const file = record(value);
    const fileReasons = reasonList(file?.reasons);
    if (
      !file ||
      Object.keys(file).length !== 2 ||
      !Object.keys(file).every((key) => ["id", "reasons"].includes(key)) ||
      !isAttachmentId(file.id) ||
      file.id !== expectedIds[index] ||
      !fileReasons
    )
      return null;
    return { id: file.id, reasons: fileReasons };
  });
  if (parsed.some((file) => file === null)) return null;
  return {
    model,
    revision: input.revision,
    files: parsed as AttachmentReadinessVerdict["files"],
    reasons,
    estimatedTokens: Number(input.estimatedTokens),
  };
}
