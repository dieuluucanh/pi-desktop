import { describe, expect, it } from "vitest";
import { isExcludedShellCommand, isShellCommand } from "../../src/shared/shell-command";

describe("shell-command prefixes", () => {
  it("recognises ! and !! after leading whitespace, including a blank line", () => {
    expect(isShellCommand("!git status")).toBe(true);
    expect(isShellCommand("!!git status")).toBe(true);
    expect(isShellCommand("  !git status")).toBe(true);
    expect(isShellCommand("\n  !!git status")).toBe(true);
    expect(isShellCommand("!")).toBe(true);
    expect(isShellCommand("!!")).toBe(true);
  });

  it("does not treat prose or a later ! as a shell command", () => {
    expect(isShellCommand("")).toBe(false);
    expect(isShellCommand("   ")).toBe(false);
    expect(isShellCommand("hello")).toBe(false);
    expect(isShellCommand("hello !world")).toBe(false);
    expect(isShellCommand("hello\n!world")).toBe(false);
  });

  it("distinguishes !! from a single !", () => {
    expect(isExcludedShellCommand("!!git status")).toBe(true);
    expect(isExcludedShellCommand("\n  !!git status")).toBe(true);
    expect(isExcludedShellCommand("!git status")).toBe(false);
    expect(isExcludedShellCommand("hello !!world")).toBe(false);
    expect(isExcludedShellCommand("")).toBe(false);
  });
});
