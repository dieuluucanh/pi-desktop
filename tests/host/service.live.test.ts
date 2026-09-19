/**
 * Live host process check: spawns the real `out/host/index.mjs` bundle with the
 * bundled Node runtime and drives the JSONL protocol end to end.
 *
 * Requires `npm run build:host` and a fetched runtime, so it skips (instead of
 * failing) in a plain `npm test` run: `npm run runtime:verify` is the gate that
 * insists on both.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createHostSupervisor, type HostSupervisor } from "../../src/main/host-supervisor";
import { resolveAppRuntime } from "../../src/main/runtime/environment";
import { HOST_PROTOCOL_VERSION } from "../../src/shared/host-protocol";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const resolution = resolveAppRuntime({
  isPackaged: false,
  resourcesPath: join(repoRoot, "resources"),
  appRoot: repoRoot,
});
const buildReady =
  resolution.ok && resolution.nodePath !== null && existsSync(resolution.piHostPath);

const scratch = mkdtempSync(join(tmpdir(), "pi-desktop-host-test-"));
let supervisor: HostSupervisor | null = null;

afterAll(async () => {
  await supervisor?.stopAll();
});

describe.skipIf(!buildReady)("live host process", () => {
  it("boots, handshakes, answers a ping and shuts down", async () => {
    const nodePath = resolution.nodePath;
    if (!nodePath) throw new Error("no bundled runtime resolved");

    supervisor = createHostSupervisor({
      nodePath,
      hostPath: resolution.piHostPath,
      binDir: resolution.binDir,
      logDir: join(scratch, "logs"),
      blobDir: join(scratch, "blobs"),
      profileDir: join(scratch, "profile"),
      requestTimeoutMs: 60_000,
    });

    const host = await supervisor.start({ sessionId: "live-1", cwd: repoRoot });
    const info = await host.ready();

    expect(info.protocolVersion).toBe(HOST_PROTOCOL_VERSION);
    expect(info.nodeVersion).toMatch(/^v24\./);
    expect(info.sessionId).toBe("live-1");
    expect(host.port).toBe(38618);

    await expect(host.request("host.ping")).resolves.toMatchObject({ pong: true });

    // Session semantics land in plan step 5; the host must say so, not hang.
    await expect(host.request("session.create")).rejects.toThrow(/not implemented/i);

    await supervisor.stopAll();
    expect(supervisor.list()).toHaveLength(0);
  }, 120_000);
});
