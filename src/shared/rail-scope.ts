/**
 * The rail's **scope model**: which folder the docked panel acts on, and which
 * session belongs to it.
 *
 * The rail used to follow the active tab's `cwd`. Since the panel moved into the
 * app shell (2026-10-30 plan), two independent selections can exist — the
 * sidebar's project and the tab strip's session — so "which folder is the rail
 * about?" has to be answered by one pure rule instead of by whichever component
 * happens to read `activeTabId` first.
 *
 * The rule is the user's model: **the rail is project-scoped**. A selected
 * project wins; the active session's folder is only the fallback for a session
 * whose folder is not a remembered project. A `web` tab never supplies a folder,
 * because it has no Pi session and therefore no working tree.
 *
 * This module is React-free and Electron-free (architecture rule 1) so main, the
 * renderer and the tests share one definition.
 */

/** The minimum a caller must know about a tab to scope the rail. */
export interface RailScopeTab {
  kind: string;
  cwd: string;
  lastActiveAt: number;
}

/**
 * True when two paths name the same folder.
 *
 * Paths reach the app from three places (picked folders, Pi session JSONL, the
 * host's `cwd`) and Windows mixes separators, so the comparison ignores trailing
 * separators, slash direction and case. A root keeps its meaning: `C:\\` is the
 * drive root, while `C:` is drive-relative and refers to the shell's current
 * directory there, so trimming the separator must not merge them.
 */
export function sameFolder(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return normalizeFolder(left) === normalizeFolder(right);
}

/** One folder path, reduced to a comparable form (root-aware). */
function normalizeFolder(value: string): string {
  const trimmed = value.trim();
  // A drive root (`C:\`, `C:/`) keeps its separator; a bare `C:` does not have
  // one and means something else, so the two must not compare equal.
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return `${trimmed.slice(0, 2).toLowerCase()}/`;
  if (/^[\\/]+$/.test(trimmed)) return "/";
  return trimmed
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

export interface RailScopeInput {
  /** The selected project's folder (`state.project.path`), when there is one. */
  projectPath: string | null | undefined;
  /** The active tab, when one is selected. */
  activeTab?: { kind: string; cwd: string } | null;
}

/**
 * The folder every rail menu acts on, or null when there is nothing to scope to.
 *
 * The project wins because the rail is the project panel: after a project click
 * the rail must describe that project even if a session from a previous project
 * is still on screen for a moment. The active session's folder is the fallback
 * for a cwd that was never remembered as a project, and a `web` tab supplies
 * nothing.
 */
export function railScopeFolder(input: RailScopeInput): string | null {
  const project = input.projectPath?.trim();
  if (project && project.length > 0) return project;
  const tab = input.activeTab;
  if (!tab || tab.kind === "web") return null;
  const cwd = tab.cwd.trim();
  return cwd.length > 0 ? cwd : null;
}

/**
 * The most recently active tab in a folder, or null when the folder has no tab.
 *
 * Only **open** tabs count. A saved session on disk is a different thing: it has
 * no host, no working tree and no transcript until it is resumed, so jumping into
 * it would silently create a tab from a sidebar click. The Session Browser is the
 * explicit way to resume from disk (`continueMostRecent`).
 */
export function mostRecentTabForFolder<T extends RailScopeTab>(
  tabs: readonly T[],
  folder: string | null | undefined,
): T | null {
  if (!folder) return null;
  let best: T | null = null;
  for (const tab of tabs) {
    if (tab.kind === "web") continue;
    if (!sameFolder(tab.cwd, folder)) continue;
    if (!best || tab.lastActiveAt > best.lastActiveAt) best = tab;
  }
  return best;
}

/** The Documents menu's one-line note, or null when there is nothing to say. */
export type DocumentScopeNoteTone = "host" | "other";

export interface DocumentScopeNote {
  tone: DocumentScopeNoteTone;
  text: string;
}

export interface DocumentScopeNoteInput {
  /** The bridge's owning tab, as `officeDocumentScope` projects it. */
  host: { title: string; projectPath: string } | null;
  /** Whether the active tab is the host. */
  isHost: boolean;
  /** The folder the rail is scoped to (see {@link railScopeFolder}). */
  railFolder: string | null | undefined;
}

/**
 * What the Documents scope says above its actions.
 *
 * Three states, and only the first two are worth a line: this session is the
 * host, or the host is somewhere else. The host's *folder* is appended only when
 * it differs from the rail's folder, so a session in the host's own project is
 * not told twice where it is. With no host there is nothing to report — the body
 * already offers to start one.
 */
export function documentScopeNote(input: DocumentScopeNoteInput): DocumentScopeNote | null {
  const host = input.host;
  if (!host) return null;
  if (input.isHost) return { tone: "host", text: "This session is the Office host." };
  const same = sameFolder(host.projectPath, input.railFolder);
  return {
    tone: "other",
    text: same ? `Office host: ${host.title}` : `Office host: ${host.title} · ${host.projectPath}`,
  };
}
