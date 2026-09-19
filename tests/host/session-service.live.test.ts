/**
 * Live session-service check (plan step 3): the real supervisor spawns the real
 * `out/host/index.mjs` with the bundled Node runtime, and the service drives it
 * as the app does — control host, session host, and recovery after the host
 * process is killed.
 *
 * Requires `npm run build:host` and a fetched runtime, so it skips (instead of
 * failing) in a plain `npm test` run; `npm run runtime:verify` is the gate that
 * insists on both.
 *
 * Not covered here: a prompt → streamed reply → final message round trip. That
 * needs a deterministic provider injected into the host, which is the
 * `streamFn`/fake-provider hook of plan step 4; today the host would reach for a
 * real provider and the network.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createHostSupervisor, type HostSupervisor } from "../../src/main/host-supervisor";
import { createSessionService, type SessionService } from "../../src/main/session-service";
import { resolveAppRuntime } from "../../src/main/runtime/environment";
import type { SessionEventEnvelope, TabRecord } from "../../src/shared/session-ipc";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const resolution = resolveAppRuntime({
  isPackaged: false,
  resourcesPath: join(repoRoot, "resources"),
  appRoot: repoRoot,
});
const buildReady =
  resolution.ok && resolution.nodePath !== null && existsSync(resolution.piHostPath);

const scratch = mkdtempSync(join(tmpdir(), "pi-desktop-session-live-"));
let supervisor: HostSupervisor | null = null;
let service: SessionService | null = null;

afterAll(async () => {
  await service?.dispose();
  await supervisor?.stopAll();
});

/** Waits until `predicate` holds, polling instead of sleeping a fixed time. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the expected host state");
}

describe.skipIf(!buildReady)("live session service", () => {
  it("runs a control host and a session host, then recovers a killed host", async () => {
    const nodePath = resolution.nodePath;
    if (!nodePath) throw new Error("no bundled runtime resolved");

    supervisor = createHostSupervisor({
      nodePath,
      hostPath: resolution.piHostPath,
      binDir: resolution.binDir,
      logDir: join(scratch, "logs"),
      blobDir: join(scratch, "blobs"),
      profileDir: join(scratch, "profile"),
      requestTimeoutMs: 120_000,
    });

    const pushes: Array<{ channel: string; payload: unknown }> = [];
    const stored: { tabs: TabRecord[]; activeTabId: string | null } = {
      tabs: [],
      activeTabId: null,
    };
    service = createSessionService({
      supervisor,
      store: {
        read: async () => stored,
        update: async (patch) => {
          if ("tabs" in patch) stored.tabs = (patch.tabs as TabRecord[]) ?? [];
          if ("activeTabId" in patch) stored.activeTabId = (patch.activeTabId as string) ?? null;
          return { tabs: stored.tabs, activeTabId: stored.activeTabId };
        },
      },
      controlCwd: scratch,
      coalesceMs: 10,
      emit: (channel, payload) => pushes.push({ channel, payload }),
    });

    // The control host is a real process that owns no session.
    await service.controlHost();
    const control = supervisor.get("control");
    expect(control).toBeDefined();
    expect((await control!.ready()).role).toBe("control");

    // A session host creates a real session in the fixture profile.
    const envelope = await service.createTab({ cwd: repoRoot });
    const tab = envelope.tabs[0]!;
    expect(tab.status).toBe("idle");
    expect(tab.sessionFile).toEqual(expect.stringContaining("sessions"));
    // Pi writes the session JSONL when the session is first persisted (a message
    // or an explicit rename), so the path is known here but the file may not
    // exist yet — that belongs to the transcript work in step 5.

    const sessionHost = supervisor.get(tab.id);
    expect(sessionHost).toBeDefined();
    const info = await sessionHost!.ready();
    expect(info.role).toBe("session");

    // A killed host is restarted by the supervisor and resumed by the service;
    // `rememberSessionFile` is what makes the restart resume the *same* session.
    pushes.length = 0;
    process.kill(info.pids.pid, "SIGTERM");
    await waitFor(() => service!.tabs()[0]!.status === "idle" && pushes.length > 0, 90_000);
    await waitFor(
      () =>
        pushes.some(
          (push) =>
            push.channel === "event" &&
            (push.payload as SessionEventEnvelope).events.some(
              (entry) => entry.event === "session.recovered",
            ),
        ),
      90_000,
    );

    const events = pushes
      .filter((push) => push.channel === "event")
      .flatMap((push) => (push.payload as SessionEventEnvelope).events.map((entry) => entry.event));
    expect(events).toContain("session.crashed");
    expect(events).toContain("session.recovered");
    expect(service.tabs()[0]!.status).toBe("idle");

    await service.dispose();
    expect(supervisor.list()).toHaveLength(0);
  }, 300_000);
});
