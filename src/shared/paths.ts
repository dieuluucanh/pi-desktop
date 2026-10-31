/**
 * Path formatting shared by the app chrome and the session footer.
 *
 * The status bar shows the active project folder and the session footer shows
 * the session's working directory; both are long values that must stay readable
 * in a one-line bar. Keeping the rules here (instead of in either component)
 * means the two surfaces can never disagree about what "compact" means.
 *
 * Pure string handling only — no `node:path` — because the renderer bundles it
 * and must format both POSIX and Windows paths the same way the host reports
 * them.
 */

/** Longest visible path label before it is compacted to its last two segments. */
const MAX_PATH_CHARS = 44;

/** Strip trailing separators without turning a root (`/`, `C:\`) into `""`. */
function trimTrailingSeparators(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return value;
  // A drive root keeps one separator: `C:\` is not the same path as `C:`.
  if (/^[A-Za-z]:$/.test(trimmed) && value.length > trimmed.length) {
    return `${trimmed}${value.charAt(trimmed.length) || "\\"}`;
  }
  return trimmed;
}

/**
 * Replace a home-directory prefix with `~`, the way Pi's footer does.
 *
 * The comparison ignores separator style and drive-letter case (Windows), while
 * the returned suffix keeps the input's separator style. A path outside the home
 * folder is returned unchanged.
 */
export function tildePath(target: string, homeDir?: string | null): string {
  if (!homeDir) return target;
  const path = trimTrailingSeparators(target);
  const home = trimTrailingSeparators(homeDir);
  if (path.length === 0 || home.length === 0) return target;

  const toSlash = (value: string): string => value.replace(/\\/g, "/");
  const pathSlash = toSlash(path);
  const homeSlash = toSlash(home);
  const caseInsensitive = /^[A-Za-z]:/.test(homeSlash) || /^[A-Za-z]:/.test(pathSlash);
  const comparablePath = caseInsensitive ? pathSlash.toLowerCase() : pathSlash;
  const comparableHome = caseInsensitive ? homeSlash.toLowerCase() : homeSlash;

  if (comparablePath === comparableHome) return "~";
  if (!comparablePath.startsWith(`${comparableHome}/`)) return target;

  const rest = pathSlash.slice(homeSlash.length + 1);
  const separator = path.includes("\\") ? "\\" : "/";
  return separator === "\\" ? `~\\${rest.split("/").join("\\")}` : `~/${rest}`;
}

/**
 * Short visible form of a path: a long value keeps only its last two segments
 * with a `…` marker. The caller keeps the exact value in a `title`.
 */
export function compactPath(path: string): string {
  const trimmed = trimTrailingSeparators(path);
  if (trimmed.length === 0) return path;
  if (trimmed.length <= MAX_PATH_CHARS) return trimmed;
  const separator = trimmed.includes("\\") ? "\\" : "/";
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1] ?? trimmed;
  const parent = parts[parts.length - 2];
  if (!parent) return last;
  return `…${separator}${parent}${separator}${last}`;
}
