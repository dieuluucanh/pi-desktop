import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  AssetKind,
  AssetOwner,
  AssetRecord,
  AttachmentStore,
  ConvertedPreparationMetadata,
} from "../attachments/store";
import { validateExtractionCoverage, type ExtractionFormat } from "../shared/extraction";

/**
 * Local, portable attachment bundles (plan step 15).
 *
 * A bundle is a zip with a versioned `bundle.json` manifest and, only when the
 * user opted in, digest-named objects. It contains no owner ids, session ids,
 * profile paths or source paths: importing is an explicit profile/session
 * reassociation, never a grant. Imported ids are new app ids; the ids in the
 * manifest are provenance only and never permissions.
 */

export const ATTACHMENT_BUNDLE_VERSION = 1 as const;
export const MAX_BUNDLE_ZIP_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 2_048;
export const MAX_BUNDLE_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const IMPORT_CHUNK = 256 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;

export interface BundleAsset {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly originalId: string | null;
  readonly originalSha256: string | null;
  readonly coverage: { readonly kind: "entire-file" };
  /**
   * Converted-text provenance. Never an approval: importing cannot restore one,
   * so imported converted text stays undeliverable until it is approved again.
   */
  readonly conversion?: ConvertedPreparationMetadata;
}

export interface BundleManifest {
  readonly version: typeof ATTACHMENT_BUNDLE_VERSION;
  readonly createdAt: number;
  readonly includesObjects: boolean;
  readonly assets: readonly BundleAsset[];
}

export interface AttachmentBundle {
  readonly zip: Uint8Array;
  readonly manifest: BundleManifest;
  readonly objects: number;
}

export type BundleError =
  | "unsafe_archive"
  | "too_large"
  | "invalid_manifest"
  | "missing_object"
  | "digest_mismatch"
  | "unavailable";

export interface InspectedBundle {
  readonly manifest: BundleManifest;
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly includesObjects: boolean;
}

export type BundleInspection =
  | { readonly ok: true; readonly bundle: InspectedBundle }
  | { readonly ok: false; readonly error: BundleError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function safeLabel(value: unknown, max = 255): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes("/") &&
    !value.includes("\\") &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toBundleAsset(asset: AssetRecord): BundleAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
    sha256: asset.sha256,
    originalId: asset.originalId,
    originalSha256: asset.originalSha256,
    coverage: { kind: "entire-file" },
    ...(asset.conversion
      ? {
          conversion: {
            version: 1 as const,
            modality: "text" as const,
            preparationVersion: asset.conversion.preparationVersion,
            warnings: [...asset.conversion.warnings],
            conversion: {
              ...asset.conversion.conversion,
              converter: { ...asset.conversion.conversion.converter },
              coverage: {
                ...asset.conversion.conversion.coverage,
                omitted: asset.conversion.conversion.coverage.omitted.map((item) => ({
                  ...item,
                })),
              },
            },
          },
        }
      : {}),
  };
}

const EXTRACTION_FORMATS: readonly ExtractionFormat[] = [
  "pdf",
  "docx",
  "odt",
  "xlsx",
  "ods",
  "pptx",
  "odp",
];

function validConversion(value: unknown): ConvertedPreparationMetadata | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "modality", "preparationVersion", "warnings", "conversion"])
  ) {
    return null;
  }
  const conversion = isRecord(value.conversion) ? value.conversion : null;
  const converter = conversion && isRecord(conversion.converter) ? conversion.converter : null;
  if (
    value.version !== 1 ||
    value.modality !== "text" ||
    !safeLabel(value.preparationVersion, 128) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 64 ||
    value.warnings.some((warning) => !safeLabel(warning)) ||
    !conversion ||
    !exactKeys(conversion, [
      "contractVersion",
      "format",
      "converter",
      "selectionDigest",
      "proposalDigest",
      "coverage",
      "createdAt",
    ]) ||
    conversion.contractVersion !== 1 ||
    !EXTRACTION_FORMATS.includes(conversion.format as ExtractionFormat) ||
    !converter ||
    !exactKeys(converter, ["name", "version"]) ||
    !safeLabel(converter.name, 64) ||
    !safeLabel(converter.version, 64) ||
    typeof conversion.selectionDigest !== "string" ||
    !DIGEST.test(conversion.selectionDigest) ||
    typeof conversion.proposalDigest !== "string" ||
    !DIGEST.test(conversion.proposalDigest) ||
    !safeCount(conversion.createdAt)
  ) {
    return null;
  }
  const coverage = validateExtractionCoverage(conversion.coverage);
  if (!coverage) return null;
  return {
    version: 1,
    modality: "text",
    preparationVersion: value.preparationVersion,
    warnings: [...value.warnings] as string[],
    conversion: {
      contractVersion: 1,
      format: conversion.format as ExtractionFormat,
      converter: { name: converter.name, version: converter.version },
      selectionDigest: conversion.selectionDigest,
      proposalDigest: conversion.proposalDigest,
      coverage,
      createdAt: conversion.createdAt,
    },
  };
}

function validAsset(value: unknown, seen: Set<string>): BundleAsset | null {
  if (!isRecord(value)) return null;
  const hasConversion = Object.prototype.hasOwnProperty.call(value, "conversion");
  if (
    !exactKeys(value, [
      "id",
      "kind",
      "name",
      "mimeType",
      "size",
      "sha256",
      "originalId",
      "originalSha256",
      "coverage",
      ...(hasConversion ? ["conversion"] : []),
    ])
  ) {
    return null;
  }
  const coverage = isRecord(value.coverage) ? value.coverage : null;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 512 ||
    seen.has(value.id) ||
    (value.kind !== "original" && value.kind !== "representation") ||
    !safeLabel(value.name) ||
    typeof value.mimeType !== "string" ||
    value.mimeType.length === 0 ||
    value.mimeType.length > 255 ||
    !safeCount(value.size) ||
    value.size > MAX_BUNDLE_OBJECT_BYTES ||
    typeof value.sha256 !== "string" ||
    !DIGEST.test(value.sha256) ||
    (value.originalId !== null &&
      (typeof value.originalId !== "string" || value.originalId.length === 0)) ||
    (value.originalSha256 !== null &&
      (typeof value.originalSha256 !== "string" || !DIGEST.test(value.originalSha256))) ||
    !coverage ||
    !exactKeys(coverage, ["kind"]) ||
    coverage.kind !== "entire-file" ||
    (hasConversion &&
      (value.kind !== "representation" ||
        value.mimeType !== "text/plain" ||
        !validConversion(value.conversion)))
  ) {
    return null;
  }
  seen.add(value.id);
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    sha256: value.sha256,
    originalId: value.originalId,
    originalSha256: value.originalSha256,
    coverage: { kind: "entire-file" },
    ...(hasConversion ? { conversion: validConversion(value.conversion)! } : {}),
  };
}

function parseManifest(value: unknown): BundleManifest | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "createdAt", "includesObjects", "assets"]) ||
    value.version !== ATTACHMENT_BUNDLE_VERSION ||
    !safeCount(value.createdAt) ||
    typeof value.includesObjects !== "boolean" ||
    !Array.isArray(value.assets) ||
    value.assets.length === 0 ||
    value.assets.length > MAX_BUNDLE_ENTRIES
  ) {
    return null;
  }
  const seen = new Set<string>();
  const assets: BundleAsset[] = [];
  for (const item of value.assets) {
    const asset = validAsset(item, seen);
    if (!asset) return null;
    assets.push(asset);
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const asset of assets) {
    if (asset.kind === "original") {
      if (asset.originalId !== null || asset.originalSha256 !== null) return null;
      continue;
    }
    const original = asset.originalId ? byId.get(asset.originalId) : undefined;
    if (!original || original.kind !== "original" || original.sha256 !== asset.originalSha256) {
      return null;
    }
  }
  return {
    version: ATTACHMENT_BUNDLE_VERSION,
    createdAt: value.createdAt,
    includesObjects: value.includesObjects,
    assets,
  };
}

/**
 * Build a portable bundle from already-authorized asset records.
 *
 * The caller owns authorization: only assets with a live owner may be passed.
 * With `includeObjects: false` the result is a provenance manifest only.
 */
export async function createAttachmentBundle(input: {
  readonly assets: readonly AssetRecord[];
  readonly read: (asset: AssetRecord) => Promise<Uint8Array>;
  readonly includeObjects: boolean;
  readonly now: number;
}): Promise<AttachmentBundle> {
  if (
    !Array.isArray(input.assets) ||
    input.assets.length === 0 ||
    input.assets.length > MAX_BUNDLE_ENTRIES ||
    !safeCount(input.now)
  ) {
    return Promise.reject(new Error("attachment bundle: unavailable"));
  }
  const assets = input.assets.map(toBundleAsset);
  const manifest: BundleManifest = {
    version: ATTACHMENT_BUNDLE_VERSION,
    createdAt: input.now,
    includesObjects: input.includeObjects,
    assets,
  };
  const entries: Record<string, Uint8Array> = {
    "bundle.json": strToU8(JSON.stringify(manifest)),
  };
  if (input.includeObjects) {
    let total = 0;
    const byDigest = new Map<string, Uint8Array>();
    for (const asset of input.assets) {
      let bytes: Uint8Array;
      try {
        bytes = await input.read(asset);
      } catch {
        return Promise.reject(new Error("attachment bundle: unavailable"));
      }
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== asset.size ||
        sameDigest(bytes) !== asset.sha256
      ) {
        return Promise.reject(new Error("attachment bundle: digest_mismatch"));
      }
      total += bytes.byteLength;
      if (total > MAX_BUNDLE_TOTAL_BYTES) {
        return Promise.reject(new Error("attachment bundle: too_large"));
      }
      if (!byDigest.has(asset.sha256)) byDigest.set(asset.sha256, bytes);
    }
    for (const [digest, bytes] of byDigest) entries[`objects/${digest}`] = bytes;
  }
  const zip = zipSync(entries, { level: 6 });
  if (zip.byteLength > MAX_BUNDLE_ZIP_BYTES) {
    return Promise.reject(new Error("attachment bundle: too_large"));
  }
  return { zip, manifest, objects: Object.keys(entries).length - 1 };
}

/**
 * Validate a bundle before any bytes reach the profile.
 *
 * The zip filter bounds the declared original size before extraction, so a
 * compression bomb is rejected without allocating its expansion.
 */
export function inspectAttachmentBundle(
  zip: Uint8Array,
  options: {
    readonly maxZipBytes?: number;
    readonly maxTotalBytes?: number;
    readonly maxEntries?: number;
    readonly maxObjectBytes?: number;
  } = {},
): BundleInspection {
  const maxZipBytes = options.maxZipBytes ?? MAX_BUNDLE_ZIP_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_BUNDLE_TOTAL_BYTES;
  const maxEntries = options.maxEntries ?? MAX_BUNDLE_ENTRIES;
  const maxObjectBytes = options.maxObjectBytes ?? MAX_BUNDLE_OBJECT_BYTES;
  if (!(zip instanceof Uint8Array) || zip.byteLength === 0 || zip.byteLength > maxZipBytes) {
    return { ok: false, error: "too_large" };
  }
  let declaredTotal = 0;
  let declaredEntries = 0;
  const names = new Set<string>();
  let invalid = false;
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(zip, {
      filter: (file) => {
        if (invalid) return false;
        declaredEntries++;
        if (declaredEntries > maxEntries) {
          invalid = true;
          return false;
        }
        const name = file.name;
        if (
          !name ||
          name.includes("\\") ||
          name.includes("..") ||
          name.startsWith("/") ||
          names.has(name)
        ) {
          invalid = true;
          return false;
        }
        const isManifest = name === "bundle.json";
        const isObject = /^objects\/[0-9a-f]{64}$/.test(name);
        if (!isManifest && !isObject) {
          invalid = true;
          return false;
        }
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
          invalid = true;
          return false;
        }
        if (file.originalSize > (isManifest ? MAX_MANIFEST_BYTES : maxObjectBytes)) {
          invalid = true;
          return false;
        }
        names.add(name);
        declaredTotal += file.originalSize;
        if (declaredTotal > maxTotalBytes) {
          invalid = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    return { ok: false, error: "unsafe_archive" };
  }
  if (invalid) return { ok: false, error: "too_large" };
  const manifestBytes = extracted["bundle.json"];
  if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    return { ok: false, error: "invalid_manifest" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(manifestBytes));
  } catch {
    return { ok: false, error: "invalid_manifest" };
  }
  const manifest = parseManifest(parsed);
  if (!manifest) return { ok: false, error: "invalid_manifest" };

  const objectEntries = Object.entries(extracted).filter(([name]) => name.startsWith("objects/"));
  const objects = new Map<string, Uint8Array>();
  for (const [name, bytes] of objectEntries) {
    const digest = name.slice("objects/".length);
    if (sameDigest(bytes) !== digest) return { ok: false, error: "digest_mismatch" };
    objects.set(digest, bytes);
  }
  const expected = new Set(manifest.assets.map((asset) => asset.sha256));
  if (manifest.includesObjects) {
    if (objects.size !== expected.size) return { ok: false, error: "missing_object" };
    for (const digest of expected) {
      if (!objects.has(digest)) return { ok: false, error: "missing_object" };
    }
    for (const asset of manifest.assets) {
      const bytes = objects.get(asset.sha256);
      if (!bytes || bytes.byteLength !== asset.size) {
        return { ok: false, error: "digest_mismatch" };
      }
    }
  } else if (objects.size > 0) {
    // A provenance bundle must not smuggle objects the manifest does not claim.
    return { ok: false, error: "invalid_manifest" };
  }
  return { ok: true, bundle: { manifest, objects, includesObjects: manifest.includesObjects } };
}

export interface AttachmentBundleImportResult {
  readonly originals: number;
  readonly representations: number;
}

function releaseImported(
  store: Pick<AttachmentStore, "releaseOwner">,
  owner: AssetOwner,
  imported: readonly { id: string; kind: AssetKind }[],
): Promise<void> {
  return (async () => {
    // Representations first: an original cannot be released while referenced.
    for (const asset of [...imported].sort((left, right) =>
      left.kind === "original" ? 1 : right.kind === "original" ? -1 : 0,
    )) {
      await store.releaseOwner(asset.id, owner).catch(() => undefined);
    }
  })();
}

/**
 * Import validated bundle objects as new assets for one explicit owner.
 *
 * Every asset gets a fresh app id; manifest ids are never reused. A failure (a
 * digest mismatch, a storage error, an interrupted write) cancels staging and
 * releases every committed owner, so a partial bundle never becomes retained
 * data or a permission.
 */
export async function importAttachmentBundle(
  store: Pick<
    AttachmentStore,
    "beginOriginal" | "beginRepresentation" | "append" | "commit" | "cancel" | "releaseOwner"
  > & {
    readonly recordConvertedPreparation?: AttachmentStore["recordConvertedPreparation"];
  },
  owner: AssetOwner,
  inspection: InspectedBundle,
): Promise<AttachmentBundleImportResult> {
  if (!inspection.includesObjects) throw new Error("attachment bundle: missing_object");
  const { manifest, objects } = inspection;
  const imported: Array<{ id: string; kind: AssetKind }> = [];
  const staged: Array<{ id: string; owner: AssetOwner }> = [];
  const ids = new Map<string, { id: string; sha256: string }>();
  const write = async (bytes: Uint8Array, id: string): Promise<void> => {
    for (let offset = 0; offset < bytes.byteLength;) {
      const length = Math.min(IMPORT_CHUNK, bytes.byteLength - offset);
      const written = await store.append(
        id,
        owner,
        offset,
        bytes.subarray(offset, offset + length),
      );
      if (written !== offset + length) throw new Error("attachment bundle: unavailable");
      offset += length;
    }
  };
  try {
    for (const asset of manifest.assets.filter((item) => item.kind === "original")) {
      const bytes = objects.get(asset.sha256);
      if (!bytes) throw new Error("attachment bundle: missing_object");
      const id = await store.beginOriginal({
        owner,
        name: asset.name,
        mimeType: asset.mimeType,
        size: bytes.byteLength,
      });
      staged.push({ id, owner });
      await write(bytes, id);
      const committed = await store.commit(id, owner, asset.sha256);
      staged.pop();
      imported.push({ id: committed.id, kind: "original" });
      ids.set(asset.id, { id: committed.id, sha256: committed.sha256 });
    }
    for (const asset of manifest.assets.filter((item) => item.kind === "representation")) {
      const bytes = objects.get(asset.sha256);
      const original = asset.originalId ? ids.get(asset.originalId) : undefined;
      if (!bytes || !original) throw new Error("attachment bundle: missing_object");
      const id = await store.beginRepresentation({
        owner,
        name: asset.name,
        mimeType: asset.mimeType,
        size: bytes.byteLength,
        originalId: original.id,
        originalSha256: original.sha256,
      });
      staged.push({ id, owner });
      await write(bytes, id);
      const committed = await store.commit(id, owner, asset.sha256);
      staged.pop();
      if (asset.conversion) {
        if (!store.recordConvertedPreparation) throw new Error("attachment bundle: unavailable");
        await store.recordConvertedPreparation(committed.id, owner, asset.conversion);
      }
      imported.push({ id: committed.id, kind: "representation" });
    }
  } catch (error) {
    for (const stage of staged) await store.cancel(stage.id, stage.owner).catch(() => undefined);
    await releaseImported(store, owner, imported);
    throw error;
  }
  return {
    originals: imported.filter((asset) => asset.kind === "original").length,
    representations: imported.filter((asset) => asset.kind === "representation").length,
  };
}
