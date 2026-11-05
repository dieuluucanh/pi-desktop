import { describe, expect, it, vi } from "vitest";
import { stopChild, stopCommand, type StoppableChild } from "../../scripts/dev-stop.mjs";

/**
 * Dev-tree teardown (2026-11-05 renderer-port plan, step 3).
 *
 * On Windows `scripts/dev.mjs` spawns npm through `shell: true`, so the child is
 * `cmd.exe`; `child.kill()` leaves the Vite/Electron descendants running and the
 * renderer dev port held. The tree kill is the fix; a child that already exited
 * must be left alone.
 */

function fakeChild(overrides: Partial<StoppableChild> = {}): StoppableChild {
  return { pid: 4321, exitCode: null, killed: false, ...overrides };
}

describe("stopCommand", () => {
  it("stops the whole tree on Windows", () => {
    expect(stopCommand(4321, "win32")).toEqual({
      command: "taskkill",
      args: ["/pid", "4321", "/T", "/F"],
    });
  });

  it("returns null when child.kill() is the right tool", () => {
    expect(stopCommand(4321, "linux")).toBeNull();
    expect(stopCommand(4321, "darwin")).toBeNull();
    expect(stopCommand(undefined, "win32")).toBeNull();
    expect(stopCommand(0, "win32")).toBeNull();
  });
});

describe("stopChild", () => {
  it("kills the Windows tree through taskkill, not the cmd.exe shell alone", () => {
    const spawnSync = vi.fn();
    const kill = vi.fn();

    expect(stopChild(fakeChild(), "win32", { spawnSync, kill })).toBe(true);

    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/pid", "4321", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps child.kill() on POSIX", () => {
    const spawnSync = vi.fn();
    const kill = vi.fn();

    expect(stopChild(fakeChild(), "linux", { spawnSync, kill })).toBe(true);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("leaves children that already exited alone", () => {
    const cases: Array<StoppableChild | null | undefined> = [
      null,
      undefined,
      fakeChild({ exitCode: 0 }),
      fakeChild({ killed: true }),
    ];

    for (const child of cases) {
      const spawnSync = vi.fn();
      const kill = vi.fn();
      expect(stopChild(child, "win32", { spawnSync, kill })).toBe(false);
      expect(spawnSync).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    }
  });
});
