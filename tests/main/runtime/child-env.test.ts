import { describe, expect, it } from "vitest";
import { composeChildEnv } from "../../../src/main/runtime/child-env";

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
