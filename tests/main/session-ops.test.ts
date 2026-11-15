import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isDeletableSessionPath, sessionsDirOf } from "../../src/main/session-ops";

/**
 * Main-process session deletion containment (plan step 11).
 *
 * `shell.trashItem` is a destructive, recoverable-only operation: the tests below
 * pin that nothing but a JSONL inside the profile's own `sessions/` directory can
 * reach it. The fixtures use the **host** path flavour because the module calls
 * the host `node:path` functions (`isAbsolute`, `resolve`, `relative`); the
 * Windows containment rules are covered by the Windows CI job.
 */

const ROOT = sep === "\\" ? "C:\\" : "/";
const PROFILE = join(ROOT, "users", "u", ".pi", "agent");
const SESSIONS = join(PROFILE, "sessions");
const session = (...parts: string[]): string => join(SESSIONS, ...parts);
/** `join` collapses `..`, so the traversal cases need a literal join. */
const escape = (...parts: string[]): string => [SESSIONS, ...parts].join(sep);

describe("sessionsDirOf", () => {
  it("puts every session under the profile's sessions directory", () => {
    expect(sessionsDirOf(PROFILE)).toBe(SESSIONS);
  });
});

describe("isDeletableSessionPath", () => {
  it("accepts a session JSONL inside the profile", () => {
    const file = session("--work--", "s1.jsonl");
    expect(isDeletableSessionPath(file, PROFILE), file).toBe(true);
  });

  it("refuses a file outside the sessions directory", () => {
    expect(isDeletableSessionPath(join(PROFILE, "auth.json"), PROFILE)).toBe(false);
    expect(isDeletableSessionPath(join(PROFILE, "settings.json"), PROFILE)).toBe(false);
    expect(isDeletableSessionPath(join(PROFILE, "sessions.jsonl"), PROFILE)).toBe(false);
  });

  it("refuses traversal and absolute escapes", () => {
    expect(
      isDeletableSessionPath(escape("..", "..", "..", "Windows", "system.jsonl"), PROFILE),
    ).toBe(false);
    expect(isDeletableSessionPath(escape("..", "..", "..", "etc", "pass.jsonl"), PROFILE)).toBe(
      false,
    );
  });

  it("refuses a directory, a non-jsonl file and a non-string", () => {
    expect(isDeletableSessionPath(session("--work--"), PROFILE)).toBe(false);
    expect(isDeletableSessionPath(session("--work--", "notes.txt"), PROFILE)).toBe(false);
    expect(isDeletableSessionPath(undefined, PROFILE)).toBe(false);
    expect(isDeletableSessionPath(42, PROFILE)).toBe(false);
    expect(isDeletableSessionPath("", PROFILE)).toBe(false);
  });

  it("refuses the sessions directory itself", () => {
    expect(isDeletableSessionPath(SESSIONS, PROFILE)).toBe(false);
  });
});
