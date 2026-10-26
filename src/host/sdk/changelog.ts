/**
 * The SDK changelog (2026-10-26 session-parity plan step 15).
 *
 * Terminal Pi's `/changelog` prints the file at `getChangelogPath()`. That
 * helper is not re-exported from this SDK's package root, but `getPackageDir()`
 * is, and its documented contract is the same: the package root that ships
 * `CHANGELOG.md`. Reading goes through an injected reader so this module stays
 * testable and free of `node:fs`.
 */

import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export interface ChangelogResult {
  path: string;
  /** Null when the packaged file is missing or unreadable (a fallback is shown). */
  text: string | null;
}

export const CHANGELOG_UNAVAILABLE =
  "This build does not ship Pi's changelog. `npm i -g @earendil-works/pi-coding-agent@latest` keeps the CLI's copy current.";

export function sdkChangelogPath(): string {
  return join(getPackageDir(), "CHANGELOG.md");
}

export async function readSdkChangelog(
  read: (path: string) => Promise<string | null>,
): Promise<ChangelogResult> {
  const path = sdkChangelogPath();
  try {
    const text = await read(path);
    return { path, text: text && text.length > 0 ? text : null };
  } catch {
    return { path, text: null };
  }
}
