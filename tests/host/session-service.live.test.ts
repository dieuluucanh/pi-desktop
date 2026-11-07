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

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createHostSupervisor, type HostSupervisor } from "../../src/main/host-supervisor";
import {
  CONTROL_HOST_ID,
  createSessionService,
  type SessionService,
} from "../../src/main/session-service";
import { resolveAppRuntime } from "../../src/main/runtime/environment";
import { isBlobRef } from "../../src/shared/host-protocol";
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
      nodeBinDir: resolution.nodeBinDir,
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

describe.skipIf(!buildReady)("live control host singleton (2026-11-07 plan)", () => {
  it("spawns one child and one port for concurrent control callers", async () => {
    const nodePath = resolution.nodePath;
    if (!nodePath) throw new Error("no bundled runtime resolved");

    const liveSupervisor = createHostSupervisor({
      nodePath,
      hostPath: resolution.piHostPath,
      binDir: resolution.binDir,
      nodeBinDir: resolution.nodeBinDir,
      logDir: join(scratch, "logs-control"),
      blobDir: join(scratch, "blobs-control"),
      profileDir: join(scratch, "profile-control"),
      requestTimeoutMs: 120_000,
    });
    const liveService = createSessionService({
      supervisor: liveSupervisor,
      store: {
        read: async () => ({ tabs: [], activeTabId: null }),
        update: async () => ({ tabs: [], activeTabId: null }),
      },
      controlCwd: scratch,
      coalesceMs: 10,
      emit: () => {},
    });

    try {
      // The renderer's boot fan-out shape: several control-addressed requests at
      // once. Before the fix this spawned one host per caller (seven children
      // under one registry key, six unreachable).
      const handles = await Promise.all(Array.from({ length: 5 }, () => liveService.controlHost()));

      expect(new Set(handles).size).toBe(1);
      expect(liveSupervisor.list()).toHaveLength(1);
      expect(liveSupervisor.allocatedPorts()).toHaveLength(1);
      expect(liveSupervisor.get(CONTROL_HOST_ID)).toBe(handles[0]);

      await liveService.dispose();
      expect(liveSupervisor.list()).toHaveLength(0);
      expect(liveSupervisor.allocatedPorts()).toEqual([]);
    } finally {
      await liveService.dispose().catch(() => undefined);
      await liveSupervisor.stopAll().catch(() => undefined);
    }
  }, 300_000);
});

describe.skipIf(!buildReady)("live session list projection", () => {
  it("returns a bounded page and chunked blobs for a profile that would spill", async () => {
    const nodePath = resolution.nodePath;
    if (!nodePath) throw new Error("no bundled runtime resolved");

    const profileDir = mkdtempSync(join(scratch, "profile-large-"));
    const blobDir = mkdtempSync(join(scratch, "blobs-large-"));
    const liveSupervisor = createHostSupervisor({
      nodePath,
      hostPath: resolution.piHostPath,
      binDir: resolution.binDir,
      nodeBinDir: resolution.nodeBinDir,
      logDir: join(scratch, "logs-large"),
      blobDir,
      profileDir,
      requestTimeoutMs: 120_000,
    });
    const liveService = createSessionService({
      supervisor: liveSupervisor,
      store: {
        read: async () => ({ tabs: [], activeTabId: null }),
        update: async () => ({ tabs: [], activeTabId: null }),
      },
      controlCwd: scratch,
      coalesceMs: 10,
      emit: () => {},
    });

    try {
      // 60 sessions x ~30 KB of message text: the raw SessionInfo[] the old
      // implementation returned is >1 MiB, i.e. it would have been spilled.
      const sessionsDir = join(profileDir, "sessions", "--C--work-large--");
      mkdirSync(sessionsDir, { recursive: true });
      for (let index = 0; index < 60; index++) {
        const text =
          index === 7
            ? `deep hidden-needle ${"x".repeat(30_000)}`
            : `session ${index} ${"text ".repeat(6_000)}`;
        const header = {
          type: "session",
          version: 3,
          id: `large-${index}`,
          timestamp: "2026-11-05T00:00:00.000Z",
          cwd: "C:\\work\\large",
        };
        const message = {
          type: "message",
          id: `m-${index}`,
          parentId: null,
          timestamp: "2026-11-05T00:00:00.000Z",
          message: { role: "user", content: text },
        };
        writeFileSync(
          join(sessionsDir, `s${index}.jsonl`),
          `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
        );
      }

      // A second project bucket proves scope filtering and path identity.
      const otherDir = join(profileDir, "sessions", "--C--work-other--");
      mkdirSync(otherDir, { recursive: true });
      for (let index = 0; index < 2; index++) {
        const header = {
          type: "session",
          version: 3,
          id: `other-${index}`,
          timestamp: "2026-11-06T00:00:00.000Z",
          cwd: "C:\\work\\other",
        };
        const message = {
          type: "message",
          id: `other-m-${index}`,
          parentId: null,
          timestamp: "2026-11-06T00:00:00.000Z",
          message: { role: "user", content: `other project session ${index}` },
        };
        writeFileSync(
          join(otherDir, `s${index}.jsonl`),
          `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
        );
      }

      await liveService.controlHost();
      const page = await liveService.request(CONTROL_HOST_ID, "session.list", {
        query: "hidden-needle",
      });
      expect(isBlobRef(page)).toBe(false);
      const result = page as {
        sessions: Array<{ id: string; title: string }>;
        total: number;
        matched: number;
      };
      expect(result.total).toBeGreaterThanOrEqual(60);
      expect(result.sessions.map((session) => session.id)).toEqual(["large-7"]);
      expect(result.sessions[0]).not.toHaveProperty("allMessagesText");

      // Timestamps survive the projection as epoch ms (never a Date / 1970).
      const allPage = (await liveService.request(CONTROL_HOST_ID, "session.list", {})) as {
        sessions: Array<{ id: string; modified: number }>;
        matched: number;
      };
      expect(allPage.sessions.every((session) => session.modified > 0)).toBe(true);
      expect(allPage.sessions.some((session) => session.id === "other-0")).toBe(true);

      // "This project" filters, and a Windows path matches across case.
      const current = (await liveService.request(CONTROL_HOST_ID, "session.list", {
        scope: "current",
        cwd: "c:\\WORK\\LARGE",
      })) as { sessions: Array<{ id: string }>; matched: number };
      expect(current.matched).toBeGreaterThan(0);
      expect(current.matched).toBeLessThan(allPage.matched);
      expect(current.sessions.every((session) => session.id.startsWith("large-"))).toBe(true);

      // The same host reads a genuinely large blob back in chunks.
      const blobPath = join(blobDir, "large.json");
      const blobText = JSON.stringify({ text: "z".repeat(3 * 1024 * 1024) });
      writeFileSync(blobPath, blobText, "utf8");
      const first = (await liveService.request(CONTROL_HOST_ID, "host.blobs.read", {
        path: blobPath,
        offset: 0,
        maxBytes: 2 * 1024 * 1024,
      })) as { contents: string; nextOffset: number; done: boolean };
      expect(isBlobRef(first)).toBe(false);
      expect(first.done).toBe(false);
      const second = (await liveService.request(CONTROL_HOST_ID, "host.blobs.read", {
        path: blobPath,
        offset: first.nextOffset,
        maxBytes: 2 * 1024 * 1024,
      })) as { contents: string; done: boolean };
      expect(second.done).toBe(true);
      expect(first.contents + second.contents).toBe(blobText);
    } finally {
      await liveService.dispose();
      await liveSupervisor.stopAll();
    }
  }, 300_000);
});
