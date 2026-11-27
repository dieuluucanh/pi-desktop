import { describe, expect, it } from "vitest";

import { appPlatform, platformFromNavigator } from "../../src/renderer/src/ui/platform";

/**
 * The renderer platform helper (2026-11-18 questionnaire paste plan).
 *
 * The paste chord differs per platform (Cmd+V vs Ctrl+V), and a keydown handler
 * must decide synchronously, so this mapping is the one source for the terminal
 * runtime and the TUI surface.
 */

describe("platformFromNavigator", () => {
  it("recognises macOS and Windows regardless of the rest of the string", () => {
    expect(platformFromNavigator("MacIntel")).toBe("darwin");
    expect(platformFromNavigator("Win32")).toBe("win32");
  });

  it("treats everything else, including an empty platform, as Linux", () => {
    expect(platformFromNavigator("Linux x86_64")).toBe("linux");
    expect(platformFromNavigator("")).toBe("linux");
    expect(platformFromNavigator(undefined)).toBe("linux");
    expect(platformFromNavigator(null)).toBe("linux");
  });

  it("reads the live navigator in the renderer", () => {
    expect(["darwin", "win32", "linux"]).toContain(appPlatform());
  });
});
