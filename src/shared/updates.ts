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

export type UpdatePhase =
  /** A development build (or safe mode) has no update feed. */
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** False for a dev build, safe mode, or when the feed could not be wired. */
  supported: boolean;
  /** The version being offered, downloaded or installed. */
  version: string | null;
  /** Download progress, 0–100, while `phase === "downloading"`. */
  percent: number | null;
  bytesPerSecond: number | null;
  /** Release notes for the offered version, bounded and string-only. */
  releaseNotes: string | null;
  error: string | null;
  /** When the last check/progress event arrived (ms since epoch). */
  checkedAt: number | null;
}

export type UpdateEvent =
  | { type: "checking" }
  | { type: "available"; version: string; releaseNotes?: string | null }
  | { type: "not-available"; version?: string | null }
  | { type: "progress"; percent: number; bytesPerSecond?: number | null }
  | { type: "downloaded"; version?: string | null }
  | { type: "error"; message: string };

/** Release notes are metadata, not a document: a page is plenty. */
export const MAX_RELEASE_NOTES_LENGTH = 4_000;
export const MAX_UPDATE_ERROR_LENGTH = 2_000;

const PHASES: readonly UpdatePhase[] = [
  "unsupported",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "up-to-date",
  "error",
];

/** The starting state; `supported` is the app's own answer, not a guess. */
export function initialUpdateState(supported: boolean): UpdateState {
  return {
    phase: supported ? "idle" : "unsupported",
    supported,
    version: null,
    percent: null,
    bytesPerSecond: null,
    releaseNotes: null,
    error: null,
    checkedAt: null,
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

/**
 * Applies one updater event. Pure: the same state + event + clock always produce
 * the same result, which is what makes the banner's transitions testable.
 */
export function reduceUpdateState(
  state: UpdateState,
  event: UpdateEvent,
  now: number,
): UpdateState {
  if (!state.supported && event.type !== "error") {
    // A dev build ignores feed chatter; it can still surface a wiring error.
    return state;
  }
  switch (event.type) {
    case "checking":
      return { ...state, phase: "checking", error: null, checkedAt: now };
    case "available":
      return {
        ...state,
        phase: "available",
        version: boundedVersion(event.version) ?? state.version,
        releaseNotes: boundedText(event.releaseNotes, MAX_RELEASE_NOTES_LENGTH),
        percent: null,
        bytesPerSecond: null,
        error: null,
        checkedAt: now,
      };
    case "not-available":
      return {
        ...state,
        phase: "up-to-date",
        version: null,
        releaseNotes: null,
        percent: null,
        bytesPerSecond: null,
        error: null,
        checkedAt: now,
      };
    case "progress":
      return {
        ...state,
        phase: "downloading",
        percent: clampPercent(event.percent),
        bytesPerSecond: finiteNumber(event.bytesPerSecond),
        error: null,
      };
    case "downloaded":
      return {
        ...state,
        phase: "downloaded",
        version: boundedVersion(event.version) ?? state.version,
        percent: 100,
        bytesPerSecond: null,
        error: null,
        checkedAt: now,
      };
    case "error":
      return {
        ...state,
        phase: "error",
        error: boundedText(event.message, MAX_UPDATE_ERROR_LENGTH) ?? "Update failed",
        bytesPerSecond: null,
      };
  }
}

/** One action is available in each finished phase; the UI uses this to decide. */
export function updateAction(state: UpdateState): "download" | "install" | "check" | null {
  if (!state.supported) return null;
  if (state.phase === "available") return "download";
  if (state.phase === "downloaded") return "install";
  if (state.phase === "idle" || state.phase === "up-to-date" || state.phase === "error") {
    return "check";
  }
  return null;
}

/** A short, user-facing sentence for the current phase (used by the banner). */
export function describeUpdate(state: UpdateState): string {
  const version = state.version ? ` ${state.version}` : "";
  switch (state.phase) {
    case "unsupported":
      return "Updates are checked in installed builds only.";
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
    case "error":
      return state.error ?? "The update check failed.";
  }
}

/** Coerces an untrusted pushed payload into a valid `UpdateState`. */
export function sanitizeUpdateState(input: unknown): UpdateState {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const supported = source.supported === true;
  const phase = PHASES.includes(source.phase as UpdatePhase)
    ? (source.phase as UpdatePhase)
    : supported
      ? "idle"
      : "unsupported";
  return {
    phase,
    supported,
    version: boundedVersion(source.version),
    percent: clampPercent(source.percent),
    bytesPerSecond: finiteNumber(source.bytesPerSecond),
    releaseNotes: boundedText(source.releaseNotes, MAX_RELEASE_NOTES_LENGTH),
    error: boundedText(source.error, MAX_UPDATE_ERROR_LENGTH),
    checkedAt: finiteNumber(source.checkedAt),
  };
}
