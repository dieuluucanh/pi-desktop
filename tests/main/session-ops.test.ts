import { describe, expect, it } from "vitest";
import { isDeletableSessionPath, sessionsDirOf } from "../../src/main/session-ops";

/**
 * Main-process session deletion containment (plan step 11).
 *
 * `shell.trashItem` is a destructive, recoverable-only operation: the tests below
 * pin that nothing but a JSONL inside the profile's own `sessions/` directory can
 * reach it, on both Windows and POSIX path syntaxes.
 */

describe("sessionsDirOf", () => {
  it("puts every session under the profile's sessions directory", () => {
    expect(sessionsDirOf("C:\\Users\\u\\.pi\\agent")).toContain("sessions");
    expect(sessionsDirOf("/home/u/.pi/agent")).toContain("sessions");
  });
});

describe("isDeletableSessionPath", () => {
  const profiles = ["C:\\Users\\u\\.pi\\agent", "/home/u/.pi/agent"];

  it("accepts a session JSONL inside the profile", () => {
    for (const profile of profiles) {
      const file =
        profile === profiles[0]
          ? "C:\\Users\\u\\.pi\\agent\\sessions\\--work--\\s1.jsonl"
          : "/home/u/.pi/agent/sessions/--work--/s1.jsonl";
      expect(isDeletableSessionPath(file, profile), file).toBe(true);
    }
  });

  it("refuses a file outside the sessions directory", () => {
    expect(isDeletableSessionPath("C:\\Users\\u\\.pi\\agent\\auth.json", profiles[0]!)).toBe(false);
    expect(isDeletableSessionPath("/home/u/.pi/agent/settings.json", profiles[1]!)).toBe(false);
    expect(isDeletableSessionPath("C:\\Users\\u\\.pi\\agent\\sessions.jsonl", profiles[0]!)).toBe(
      false,
    );
  });

  it("refuses traversal and absolute escapes", () => {
    expect(
      isDeletableSessionPath(
        "C:\\Users\\u\\.pi\\agent\\sessions\\..\\..\\..\\Windows\\system.jsonl",
        profiles[0]!,
      ),
    ).toBe(false);
    expect(
      isDeletableSessionPath("/home/u/.pi/agent/sessions/../../../etc/pass.jsonl", profiles[1]!),
    ).toBe(false);
  });

  it("refuses a directory, a non-jsonl file and a non-string", () => {
    expect(
      isDeletableSessionPath("C:\\Users\\u\\.pi\\agent\\sessions\\--work--", profiles[0]!),
    ).toBe(false);
    expect(
      isDeletableSessionPath(
        "C:\\Users\\u\\.pi\\agent\\sessions\\--work--\\notes.txt",
        profiles[0]!,
      ),
    ).toBe(false);
    expect(isDeletableSessionPath(undefined, profiles[0]!)).toBe(false);
    expect(isDeletableSessionPath(42, profiles[0]!)).toBe(false);
    expect(isDeletableSessionPath("", profiles[0]!)).toBe(false);
  });

  it("refuses the sessions directory itself", () => {
    expect(isDeletableSessionPath(sessionsDirOf(profiles[1]!), profiles[1]!)).toBe(false);
  });
});
