/**
 * Build provenance (2026-11-01 update plan).
 *
 * `electron-builder`'s `afterPack` hook writes `resources/build-info.json` into
 * a packaged app. This module is the pure parser for it: a packaged build can
 * say whether it came from local packaging or a release CI run, which is what
 * lets a local installer skip the update feed instead of turning a missing
 * release into an "Update failed" banner.
 *
 * The file is metadata, not user data: a missing or malformed document falls
 * back to `unknown` rather than being repaired.
 */

export type BuildChannel = "dev" | "local" | "release" | "unknown";

export const BUILD_CHANNELS: readonly BuildChannel[] = ["dev", "local", "release", "unknown"];

/**
 * How a macOS package was signed, recorded at pack time.
 *
 * Only `developer-id` produces a signature Squirrel.Mac will accept for an
 * in-app update: an ad-hoc signature's designated requirement is cdhash-based
 * and changes with every build, so the updater would download an update it can
 * never install. `none` covers an unsigned bundle and every non-macOS package.
 */
export type MacSigning = "developer-id" | "adhoc" | "none";

export const MAC_SIGNING_VALUES: readonly MacSigning[] = ["developer-id", "adhoc", "none"];

export interface BuildInfo {
  channel: BuildChannel;
  /** The version the package was built as, from electron-builder's app info. */
  version: string | null;
  /** Short git commit, when the build host had a git checkout. */
  commit: string | null;
  /** ISO timestamp written by `afterPack`. */
  builtAt: string | null;
  /** macOS signing identity kind; `none` on every other platform. */
  macSigning: MacSigning;
}

/** The one file `afterPack` writes and `src/main/build-info.ts` reads. */
export const BUILD_INFO_FILE = "build-info.json";

const MAX_FIELD_LENGTH = 200;

function boundedText(value: unknown, max = MAX_FIELD_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** A development run has no packaged provenance. */
export function devBuildInfo(): BuildInfo {
  return { channel: "dev", version: null, commit: null, builtAt: null, macSigning: "none" };
}

/** A packaged build whose provenance file is missing or invalid. */
export function unknownBuildInfo(): BuildInfo {
  return { channel: "unknown", version: null, commit: null, builtAt: null, macSigning: "none" };
}

/** Coerces an untrusted JSON document into a valid `BuildInfo`. */
export function parseBuildInfo(input: unknown): BuildInfo {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const channel = BUILD_CHANNELS.includes(source.channel as BuildChannel)
    ? (source.channel as BuildChannel)
    : "unknown";
  return {
    channel,
    version: boundedText(source.version),
    commit: boundedText(source.commit),
    builtAt: boundedText(source.builtAt),
    // A package built before this field existed reports "none": the safe
    // default, because an unknown signature can never satisfy Squirrel.Mac.
    macSigning: MAC_SIGNING_VALUES.includes(source.macSigning as MacSigning)
      ? (source.macSigning as MacSigning)
      : "none",
  };
}
