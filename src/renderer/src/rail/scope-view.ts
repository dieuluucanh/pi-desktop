/**
 * The rail's **scope line**, as data.
 *
 * The three rail menus act on three different things, and nothing in the UI said
 * so:
 *
 * | Menu           | Scope                  |
 * | -------------- | ---------------------- |
 * | Source Control | the active session cwd |
 * | Checkpoints    | a project **folder**   |
 * | Documents      | an app-wide bridge     |
 *
 * This module resolves "which folder are we talking about" into the three facts
 * the line renders (a short name, the full path, and the hover title), so the
 * component and its tests agree and the fallback rules live in one place.
 */

/** One path, split into what the line shows and what it hides. */
export interface ProjectScopeLabel {
  /** The last path segment — what fits in a 320 px column. */
  name: string;
  /** The full path, unchanged. */
  path: string;
  /** The `title` attribute: the full path, so hover reveals it. */
  title: string;
}

/**
 * The folder's own name: the last non-empty segment of either separator.
 *
 * Paths reach the renderer from the host on every platform, and a Windows path
 * can still arrive with forward slashes (Electron normalises inconsistently), so
 * both separators are treated as boundaries. A path that is already a root —
 * `/` or `C:\` — is returned unchanged: trimming it would turn `C:\` into
 * `C:`, which reads like a drive-relative path rather than the root.
 */
export function projectFolderName(path: string): string {
  // A root is a label in itself (`/`, `C:\`); stripping its only separator
  // would produce `C:`, which means something different on Windows.
  if (/^[A-Za-z]:[\\/]?$/.test(path) || /^[\\/]+$/.test(path)) return path;
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return path;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * The scope line for a folder, or `null` when there is no folder to name.
 *
 * A remembered project's stored `name` wins over the derived folder name: the
 * user may have renamed the project to something meaningful, and the scope line
 * should match the sidebar rather than disagree with it.
 */
export function projectScopeLabel(
  project: { path: string; name?: string | null } | null,
): ProjectScopeLabel | null {
  if (!project || project.path.length === 0) return null;
  const name =
    typeof project.name === "string" && project.name.trim().length > 0
      ? project.name.trim()
      : projectFolderName(project.path);
  return { name, path: project.path, title: project.path };
}
