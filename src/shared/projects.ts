/**
 * Projects and workspace management (plan step 10).
 *
 * The app treats a *project* as a folder the Pi agent runs in — the same unit
 * terminal Pi scopes a session to. This module is the one pure model shared by
 * the main process (persistence, folder creation), the host (inspection + trust)
 * and the renderer (the sidebar and welcome view), so all four agree on what a
 * project record is and what a trust answer means.
 *
 * Nothing here touches the filesystem or the SDK: it is data + sanitizers only.
 */

/** One remembered project (the app's own state, never Pi's). */
export interface ProjectRecord {
  /** Absolute folder path; the session `cwd`. */
  path: string;
  /** Display name (the last path segment), stored so a missing folder still shows. */
  name: string;
  /** When the project was first added, for stable ordering. */
  addedAt: number;
  /** When it was last opened, for recency ordering. */
  lastOpenedAt: number;
  /**
   * Whether app writes target this project's `.pi/settings.json` instead of the
   * shared global settings. Defaults to false (global). The app snapshots and
   * empties the project document when this is switched off.
   */
  useProjectSettings?: boolean;
}

/** One saved project settings document, kept while the toggle is off. */
export interface ProjectSettingsSnapshot {
  /** Serialized JSON object from `<project>/.pi/settings.json`. */
  json: string;
  /** When the snapshot was taken (`Date.now()`). */
  savedAt: number;
}

/** Bounds the snapshot kept in app state; a larger file must be trimmed first. */
export const MAX_PROJECT_SETTINGS_SNAPSHOT_CHARS = 512_000;

/** How many projects are remembered; the sidebar is a working set, not a disk index. */
export const MAX_PROJECTS = 30;

/** Longest accepted project path. */
export const MAX_PROJECT_PATH = 4096;

/** The last path segment of a project directory, used as its display name. */
export function projectNameOf(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Removes a trailing separator (except at the root) so paths compare equal. */
export function normalizeProjectPath(target: string): string {
  const trimmed = target.trim().replace(/[\\/]+$/, "");
  return trimmed.length === 0 ? target.trim() : trimmed;
}

function sanitizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function sanitizeTime(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Coerces one untrusted entry into a `ProjectRecord`, or null when unusable. */
export function sanitizeProjectRecord(value: unknown): ProjectRecord | null {
  // A legacy recent-project entry is a bare path string (see the app store).
  if (typeof value === "string") {
    const path = sanitizeText(value, MAX_PROJECT_PATH);
    if (!path) return null;
    return { path, name: projectNameOf(path), addedAt: 0, lastOpenedAt: 0 };
  }
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const rawPath = sanitizeText(source.path, MAX_PROJECT_PATH);
  if (!rawPath) return null;
  const path = normalizeProjectPath(rawPath);
  const record: ProjectRecord = {
    path,
    name: sanitizeText(source.name, 300) ?? projectNameOf(path),
    addedAt: sanitizeTime(source.addedAt, 0),
    lastOpenedAt: sanitizeTime(source.lastOpenedAt, 0),
  };
  const useProjectSettings = source.useProjectSettings === true;
  if (useProjectSettings) record.useProjectSettings = true;
  return record;
}

/**
 * Keeps the per-project settings snapshots small and well-formed. A snapshot is
 * the serialized object from `.pi/settings.json`; malformed JSON is dropped here
 * (the toggle service reports it when it actually tries to read the file).
 */
export function sanitizeProjectSettingsSnapshots(
  value: unknown,
): Record<string, ProjectSettingsSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const snapshots: Record<string, ProjectSettingsSnapshot> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_PROJECTS) break;
    const path = normalizeProjectPath(rawKey);
    if (path.length === 0 || path.length > MAX_PROJECT_PATH) continue;
    const record =
      rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
        ? (rawValue as Record<string, unknown>)
        : null;
    const json = typeof record?.json === "string" ? record.json : null;
    const savedAt = record?.savedAt;
    if (
      json === null ||
      json.length === 0 ||
      json.length > MAX_PROJECT_SETTINGS_SNAPSHOT_CHARS ||
      typeof savedAt !== "number" ||
      !Number.isFinite(savedAt) ||
      savedAt < 0
    ) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    } catch {
      continue;
    }
    snapshots[path] = { json, savedAt };
    count += 1;
  }
  return snapshots;
}

/** Sanitizes a persisted project list, dropping duplicates and unusable entries. */
export function sanitizeProjects(value: unknown): ProjectRecord[] {
  const input = Array.isArray(value) ? value : [];
  const projects: ProjectRecord[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const record = sanitizeProjectRecord(entry);
    if (!record || seen.has(record.path)) continue;
    seen.add(record.path);
    projects.push(record);
    if (projects.length >= MAX_PROJECTS) break;
  }
  return projects;
}

/**
 * Adds a project (or refreshes an existing one) and puts it first, which is how
 * "recent" is ordered. `now` is injected so tests do not depend on the clock.
 */
export function addProject(
  list: readonly ProjectRecord[],
  path: string,
  now: number,
): ProjectRecord[] {
  const normalized = normalizeProjectPath(path);
  if (normalized.length === 0 || normalized.length > MAX_PROJECT_PATH) return [...list];
  const existing = list.find((project) => project.path === normalized);
  const record: ProjectRecord = existing
    ? { ...existing, lastOpenedAt: now }
    : { path: normalized, name: projectNameOf(normalized), addedAt: now, lastOpenedAt: now };
  return [record, ...list.filter((project) => project.path !== normalized)].slice(0, MAX_PROJECTS);
}

/** Removes a project from the list. */
export function removeProject(list: readonly ProjectRecord[], path: string): ProjectRecord[] {
  const normalized = normalizeProjectPath(path);
  return list.filter((project) => project.path !== normalized);
}

/** Moves a project to `toIndex` (clamped); used by sidebar drag/reorder actions. */
export function reorderProject(
  list: readonly ProjectRecord[],
  path: string,
  toIndex: number,
): ProjectRecord[] {
  const normalized = normalizeProjectPath(path);
  const from = list.findIndex((project) => project.path === normalized);
  if (from === -1) return [...list];
  const target = Math.max(0, Math.min(list.length - 1, Math.floor(toIndex)));
  if (target === from) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (!moved) return [...list];
  next.splice(target, 0, moved);
  return next;
}

/** Updates a project's settings-scope toggle. */
export interface ProjectConfigPatch {
  useProjectSettings?: boolean;
}

export function updateProject(
  list: readonly ProjectRecord[],
  path: string,
  patch: ProjectConfigPatch,
): ProjectRecord[] {
  const normalized = normalizeProjectPath(path);
  return list.map((project) => {
    if (project.path !== normalized) return project;
    const useProjectSettings =
      patch.useProjectSettings === undefined
        ? project.useProjectSettings === true
        : patch.useProjectSettings === true;
    return {
      path: project.path,
      name: project.name,
      addedAt: project.addedAt,
      lastOpenedAt: project.lastOpenedAt,
      ...(useProjectSettings ? { useProjectSettings: true } : {}),
    };
  });
}

/** The record for a path, or null when the project is not remembered. */
export function findProject(
  list: readonly ProjectRecord[],
  path: string | null | undefined,
): ProjectRecord | null {
  if (!path) return null;
  const normalized = normalizeProjectPath(path);
  return list.find((project) => project.path === normalized) ?? null;
}

/**
 * Pi's session directory name for a cwd (`<agentDir>/sessions/<encoded>/`).
 *
 * Mirrors the SDK's `getDefaultSessionDirPath` encoding exactly (it is not a
 * package export): the leading separator is dropped and every `/`, `\` or `:`
 * becomes `-`, wrapped in `--`. `src/host/project-inspect` joins it with the
 * profile's `agentDir`; keeping the name here lets main and the renderer show a
 * path without importing the SDK.
 */
export function encodeSessionDirName(cwd: string): string {
  const stripped = cwd.replace(/[\\/]+$/, "").replace(/^[/\\]/, "");
  return `--${stripped.replace(/[/\\:]/g, "-")}--`;
}

// ---------------------------------------------------------------------------
// Trust (plan step 10)
// ---------------------------------------------------------------------------

/** A remembered trust decision: trusted, untrusted, or not decided yet. */
export type TrustDecision = boolean | null;

/**
 * The user's answer to the trust prompt.
 *  - `trust`  remember this project as trusted;
 *  - `never`  remember it as untrusted (project resources stay disabled);
 *  - `session` trust for this app run only, writing nothing to the trust store.
 */
export type TrustAnswer = "trust" | "never" | "session";

export function isTrustAnswer(value: unknown): value is TrustAnswer {
  return value === "trust" || value === "never" || value === "session";
}

export interface ProjectTrustStatus {
  cwd: string;
  /** The project ships resources that need a decision. */
  requiresTrust: boolean;
  /** The stored decision, or null when the user has not decided yet. */
  decision: TrustDecision;
  /** True when project resources may be loaded. */
  trusted: boolean;
  /** True when the app still has to ask before loading project resources. */
  needsPrompt: boolean;
}

// ---------------------------------------------------------------------------
// Inspection (the project header's data)
// ---------------------------------------------------------------------------

/** Which project-level Pi resources exist under `<cwd>/.pi/`. */
export interface PiProjectResources {
  settings: boolean;
  agentsMd: boolean;
  extensions: boolean;
  skills: boolean;
  prompts: boolean;
  themes: boolean;
  packages: boolean;
}

/** Everything the project header shows, computed by the host. */
export interface ProjectInspection {
  cwd: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  /** Current git branch, or null when the folder is not a repository / has no git. */
  gitBranch: string | null;
  resources: PiProjectResources;
  /** Pi's session directory for this cwd (`~/.pi/agent/sessions/--…--`). */
  sessionDir: string;
  trust: ProjectTrustStatus;
}

// ---------------------------------------------------------------------------
// IPC inputs (validated in main)
// ---------------------------------------------------------------------------

/** A mutating request against the remembered project list. */
export type ProjectMutation =
  | { action: "add"; path: string }
  | { action: "remove"; path: string }
  | { action: "reorder"; path: string; toIndex: number }
  | { action: "activate"; path: string | null }
  | { action: "update"; path: string; patch: ProjectConfigPatch };

export const PROJECT_ACTIONS = ["reveal", "terminal", "copy-path"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export function isProjectAction(value: unknown): value is ProjectAction {
  return typeof value === "string" && (PROJECT_ACTIONS as readonly string[]).includes(value);
}

export interface ProjectActionInput {
  path: string;
  action: ProjectAction;
}

export interface CreateProjectInput {
  /** Existing folder the new project directory is created in. */
  parentDir: string;
  /** New folder name (single path segment). */
  name: string;
  /** Run `git init` after creating the directory. */
  gitInit?: boolean;
}

export interface CloneProjectInput {
  /** Existing folder the clone is created in. */
  parentDir: string;
  /** Git URL (`https://`, `git@`, `ssh://`, …) or a local path. */
  url: string;
  /** Optional target folder name; defaults to the repository's last segment. */
  name?: string;
}

/** Result of creating/cloning a project; `ok:false` carries a user-readable reason. */
export interface ProjectOpResult {
  ok: boolean;
  path: string | null;
  error?: string;
}

/** The remembered list plus the active project, as the renderer needs it. */
export interface ProjectsSnapshot {
  projects: ProjectRecord[];
  activeProject: string | null;
}

/** Input for the project-panel "Use project settings" toggle. */
export interface ProjectSettingsToggleInput {
  path: string;
  enabled: boolean;
}

/** What the toggle did, plus the refreshed project list. */
export interface ProjectSettingsToggleResult extends ProjectsSnapshot {
  enabled: boolean;
  /** A non-empty project document was saved before being emptied. */
  saved: boolean;
  /** A saved snapshot was restored on enable. */
  restored: boolean;
  /** On enable, the current file was non-empty and was kept instead. */
  keptCurrent: boolean;
  settingsPath: string;
}
