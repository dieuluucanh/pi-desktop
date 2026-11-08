/**
 * Types for `scripts/electron-builder-after-pack.mjs`.
 *
 * `tsconfig.node.json` typechecks `tests/**` but does not include `scripts/**`,
 * so a test that imports the hook needs this declaration (same convention as
 * `extension-package.d.mts`). Keep it in step with the implementation.
 */

/** The subset of electron-builder's `AfterPackContext` the hook reads. */
export interface AfterPackContext {
  /** `context.electronPlatformName`, e.g. `win32`, `linux`, `darwin`. */
  electronPlatformName: string;
  /** `Arch` enum value from `builder-util` (0 ia32, 1 x64, 2 armv7l, 3 arm64). */
  arch: number;
  /** The directory electron-builder packed this target into. */
  appOutDir: string;
  packager: {
    projectDir: string;
    /** electron-builder's app metadata; the hook reads `version`. */
    appInfo?: { version?: string };
    /** `<appOutDir>/resources` on every platform this app ships for. */
    getResourcesDir(appOutDir: string): string;
  };
}

/**
 * Deletes every runtime directory under `nodeDir` except `target`
 * (`<platform>-<arch>`), and returns the removed names sorted.
 */
export function pruneForeignRuntimes(nodeDir: string, target: string): string[];

/** The file the hook writes and the app reads. */
export const BUILD_INFO_FILE: string;

/** `local` for a workstation build, `release` for GitHub Actions. */
export type BuildChannel = "local" | "release";

/** Decides the channel from `PI_BUILD_CHANNEL` / `GITHUB_ACTIONS`. */
export function buildChannelFromEnv(env?: Record<string, string | undefined>): BuildChannel;

/** How a macOS package was signed; `none` on every other platform. */
export type MacSigning = "developer-id" | "adhoc" | "none";

/** Reads `PI_MAC_SIGNING`; anything unset or unrecognised is `none`. */
export function macSigningFromEnv(env?: Record<string, string | undefined>): MacSigning;

export interface BuildInfoDocument {
  channel: BuildChannel | "unknown";
  version: string | null;
  commit: string | null;
  builtAt: string | null;
  macSigning: MacSigning;
}

/** The JSON document written into `resources/build-info.json`. */
export function buildInfoDocument(input: {
  version?: unknown;
  channel?: unknown;
  commit?: unknown;
  builtAt?: unknown;
  /** `context.electronPlatformName`; signing is only recorded for `darwin`. */
  platform?: string;
  macSigning?: unknown;
}): BuildInfoDocument;

/** Writes the provenance file and returns its path. */
export function writeBuildInfo(
  resourcesDir: string,
  info: Parameters<typeof buildInfoDocument>[0],
): string;

/** Prunes foreign runtimes, stamps build provenance, then rewrites the shims. */
export default function afterPack(context: AfterPackContext): Promise<void>;

/** Throws when the asar-unpacked terminal host bundle is missing. */
export function assertTerminalBundle(resourcesDir: string): string;

/** Runs the ELF floor check; throws when the binary needs a newer runtime. */
export function verifyNativeFloor(binary: string): {
  binary: string;
  glibc: string | null;
  glibcxx: string | null;
};

/**
 * Makes the packaged node-pty's `spawn-helper` path rewrite idempotent (the
 * upstream 1.1.0 bug appends `.unpacked` twice on macOS). Throws when the
 * expected upstream source is gone, so an upgrade cannot silently ship it.
 */
export function patchNodePtyHelperPath(moduleDir: string): {
  patched: boolean;
  file: string;
  reason: "patched" | "already-patched";
};
