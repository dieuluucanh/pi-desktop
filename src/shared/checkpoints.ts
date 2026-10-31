/**
 * The checkpoint model (git-checkpoint plan step 17).
 *
 * A checkpoint is a snapshot of a whole folder — Office documents, images, code,
 * anything — taken into a **shadow git repository** that lives under the Pi
 * profile and never touches the project's own `.git`. This module is the pure
 * vocabulary: the record, the layout, the configuration, the commit-metadata
 * encoding that lets `git log` be the manifest, and the retention plan.
 *
 * Nothing here spawns a process or reads a file; `src/checkpoints/store.ts`
 * does that against injected ports.
 */

/** Why a snapshot was taken. */
export type CheckpointKind =
  /** Automatically, once per user prompt, before the prompt is processed. */
  | "run"
  /** The user pressed "Snapshot now". */
  | "manual"
  /** Before a destructive git action (discard, branch switch). */
  | "pre-op"
  /** Before a restore, so the restore itself is undoable. */
  | "pre-restore";

export const CHECKPOINT_KINDS: readonly CheckpointKind[] = [
  "run",
  "manual",
  "pre-op",
  "pre-restore",
] as const;

export function isCheckpointKind(value: unknown): value is CheckpointKind {
  return typeof value === "string" && (CHECKPOINT_KINDS as readonly string[]).includes(value);
}

/** One snapshot, as the rail lists it. */
export interface Checkpoint {
  /** Stable id: the commit sha of the snapshot. */
  id: string;
  /** The git ref the snapshot lives at (a sha, but kept separate for clarity). */
  ref: string;
  /** Epoch milliseconds. */
  createdAt: number;
  kind: CheckpointKind;
  /** The prompt snippet (run/manual) or the operation (pre-op/pre-restore). */
  label: string;
  /** The session entry this checkpoint belongs to, when one exists. */
  entryId: string | null;
  /** The Pi session file/id that produced it, when known. */
  sessionId: string | null;
  /** Files captured. */
  files: number;
  /** Total bytes of the captured tree (approximate; from `git ls-tree`). */
  bytes: number;
  /** Files skipped (unreadable, locked by an Office app, over the size cap). */
  skipped: number;
  /** Extra context (a git action name, a failure note). */
  note: string | null;
}

/* --------------------------------------------------------------- layout */

/** The sidecar inside the shadow repo recording which tree it snapshots. */
export const WORK_TREE_MARKER = "pi-work-tree";

/** The branch a shadow repo keeps its snapshots on. */
export const SHADOW_BRANCH = "main";

/** `<profileDir>/checkpoints` — inside the Pi profile (plan D5). */
export function checkpointsRoot(profileDir: string): string {
  return `${trimSeparators(profileDir)}/checkpoints`;
}

/**
 * A stable, filesystem-safe key for a project folder: its basename (for a human
 * looking at the profile) plus eight hex characters of a hash (for uniqueness).
 *
 * Implemented with a small FNV-1a hash rather than `node:crypto` so this module
 * stays importable by the renderer and by tests without a Node built-in.
 */
export function projectKeyFor(cwd: string): string {
  const normalised = trimSeparators(cwd).replace(/\\/g, "/");
  const parts = normalised.split("/");
  const basename = (parts[parts.length - 1] ?? "project").replace(/[^\w.-]+/g, "_");
  return `${basename || "project"}-${fnv1a(normalised).toString(16).padStart(8, "0")}`;
}

/** `<checkpointsRoot>/<projectKey>` — one shadow repo per project folder. */
export function shadowDirFor(profileDir: string, cwd: string): string {
  return `${checkpointsRoot(profileDir)}/${projectKeyFor(cwd)}`;
}

/** True when two folder spellings name the same place (case/separator-insensitive). */
export function sameWorkTree(left: string, right: string): boolean {
  const norm = (value: string): string => trimSeparators(value).replace(/\\/g, "/").toLowerCase();
  return norm(left) === norm(right);
}

function trimSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

/** FNV-1a, 32-bit. Small, stable and dependency-free. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/* --------------------------------------------------------------- config */

export interface CheckpointConfig {
  /** Whether checkpoints run at all (manual snapshots honour this too). */
  enabled: boolean;
  /** Most checkpoints kept per project (newest win). */
  maxPerSession: number;
  /** Age at which a checkpoint is pruned. */
  retentionDays: number;
  /** Hard byte budget for one project's shadow repo. */
  maxBytesPerProject: number;
  /** Files larger than this are skipped and counted, never fatal. */
  maxFileBytes: number;
  /** Minimum gap between idle scans, in ms. */
  scanIntervalMs: number;
  /** Extra ignore patterns, appended to the defaults. */
  exclude: string[];
}

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  maxPerSession: 100,
  retentionDays: 30,
  maxBytesPerProject: 2 * 1024 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  scanIntervalMs: 300_000,
  exclude: [],
};

/** The floor for the idle scan: a scan every few seconds is never useful. */
export const MIN_SCAN_INTERVAL_MS = 60_000;
/** Bounds the exclude list so a hostile config cannot balloon the matcher. */
export const MAX_EXCLUDE_PATTERNS = 200;

/**
 * Patterns added to the shadow repo's `info/exclude`. A non-git folder has no
 * `.gitignore`, and these are the files that would otherwise churn a snapshot
 * (Office lock files, build output, OS metadata).
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  // Office lock/owner files: `~$Report.docx`, `.~lock.Report.odt#`.
  "~$*",
  ".~lock.*#",
  // Build output and dependency trees.
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".cache/",
  "target/",
  "__pycache__/",
  // OS metadata and editor scratch files.
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "*.tmp",
  "*.swp",
  "*~",
];

/** Coerces an untrusted config document into the valid shape. */
export function sanitizeCheckpointConfig(value: unknown): CheckpointConfig {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const number = (raw: unknown, fallback: number, min: number, max: number): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  };
  const exclude = Array.isArray(source.exclude)
    ? source.exclude
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.length <= 200)
        .slice(0, MAX_EXCLUDE_PATTERNS)
    : DEFAULT_CHECKPOINT_CONFIG.exclude;

  return {
    enabled:
      typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CHECKPOINT_CONFIG.enabled,
    maxPerSession: number(source.maxPerSession, DEFAULT_CHECKPOINT_CONFIG.maxPerSession, 1, 1000),
    retentionDays: number(source.retentionDays, DEFAULT_CHECKPOINT_CONFIG.retentionDays, 1, 3650),
    maxBytesPerProject: number(
      source.maxBytesPerProject,
      DEFAULT_CHECKPOINT_CONFIG.maxBytesPerProject,
      64 * 1024 * 1024,
      100 * 1024 * 1024 * 1024,
    ),
    maxFileBytes: number(
      source.maxFileBytes,
      DEFAULT_CHECKPOINT_CONFIG.maxFileBytes,
      1024 * 1024,
      2 * 1024 * 1024 * 1024,
    ),
    scanIntervalMs: number(
      source.scanIntervalMs,
      DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs,
      MIN_SCAN_INTERVAL_MS,
      24 * 60 * 60 * 1000,
    ),
    exclude,
  };
}

/* ------------------------------------------------- commit metadata */

/** The one-line JSON header stored as a shadow commit's message. */
export interface CheckpointMetadata {
  /** Format version, so a future change can be read forward. */
  v: 1;
  id: string;
  kind: CheckpointKind;
  label: string;
  entryId: string | null;
  sessionId: string | null;
  files: number;
  skipped: number;
  note: string | null;
}

/** Serialises metadata into the commit message (one line, no newlines). */
export function encodeCommitMetadata(metadata: CheckpointMetadata): string {
  return JSON.stringify({
    ...metadata,
    label: oneLine(metadata.label),
    note: metadata.note ? oneLine(metadata.note) : null,
  });
}

/**
 * Parses a shadow commit's message. Returns null for anything that is not our
 * metadata, so a foreign commit in the repo (or a future format) is skipped
 * instead of crashing the list.
 */
export function decodeCommitMetadata(message: string): CheckpointMetadata | null {
  const text = message.trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.id !== "string" || !isCheckpointKind(record.kind)) return null;
  return {
    v: 1,
    id: record.id,
    kind: record.kind,
    label: typeof record.label === "string" ? record.label : "",
    entryId: typeof record.entryId === "string" ? record.entryId : null,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    files: typeof record.files === "number" && Number.isFinite(record.files) ? record.files : 0,
    skipped:
      typeof record.skipped === "number" && Number.isFinite(record.skipped) ? record.skipped : 0,
    note: typeof record.note === "string" ? record.note : null,
  };
}

/** Collapses whitespace so a metadata field can never break the one-line format. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/* ------------------------------------------------------------- retention */

export interface PruneCandidate {
  /** The checkpoint's id (commit sha). */
  id: string;
  createdAt: number;
  /** Approximate bytes this checkpoint is responsible for. */
  bytes: number;
  /**
   * Tie-breaker for ordering, ascending with age (the oldest candidate has the
   * smallest value).
   *
   * `createdAt` comes from git's `%ct`, which has **one-second** resolution, and
   * a burst of runs easily lands two snapshots in the same second. Sorting on
   * `createdAt` alone would then leave the order up to the sort's stability —
   * and picking the wrong one here drops the checkpoint the user is most likely
   * to restore. The shadow-repo log position is the real chronology, so the store
   * passes it. When omitted, the value is treated as unknown and the candidate is
   * kept (pruning a live checkpoint is worse than pruning nothing).
   */
  order?: number;
}

export interface PrunePlan {
  /** Ids to drop, newest-last (so a caller can walk them in order). */
  drop: string[];
  /** How many bytes the drop would free (approximate). */
  reclaimedBytes: number;
  /** Why each limit contributed, for Diagnostics and the Settings readout. */
  reasons: { tooOld: number; tooMany: number; overBudget: number };
}

/**
 * Decides which checkpoints to drop under the three limits, oldest first.
 *
 * The newest checkpoint is **never** dropped: pruning must not be able to leave
 * a project with nothing to restore to, even when a single snapshot is larger
 * than the whole budget.
 */
export function planPrune(
  entries: readonly PruneCandidate[],
  config: Pick<CheckpointConfig, "maxPerSession" | "retentionDays" | "maxBytesPerProject">,
  now: number,
): PrunePlan {
  // Age first; the log position breaks a same-second tie so the newest snapshot
  // can never be the one dropped. A missing `order` sorts last, i.e. is kept.
  const ordered = [...entries].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
  });
  const drop = new Set<string>();
  const reasons = { tooOld: 0, tooMany: 0, overBudget: 0 };

  const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of ordered) {
    if (entry.createdAt < cutoff) {
      drop.add(entry.id);
      reasons.tooOld += 1;
    }
  }

  const survivingCount = (): number => ordered.filter((entry) => !drop.has(entry.id)).length;
  for (const entry of ordered) {
    if (survivingCount() <= config.maxPerSession) break;
    if (drop.has(entry.id)) continue;
    drop.add(entry.id);
    reasons.tooMany += 1;
  }

  const totalBytes = (): number =>
    ordered.filter((entry) => !drop.has(entry.id)).reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of ordered) {
    if (totalBytes() <= config.maxBytesPerProject) break;
    // Keep the newest checkpoint no matter how large it is.
    if (entry.id === ordered[ordered.length - 1]?.id) break;
    if (drop.has(entry.id)) continue;
    drop.add(entry.id);
    reasons.overBudget += 1;
  }

  let reclaimedBytes = 0;
  for (const entry of ordered) {
    if (drop.has(entry.id)) reclaimedBytes += entry.bytes;
  }
  return { drop: [...drop], reclaimedBytes, reasons };
}

/** Human-readable retention summary for the rail and Settings. */
export function describeRetention(config: CheckpointConfig): string {
  const days = config.retentionDays === 1 ? "1 day" : `${config.retentionDays} days`;
  return `${config.maxPerSession} per project, ${days}, up to ${formatBytes(config.maxBytesPerProject)}`;
}

/** `1.2 GB`, `840 MB`, `12 KB` — for usage readouts. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** A label for a checkpoint row: its own label, or a sensible default. */
export function checkpointLabel(checkpoint: Checkpoint): string {
  const label = checkpoint.label.trim();
  if (label.length > 0) return label;
  switch (checkpoint.kind) {
    case "run":
      return "Before the prompt";
    case "manual":
      return "Manual snapshot";
    case "pre-op":
      return "Before a destructive action";
    case "pre-restore":
      return "Before a restore";
  }
}

/* ------------------------------------------------------------ rail state */

/**
 * Why the checkpoint rail cannot show a timeline. Every reason is a sentence the
 * rail renders — checkpoints never fail silently (D3).
 */
export type CheckpointUnavailableReason =
  /** No `git` on `PATH`; checkpoints are impossible, not merely empty. */
  | "git_missing"
  /** The config projection says disabled. */
  | "disabled"
  /** Safe mode: manual snapshots work, automatic prompt snapshots do not. */
  | "safe_mode"
  /** The shadow repo was created for a different folder (a copied profile). */
  | "work_tree_mismatch"
  /** The store failed in a way it could not classify. */
  | "unavailable";

/** One project's checkpoint surface, as the rail renders it. */
export interface CheckpointState {
  /** The folder this state is about (the session cwd / project path). */
  projectPath: string;
  available: boolean;
  /** Present exactly when `available` is false. */
  reason?: CheckpointUnavailableReason;
  /** A human sentence for `reason`. */
  message?: string;
  /** Whether the configured switches allow checkpointing at all. */
  enabled: boolean;
  /** The timeline, newest first. */
  checkpoints: Checkpoint[];
  /** Disk usage of this project's shadow repo. */
  usage: { checkpoints: number; bytes: number; maxBytes: number };
  /**
   * Whether run-scoped snapshots are live. False when the host predates the
   * checkpoint extension or safe mode is on, so the rail can say so instead of
   * waiting for a snapshot that will never arrive (R9).
   */
  runSnapshots: boolean;
  /** ISO timestamp of the read. */
  fetchedAt: string;
}

/** What a restore would do, as the confirm dialog shows it. */
export interface CheckpointPreviewState {
  /** Files the restore writes back to the checkpoint's content. */
  restore: string[];
  /** Files created after the checkpoint; removed only when opted in. */
  remove: string[];
  /** Files open in an Office pane right now (close them first). */
  openInOffice: string[];
}

/** The closed action union the rail may ask for. */
export type CheckpointAction =
  | { kind: "create"; label?: string }
  | { kind: "preview"; ref: string }
  | { kind: "restore"; ref: string; removeAdded?: boolean }
  | { kind: "prune" }
  | { kind: "usage" };

/** The outcome of one checkpoint action; never an exception across IPC. */
export interface CheckpointActionResult {
  ok: boolean;
  /** A one-line confirmation for the rail's status line. */
  message?: string;
  /** A failure sentence, already classified. */
  error?: string;
  /** Present for `preview`. */
  preview?: CheckpointPreviewState;
  /** Present for `create` — the checkpoint just taken. */
  checkpoint?: Checkpoint;
  /** Present for `restore` — the pre-restore ref, so the rail can offer Undo. */
  undoRef?: string;
  /** Present for `prune`/`usage`. */
  usage?: CheckpointState["usage"];
  /**
   * Why a `create` captured nothing: `same_tree` is normal (the folder had not
   * changed since the last checkpoint), not an error worth a banner.
   */
  skipped?: "same_tree";
}

/** True when a value is a plausible commit sha (the only shape a ref may take). */
export function isCheckpointRef(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** Parses an untrusted action payload from IPC. Never throws. */
export function parseCheckpointAction(value: unknown): CheckpointAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "create": {
      const label = typeof record.label === "string" ? record.label.trim().slice(0, 300) : "";
      return label.length > 0 ? { kind: "create", label } : { kind: "create" };
    }
    case "preview":
      return isCheckpointRef(record.ref) ? { kind: "preview", ref: record.ref } : null;
    case "restore": {
      if (!isCheckpointRef(record.ref)) return null;
      if (record.removeAdded !== undefined && typeof record.removeAdded !== "boolean") return null;
      return {
        kind: "restore",
        ref: record.ref,
        ...(record.removeAdded === true ? { removeAdded: true } : {}),
      };
    }
    case "prune":
      return { kind: "prune" };
    case "usage":
      return { kind: "usage" };
    default:
      return null;
  }
}

/**
 * The empty state for a folder nothing has been asked about yet. A caller that
 * has no service (safe mode, an older main) renders this rather than `undefined`,
 * so the section never flickers between "empty" and "unknown".
 */
export function emptyCheckpointState(projectPath: string, now: number): CheckpointState {
  return {
    projectPath,
    available: true,
    enabled: DEFAULT_CHECKPOINT_CONFIG.enabled,
    checkpoints: [],
    usage: {
      checkpoints: 0,
      bytes: 0,
      maxBytes: DEFAULT_CHECKPOINT_CONFIG.maxBytesPerProject,
    },
    runSnapshots: false,
    fetchedAt: new Date(now).toISOString(),
  };
}

/**
 * How a checkpoint relates to the session the rail is showing (plan step 25).
 *
 *  - `linked` — a turn of *this* session produced it, so the conversation can be
 *    rewound to it.
 *  - `from-before-fork` — the entry id belongs to an ancestor session. A fork
 *    inherits its ancestors' entries up to the fork point, but the conversation
 *    on screen is not the one that produced this checkpoint.
 *  - `unlinked` — a manual/pre-op/pre-restore snapshot, or another session's run:
 *    no conversation to navigate to.
 *
 * **One rule, one place.** The rail, the section and any future surface (a
 * terminal `/checkpoint` listing) must agree on which checkpoints can rewind a
 * conversation, because getting it wrong jumps the user somewhere they did not
 * ask for.
 */
export function checkpointLink(
  checkpoint: Pick<Checkpoint, "kind" | "entryId">,
  entryIds: ReadonlySet<string> | Readonly<Record<string, true>> | undefined,
): "linked" | "from-before-fork" | "unlinked" {
  // Only a *run* snapshot is tied to a turn: manual and safety snapshots carry a
  // null entry id by construction, and even one that carried an id could not
  // navigate a conversation it was not taken for.
  if (checkpoint.kind !== "run" || !checkpoint.entryId) return "unlinked";
  if (!entryIds) return "unlinked";
  const found =
    entryIds instanceof Set
      ? entryIds.has(checkpoint.entryId)
      : (entryIds as Readonly<Record<string, true>>)[checkpoint.entryId] === true;
  return found ? "linked" : "from-before-fork";
}

/** True when a checkpoint can rewind the conversation it is shown beside. */
export function canRewindCheckpoint(
  checkpoint: Pick<Checkpoint, "kind" | "entryId">,
  entryIds: ReadonlySet<string> | Readonly<Record<string, true>> | undefined,
): boolean {
  return checkpointLink(checkpoint, entryIds) === "linked";
}

const UNAVAILABLE_REASONS: readonly CheckpointUnavailableReason[] = [
  "git_missing",
  "disabled",
  "safe_mode",
  "work_tree_mismatch",
  "unavailable",
];

/**
 * Coerces a pushed/served checkpoint state into the valid shape.
 *
 * The renderer renders whatever main sends, so the same rule as git applies: an
 * unchecked payload is a trust boundary crossing. An unknown kind, a missing
 * ref or a negative count is dropped rather than rendered as a broken row.
 */
export function sanitizeCheckpointState(value: unknown): CheckpointState {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const projectPath = typeof record.projectPath === "string" ? record.projectPath : "";
  const available = record.available !== false;
  const reason = UNAVAILABLE_REASONS.includes(record.reason as CheckpointUnavailableReason)
    ? (record.reason as CheckpointUnavailableReason)
    : undefined;
  const state: CheckpointState = {
    projectPath,
    available,
    enabled: record.enabled !== false,
    checkpoints: sanitizeCheckpoints(record.checkpoints),
    usage: sanitizeUsage(record.usage),
    runSnapshots: record.runSnapshots === true,
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : new Date(0).toISOString(),
  };
  if (!available) {
    const fallback = reason ?? "unavailable";
    state.reason = fallback;
    state.message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : describeUnavailableFallback(fallback);
  }
  return state;
}

/** The renderer's copy of each reason's sentence (main sends its own too). */
function describeUnavailableFallback(reason: CheckpointUnavailableReason): string {
  switch (reason) {
    case "git_missing":
      return "Folder checkpoints need git. Install git and make sure it is on your PATH.";
    case "disabled":
      return "Checkpoints are turned off in Settings.";
    case "safe_mode":
      return "Automatic snapshots are off in safe mode. Manual snapshots still work.";
    case "work_tree_mismatch":
      return "These checkpoints were taken in a different folder; refusing to touch this one.";
    case "unavailable":
      return "The checkpoint store could not be read. See Diagnostics for details.";
  }
}

function sanitizeCheckpoints(value: unknown): Checkpoint[] {
  if (!Array.isArray(value)) return [];
  const out: Checkpoint[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const ref = typeof record.ref === "string" && isCheckpointRef(record.ref) ? record.ref : null;
    if (!ref || !isCheckpointKind(record.kind)) continue;
    out.push({
      id: typeof record.id === "string" ? record.id : ref,
      ref,
      createdAt: asCount(record.createdAt),
      kind: record.kind,
      label: typeof record.label === "string" ? record.label.slice(0, 300) : "",
      entryId: typeof record.entryId === "string" ? record.entryId : null,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      files: asCount(record.files),
      bytes: asCount(record.bytes),
      skipped: asCount(record.skipped),
      note: typeof record.note === "string" ? record.note.slice(0, 300) : null,
    });
    if (out.length >= 500) break;
  }
  return out;
}

function sanitizeUsage(value: unknown): CheckpointState["usage"] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    checkpoints: asCount(record.checkpoints),
    bytes: asCount(record.bytes),
    maxBytes:
      asCount(record.maxBytes) > 0
        ? asCount(record.maxBytes)
        : DEFAULT_CHECKPOINT_CONFIG.maxBytesPerProject,
  };
}

/** A non-negative integer from untrusted input. */
function asCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}
