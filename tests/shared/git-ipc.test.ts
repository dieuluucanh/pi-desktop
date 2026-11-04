import { describe, expect, it } from "vitest";
import {
  MAX_LOG_PAGE,
  parseGitDiffRequest,
  parseGitLogRequest,
  requireProjectPath,
} from "../../src/shared/git";

/**
 * The IPC-boundary validators (git-checkpoint plan step 7).
 *
 * These three functions are the only thing between a renderer payload and a git
 * invocation that names a folder, a path or a page. They are tested here rather
 * than in `src/main/ipc.ts` because they are pure: `main/ipc.ts` is the
 * Electron-bound wiring, and `tests/architecture/security.test.ts` proves every
 * channel it registers is reachable from the preload.
 */

describe("requireProjectPath", () => {
  const known = ["C:\\work\\app", "/home/ada/notes"];

  it("accepts a known folder, including a trailing separator", () => {
    expect(requireProjectPath(known, "C:\\work\\app")).toBe("C:\\work\\app");
    expect(requireProjectPath(known, "C:\\work\\app\\")).toBe("C:\\work\\app\\");
    expect(requireProjectPath(known, "/home/ada/notes/")).toBe("/home/ada/notes/");
  });

  it("compares case-insensitively, so a round-tripped Windows path still works", () => {
    expect(requireProjectPath(known, "c:/WORK/App")).toBe("c:/WORK/App");
  });

  it("trims the value it echoes back", () => {
    expect(requireProjectPath(known, "  C:\\work\\app  ")).toBe("C:\\work\\app");
  });

  it("refuses a folder the renderer invented", () => {
    expect(() => requireProjectPath(known, "C:\\Windows\\System32")).toThrow(/not an open project/);
    expect(() => requireProjectPath(known, "/etc")).toThrow(/not an open project/);
    expect(() => requireProjectPath(known, "/home/ada/notes-secret")).toThrow(
      /not an open project/,
    );
  });

  it("refuses a traversal attempt", () => {
    expect(() => requireProjectPath(known, "C:\\work\\app\\..\\..\\Windows")).toThrow(
      /not an open project/,
    );
    expect(() => requireProjectPath(known, "/home/ada/notes/../../etc")).toThrow(
      /not an open project/,
    );
  });

  it("refuses an empty or non-string value", () => {
    expect(() => requireProjectPath(known, "")).toThrow(/project folder is required/);
    expect(() => requireProjectPath(known, "   ")).toThrow(/project folder is required/);
    expect(() => requireProjectPath(known, null)).toThrow(/project folder is required/);
    expect(() => requireProjectPath(known, 42)).toThrow(/project folder is required/);
    expect(() => requireProjectPath(known, undefined)).toThrow(/project folder is required/);
  });

  it("does not treat a prefix match as membership", () => {
    expect(() => requireProjectPath(["C:\\work\\app"], "C:\\work\\app-extra")).toThrow(
      /not an open project/,
    );
  });

  it("refuses every folder when the allowlist is empty", () => {
    expect(() => requireProjectPath([], "/home/ada/notes")).toThrow(/not an open project/);
  });
});

describe("parseGitDiffRequest", () => {
  it("accepts an empty request (the whole tree)", () => {
    expect(parseGitDiffRequest(undefined)).toEqual({});
    expect(parseGitDiffRequest({})).toEqual({});
  });

  it("accepts a safe path, a staged flag and a full sha", () => {
    expect(parseGitDiffRequest({ path: "src/app.ts", staged: true })).toEqual({
      path: "src/app.ts",
      staged: true,
    });
    expect(parseGitDiffRequest({ commit: "a".repeat(40) })).toEqual({ commit: "a".repeat(40) });
  });

  it("accepts a staged diff with no path", () => {
    expect(parseGitDiffRequest({ staged: true })).toEqual({ staged: true });
  });

  it("refuses an unsafe path", () => {
    expect(() => parseGitDiffRequest({ path: "../secret" })).toThrow(/invalid diff path/);
    expect(() => parseGitDiffRequest({ path: "/etc/passwd" })).toThrow(/invalid diff path/);
    expect(() => parseGitDiffRequest({ path: ".git/config" })).toThrow(/invalid diff path/);
    expect(() => parseGitDiffRequest({ path: "a\\b.ts" })).toThrow(/invalid diff path/);
  });

  it("refuses a non-boolean staged flag", () => {
    expect(() => parseGitDiffRequest({ staged: "yes" })).toThrow(/staged must be a boolean/);
    expect(() => parseGitDiffRequest({ staged: {} })).toThrow(/staged must be a boolean/);
  });

  it("refuses a short or hostile commit", () => {
    expect(() => parseGitDiffRequest({ commit: "abc1234" })).toThrow(/full sha/);
    expect(() => parseGitDiffRequest({ commit: "--help" })).toThrow(/full sha/);
    expect(() => parseGitDiffRequest({ commit: "A".repeat(40) })).toThrow(/full sha/);
  });

  it("drops fields it does not know", () => {
    expect(parseGitDiffRequest({ path: "a.ts", argv: ["--exec=evil"] })).toEqual({ path: "a.ts" });
  });
});

describe("parseGitLogRequest", () => {
  it("defaults to an empty page request", () => {
    expect(parseGitLogRequest(undefined)).toEqual({});
    expect(parseGitLogRequest(null)).toEqual({});
    expect(parseGitLogRequest({})).toEqual({});
  });

  it("clamps the window instead of trusting the renderer", () => {
    expect(parseGitLogRequest({ limit: 0 })).toEqual({ limit: 1 });
    expect(parseGitLogRequest({ limit: 10_000 })).toEqual({ limit: MAX_LOG_PAGE });
    expect(parseGitLogRequest({ limit: 30.9 })).toEqual({ limit: 30 });
    expect(parseGitLogRequest({ skip: -5 })).toEqual({ skip: 0 });
    expect(parseGitLogRequest({ skip: 60.4 })).toEqual({ skip: 60 });
  });

  it("refuses a non-numeric window", () => {
    expect(() => parseGitLogRequest({ limit: "30" })).toThrow(/limit must be a number/);
    expect(() => parseGitLogRequest({ skip: Number.NaN })).toThrow(/skip must be a number/);
    expect(() => parseGitLogRequest({ skip: Number.POSITIVE_INFINITY })).toThrow(
      /skip must be a number/,
    );
  });

  it("refuses an unsafe path", () => {
    expect(() => parseGitLogRequest({ path: "../x" })).toThrow(/invalid log path/);
    expect(() => parseGitLogRequest({ path: ".git/HEAD" })).toThrow(/invalid log path/);
  });

  it("keeps a safe path", () => {
    expect(parseGitLogRequest({ path: "src/app.ts", limit: 30, skip: 30 })).toEqual({
      path: "src/app.ts",
      limit: 30,
      skip: 30,
    });
  });
});
