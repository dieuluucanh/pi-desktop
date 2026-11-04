/**
 * The rail's scope rendering helpers.
 *
 * The rail used to pin a "scope line" under every panel title: a folder icon, the
 * project name and a button that took you to the owning project
 * (`RailScopeLine`). That row existed because the panel followed whichever tab
 * was on screen, so the panel had to tell the user which folder it meant and
 * offer a way back. Since the rail is now app chrome scoped to the **selected
 * project** (2026-10-30 project-scoped rail plan), the row is gone: the panel and
 * the sidebar always agree, and the panel header names the folder (its short
 * name, with the full path as the header's `title`).
 *
 * What remains here is the one piece the Documents note still needs: a folder's
 * short display name.
 */

/**
 * The folder's own name: the last non-empty segment of either separator.
 *
 * Paths reach the renderer from the host on every platform, and a Windows path
 * can still arrive with forward slashes (Electron normalises inconsistently), so
 * both separators are treated as boundaries. A path that is already a root —
 * `/` or `C:\` — is returned unchanged: trimming it would turn `C:\` into `C:`,
 * which reads like a drive-relative path rather than the root.
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
