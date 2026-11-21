import { isDeepStrictEqual } from "node:util";
import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  validateAttachmentClassification,
  type AttachmentClassification,
} from "../shared/attachments";
import {
  validateExtractionCoverage,
  type ExtractionCoverage,
  type ExtractionFormat,
} from "../shared/extraction";

/**
 * Immutable attachment snapshots and their app-owned ownership manifest.
 * All I/O, hashing, quota accounting, IDs and time are injected. The store is
 * not an authorization boundary: callers must establish the active profile and
 * owner before invoking it, and the port must never resolve user-provided paths.
 */
export const ATTACHMENT_MANIFEST_VERSION = 3 as const;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;

export type AssetKind = "original" | "representation";
export interface AssetOwner {
  readonly kind: "draft" | "session";
  /** Opaque application identity; it is never used as a filesystem path. */
  readonly id: string;
}

/** Provenance for a direct, already-prepared representation. Converted-file
 * consent is intentionally not represented here; it needs its own workflow. */
export interface DirectPreparationMetadata {
  readonly version: 1;
  readonly modality: "text" | "image";
  readonly preparationVersion: string;
  readonly warnings: readonly string[];
  readonly details:
    | { readonly kind: "text"; readonly empty: boolean; readonly utf8Bom: boolean }
    | {
        readonly kind: "image";
        readonly mime: string;
        readonly width: number;
        readonly height: number;
        readonly original: {
          readonly mime: string;
          readonly width: number;
          readonly height: number;
          readonly encodedWidth: number;
          readonly encodedHeight: number;
          readonly orientation: number;
          readonly animated: boolean;
        };
        readonly wasResized: boolean;
        readonly wasReencoded: boolean;
      };
}

/** A deleted durable owner whose assets stay recoverable for the policy window. */
export interface AssetTombstone {
  /** Always a durable (`session`) owner; draft owners never tombstone. */
  readonly owner: AssetOwner;
  readonly deletedAt: number;
  readonly expiresAt: number;
  /** Assets that existed under this owner when it was retired. */
  readonly assetIds: readonly string[];
}

/** Main-only staging projection; never rendered and never contains bytes. */
export interface StagingView {
  readonly id: string;
  readonly kind: AssetKind;
  readonly size: number;
  readonly createdAt: number;
  readonly owner: AssetOwner;
}

export interface AttachmentInventory {
  readonly assets: readonly AssetRecord[];
  readonly staging: readonly StagingView[];
  readonly tombstones: readonly AssetTombstone[];
  /** Object digests whose manifest record is gone but whose file may remain. */
  readonly pendingRemovals: readonly string[];
  /** Free bytes on the attachment volume, or null when the port cannot report. */
  readonly freeBytes: number | null;
}

/** Immutable provenance for an approved converted-text representation. */
export interface ConvertedPreparationMetadata {
  readonly version: 1;
  readonly modality: "text";
  readonly preparationVersion: string;
  readonly warnings: readonly string[];
  readonly conversion: {
    readonly contractVersion: 1;
    readonly format: ExtractionFormat;
    readonly converter: { readonly name: string; readonly version: string };
    readonly selectionDigest: string;
    readonly proposalDigest: string;
    readonly coverage: ExtractionCoverage;
    readonly createdAt: number;
  };
}

export interface AssetRecord {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly owners: readonly AssetOwner[];
  /** An unowned asset is retained until the separate retention/GC policy runs. */
  readonly unownedAt: number | null;
  readonly originalId: string | null;
  readonly originalSha256: string | null;
  /** Absent on originals and legacy/unprepared representations. */
  readonly preparation?: DirectPreparationMetadata;
  /** Present only on an approved converted-text representation. */
  readonly conversion?: ConvertedPreparationMetadata;
  /** Present on originals once content classification has been persisted. */
  readonly classification?: AttachmentClassification;
}

interface StagingRecord {
  id: string;
  kind: AssetKind;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  owner: AssetOwner;
  originalId: string | null;
  originalSha256: string | null;
}

interface Manifest {
  version: typeof ATTACHMENT_MANIFEST_VERSION;
  staging: StagingRecord[];
  assets: AssetRecord[];
  tombstones: AssetTombstone[];
  pendingRemovals: string[];
}

export type AttachmentStoreErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "quota_exceeded"
  | "size_mismatch"
  | "digest_mismatch"
  | "corrupt_manifest";

export class AttachmentStoreError extends Error {
  readonly code: AttachmentStoreErrorCode;
  constructor(code: AttachmentStoreErrorCode, message: string) {
    super(message);
    this.name = "AttachmentStoreError";
    this.code = code;
  }
}

/**
 * A single port instance must serialize `exclusive` across ALL profiles and
 * store instances in this app process. Its staging reservation must enforce the
 * store-wide quota and disk reserve atomically, including temporary promotion
 * space. A production adapter must also guarantee one app writer or provide an
 * OS-level lock. `ensureObject` verifies an existing digest-named object before
 * reuse and leaves staging intact until the manifest has been committed.
 */
export interface AttachmentStoreIo {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  readManifest(profile: string): Promise<string | null>;
  writeManifestAtomic(profile: string, contents: string): Promise<void>;
  createStaging(
    profile: string,
    id: string,
    declaredBytes: number,
    limits: { storeBytes: number; freeReserveBytes: number },
  ): Promise<void>;
  stagingSize(profile: string, id: string): Promise<number | null>;
  appendStaging(profile: string, id: string, offset: number, chunk: Uint8Array): Promise<void>;
  hashStaging(profile: string, id: string): Promise<string>;
  ensureObject(profile: string, stagingId: string, digest: string): Promise<void>;
  /** Verify the complete object digest before returning at most `maxBytes`. */
  readObjectPreview(
    profile: string,
    digest: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }>;
  /** Read the complete immutable object within the caller's hard byte limit. */
  readObject(profile: string, digest: string, maxBytes: number): Promise<Uint8Array>;
  /** Remove exactly one digest-named immutable object; missing is success. */
  removeObject(profile: string, digest: string): Promise<void>;
  /** Free bytes on the storage volume, when the platform can report it. */
  freeBytes?(): Promise<number>;
  removeStaging(profile: string, id: string): Promise<void>;
}

export interface AttachmentStoreDeps {
  /** Lowercase SHA-256 of a canonical profile identity, not the profile path. */
  profile: string;
  io: AttachmentStoreIo;
  newId(): string;
  now(): number;
}

export interface BeginAssetInput {
  owner: AssetOwner;
  name: string;
  mimeType: string;
  size: number;
}

export interface BeginRepresentationInput extends BeginAssetInput {
  originalId: string;
  originalSha256: string;
}

export interface AttachmentStore {
  beginOriginal(input: BeginAssetInput): Promise<string>;
  beginRepresentation(input: BeginRepresentationInput): Promise<string>;
  stagingSize(id: string, owner: AssetOwner): Promise<number>;
  append(id: string, owner: AssetOwner, offset: number, chunk: Uint8Array): Promise<number>;
  commit(id: string, owner: AssetOwner, expectedSha256: string): Promise<AssetRecord>;
  cancel(id: string, owner: AssetOwner): Promise<void>;
  list(owner: AssetOwner): Promise<readonly AssetRecord[]>;
  readPreview(
    id: string,
    owner: AssetOwner,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number; truncated: boolean }>;
  /** Internal preparation only; this full read is never exposed over renderer IPC. */
  readForPreparation(
    id: string,
    owner: AssetOwner,
    maxBytes: number,
  ): Promise<{ asset: AssetRecord; bytes: Uint8Array }>;
  /** Main-only publication of immutable provenance; never a renderer grant. */
  recordDirectPreparation(
    id: string,
    owner: AssetOwner,
    metadata: DirectPreparationMetadata,
  ): Promise<AssetRecord>;
  /** Persist immutable approved converted-text provenance (plan step 19). */
  recordConvertedPreparation(
    id: string,
    owner: AssetOwner,
    metadata: ConvertedPreparationMetadata,
  ): Promise<AssetRecord>;
  /** Persist immutable content classification for one original snapshot. */
  recordClassification(
    id: string,
    owner: AssetOwner,
    metadata: AttachmentClassification,
  ): Promise<AssetRecord>;
  addOwner(id: string, currentOwner: AssetOwner, newOwner: AssetOwner): Promise<void>;
  releaseOwner(id: string, owner: AssetOwner): Promise<void>;
  /**
   * Main-only ownership lookup by immutable asset id: no bytes, content, path
   * or renderer projection. Used by acceptance/retention reconciliation.
   */
  owners(id: string): Promise<readonly AssetOwner[]>;
  /** Main-only bounded manifest projection for retention/storage reporting. */
  inventory(): Promise<AttachmentInventory>;
  /** Retire durable owners atomically: tombstone them and release their assets. */
  retireOwners(
    owners: readonly AssetOwner[],
    retentionMs: number,
  ): Promise<{ readonly assets: number; readonly tombstones: number }>;
  /** Remove a recovery tombstone (the session/branch is live again). */
  clearTombstone(owner: AssetOwner): Promise<number>;
  /** True while a durable owner is inside its recovery window. */
  isRetired(owner: AssetOwner): Promise<boolean>;
  /**
   * Remove one unowned asset from the manifest and its object when the digest
   * is no longer shared. Referenced or owned assets are refused, never evicted.
   */
  removeAsset(id: string): Promise<void>;
  /** Retry object removals whose manifest record is already gone. */
  retryObjectRemovals(): Promise<number>;
}

function fail(code: AttachmentStoreErrorCode, message: string): never {
  throw new AttachmentStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasControl(value: string, includeSpace = false): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < (includeSpace ? 33 : 32) || code === 127;
  });
}

function validOwner(value: unknown): value is AssetOwner {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "id"]) &&
    (value.kind === "draft" || value.kind === "session") &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 256 &&
    !hasControl(value.id)
  );
}

function sameOwner(left: AssetOwner, right: AssetOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !hasControl(value)
  );
}

function validMime(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 255 && !hasControl(value, true)
  );
}

function validBase(value: Record<string, unknown>): boolean {
  return (
    isAttachmentId(value.id) &&
    (value.kind === "original" || value.kind === "representation") &&
    validName(value.name) &&
    validMime(value.mimeType) &&
    isCount(value.size) &&
    value.size <= ATTACHMENT_LIMITS.documentOriginalBytes &&
    isCount(value.createdAt) &&
    (value.kind === "original"
      ? value.originalId === null && value.originalSha256 === null
      : isAttachmentId(value.originalId) &&
        typeof value.originalSha256 === "string" &&
        DIGEST.test(value.originalSha256))
  );
}

const BASE_KEYS = [
  "id",
  "kind",
  "name",
  "mimeType",
  "size",
  "createdAt",
  "originalId",
  "originalSha256",
];

function validStaging(value: unknown): value is StagingRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [...BASE_KEYS, "owner"]) &&
    validBase(value) &&
    validOwner(value.owner)
  );
}

function validDirectPreparation(
  value: unknown,
  asset: unknown,
): value is DirectPreparationMetadata {
  if (
    !isRecord(asset) ||
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "modality", "preparationVersion", "warnings", "details"]) ||
    value.version !== 1 ||
    (value.modality !== "text" && value.modality !== "image") ||
    typeof value.preparationVersion !== "string" ||
    !value.preparationVersion.length ||
    value.preparationVersion.length > 128 ||
    hasControl(value.preparationVersion) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 64 ||
    !value.warnings.every(
      (warning: unknown) =>
        typeof warning === "string" && warning.length <= 512 && !hasControl(warning),
    ) ||
    !isRecord(value.details) ||
    value.details.kind !== value.modality ||
    asset.kind !== "representation"
  )
    return false;
  const details = value.details;
  if (value.modality === "text") {
    return (
      hasOnlyKeys(details, ["kind", "empty", "utf8Bom"]) &&
      typeof details.empty === "boolean" &&
      typeof details.utf8Bom === "boolean" &&
      details.empty === (asset.size === 0) &&
      asset.mimeType === "text/plain"
    );
  }
  if (
    !hasOnlyKeys(details, [
      "kind",
      "mime",
      "width",
      "height",
      "original",
      "wasResized",
      "wasReencoded",
    ]) ||
    typeof details.mime !== "string" ||
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(details.mime) ||
    details.mime !== asset.mimeType ||
    !validDimensions(details.width, details.height) ||
    typeof details.wasResized !== "boolean" ||
    typeof details.wasReencoded !== "boolean" ||
    !isRecord(details.original)
  )
    return false;
  const original = details.original;
  if (
    !hasOnlyKeys(original, [
      "mime",
      "width",
      "height",
      "encodedWidth",
      "encodedHeight",
      "orientation",
      "animated",
    ]) ||
    typeof original.mime !== "string" ||
    !["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].includes(original.mime) ||
    !validDimensions(original.width, original.height) ||
    !validDimensions(original.encodedWidth, original.encodedHeight) ||
    !isCount(original.orientation) ||
    original.orientation < 1 ||
    original.orientation > 8 ||
    typeof original.animated !== "boolean"
  )
    return false;
  const rotated = original.orientation >= 5;
  if (
    original.width !== (rotated ? original.encodedHeight : original.encodedWidth) ||
    original.height !== (rotated ? original.encodedWidth : original.encodedHeight)
  )
    return false;
  if (
    !details.wasResized &&
    (details.width !== original.width || details.height !== original.height)
  )
    return false;
  if (!details.wasReencoded && original.mime !== details.mime) return false;
  return true;
}

function validDimensions(width: unknown, height: unknown): boolean {
  return (
    isCount(width) &&
    isCount(height) &&
    width > 0 &&
    height > 0 &&
    width <= 32_768 &&
    height <= 32_768 &&
    width * height <= ATTACHMENT_LIMITS.imagePixels
  );
}

function validConvertedPreparation(
  value: unknown,
  asset: unknown,
): value is ConvertedPreparationMetadata {
  if (
    !isRecord(asset) ||
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "modality", "preparationVersion", "warnings", "conversion"]) ||
    value.version !== 1 ||
    value.modality !== "text" ||
    typeof value.preparationVersion !== "string" ||
    !value.preparationVersion.length ||
    value.preparationVersion.length > 128 ||
    hasControl(value.preparationVersion) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 64 ||
    !value.warnings.every(
      (warning: unknown) =>
        typeof warning === "string" && warning.length <= 512 && !hasControl(warning),
    ) ||
    asset.kind !== "representation" ||
    asset.mimeType !== "text/plain" ||
    !isCount(asset.size) ||
    asset.size > ATTACHMENT_LIMITS.promptTextBytesPerFile
  ) {
    return false;
  }
  const conversion = value.conversion;
  if (
    !isRecord(conversion) ||
    !hasOnlyKeys(conversion, [
      "contractVersion",
      "format",
      "converter",
      "selectionDigest",
      "proposalDigest",
      "coverage",
      "createdAt",
    ]) ||
    conversion.contractVersion !== 1 ||
    !["pdf", "docx", "odt", "xlsx", "ods", "pptx", "odp"].includes(String(conversion.format)) ||
    !isRecord(conversion.converter) ||
    !hasOnlyKeys(conversion.converter, ["name", "version"]) ||
    typeof conversion.converter.name !== "string" ||
    !conversion.converter.name.length ||
    conversion.converter.name.length > 64 ||
    typeof conversion.converter.version !== "string" ||
    !conversion.converter.version.length ||
    conversion.converter.version.length > 64 ||
    typeof conversion.selectionDigest !== "string" ||
    !DIGEST.test(conversion.selectionDigest) ||
    typeof conversion.proposalDigest !== "string" ||
    !DIGEST.test(conversion.proposalDigest) ||
    !validateExtractionCoverage(conversion.coverage) ||
    !isCount(conversion.createdAt)
  ) {
    return false;
  }
  return true;
}

function validAsset(value: unknown): value is AssetRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      ...BASE_KEYS,
      "sha256",
      "owners",
      "unownedAt",
      ...(Object.hasOwn(value, "preparation") ? ["preparation"] : []),
      ...(Object.hasOwn(value, "conversion") ? ["conversion"] : []),
      ...(Object.hasOwn(value, "classification") ? ["classification"] : []),
    ]) ||
    !validBase(value)
  )
    return false;
  if (Object.hasOwn(value, "preparation") && !validDirectPreparation(value.preparation, value))
    return false;
  if (Object.hasOwn(value, "conversion") && !validConvertedPreparation(value.conversion, value))
    return false;
  if (Object.hasOwn(value, "preparation") && Object.hasOwn(value, "conversion")) return false;
  if (
    Object.hasOwn(value, "classification") &&
    (value.kind !== "original" || !validateAttachmentClassification(value.classification))
  )
    return false;
  if (typeof value.sha256 !== "string" || !DIGEST.test(value.sha256)) return false;
  if (
    !Array.isArray(value.owners) ||
    value.owners.length > 1_000 ||
    !value.owners.every(validOwner)
  )
    return false;
  if (value.unownedAt !== null && !isCount(value.unownedAt)) return false;
  if ((value.owners.length === 0) !== (value.unownedAt !== null)) return false;
  const owners = value.owners as AssetOwner[];
  const keys = owners.map((owner) => JSON.stringify([owner.kind, owner.id]));
  return new Set(keys).size === keys.length;
}

const MAX_TOMBSTONES = 1_000;
const MAX_PENDING_REMOVALS = 2_000;
const MAX_TOMBSTONE_ASSETS = 10_000;

function validTombstone(value: unknown): value is AssetTombstone {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["owner", "deletedAt", "expiresAt", "assetIds"]) &&
    validOwner(value.owner) &&
    value.owner.kind === "session" &&
    isCount(value.deletedAt) &&
    isCount(value.expiresAt) &&
    value.expiresAt > value.deletedAt &&
    Array.isArray(value.assetIds) &&
    value.assetIds.length > 0 &&
    value.assetIds.length <= MAX_TOMBSTONE_ASSETS &&
    value.assetIds.every(isAttachmentId) &&
    new Set(value.assetIds).size === value.assetIds.length
  );
}

function sameDurableOwner(left: AssetOwner, right: AssetOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function cloneTombstone(tombstone: AssetTombstone): AssetTombstone {
  return {
    owner: { ...tombstone.owner },
    deletedAt: tombstone.deletedAt,
    expiresAt: tombstone.expiresAt,
    assetIds: [...tombstone.assetIds],
  };
}

function decodeManifest(raw: string | null): Manifest {
  if (raw === null)
    return {
      version: ATTACHMENT_MANIFEST_VERSION,
      staging: [],
      assets: [],
      tombstones: [],
      pendingRemovals: [],
    };
  if (new TextEncoder().encode(raw).length > MAX_MANIFEST_BYTES) {
    return fail("corrupt_manifest", "attachment manifest exceeds the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("corrupt_manifest", "attachment manifest is malformed");
  }
  const legacy = isRecord(parsed) && (parsed.version === 1 || parsed.version === 2);
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(
      parsed,
      legacy
        ? ["version", "staging", "assets"]
        : ["version", "staging", "assets", "tombstones", "pendingRemovals"],
    ) ||
    (parsed.version !== 1 &&
      parsed.version !== 2 &&
      parsed.version !== ATTACHMENT_MANIFEST_VERSION) ||
    !Array.isArray(parsed.staging) ||
    !parsed.staging.every(validStaging) ||
    !Array.isArray(parsed.assets) ||
    !parsed.assets.every(validAsset)
  ) {
    return fail("corrupt_manifest", "attachment manifest has an invalid schema or version");
  }
  const staging = parsed.staging as StagingRecord[];
  const assets = parsed.assets as AssetRecord[];
  const tombstones = legacy ? [] : (parsed.tombstones as unknown);
  const pendingRemovals = legacy ? [] : (parsed.pendingRemovals as unknown);
  if (
    !Array.isArray(tombstones) ||
    tombstones.length > MAX_TOMBSTONES ||
    !tombstones.every(validTombstone) ||
    !Array.isArray(pendingRemovals) ||
    pendingRemovals.length > MAX_PENDING_REMOVALS ||
    !pendingRemovals.every((digest) => typeof digest === "string" && DIGEST.test(digest)) ||
    new Set(pendingRemovals).size !== pendingRemovals.length
  ) {
    return fail("corrupt_manifest", "attachment manifest has invalid retention state");
  }
  const knownAssets = new Set(assets.map((asset) => asset.id));
  const tombstoneOwners = (tombstones as AssetTombstone[]).map((tombstone) =>
    JSON.stringify([tombstone.owner.kind, tombstone.owner.id]),
  );
  if (
    new Set(tombstoneOwners).size !== tombstoneOwners.length ||
    (tombstones as AssetTombstone[]).some((tombstone) =>
      tombstone.assetIds.some((id) => !knownAssets.has(id)),
    )
  ) {
    return fail("corrupt_manifest", "attachment tombstone is invalid");
  }
  if (
    parsed.version === 1 &&
    assets.some((asset) => asset.preparation !== undefined || asset.conversion !== undefined)
  ) {
    return fail("corrupt_manifest", "legacy attachment manifest has unexpected provenance");
  }
  if (parsed.version === 2 && assets.some((asset) => asset.conversion !== undefined)) {
    return fail("corrupt_manifest", "legacy attachment manifest has unexpected conversion");
  }
  const ids = [...staging, ...assets].map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    return fail("corrupt_manifest", "attachment manifest has duplicate IDs");
  }
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const item of [...staging, ...assets]) {
    if (item.kind !== "representation") continue;
    const original = item.originalId ? assetsById.get(item.originalId) : undefined;
    if (!original || original.kind !== "original" || original.sha256 !== item.originalSha256) {
      return fail("corrupt_manifest", "attachment representation has an invalid original");
    }
    const owners = "owner" in item ? [item.owner] : item.owners;
    if (!owners.every((owner) => original.owners.some((entry) => sameOwner(entry, owner)))) {
      return fail("corrupt_manifest", "attachment representation owner lacks the original");
    }
  }
  return {
    version: ATTACHMENT_MANIFEST_VERSION,
    staging,
    assets,
    tombstones: (tombstones as AssetTombstone[]).map(cloneTombstone),
    pendingRemovals: [...(pendingRemovals as string[])],
  };
}

function assertOwner(owner: AssetOwner): void {
  if (!validOwner(owner)) fail("bad_request", "invalid attachment owner");
}

function assertId(id: string): void {
  if (!isAttachmentId(id)) fail("bad_request", "invalid attachment ID");
}

function requireAsset(manifest: Manifest, id: string, owner: AssetOwner): AssetRecord {
  const asset = manifest.assets.find((item) => item.id === id);
  if (!asset || !asset.owners.some((item) => sameOwner(item, owner))) {
    return fail("not_found", "attachment not found for this owner");
  }
  return asset;
}

function requireStage(manifest: Manifest, id: string, owner: AssetOwner): StagingRecord {
  const stage = manifest.staging.find((item) => item.id === id);
  if (!stage || !sameOwner(stage.owner, owner)) {
    return fail("not_found", "staged attachment not found for this owner");
  }
  return stage;
}

function cloneAsset(asset: AssetRecord): AssetRecord {
  return {
    ...asset,
    owners: asset.owners.map((owner) => ({ ...owner })),
    ...(asset.preparation ? { preparation: structuredClone(asset.preparation) } : {}),
    ...(asset.conversion ? { conversion: structuredClone(asset.conversion) } : {}),
    ...(asset.classification ? { classification: structuredClone(asset.classification) } : {}),
  };
}

function assertDraftRoom(manifest: Manifest, owner: AssetOwner, extraBytes: number): void {
  if (owner.kind !== "draft") return;
  const owned = manifest.assets.filter(
    (asset) => asset.kind === "original" && asset.owners.some((entry) => sameOwner(entry, owner)),
  );
  const staged = manifest.staging.filter(
    (stage) => stage.kind === "original" && sameOwner(stage.owner, owner),
  );
  if (
    owned.length + staged.length >= ATTACHMENT_LIMITS.filesPerDraft ||
    owned.reduce((total, asset) => total + asset.size, 0) +
      staged.reduce((total, stage) => total + stage.size, 0) +
      extraBytes >
      ATTACHMENT_LIMITS.draftOriginalBytes
  ) {
    fail("quota_exceeded", "attachment draft limit exceeded");
  }
}

export function createAttachmentStore(deps: AttachmentStoreDeps): AttachmentStore {
  if (!DIGEST.test(deps.profile)) fail("bad_request", "invalid attachment profile namespace");
  const { io, profile } = deps;
  const load = async (): Promise<Manifest> => decodeManifest(await io.readManifest(profile));
  const save = async (manifest: Manifest): Promise<void> => {
    const encoded = JSON.stringify(manifest);
    if (new TextEncoder().encode(encoded).length > MAX_MANIFEST_BYTES) {
      fail("quota_exceeded", "attachment manifest exceeds the size limit");
    }
    await io.writeManifestAtomic(profile, encoded);
  };
  const clock = (): number => {
    const value = deps.now();
    if (!isCount(value)) return fail("bad_request", "invalid attachment clock");
    return value;
  };

  const begin = async (
    input: BeginAssetInput,
    original: { id: string; sha256: string } | null,
  ): Promise<string> =>
    io.exclusive(async () => {
      assertOwner(input.owner);
      if (!validName(input.name) || !validMime(input.mimeType) || !isCount(input.size)) {
        return fail("bad_request", "invalid attachment metadata");
      }
      if (input.size > ATTACHMENT_LIMITS.documentOriginalBytes) {
        return fail("quota_exceeded", "attachment exceeds the file size limit");
      }
      const manifest = await load();
      if (original) {
        assertId(original.id);
        const source = requireAsset(manifest, original.id, input.owner);
        if (source.kind !== "original" || source.sha256 !== original.sha256) {
          return fail("conflict", "representation does not match the original snapshot");
        }
      } else {
        assertDraftRoom(manifest, input.owner, input.size);
      }
      const id = deps.newId();
      assertId(id);
      if (
        manifest.assets.some((asset) => asset.id === id) ||
        manifest.staging.some((s) => s.id === id)
      ) {
        return fail("conflict", "attachment ID already exists");
      }
      const stage: StagingRecord = {
        id,
        kind: original ? "representation" : "original",
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        createdAt: clock(),
        owner: { ...input.owner },
        originalId: original?.id ?? null,
        originalSha256: original?.sha256 ?? null,
      };
      await io.createStaging(profile, id, input.size, {
        storeBytes: ATTACHMENT_LIMITS.localStoreBytes,
        freeReserveBytes: ATTACHMENT_LIMITS.freeDiskReserveBytes,
      });
      try {
        await save({ ...manifest, staging: [...manifest.staging, stage] });
      } catch (error) {
        // A failed acknowledgement may follow a successful atomic publication.
        // Delete bytes only after a fresh, valid manifest proves them unreferenced.
        let unreferenced = false;
        try {
          const current = await load();
          unreferenced =
            !current.staging.some((item) => item.id === id) &&
            !current.assets.some((item) => item.id === id);
        } catch {
          // A missing/corrupt/unreadable manifest cannot justify deletion.
        }
        if (unreferenced) await io.removeStaging(profile, id).catch(() => undefined);
        throw error;
      }
      return id;
    });

  return {
    beginOriginal: (input) => begin(input, null),
    beginRepresentation: async (input) => {
      assertId(input.originalId);
      if (!DIGEST.test(input.originalSha256)) fail("bad_request", "invalid original digest");
      return begin(input, { id: input.originalId, sha256: input.originalSha256 });
    },
    stagingSize: (id, owner) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        const stage = requireStage(await load(), id, owner);
        const size = await io.stagingSize(profile, id);
        if (size === null || !isCount(size) || size > stage.size) {
          return fail("conflict", "staging data is missing or exceeds its declared size");
        }
        return size;
      }),
    append: (id, owner, offset, chunk) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        if (
          !isCount(offset) ||
          !(chunk instanceof Uint8Array) ||
          chunk.byteLength === 0 ||
          chunk.byteLength > ATTACHMENT_LIMITS.importChunkBytes
        ) {
          return fail("bad_request", "invalid attachment chunk");
        }
        const stage = requireStage(await load(), id, owner);
        const size = await io.stagingSize(profile, id);
        if (size === null || size !== offset || offset + chunk.byteLength > stage.size) {
          return fail("conflict", "attachment chunk offset or size is invalid");
        }
        await io.appendStaging(profile, id, offset, chunk);
        return offset + chunk.byteLength;
      }),
    commit: (id, owner, expectedSha256) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        if (!DIGEST.test(expectedSha256)) return fail("bad_request", "invalid attachment digest");
        const manifest = await load();
        const existing = manifest.assets.find((asset) => asset.id === id);
        if (existing) {
          const asset = requireAsset(manifest, id, owner);
          if (asset.sha256 !== expectedSha256)
            return fail("conflict", "attachment already committed");
          // A crash may have occurred after manifest commit but before cleanup.
          await io.removeStaging(profile, id).catch(() => undefined);
          return cloneAsset(asset);
        }
        const stage = requireStage(manifest, id, owner);
        if ((await io.stagingSize(profile, id)) !== stage.size) {
          return fail("size_mismatch", "attachment staging size does not match");
        }
        if (stage.originalId && stage.originalSha256) {
          const source = requireAsset(manifest, stage.originalId, owner);
          if (source.kind !== "original" || source.sha256 !== stage.originalSha256) {
            return fail("conflict", "representation original is no longer available");
          }
        }
        const actual = await io.hashStaging(profile, id);
        if (actual !== expectedSha256)
          return fail("digest_mismatch", "attachment digest does not match");
        await io.ensureObject(profile, id, actual);
        const asset: AssetRecord = {
          id,
          kind: stage.kind,
          name: stage.name,
          mimeType: stage.mimeType,
          size: stage.size,
          sha256: actual,
          createdAt: stage.createdAt,
          owners: [{ ...owner }],
          unownedAt: null,
          originalId: stage.originalId,
          originalSha256: stage.originalSha256,
        };
        await save({
          ...manifest,
          staging: manifest.staging.filter((item) => item.id !== id),
          assets: [...manifest.assets, asset],
          // A new asset may reuse a digest whose old record was removed; the
          // object is referenced again and must not be deleted by a retry.
          pendingRemovals: manifest.pendingRemovals.filter((digest) => digest !== actual),
        });
        await io.removeStaging(profile, id).catch(() => undefined);
        return cloneAsset(asset);
      }),
    cancel: (id, owner) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        const manifest = await load();
        requireStage(manifest, id, owner);
        await save({ ...manifest, staging: manifest.staging.filter((stage) => stage.id !== id) });
        await io.removeStaging(profile, id).catch(() => undefined);
      }),
    list: (owner) =>
      io.exclusive(async () => {
        assertOwner(owner);
        const manifest = await load();
        return manifest.assets
          .filter((asset) => asset.owners.some((item) => sameOwner(item, owner)))
          .map(cloneAsset);
      }),
    readPreview: (id, owner, maxBytes) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        if (!isCount(maxBytes) || maxBytes > ATTACHMENT_LIMITS.previewBytes) {
          return fail("bad_request", "invalid attachment preview limit");
        }
        const asset = requireAsset(await load(), id, owner);
        const result = await io.readObjectPreview(profile, asset.sha256, maxBytes);
        if (result.size !== asset.size || result.bytes.byteLength > maxBytes) {
          return fail("conflict", "attachment preview does not match its snapshot");
        }
        return {
          bytes: new Uint8Array(result.bytes),
          size: result.size,
          truncated: result.size > result.bytes.byteLength,
        };
      }),
    readForPreparation: (id, owner, maxBytes) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        if (!isCount(maxBytes) || maxBytes > ATTACHMENT_LIMITS.documentOriginalBytes) {
          return fail("bad_request", "invalid attachment preparation limit");
        }
        const asset = requireAsset(await load(), id, owner);
        if (asset.size > maxBytes) {
          return fail("quota_exceeded", "attachment exceeds the preparation limit");
        }
        const bytes = await io.readObject(profile, asset.sha256, maxBytes);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== asset.size) {
          return fail("conflict", "attachment data does not match its snapshot");
        }
        return { asset: cloneAsset(asset), bytes: new Uint8Array(bytes) };
      }),
    recordDirectPreparation: (id, owner, metadata) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        const manifest = await load();
        const asset = requireAsset(manifest, id, owner);
        if (asset.conversion) {
          return fail("conflict", "attachment already has converted provenance");
        }
        if (!validDirectPreparation(metadata, asset)) {
          return fail("bad_request", "invalid direct preparation provenance");
        }
        if (asset.preparation) {
          if (!isDeepStrictEqual(asset.preparation, metadata)) {
            return fail("conflict", "preparation provenance is immutable");
          }
          return cloneAsset(asset);
        }
        const updated = { ...asset, preparation: structuredClone(metadata) };
        await save({
          ...manifest,
          assets: manifest.assets.map((item) => (item.id === id ? updated : item)),
        });
        return cloneAsset(updated);
      }),
    recordConvertedPreparation: (id, owner, metadata) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        const manifest = await load();
        const asset = requireAsset(manifest, id, owner);
        if (asset.preparation) {
          return fail("conflict", "attachment already has direct provenance");
        }
        if (!validConvertedPreparation(metadata, asset)) {
          return fail("bad_request", "invalid converted preparation provenance");
        }
        if (asset.conversion) {
          if (!isDeepStrictEqual(asset.conversion, metadata)) {
            return fail("conflict", "conversion provenance is immutable");
          }
          return cloneAsset(asset);
        }
        const updated = { ...asset, conversion: structuredClone(metadata) };
        await save({
          ...manifest,
          assets: manifest.assets.map((item) => (item.id === id ? updated : item)),
        });
        return cloneAsset(updated);
      }),
    recordClassification: (id, owner, metadata) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        const manifest = await load();
        const asset = requireAsset(manifest, id, owner);
        const validated = validateAttachmentClassification(metadata);
        if (!validated || asset.kind !== "original") {
          return fail("bad_request", "invalid attachment classification");
        }
        if (asset.classification) {
          if (!isDeepStrictEqual(asset.classification, validated)) {
            return fail("conflict", "attachment classification is immutable");
          }
          return cloneAsset(asset);
        }
        const updated = { ...asset, classification: structuredClone(validated) };
        await save({
          ...manifest,
          assets: manifest.assets.map((item) => (item.id === id ? updated : item)),
        });
        return cloneAsset(updated);
      }),
    addOwner: (id, currentOwner, newOwner) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(currentOwner);
        assertOwner(newOwner);
        const manifest = await load();
        const asset = requireAsset(manifest, id, currentOwner);
        if (asset.owners.some((owner) => sameOwner(owner, newOwner))) return;
        if (asset.owners.length >= 1_000) fail("quota_exceeded", "too many attachment owners");
        if (asset.kind === "original") {
          assertDraftRoom(manifest, newOwner, asset.size);
        } else if (asset.originalId) {
          requireAsset(manifest, asset.originalId, newOwner);
        }
        await save({
          ...manifest,
          assets: manifest.assets.map((item) =>
            item.id === id
              ? { ...item, owners: [...item.owners, { ...newOwner }], unownedAt: null }
              : item,
          ),
        });
      }),
    releaseOwner: (id, owner) =>
      io.exclusive(async () => {
        assertId(id);
        assertOwner(owner);
        const manifest = await load();
        const asset = requireAsset(manifest, id, owner);
        if (
          asset.kind === "original" &&
          (manifest.assets.some(
            (item) =>
              item.originalId === id && item.owners.some((entry) => sameOwner(entry, owner)),
          ) ||
            manifest.staging.some((item) => item.originalId === id && sameOwner(item.owner, owner)))
        ) {
          fail("conflict", "release dependent representations before their original");
        }
        const remaining = asset.owners.filter((item) => !sameOwner(item, owner));
        await save({
          ...manifest,
          assets: manifest.assets.map((item) =>
            item.id === id
              ? { ...item, owners: remaining, unownedAt: remaining.length === 0 ? clock() : null }
              : item,
          ),
        });
      }),
    owners: (id) =>
      io.exclusive(async () => {
        assertId(id);
        const manifest = await load();
        const asset = manifest.assets.find((item) => item.id === id);
        return asset ? asset.owners.map((owner) => ({ ...owner })) : [];
      }),
    inventory: () =>
      io.exclusive(async () => {
        const manifest = await load();
        let freeBytes: number | null = null;
        if (io.freeBytes) {
          try {
            const value = await io.freeBytes();
            freeBytes = isCount(value) ? value : null;
          } catch {
            freeBytes = null;
          }
        }
        return {
          assets: manifest.assets.map(cloneAsset),
          staging: manifest.staging.map((stage) => ({
            id: stage.id,
            kind: stage.kind,
            size: stage.size,
            createdAt: stage.createdAt,
            owner: { ...stage.owner },
          })),
          tombstones: manifest.tombstones.map(cloneTombstone),
          pendingRemovals: [...manifest.pendingRemovals],
          freeBytes,
        };
      }),
    retireOwners: (owners, retentionMs) =>
      io.exclusive(async () => {
        if (
          !Array.isArray(owners) ||
          owners.length === 0 ||
          owners.length > 64 ||
          owners.some((owner) => !validOwner(owner) || owner.kind !== "session") ||
          !isCount(retentionMs) ||
          retentionMs <= 0 ||
          retentionMs > 10 * 365 * 24 * 60 * 60 * 1_000
        ) {
          return fail("bad_request", "invalid attachment retirement request");
        }
        const unique = owners.filter(
          (owner, index) =>
            owners.findIndex((candidate) => sameDurableOwner(candidate, owner)) === index,
        );
        const manifest = await load();
        const timestamp = clock();
        const assetIds = new Set<string>();
        for (const owner of unique) {
          for (const asset of manifest.assets) {
            if (asset.owners.some((entry) => sameDurableOwner(entry, owner))) {
              assetIds.add(asset.id);
            }
          }
        }
        const tombstones = [...manifest.tombstones];
        for (const owner of unique) {
          const existingIndex = tombstones.findIndex((tombstone) =>
            sameDurableOwner(tombstone.owner, owner),
          );
          if (existingIndex < 0 && tombstones.length >= MAX_TOMBSTONES) {
            return fail("quota_exceeded", "too many attachment tombstones");
          }
          const existing = existingIndex >= 0 ? tombstones[existingIndex] : undefined;
          const merged = new Set<string>([...(existing?.assetIds ?? []), ...assetIds]);
          if (merged.size > MAX_TOMBSTONE_ASSETS) {
            return fail("quota_exceeded", "attachment tombstone is too large");
          }
          const next: AssetTombstone = {
            owner: { ...owner },
            deletedAt: timestamp,
            expiresAt: timestamp + retentionMs,
            assetIds: [...merged],
          };
          if (existingIndex >= 0) tombstones[existingIndex] = next;
          else tombstones.push(next);
        }
        const assets = manifest.assets.map((asset) => {
          const remaining = asset.owners.filter(
            (owner) => !unique.some((candidate) => sameDurableOwner(candidate, owner)),
          );
          if (remaining.length === asset.owners.length) return asset;
          return {
            ...asset,
            owners: remaining,
            unownedAt: remaining.length === 0 ? timestamp : null,
          };
        });
        await save({ ...manifest, assets, tombstones });
        return { assets: assetIds.size, tombstones: unique.length };
      }),
    clearTombstone: (owner) =>
      io.exclusive(async () => {
        if (!validOwner(owner) || owner.kind !== "session") {
          return fail("bad_request", "invalid attachment tombstone owner");
        }
        const manifest = await load();
        const tombstones = manifest.tombstones.filter(
          (tombstone) => !sameDurableOwner(tombstone.owner, owner),
        );
        if (tombstones.length === manifest.tombstones.length) return 0;
        await save({ ...manifest, tombstones });
        return manifest.tombstones.length - tombstones.length;
      }),
    isRetired: (owner) =>
      io.exclusive(async () => {
        if (!validOwner(owner) || owner.kind !== "session") {
          return fail("bad_request", "invalid attachment tombstone owner");
        }
        const manifest = await load();
        return manifest.tombstones.some((tombstone) => sameDurableOwner(tombstone.owner, owner));
      }),
    removeAsset: (id) =>
      io.exclusive(async () => {
        assertId(id);
        const manifest = await load();
        const asset = manifest.assets.find((item) => item.id === id);
        if (!asset) return fail("not_found", "attachment not found");
        if (asset.owners.length !== 0) {
          return fail("conflict", "attachment is still referenced by an owner");
        }
        if (
          asset.kind === "original" &&
          (manifest.assets.some((item) => item.originalId === id) ||
            manifest.staging.some((item) => item.originalId === id))
        ) {
          return fail("conflict", "remove dependent representations before their original");
        }
        const shared = manifest.assets.some(
          (item) => item.id !== id && item.sha256 === asset.sha256,
        );
        const pending = [...manifest.pendingRemovals];
        if (!shared && !pending.includes(asset.sha256)) {
          if (pending.length >= MAX_PENDING_REMOVALS) {
            return fail("quota_exceeded", "too many pending object removals");
          }
          pending.push(asset.sha256);
        }
        await save({
          ...manifest,
          assets: manifest.assets.filter((item) => item.id !== id),
          pendingRemovals: pending,
        });
        if (shared) return;
        try {
          await io.removeObject(profile, asset.sha256);
        } catch {
          // The digest stays pending; the next maintenance pass retries it.
          return;
        }
        try {
          const current = await load();
          await save({
            ...current,
            pendingRemovals: current.pendingRemovals.filter((digest) => digest !== asset.sha256),
          });
        } catch {
          // A failed acknowledgement is harmless: removing a missing object is a no-op.
        }
      }),
    retryObjectRemovals: () =>
      io.exclusive(async () => {
        const manifest = await load();
        const referenced = new Set(manifest.assets.map((asset) => asset.sha256));
        const pending = manifest.pendingRemovals.filter((digest) => !referenced.has(digest));
        let removed = 0;
        const remaining: string[] = [];
        for (const digest of pending) {
          try {
            await io.removeObject(profile, digest);
            removed++;
          } catch {
            remaining.push(digest);
          }
        }
        const keep = [
          ...manifest.pendingRemovals.filter((digest) => referenced.has(digest)),
          ...remaining,
        ];
        if (keep.length !== manifest.pendingRemovals.length) {
          await save({ ...manifest, pendingRemovals: keep });
        }
        return removed;
      }),
  };
}
