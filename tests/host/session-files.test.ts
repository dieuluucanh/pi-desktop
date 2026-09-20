import { describe, expect, it } from "vitest";
import { resolveListedSession, SessionFileError } from "../../src/host/session-files";

/**
 * Session index validation (plan step 11).
 *
 * The control host resolves a session file against Pi's own index because only
 * Electron can move the file to the OS trash (main does that) and because a
 * closed session is renamed through the SDK's `SessionManager`. This module is
 * the guard: a renderer can never point an operation at a file that is not a
 * listed session of the shared profile.
 */

const SESSIONS = [
  { path: "C:\\Users\\u\\.pi\\agent\\sessions\\--a--\\s1.jsonl", id: "s1" },
  { path: "/home/u/.pi/agent/sessions/--b--/s2.jsonl", id: "s2" },
];

describe("resolveListedSession", () => {
  it("accepts a session that Pi itself lists", () => {
    expect(resolveListedSession(SESSIONS, SESSIONS[1]!.path)).toEqual({
      path: "/home/u/.pi/agent/sessions/--b--/s2.jsonl",
    });
  });

  it("refuses a path that is not a listed session", () => {
    expect(() => resolveListedSession(SESSIONS, "C:\\Users\\u\\.pi\\agent\\auth.json")).toThrow(
      SessionFileError,
    );
    expect(() => resolveListedSession(SESSIONS, "C:\\Users\\u\\.pi\\agent\\auth.json")).toThrow(
      /not part of this profile/,
    );
  });

  it("refuses a missing or malformed file argument", () => {
    expect(() => resolveListedSession(SESSIONS, undefined)).toThrow(/session file is required/);
    expect(() => resolveListedSession(SESSIONS, "")).toThrow(/session file is required/);
    expect(() => resolveListedSession(SESSIONS, 42)).toThrow(/session file is required/);
  });

  it("survives an index with malformed entries", () => {
    expect(() => resolveListedSession([null, "s1", 7, {}], "s1")).toThrow(SessionFileError);
  });

  it("uses the not_found code so the UI can refresh the list", () => {
    try {
      resolveListedSession(SESSIONS, "/tmp/nope.jsonl");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionFileError);
      expect((error as SessionFileError).code).toBe("not_found");
    }
  });
});
