import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  isWellFormedAttachmentText,
  sameAttachmentRepresentations,
  validateAttachmentSubmissionMetadata,
  type AttachmentAttemptId,
  type AttachmentDeliveryScope,
  type AttachmentPromptResult,
  type AttachmentReason,
  type AttachmentSubmissionAssociation,
  type AttachmentSubmissionImageDigest,
  type AttachmentSubmissionRepresentation,
  type AttachmentTurnId,
  type AuthorizedAttachmentAsset,
} from "../shared/attachments";

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 2_000;
const MAX_ASSOCIATIONS = MAX_JOURNAL_ENTRIES;
const ENTRY_STATES = ["dispatching", "accepted", "handled", "blocked", "uncertain"] as const;
const ATTACHMENT_REASONS: readonly AttachmentReason[] = [
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

export type AttachmentSubmissionJournalState = (typeof ENTRY_STATES)[number];

/** No source text, file bytes, paths, or provider payloads are journaled. */
export interface AttachmentSubmissionJournalEntry {
  readonly version: 1;
  readonly planId: string;
  readonly turnId: AttachmentTurnId;
  readonly attemptId: AttachmentAttemptId;
  readonly scope: AttachmentDeliveryScope;
  readonly sourceTextSha256: string;
  readonly images: readonly AttachmentSubmissionImageDigest[];
  readonly representations: readonly AttachmentSubmissionRepresentation[];
  readonly retryOfAttemptId: AttachmentAttemptId | null;
  readonly state: AttachmentSubmissionJournalState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result: AttachmentPromptResult | null;
}

export interface AttachmentSubmissionJournalIo {
  /** Returns null only when the file does not exist; other errors must reject. */
  readText(path: string): Promise<string | null>;
  /** Writes and fsyncs a same-directory temporary file, then atomically replaces path. */
  writeAtomic(path: string, contents: string): Promise<void>;
}

export interface AttachmentSubmissionJournalBeginInput {
  readonly planId: string;
  readonly turnId: AttachmentTurnId;
  readonly attemptId: AttachmentAttemptId;
  readonly scope: AttachmentDeliveryScope;
  /** Hashed immediately; the original text is never persisted. */
  readonly sourceText: string;
  readonly assets: readonly AuthorizedAttachmentAsset[];
  /** Set only for an explicit user decision to retry a blocked/handled/uncertain turn. */
  readonly explicitRetry?: boolean;
}

export type AttachmentSubmissionJournalBeginResult =
  | { readonly kind: "dispatch"; readonly entry: AttachmentSubmissionJournalEntry }
  | { readonly kind: "existing"; readonly entry: AttachmentSubmissionJournalEntry }
  | { readonly kind: "conflict" };

export interface AttachmentSubmissionJournal {
  begin(
    input: AttachmentSubmissionJournalBeginInput,
  ): Promise<AttachmentSubmissionJournalBeginResult>;
  complete(
    turnId: AttachmentTurnId,
    attemptId: AttachmentAttemptId,
    result: AttachmentPromptResult,
    proof?: AttachmentSubmissionAssociation,
  ): Promise<AttachmentSubmissionJournalEntry>;
  reconcile(
    liveScope: AttachmentDeliveryScope,
    associations: unknown,
  ): Promise<readonly AttachmentSubmissionJournalEntry[]>;
  get(
    turnId: AttachmentTurnId,
    attemptId: AttachmentAttemptId,
  ): Promise<AttachmentSubmissionJournalEntry | null>;
  list(): Promise<readonly AttachmentSubmissionJournalEntry[]>;
}

export class AttachmentSubmissionJournalError extends Error {
  constructor() {
    super("attachment submission journal is unavailable or invalid");
    this.name = "AttachmentSubmissionJournalError";
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function ensureJournalDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("attachment journal directory is not a safe directory");
  }
}

/** Node filesystem adapter; journal logic and tests depend only on the injected port. */
export function createNodeAttachmentSubmissionJournalIo(): AttachmentSubmissionJournalIo {
  return {
    async readText(path) {
      let pathInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        pathInfo = await lstat(path);
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return null;
        throw error;
      }
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
        throw new Error("attachment journal is not a regular file");
      }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > MAX_JOURNAL_BYTES) {
          throw new Error("attachment journal is not a bounded regular file");
        }
        const bytes = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== info.size) throw new Error("attachment journal changed while reading");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      } finally {
        await handle.close();
      }
    },
    async writeAtomic(path, contents) {
      const directory = dirname(path);
      await ensureJournalDirectory(directory);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(contents, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        // Directory fsync makes the rename durable on filesystems that support it.
        if (process.platform !== "win32") {
          const directoryHandle = await open(directory, constants.O_RDONLY);
          try {
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }
        }
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function label(value: unknown, max = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function validScope(value: unknown): value is AttachmentDeliveryScope {
  const scope = record(value);
  return (
    !!scope &&
    exactKeys(scope, [
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
    ]) &&
    isAttachmentId(scope.authorityId) &&
    isAttachmentId(scope.leaseId) &&
    typeof scope.profileKey === "string" &&
    /^[0-9a-f]{64}$/.test(scope.profileKey) &&
    label(scope.tabId, 128) &&
    isAttachmentId(scope.draftId) &&
    Number.isSafeInteger(scope.hostGeneration) &&
    Number(scope.hostGeneration) >= 0 &&
    Number.isSafeInteger(scope.processGeneration) &&
    Number(scope.processGeneration) > 0 &&
    label(scope.sessionId) &&
    Number.isSafeInteger(scope.sessionEpoch) &&
    Number(scope.sessionEpoch) > 0 &&
    (scope.branchId === null || label(scope.branchId)) &&
    label(scope.revision)
  );
}

function validImages(value: unknown): AttachmentSubmissionImageDigest[] | null {
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.filesPerDraft) return null;
  const images = value.map((item) => {
    const image = record(item);
    if (
      !image ||
      !exactKeys(image, ["mimeType", "sha256"]) ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(image.mimeType)) ||
      typeof image.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(image.sha256)
    )
      return null;
    return { mimeType: image.mimeType as string, sha256: image.sha256 };
  });
  return images.some((image) => image === null)
    ? null
    : (images as AttachmentSubmissionImageDigest[]);
}

function validRepresentations(value: unknown): AttachmentSubmissionRepresentation[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > ATTACHMENT_LIMITS.filesPerDraft)
    return null;
  const representations = value.map((item) => {
    const representation = record(item);
    if (
      !representation ||
      !exactKeys(representation, [
        "representationId",
        "representationSha256",
        "originalId",
        "originalSha256",
        "modality",
      ]) ||
      !isAttachmentId(representation.representationId) ||
      typeof representation.representationSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(representation.representationSha256) ||
      !isAttachmentId(representation.originalId) ||
      typeof representation.originalSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(representation.originalSha256) ||
      (representation.modality !== "text" && representation.modality !== "image")
    )
      return null;
    return {
      representationId: representation.representationId,
      representationSha256: representation.representationSha256,
      originalId: representation.originalId,
      originalSha256: representation.originalSha256,
      modality: representation.modality,
    };
  });
  if (
    representations.some((item) => item === null) ||
    new Set(representations.map((item) => item?.representationId)).size !== representations.length
  )
    return null;
  return representations as AttachmentSubmissionRepresentation[];
}

function validEntryId(value: unknown): value is string {
  return label(value);
}

function parseResult(
  value: unknown,
  turnId: string,
  attemptId: string,
): AttachmentPromptResult | null {
  const result = record(value);
  if (!result || result.turnId !== turnId || result.attemptId !== attemptId) return null;
  if (
    result.outcome === "accepted" &&
    exactKeys(result, ["outcome", "turnId", "attemptId", "userEntryId", "associationEntryId"])
  ) {
    if (!validEntryId(result.userEntryId) || !validEntryId(result.associationEntryId)) return null;
    return {
      outcome: "accepted",
      turnId,
      attemptId,
      userEntryId: result.userEntryId,
      associationEntryId: result.associationEntryId,
    };
  }
  if (
    (result.outcome === "handled" || result.outcome === "uncertain") &&
    exactKeys(result, ["outcome", "turnId", "attemptId"])
  ) {
    return result.outcome === "handled"
      ? { outcome: "handled", turnId, attemptId }
      : { outcome: "uncertain", turnId, attemptId };
  }
  if (
    result.outcome === "blocked" &&
    exactKeys(result, ["outcome", "turnId", "attemptId", "reasons"]) &&
    Array.isArray(result.reasons) &&
    result.reasons.length > 0 &&
    result.reasons.length <= 8 &&
    result.reasons.every((reason) => ATTACHMENT_REASONS.includes(reason as AttachmentReason))
  ) {
    return {
      outcome: "blocked",
      turnId,
      attemptId,
      reasons: result.reasons as AttachmentReason[],
    };
  }
  return null;
}

function parseEntry(value: unknown, profileKey: string): AttachmentSubmissionJournalEntry | null {
  const entry = record(value);
  if (
    !entry ||
    !exactKeys(entry, [
      "version",
      "planId",
      "turnId",
      "attemptId",
      "scope",
      "sourceTextSha256",
      "images",
      "representations",
      "retryOfAttemptId",
      "state",
      "createdAt",
      "updatedAt",
      "result",
    ]) ||
    entry.version !== JOURNAL_VERSION ||
    !isAttachmentId(entry.planId) ||
    !isAttachmentId(entry.turnId) ||
    !isAttachmentId(entry.attemptId) ||
    !validScope(entry.scope) ||
    entry.scope.profileKey !== profileKey ||
    typeof entry.sourceTextSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.sourceTextSha256) ||
    (entry.retryOfAttemptId !== null && !isAttachmentId(entry.retryOfAttemptId)) ||
    !ENTRY_STATES.includes(entry.state as AttachmentSubmissionJournalState) ||
    !Number.isSafeInteger(entry.createdAt) ||
    Number(entry.createdAt) < 0 ||
    !Number.isSafeInteger(entry.updatedAt) ||
    Number(entry.updatedAt) < Number(entry.createdAt)
  )
    return null;
  const images = validImages(entry.images);
  const representations = validRepresentations(entry.representations);
  if (!images || !representations) return null;
  const result =
    entry.result === null ? null : parseResult(entry.result, entry.turnId, entry.attemptId);
  if (
    (entry.result !== null && !result) ||
    (entry.state === "dispatching" && result !== null) ||
    (entry.state !== "dispatching" && result?.outcome !== entry.state)
  )
    return null;
  return {
    version: JOURNAL_VERSION,
    planId: entry.planId,
    turnId: entry.turnId,
    attemptId: entry.attemptId,
    scope: entry.scope,
    sourceTextSha256: entry.sourceTextSha256,
    images,
    representations,
    retryOfAttemptId: entry.retryOfAttemptId as AttachmentAttemptId | null,
    state: entry.state as AttachmentSubmissionJournalState,
    createdAt: Number(entry.createdAt),
    updatedAt: Number(entry.updatedAt),
    result,
  };
}

function validEntrySequence(entries: readonly AttachmentSubmissionJournalEntry[]): boolean {
  const latestByTurn = new Map<string, AttachmentSubmissionJournalEntry>();
  for (const entry of entries) {
    const previous = latestByTurn.get(entry.turnId);
    if (entry.retryOfAttemptId !== (previous?.attemptId ?? null)) return false;
    latestByTurn.set(entry.turnId, entry);
  }
  return true;
}

/**
 * `null` means the association envelope was malformed/oversized. Callers must
 * fail closed instead of treating it as "no associations": an empty result would
 * normalize live dispatches to uncertain and could make retention unsafe.
 */
function parseAssociations(value: unknown): AttachmentSubmissionAssociation[] | null {
  if (!Array.isArray(value) || value.length > MAX_ASSOCIATIONS) return null;
  const output: AttachmentSubmissionAssociation[] = [];
  for (const item of value) {
    const association = record(item);
    if (!association || !exactKeys(association, ["metadata", "associationEntryId"])) continue;
    const metadata = validateAttachmentSubmissionMetadata(association.metadata);
    if (!metadata || !validEntryId(association.associationEntryId)) continue;
    output.push({ metadata, associationEntryId: association.associationEntryId });
  }
  return output;
}

function sourceDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildSubmission(input: AttachmentSubmissionJournalBeginInput): {
  sourceTextSha256: string;
  images: AttachmentSubmissionImageDigest[];
  representations: AttachmentSubmissionRepresentation[];
} | null {
  if (
    !isAttachmentId(input.planId) ||
    !isAttachmentId(input.turnId) ||
    !isAttachmentId(input.attemptId) ||
    !validScope(input.scope) ||
    !isWellFormedAttachmentText(input.sourceText) ||
    !Array.isArray(input.assets) ||
    input.assets.length === 0 ||
    input.assets.length > ATTACHMENT_LIMITS.filesPerDraft
  )
    return null;
  const images: AttachmentSubmissionImageDigest[] = [];
  const representations: AttachmentSubmissionRepresentation[] = [];
  for (const asset of input.assets) {
    const original = asset?.original;
    const representation = asset?.representation;
    if (
      !original ||
      !representation ||
      !isAttachmentId(original.id) ||
      !isAttachmentId(representation.id) ||
      representation.attachmentId !== original.id ||
      !/^[0-9a-f]{64}$/.test(original.sha256) ||
      !/^[0-9a-f]{64}$/.test(representation.originalSha256) ||
      !/^[0-9a-f]{64}$/.test(representation.representationSha256) ||
      representation.originalSha256 !== original.sha256 ||
      (representation.modality !== "text" && representation.modality !== "image")
    )
      return null;
    representations.push({
      representationId: representation.id,
      representationSha256: representation.representationSha256,
      originalId: original.id,
      originalSha256: original.sha256,
      modality: representation.modality,
    });
    if (representation.modality === "image") {
      if (
        !asset.image ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.image.mime)
      )
        return null;
      images.push({ mimeType: asset.image.mime, sha256: representation.representationSha256 });
    } else if (asset.image !== null) {
      return null;
    }
  }
  return {
    sourceTextSha256: sourceDigest(input.sourceText),
    images,
    representations,
  };
}

function sameRequest(
  entry: AttachmentSubmissionJournalEntry,
  input: AttachmentSubmissionJournalBeginInput,
  projection: ReturnType<typeof buildSubmission> & object,
): boolean {
  return (
    entry.planId === input.planId &&
    entry.turnId === input.turnId &&
    entry.attemptId === input.attemptId &&
    isDeepStrictEqual(entry.scope, input.scope) &&
    entry.sourceTextSha256 === projection.sourceTextSha256 &&
    isDeepStrictEqual(entry.images, projection.images) &&
    sameAttachmentRepresentations(entry.representations, projection.representations)
  );
}

function associationMatches(
  entry: AttachmentSubmissionJournalEntry,
  association: AttachmentSubmissionAssociation,
): boolean {
  const metadata = association.metadata;
  return (
    entry.planId === metadata.planId &&
    entry.turnId === metadata.turnId &&
    entry.attemptId === metadata.attemptId &&
    isDeepStrictEqual(entry.scope, metadata.scope) &&
    entry.sourceTextSha256 === metadata.sourceTextSha256 &&
    isDeepStrictEqual(entry.images, metadata.images) &&
    // The host stores card/display metadata alongside identity. Presentation
    // metadata must never prevent legitimate proof matching or recovery.
    sameAttachmentRepresentations(entry.representations, metadata.representations)
  );
}

function uncertain(entry: AttachmentSubmissionJournalEntry): AttachmentSubmissionJournalEntry {
  return {
    ...entry,
    state: "uncertain",
    updatedAt: Math.max(entry.updatedAt, entry.createdAt),
    result: { outcome: "uncertain", turnId: entry.turnId, attemptId: entry.attemptId },
  };
}

function accepted(
  entry: AttachmentSubmissionJournalEntry,
  association: AttachmentSubmissionAssociation,
): AttachmentSubmissionJournalEntry {
  return {
    ...entry,
    state: "accepted",
    updatedAt: Math.max(entry.updatedAt, entry.createdAt),
    result: {
      outcome: "accepted",
      turnId: entry.turnId,
      attemptId: entry.attemptId,
      userEntryId: association.metadata.userEntryId,
      associationEntryId: association.associationEntryId,
    },
  };
}

export function createAttachmentSubmissionJournal(input: {
  readonly root: string;
  readonly profileKey: string;
  readonly io: AttachmentSubmissionJournalIo;
  readonly now?: () => number;
}): AttachmentSubmissionJournal {
  if (!/^[0-9a-f]{64}$/.test(input.profileKey)) throw new AttachmentSubmissionJournalError();
  const path = join(input.root, "submissions", `${input.profileKey}.json`);
  const now = input.now ?? Date.now;
  let tail = Promise.resolve();
  const inFlight = new Set<string>();

  const transact = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const readEntries = async (): Promise<AttachmentSubmissionJournalEntry[]> => {
    let contents: string | null;
    try {
      contents = await input.io.readText(path);
    } catch {
      throw new AttachmentSubmissionJournalError();
    }
    if (contents === null) return [];
    if (Buffer.byteLength(contents, "utf8") > MAX_JOURNAL_BYTES) {
      throw new AttachmentSubmissionJournalError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new AttachmentSubmissionJournalError();
    }
    const document = record(parsed);
    if (
      !document ||
      !exactKeys(document, ["version", "entries"]) ||
      document.version !== JOURNAL_VERSION ||
      !Array.isArray(document.entries) ||
      document.entries.length > MAX_JOURNAL_ENTRIES
    )
      throw new AttachmentSubmissionJournalError();
    const entries = document.entries.map((entry) => parseEntry(entry, input.profileKey));
    if (entries.some((entry) => entry === null)) throw new AttachmentSubmissionJournalError();
    const validEntries = entries as AttachmentSubmissionJournalEntry[];
    if (
      new Set(validEntries.map((entry) => entry.attemptId)).size !== validEntries.length ||
      !validEntrySequence(validEntries)
    )
      throw new AttachmentSubmissionJournalError();
    return validEntries;
  };

  const writeEntries = async (
    entries: readonly AttachmentSubmissionJournalEntry[],
  ): Promise<void> => {
    const contents = JSON.stringify({ version: JOURNAL_VERSION, entries });
    if (
      entries.length > MAX_JOURNAL_ENTRIES ||
      Buffer.byteLength(contents, "utf8") > MAX_JOURNAL_BYTES
    )
      throw new AttachmentSubmissionJournalError();
    try {
      await input.io.writeAtomic(path, contents);
    } catch {
      throw new AttachmentSubmissionJournalError();
    }
  };

  return {
    begin(beginInput) {
      return transact(async () => {
        const projection = buildSubmission(beginInput);
        if (!projection || beginInput.scope.profileKey !== input.profileKey) {
          throw new AttachmentSubmissionJournalError();
        }
        const entries = await readEntries();
        const existing = entries.find((entry) => entry.attemptId === beginInput.attemptId);
        if (existing) {
          return sameRequest(existing, beginInput, projection)
            ? { kind: "existing", entry: structuredClone(existing) }
            : { kind: "conflict" };
        }
        const previous = entries.filter((entry) => entry.turnId === beginInput.turnId).at(-1);
        if (previous) {
          if (
            !beginInput.explicitRetry ||
            previous.state === "accepted" ||
            previous.state === "dispatching" ||
            inFlight.has(previous.attemptId)
          )
            return { kind: "conflict" };
        }
        const currentTime = now();
        if (
          !Number.isSafeInteger(currentTime) ||
          currentTime < 0 ||
          entries.length >= MAX_JOURNAL_ENTRIES
        ) {
          throw new AttachmentSubmissionJournalError();
        }
        const timestamp = Math.max(currentTime, previous?.updatedAt ?? 0);
        const entry: AttachmentSubmissionJournalEntry = {
          version: 1,
          planId: beginInput.planId,
          turnId: beginInput.turnId,
          attemptId: beginInput.attemptId,
          scope: structuredClone(beginInput.scope),
          sourceTextSha256: projection.sourceTextSha256,
          images: projection.images,
          representations: projection.representations,
          retryOfAttemptId: previous?.attemptId ?? null,
          state: "dispatching",
          createdAt: timestamp,
          updatedAt: timestamp,
          result: null,
        };
        await writeEntries([...entries, entry]);
        inFlight.add(entry.attemptId);
        return { kind: "dispatch", entry: structuredClone(entry) };
      });
    },

    complete(turnId, attemptId, result, proof) {
      return transact(async () => {
        // Any terminal outcome releases this process's in-flight marker, even
        // when validation or persistence fails. A leftover marker would pin a
        // dispatching entry as live forever and block reconcile/retry.
        try {
          const entries = await readEntries();
          const index = entries.findIndex(
            (entry) => entry.turnId === turnId && entry.attemptId === attemptId,
          );
          if (index < 0) throw new AttachmentSubmissionJournalError();
          const current = entries[index]!;
          const parsedResult = parseResult(result, turnId, attemptId);
          if (!parsedResult) throw new AttachmentSubmissionJournalError();
          if (parsedResult.outcome === "accepted") {
            const parsedProof = parseAssociations([proof])?.[0] ?? null;
            if (
              !parsedProof ||
              !associationMatches(current, parsedProof) ||
              parsedProof.metadata.userEntryId !== parsedResult.userEntryId ||
              parsedProof.associationEntryId !== parsedResult.associationEntryId
            )
              throw new AttachmentSubmissionJournalError();
          }
          if (current.state !== "dispatching") {
            if (current.result && isDeepStrictEqual(current.result, parsedResult)) return current;
            throw new AttachmentSubmissionJournalError();
          }
          const timestamp = now();
          if (!Number.isSafeInteger(timestamp) || timestamp < current.createdAt) {
            throw new AttachmentSubmissionJournalError();
          }
          const updated: AttachmentSubmissionJournalEntry = {
            ...current,
            state: parsedResult.outcome,
            updatedAt: timestamp,
            result: parsedResult,
          };
          entries[index] = updated;
          await writeEntries(entries);
          return structuredClone(updated);
        } finally {
          inFlight.delete(attemptId);
        }
      });
    },

    reconcile(liveScope, associationsValue) {
      return transact(async () => {
        if (!validScope(liveScope) || liveScope.profileKey !== input.profileKey) {
          throw new AttachmentSubmissionJournalError();
        }
        const associations = parseAssociations(associationsValue);
        if (!associations) throw new AttachmentSubmissionJournalError();
        const entries = await readEntries();
        let changed = false;
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
          throw new AttachmentSubmissionJournalError();
        }
        const updated = entries.map((entry) => {
          // A resumed host has new authority/lease/process generations. The live
          // read is limited to the same profile/session; the association must
          // still match the entry's complete original scope (branch/revision included).
          const sameSession =
            entry.scope.profileKey === liveScope.profileKey &&
            entry.scope.sessionId === liveScope.sessionId;
          const match = sameSession
            ? associations.find((association) => associationMatches(entry, association))
            : undefined;
          if (match && entry.state !== "accepted") {
            inFlight.delete(entry.attemptId);
            changed = true;
            return {
              ...accepted(entry, match),
              updatedAt: Math.max(timestamp, entry.createdAt),
            };
          }
          if (entry.state === "dispatching" && !inFlight.has(entry.attemptId)) {
            changed = true;
            return { ...uncertain(entry), updatedAt: Math.max(timestamp, entry.createdAt) };
          }
          return entry;
        });
        if (changed) await writeEntries(updated);
        return structuredClone(updated);
      });
    },

    get(turnId, attemptId) {
      return transact(async () => {
        const entry = (await readEntries()).find(
          (candidate) => candidate.turnId === turnId && candidate.attemptId === attemptId,
        );
        return entry ? structuredClone(entry) : null;
      });
    },

    list() {
      return transact(async () => {
        const entries = await readEntries();
        const timestamp = now();
        let changed = false;
        const normalized = entries.map((entry) => {
          if (entry.state === "dispatching" && !inFlight.has(entry.attemptId)) {
            changed = true;
            return { ...uncertain(entry), updatedAt: Math.max(timestamp, entry.createdAt) };
          }
          return entry;
        });
        if (changed) await writeEntries(normalized);
        return structuredClone(normalized);
      });
    },
  };
}
