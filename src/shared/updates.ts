/**
 * Update checking and installation (plan step 26).
 *
 * The app ships through GitHub Releases and checks for a newer build with
 * `electron-updater`. This module is the pure half: a small state machine over
 * the events `electron-updater` emits, plus the sanitizer the renderer uses for
 * the pushed state. `electron-updater` itself stays in one Electron-only module
 * (`src/main/electron-updater.ts`) behind the `UpdatePort` in `src/main/updater.ts`,
 * so the policy is unit-tested without an Electron process or a network.
 *
 * Nothing here downloads on its own: `autoDownload` is off, so a check only
 * reports, and the user decides whether to download and restart.
 */

import { isOfflineError } from "./diagnostics";
import type { BuildChannel } from "./build-info";

export type UpdatePhase =
  /** A development build, safe mode, offline mode, or an unavailable updater. */
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  /** The build has no published release/feed; a benign state, not a failure. */
  | "no-feed"
  | "error";

/** Why this build cannot use the updater at all. */
export type UpdateUnsupportedReason =
  "development" | "safe-mode" | "offline" | "updater-unavailable";

/**
 * What went wrong. `no-feed` is deliberately separate from `error`: a locally
 * built or unpublished build has no feed, which is expected rather than broken.
 */
export type UpdateProblemKind =
  "no-feed" | "network" | "invalid-feed" | "invalid-version" | "download" | "install" | "unknown";

/** Which updater action produced an error, so a 404 is classified correctly. */
export type UpdateErrorContext = "check" | "download" | "install";

export interface UpdateState {
  phase: UpdatePhase;
  /** False for a dev build, safe mode, offline mode, or a wiring failure. */
  supported: boolean;
  /** Set only when `supported === false`. */
  unsupportedReason: UpdateUnsupportedReason | null;
  /** The running app version, used to reject a feed that offers an older build. */
  currentVersion: string;
  /** The version being offered, downloaded or installed. */
  version: string | null;
  /** Download progress, 0–100, while `phase === "downloading"`. */
  percent: number | null;
  bytesPerSecond: number | null;
  /** Release notes for the offered version, bounded and string-only. */
  releaseNotes: string | null;
  /** The last problem's raw text, bounded; shown under Technical details. */
  error: string | null;
  problemKind: UpdateProblemKind | null;
  /** True when the problem came from an automatic (startup) check. */
  problemAutomatic: boolean;
  /** When the last check/progress event arrived (ms since epoch). */
  checkedAt: number | null;
  /** Whether the most recent check was started by the startup timer. */
  lastCheckWasAutomatic: boolean;
}

export type UpdateEvent =
  | { type: "checking"; automatic?: boolean }
  | { type: "available"; version: string; releaseNotes?: string | null }
  | { type: "not-available"; version?: string | null }
  | { type: "progress"; percent: number; bytesPerSecond?: number | null }
  | { type: "downloaded"; version?: string | null }
  | { type: "error"; message: string; context?: UpdateErrorContext };

/** Release notes are metadata, not a document: a page is plenty. */
export const MAX_RELEASE_NOTES_LENGTH = 4_000;
export const MAX_UPDATE_ERROR_LENGTH = 2_000;

/** The public release page the Settings card links to. */
export const PI_DESKTOP_RELEASES_URL = "https://github.com/dieuluucanh/pi-desktop/releases";

const PHASES: readonly UpdatePhase[] = [
  "unsupported",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "up-to-date",
  "no-feed",
  "error",
];

const UNSUPPORTED_REASONS: readonly UpdateUnsupportedReason[] = [
  "development",
  "safe-mode",
  "offline",
  "updater-unavailable",
];

const PROBLEM_KINDS: readonly UpdateProblemKind[] = [
  "no-feed",
  "network",
  "invalid-feed",
  "invalid-version",
  "download",
  "install",
  "unknown",
];

export interface InitialUpdateOptions {
  currentVersion?: string;
  unsupportedReason?: UpdateUnsupportedReason | null;
}

export interface UpdatePrefs {
  /** Check once after launch (effective off for local/dev/offline builds). */
  autoCheck: boolean;
  /** An offered version whose status-bar chip the user dismissed. */
  dismissedVersion: string | null;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  autoCheck: true,
  dismissedVersion: null,
};

/** Keeps the updater preference object valid; unknown keys are dropped. */
export function sanitizeUpdatePrefs(input: unknown): UpdatePrefs {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    // A missing value means on: an older app-state.json did not ask to disable
    // update checks, and a fresh install should notice a new release.
    autoCheck: typeof source.autoCheck === "boolean" ? source.autoCheck : true,
    dismissedVersion: boundedVersion(source.dismissedVersion),
  };
}

/** Applies a partial patch without discarding the other update preference. */
export function mergeUpdatePrefs(current: UpdatePrefs, patch: unknown): UpdatePrefs {
  const source = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  return sanitizeUpdatePrefs({ ...current, ...source });
}

/** The support gate's answer: can this launch use the updater at all? */
export interface UpdateSupport {
  supported: boolean;
  reason: UpdateUnsupportedReason | null;
}

export interface UpdateSupportInput {
  isPackaged: boolean;
  safeMode: boolean;
  offline: boolean;
  portAvailable: boolean;
}

/** The one place the updater's support gate is decided. */
export function resolveUpdateSupport(input: UpdateSupportInput): UpdateSupport {
  if (!input.isPackaged) return { supported: false, reason: "development" };
  if (input.safeMode) return { supported: false, reason: "safe-mode" };
  if (input.offline) return { supported: false, reason: "offline" };
  if (!input.portAvailable) return { supported: false, reason: "updater-unavailable" };
  return { supported: true, reason: null };
}

/**
 * Whether the startup check may run. Local and dev packages are not on the
 * release feed, so they never auto-check; a manual check is still allowed.
 */
export function autoCheckAllowed(input: {
  support: UpdateSupport;
  autoCheck: boolean;
  buildChannel: BuildChannel;
}): boolean {
  return (
    input.support.supported &&
    input.autoCheck &&
    input.buildChannel !== "local" &&
    input.buildChannel !== "dev"
  );
}

/** The starting state; `supported` is the app's own answer, not a guess. */
export function initialUpdateState(
  supported: boolean,
  options: InitialUpdateOptions = {},
): UpdateState {
  return {
    phase: supported ? "idle" : "unsupported",
    supported,
    unsupportedReason: supported ? null : (options.unsupportedReason ?? "updater-unavailable"),
    currentVersion: boundedVersion(options.currentVersion) ?? "",
    version: null,
    percent: null,
    bytesPerSecond: null,
    releaseNotes: null,
    error: null,
    problemKind: null,
    problemAutomatic: false,
    checkedAt: null,
    lastCheckWasAutomatic: false,
  };
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function boundedVersion(value: unknown): string | null {
  return boundedText(value, 200);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, Math.round(number)));
}

interface ParsedVersion {
  parts: readonly [number, number, number];
  prerelease: readonly string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  const pre = match[4] ? match[4].split(".").filter((part) => part.length > 0) : [];
  return {
    parts: [major, minor, patch],
    prerelease: pre.length > 0 ? pre : null,
  };
}

function comparePrerelease(
  left: readonly string[] | null,
  right: readonly string[] | null,
): number {
  if (left === null && right === null) return 0;
  // A stable release sorts after every prerelease of the same version.
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    // A shorter prerelease sorts first when all its identifiers match.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers have lower precedence than alphanumeric ones.
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Compares two semver strings; invalid input compares as equal (never newer). */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    const aPart = a.parts[index] ?? 0;
    const bPart = b.parts[index] ?? 0;
    if (aPart !== bPart) return aPart < bPart ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** True only when both versions are valid and `candidate` is strictly newer. */
export function isVersionNewer(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (typeof candidate !== "string" || typeof current !== "string") return false;
  return compareVersions(candidate, current) > 0;
}

const NO_FEED_PATTERN =
  /err_updater_(?:latest_version_not_found|channel_file_not_found)|no published versions|cannot find latest(?:-linux|-arm64|-mac)?\.ya?ml|unable to find latest version|ensure a production release exists/i;
const INVALID_FEED_PATTERN = /err_updater_invalid_release_feed|cannot parse releases feed/i;
const INVALID_VERSION_PATTERN =
  /err_updater_invalid_version|not a valid semver version|does not have a valid semver version/i;

/**
 * Classifies an updater error. The context matters: a 404 while *checking*
 * means the build has no published release, while a 404 while *downloading*
 * means the artefact is missing and the download must be retried.
 */
export function classifyUpdateProblem(
  message: unknown,
  context: UpdateErrorContext = "check",
): UpdateProblemKind {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (context === "check" && (NO_FEED_PATTERN.test(text) || /(?:^|\D)404(?:\D|$)/.test(text))) {
    return "no-feed";
  }
  if (isOfflineError(text)) return "network";
  if (INVALID_FEED_PATTERN.test(text)) return "invalid-feed";
  if (INVALID_VERSION_PATTERN.test(text)) return "invalid-version";
  if (context === "download") return "download";
  if (context === "install") return "install";
  return "unknown";
}

function errorContextOf(state: UpdateState): UpdateErrorContext {
  if (state.phase === "downloading") return "download";
  if (state.phase === "downloaded") return "install";
  return "check";
}

/**
 * Applies one updater event. Pure: the same state + event + clock always produce
 * the same result, which is what makes the status chip and Settings card
 * transitions testable.
 */
export function reduceUpdateState(
  state: UpdateState,
  event: UpdateEvent,
  now: number,
): UpdateState {
  // A build with no updater ignores all feed chatter; the support reason is the
  // only honest answer, and recording wiring errors here only invented noise.
  if (!state.supported) return state;
  switch (event.type) {
    case "checking": {
      const automatic = event.automatic ?? state.lastCheckWasAutomatic;
      return {
        ...state,
        // An automatic check is background work: keep the settled phase and
        // never flash a "checking" chip the user did not ask for.
        phase: automatic ? state.phase : "checking",
        error: null,
        problemKind: null,
        problemAutomatic: false,
        checkedAt: now,
        lastCheckWasAutomatic: automatic,
      };
    }
    case "available": {
      const offered = boundedVersion(event.version) ?? state.version;
      // Defense in depth: electron-updater already compares semver, but a feed
      // that offers the running version (or an older one) must never surface as
      // an update. This is the local-build/version-mismatch guard.
      if (
        offered &&
        state.currentVersion.length > 0 &&
        !isVersionNewer(offered, state.currentVersion)
      ) {
        return {
          ...state,
          phase: "up-to-date",
          version: null,
          releaseNotes: null,
          percent: null,
          bytesPerSecond: null,
          error: null,
          problemKind: null,
          problemAutomatic: false,
          checkedAt: now,
        };
      }
      return {
        ...state,
        phase: "available",
        version: offered,
        releaseNotes: boundedText(event.releaseNotes, MAX_RELEASE_NOTES_LENGTH),
        percent: null,
        bytesPerSecond: null,
        error: null,
        problemKind: null,
        problemAutomatic: false,
        checkedAt: now,
      };
    }
    case "not-available":
      return {
        ...state,
        phase: "up-to-date",
        version: null,
        releaseNotes: null,
        percent: null,
        bytesPerSecond: null,
        error: null,
        problemKind: null,
        problemAutomatic: false,
        checkedAt: now,
      };
    case "progress":
      return {
        ...state,
        phase: "downloading",
        percent: clampPercent(event.percent),
        bytesPerSecond: finiteNumber(event.bytesPerSecond),
        error: null,
        problemKind: null,
        problemAutomatic: false,
      };
    case "downloaded":
      return {
        ...state,
        phase: "downloaded",
        version: boundedVersion(event.version) ?? state.version,
        percent: 100,
        bytesPerSecond: null,
        error: null,
        problemKind: null,
        problemAutomatic: false,
        checkedAt: now,
      };
    case "error": {
      const message = boundedText(event.message, MAX_UPDATE_ERROR_LENGTH) ?? "Update failed";
      const context = event.context ?? errorContextOf(state);
      const problemKind = classifyUpdateProblem(message, context);
      const problemAutomatic = state.lastCheckWasAutomatic;
      const base: UpdateState = {
        ...state,
        error: message,
        problemKind,
        problemAutomatic,
        bytesPerSecond: null,
        checkedAt: now,
      };

      if (context === "download") {
        // Keep the offer so Download can be retried.
        return {
          ...base,
          phase: state.version ? "available" : "error",
          percent: null,
        };
      }
      if (context === "install") {
        // Keep the downloaded build so Restart & install can be retried.
        return { ...base, phase: state.phase === "downloaded" ? "downloaded" : "error" };
      }
      if (state.version) {
        // A failed re-check must not throw away an existing offer. `percent`
        // survives the checking event, so a fully downloaded build stays
        // downloaded rather than falling back to "available".
        return { ...base, phase: state.percent === 100 ? "downloaded" : "available" };
      }
      if (problemKind === "no-feed") {
        return {
          ...base,
          phase: "no-feed",
          percent: null,
          releaseNotes: null,
        };
      }
      if (problemAutomatic) {
        // Background failures stay quiet: the settled phase is unchanged and
        // the problem is only visible in the Settings card.
        return { ...base, phase: state.phase === "checking" ? "idle" : state.phase };
      }
      return { ...base, phase: "error" };
    }
  }
}

/** One action is available in each finished phase; the UI uses this to decide. */
export function updateAction(state: UpdateState): "download" | "install" | "check" | null {
  if (!state.supported) return null;
  if (state.phase === "available") return "download";
  if (state.phase === "downloaded") return "install";
  if (
    state.phase === "idle" ||
    state.phase === "up-to-date" ||
    state.phase === "no-feed" ||
    state.phase === "error"
  ) {
    return "check";
  }
  return null;
}

/** A friendly sentence for a problem kind; the raw text stays in `error`. */
export function describeUpdateProblem(kind: UpdateProblemKind | null): string {
  switch (kind) {
    case "no-feed":
      return "No published release was found for this build.";
    case "network":
      return "Couldn't reach the update server. Check your connection and try again.";
    case "invalid-feed":
      return "The update feed could not be read.";
    case "invalid-version":
      return "The update server offered an invalid version.";
    case "download":
      return "The update download failed. Try again.";
    case "install":
      return "The update could not be installed. Try again.";
    default:
      return "The update check failed.";
  }
}

function describeUnsupported(reason: UpdateUnsupportedReason | null): string {
  switch (reason) {
    case "safe-mode":
      return "Updates are disabled in safe mode.";
    case "offline":
      return "Updates are disabled while PI_OFFLINE is set.";
    case "updater-unavailable":
      return "The updater is unavailable in this build.";
    default:
      return "Updates are checked in installed builds only.";
  }
}

/** A short, user-facing sentence for the current phase. */
export function describeUpdate(state: UpdateState): string {
  const version = state.version ? ` ${state.version}` : "";
  switch (state.phase) {
    case "unsupported":
      return describeUnsupported(state.unsupportedReason);
    case "idle":
      return "No update check has run yet.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Pi Desktop${version} is available.`;
    case "downloading":
      return state.percent === null
        ? `Downloading Pi Desktop${version}…`
        : `Downloading Pi Desktop${version} — ${state.percent}%`;
    case "downloaded":
      return `Pi Desktop${version} is ready to install.`;
    case "up-to-date":
      return "Pi Desktop is up to date.";
    case "no-feed":
      return describeUpdateProblem("no-feed");
    case "error":
      return describeUpdateProblem(state.problemKind);
  }
}

/** Coerces an untrusted pushed payload into a valid `UpdateState`. */
export function sanitizeUpdateState(input: unknown): UpdateState {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const supported = source.supported === true;
  const rawPhase = PHASES.includes(source.phase as UpdatePhase)
    ? (source.phase as UpdatePhase)
    : null;
  const phase = supported
    ? rawPhase && rawPhase !== "unsupported"
      ? rawPhase
      : "idle"
    : "unsupported";
  const rawReason = UNSUPPORTED_REASONS.includes(
    source.unsupportedReason as UpdateUnsupportedReason,
  )
    ? (source.unsupportedReason as UpdateUnsupportedReason)
    : null;
  const problemKind = PROBLEM_KINDS.includes(source.problemKind as UpdateProblemKind)
    ? (source.problemKind as UpdateProblemKind)
    : null;
  return {
    phase,
    supported,
    unsupportedReason: supported ? null : (rawReason ?? "updater-unavailable"),
    currentVersion: boundedVersion(source.currentVersion) ?? "",
    version: supported ? boundedVersion(source.version) : null,
    percent: supported ? clampPercent(source.percent) : null,
    bytesPerSecond: supported ? finiteNumber(source.bytesPerSecond) : null,
    releaseNotes: supported ? boundedText(source.releaseNotes, MAX_RELEASE_NOTES_LENGTH) : null,
    error: supported ? boundedText(source.error, MAX_UPDATE_ERROR_LENGTH) : null,
    problemKind: supported ? problemKind : null,
    problemAutomatic: supported && source.problemAutomatic === true,
    checkedAt: supported ? finiteNumber(source.checkedAt) : null,
    lastCheckWasAutomatic: supported && source.lastCheckWasAutomatic === true,
  };
}
