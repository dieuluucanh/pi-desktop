/**
 * Session-file operations that belong to the control host (plan step 11).
 *
 * Deleting a session must be *recoverable*, so the file has to move to the OS
 * trash — and only Electron's `shell.trashItem` can do that, in the main
 * process. The host therefore does what it is actually good at: it checks the
 * requested file against Pi's own session index (`SessionManager.listAll`) and
 * resolves it to the canonical path. `src/main/ipc.ts` then trashes that path.
 * Renaming a session that is not open takes the same route, except the host can
 * finish it itself through `SessionManager.open(...).appendSessionInfo(name)`.
 *
 * Keeping the check here (rather than guessing from a path shape in main) means a
 * renderer can never point an operation at an arbitrary file: only sessions the
 * profile itself lists are accepted.
 */

/** The `SessionInfo` fields the resolver reads; the rest of Pi's shape is ignored. */
interface SessionIndexEntry {
  path?: unknown;
}

export class SessionFileError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.code = code;
  }
}

/**
 * Validates `sessionFile` against the profile's session index and returns the
 * canonical path. Throws `SessionFileError` for anything that is not an exact
 * match, so a stale renderer entry cannot act on a file Pi no longer owns.
 */
export function resolveListedSession(
  sessions: readonly unknown[],
  sessionFile: unknown,
): { path: string } {
  if (typeof sessionFile !== "string" || sessionFile.length === 0) {
    throw new SessionFileError("a session file is required");
  }
  const found = sessions.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as SessionIndexEntry).path === sessionFile;
  });
  if (!found) {
    throw new SessionFileError(
      "that session is not part of this profile — refresh the list before acting on it",
      "not_found",
    );
  }
  return { path: sessionFile };
}
