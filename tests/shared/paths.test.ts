import { describe, expect, it } from "vitest";

import { compactPath, tildePath } from "../../src/shared/paths";

/**
 * Path labels shared by the app status bar and the session footer
 * (minimal-session-ui step 3). Pure strings: both surfaces must format POSIX
 * and Windows paths the same way, and neither may lose the exact value — both
 * callers keep the full path in a `title`.
 */

describe("tildePath", () => {
  it("replaces a POSIX home prefix", () => {
    expect(tildePath("/home/me/app", "/home/me")).toBe("~/app");
    expect(tildePath("/home/me/a/b", "/home/me")).toBe("~/a/b");
  });

  it("treats the home folder itself as ~", () => {
    expect(tildePath("/home/me", "/home/me")).toBe("~");
    expect(tildePath("/home/me/", "/home/me/")).toBe("~");
  });

  it("keeps Windows separators and ignores drive-letter case", () => {
    expect(tildePath("C:\\Users\\me\\app", "C:\\Users\\me")).toBe("~\\app");
    expect(tildePath("c:\\users\\ME\\app", "C:\\Users\\me")).toBe("~\\app");
  });

  it("does not match a sibling whose name only starts with the home name", () => {
    expect(tildePath("/home/menot/app", "/home/me")).toBe("/home/menot/app");
  });

  it("leaves a path outside home or an unknown home unchanged", () => {
    expect(tildePath("/other/app", "/home/me")).toBe("/other/app");
    expect(tildePath("/home/me/app", null)).toBe("/home/me/app");
    expect(tildePath("/home/me/app", "")).toBe("/home/me/app");
  });
});

describe("compactPath", () => {
  it("compacts only long paths and keeps the tail", () => {
    expect(compactPath("/work/app")).toBe("/work/app");
    const long = "C:\\Users\\someone\\very\\deeply\\nested\\workspace\\project-folder";
    expect(compactPath(long)).toBe("…\\workspace\\project-folder");
    expect(compactPath("")).toBe("");
  });

  it("keeps a Windows drive root intact", () => {
    // Trimming the only separator of `C:\` changes its meaning (the
    // 2026-10-30 project-folder-name bug); it is short enough to show verbatim.
    expect(compactPath("C:\\")).toBe("C:\\");
    expect(compactPath("/")).toBe("/");
  });
});
