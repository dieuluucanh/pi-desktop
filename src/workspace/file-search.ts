/**
 * Project-wide file search for the Explorer.
 *
 * The tree is lazy, so a filter over loaded rows can never find a file in a
 * collapsed folder. This engine reuses the flat, gitignore-aware listing and
 * ranks every candidate by name and path, without reading file contents.
 *
 * Both the listing and this module are port-injected and free of Electron, so
 * the whole behaviour is unit-tested with an in-memory tree.
 */

import {
  DEFAULT_WORKSPACE_SEARCH_LIMIT,
  MAX_WORKSPACE_SEARCH_LIMIT,
  workspaceBasename,
  workspaceDirname,
  type WorkspaceSearchMatch,
} from "../shared/workspace";
import { MAX_FILE_LIMIT, listWorkspaceFiles, type FileListingIo } from "./file-listing";

export interface FileSearchOptions {
  /** Matched case-insensitively against the path; whitespace means "all terms". */
  query: string;
  /** Include dotfiles/dot-directories (default true). */
  includeHidden?: boolean;
  /** Include git-ignored files (default false). */
  includeIgnored?: boolean;
  /** Maximum matches to return (default 200, capped at 500). */
  limit?: number;
}

export interface FileSearchResult {
  matches: WorkspaceSearchMatch[];
  /** A scan or result cap cut the list; the UI must say so. */
  truncated: boolean;
  /** Candidate files considered before ranking. */
  scanned: number;
}

export interface RankedSearchMatches {
  matches: WorkspaceSearchMatch[];
  /** Matching files before the result limit was applied. */
  total: number;
}

/**
 * Searches the project's flat file list. The listing is capped at
 * `MAX_FILE_LIMIT`, so `truncated` also covers "some files were never scanned".
 */
export async function searchWorkspaceFiles(
  io: FileListingIo,
  root: string,
  options: FileSearchOptions,
): Promise<FileSearchResult> {
  const query = options.query.trim();
  if (query.length === 0) return { matches: [], truncated: false, scanned: 0 };

  const limit = clampSearchLimit(options.limit);
  const listing = await listWorkspaceFiles(io, root, {
    limit: MAX_FILE_LIMIT,
    includeHidden: options.includeHidden ?? true,
    includeIgnored: options.includeIgnored ?? false,
  });
  const ranked = rankWorkspaceSearchMatches(listing.files, query, limit);
  return {
    matches: ranked.matches,
    truncated: listing.truncated || ranked.total > ranked.matches.length,
    scanned: listing.files.length,
  };
}

/**
 * Pure ranking used by the engine and by tests. Basename matches win over path
 * matches, and a shorter path wins a tie.
 */
export function rankWorkspaceSearchMatches(
  files: readonly string[],
  query: string,
  limit: number,
): RankedSearchMatches {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return { matches: [], total: 0 };
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  const max =
    Number.isFinite(limit) && limit > 0
      ? Math.max(1, Math.floor(limit))
      : DEFAULT_WORKSPACE_SEARCH_LIMIT;

  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const lowerPath = path.toLowerCase();
    if (!tokens.every((token) => lowerPath.includes(token))) continue;
    let score = scorePath(path, lowerPath, trimmed);
    // A multi-term query usually cannot be a contiguous basename/path match.
    if (tokens.length > 1 && !lowerPath.includes(trimmed)) score += 6;
    scored.push({ path, score });
  }

  scored.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    if (left.path.length !== right.path.length) return left.path.length - right.path.length;
    return left.path.localeCompare(right.path);
  });

  return {
    matches: scored.slice(0, max).map(({ path }) => ({
      path,
      name: workspaceBasename(path),
      directory: workspaceDirname(path),
    })),
    total: scored.length,
  };
}

function scorePath(path: string, lowerPath: string, lowerQuery: string): number {
  const name = workspaceBasename(path).toLowerCase();
  if (name === lowerQuery) return 0;
  if (name.startsWith(lowerQuery)) return 1;
  if (name.includes(lowerQuery)) return 2;
  if (lowerPath.split("/").some((segment) => segment.startsWith(lowerQuery))) return 3;
  if (lowerPath.includes(lowerQuery)) return 4;
  return 5;
}

function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_WORKSPACE_SEARCH_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_WORKSPACE_SEARCH_LIMIT);
}
