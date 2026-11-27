import { describe, expect, it } from "vitest";
import { composeChildEnv, stripAppImageLibraryPaths } from "../../../src/main/runtime/child-env";

describe("composeChildEnv", () => {
  it("puts the shim directory and the Node directory before the base PATH", () => {
    const env = composeChildEnv({
      baseEnv: { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/me" },
      platform: "linux",
      binDir: "/app/runtime/bin",
      nodeBinDir: "/app/runtime/node/linux-x64/bin",
    });
    expect(env.PATH).toBe(
      "/app/runtime/bin:/app/runtime/node/linux-x64/bin:/usr/local/bin:/usr/bin",
    );
    expect(env.HOME).toBe("/home/me");
  });

  it("uses the Windows separator and a single canonical PATH key", () => {
    const env = composeChildEnv({
      baseEnv: { Path: "C:\\Windows", path: "C:\\stale", HOME: "C:\\Users\\me" },
      platform: "win32",
      binDir: "C:\\app\\runtime\\bin",
      nodeBinDir: "C:\\app\\runtime\\node\\win32-x64\\bin",
    });
    expect(env.PATH).toBe(
      "C:\\app\\runtime\\bin;C:\\app\\runtime\\node\\win32-x64\\bin;C:\\Windows",
    );
    expect(env.Path).toBeUndefined();
    expect(env.path).toBeUndefined();
    expect(env.HOME).toBe("C:\\Users\\me");
  });

  it("tolerates a missing base PATH and a missing node directory", () => {
    const env = composeChildEnv({
      baseEnv: {},
      platform: "linux",
      binDir: "/app/runtime/bin",
      nodeBinDir: null,
    });
    expect(env.PATH).toBe("/app/runtime/bin");
  });

  it("applies extra variables after the base environment", () => {
    const env = composeChildEnv({
      baseEnv: { TERM: "dumb" },
      platform: "linux",
      binDir: "/bin",
      extra: { TERM: "xterm-256color", PI_CODING_AGENT_DIR: "/home/me/.pi/agent" },
    });
    expect(env.TERM).toBe("xterm-256color");
    expect(env.PI_CODING_AGENT_DIR).toBe("/home/me/.pi/agent");
  });

  it("strips the requested names after composition", () => {
    const env = composeChildEnv({
      baseEnv: { ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" },
      platform: "linux",
      binDir: "/bin",
      strip: ["ELECTRON_RUN_AS_NODE"],
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.KEEP).toBe("yes");
  });

  it("does not mutate the base environment", () => {
    const base = { Path: "C:\\Windows" };
    composeChildEnv({
      baseEnv: base,
      platform: "win32",
      binDir: "C:\\bin",
    });
    expect(base).toEqual({ Path: "C:\\Windows" });
  });
});

describe("stripAppImageLibraryPaths", () => {
  const appDir = "/tmp/.mount_PiDesk123";

  it("removes AppImage entries and keeps the rest", () => {
    const env = stripAppImageLibraryPaths({
      APPDIR: appDir,
      LD_LIBRARY_PATH: `${appDir}/usr/lib:/usr/local/lib`,
      LD_PRELOAD: `${appDir}/usr/lib/libfoo.so`,
      PATH: "/usr/bin",
    });
    expect(env.LD_LIBRARY_PATH).toBe("/usr/local/lib");
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("handles a space-separated LD_PRELOAD and a trailing slash", () => {
    const env = stripAppImageLibraryPaths({
      APPDIR: `${appDir}/`,
      LD_PRELOAD: `${appDir}/a.so /usr/lib/b.so`,
    });
    expect(env.LD_PRELOAD).toBe("/usr/lib/b.so");
  });

  it("is a no-op without APPDIR or when nothing matches", () => {
    const without = { LD_LIBRARY_PATH: "/usr/lib" };
    expect(stripAppImageLibraryPaths(without)).toEqual(without);

    const elsewhere = stripAppImageLibraryPaths({
      APPDIR: appDir,
      LD_LIBRARY_PATH: "/tmp/.mount_other/lib:/usr/lib",
    });
    expect(elsewhere.LD_LIBRARY_PATH).toBe("/tmp/.mount_other/lib:/usr/lib");
  });

  it("does not touch a path that merely shares the prefix", () => {
    const env = stripAppImageLibraryPaths({
      APPDIR: "/tmp/mount",
      LD_LIBRARY_PATH: "/tmp/mount-other/lib",
    });
    expect(env.LD_LIBRARY_PATH).toBe("/tmp/mount-other/lib");
  });

  it("does not mutate the input", () => {
    const input = { APPDIR: appDir, LD_LIBRARY_PATH: `${appDir}/usr/lib` };
    stripAppImageLibraryPaths(input);
    expect(input.LD_LIBRARY_PATH).toBe(`${appDir}/usr/lib`);
  });
});
