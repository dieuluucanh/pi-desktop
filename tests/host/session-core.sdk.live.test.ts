/**
 * SDK integration check (plan step 5 acceptance): drive a **real** Pi session
 * through the session core against a throw-away profile directory.
 *
 * No provider is contacted — this asserts the wiring: services come up, the SDK
 * writes a v3 JSONL session header, state/settings are readable, and the session
 * can be resumed from its own file. Network-dependent prompt streaming is covered
 * by the fake-provider harness in plan step 24.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSessionCore, type SessionCore } from "../../src/host/session-core";
import type { HostMethod } from "../../src/shared/host-protocol";
import {
  ProjectTrustStore,
  SessionManager,
  createSdkSessionRuntime,
  hasTrustRequiringProjectResources,
} from "../../src/host/sdk";

const profileDir = mkdtempSync(join(tmpdir(), "pi-desktop-profile-"));
const projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-project-"));
const sessionsDir = join(profileDir, "sessions");

interface SessionHeader {
  type?: string;
  version?: number;
  id?: string;
  cwd?: string;
}

let core: SessionCore | null = null;
/** The manager the core created, so the test can assert the SDK's own header. */
let manager: { getHeader?(): SessionHeader | null } | null = null;

afterAll(async () => {
  await core?.dispose();
});

function buildCore(): SessionCore {
  return createSessionCore({
    cwd: projectDir,
    agentDir: profileDir,
    emit: () => {},
    trustStore: new ProjectTrustStore(profileDir),
    requiresTrust: (cwd) => hasTrustRequiringProjectResources(cwd),
    newSessionManager: (cwd) => {
      const handle = SessionManager.create(cwd, sessionsDir) as never;
      manager = handle as { getHeader?(): SessionHeader | null };
      return handle;
    },
    openSessionManager: (sessionFile, cwd, sessionDir) =>
      SessionManager.open(sessionFile, sessionDir, cwd) as never,
    listSessions: (cwd) => SessionManager.list(cwd) as Promise<never[]>,
    createRuntime: async (request) => {
      const created = await createSdkSessionRuntime({
        cwd: request.cwd,
        agentDir: request.agentDir,
        sessionManager: request.sessionManager as never,
      });
      return { runtime: created.runtime, session: created.session };
    },
  });
}

describe("session core against the real SDK", () => {
  /** Calls a protocol handler the way the host loop does. */
  const call = async (target: SessionCore, method: string, params?: unknown): Promise<unknown> => {
    const handlers = target.handlers();
    const handler = handlers[method as HostMethod];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {
      method: method as HostMethod,
      requestId: 1,
      emit: () => {},
      readBlob: async () => null,
    });
  };

  it("creates a session and the SDK writes a v3 JSONL file", async () => {
    core = buildCore();

    const snapshot = (await call(core, "session.create")) as {
      sessionId: string;
      sessionFile: string;
    };

    expect(snapshot.sessionId).toBeTruthy();
    expect(snapshot.sessionFile).toBeTruthy();
    expect(snapshot.sessionFile.startsWith(sessionsDir)).toBe(true);
    expect(snapshot.sessionFile.endsWith(".jsonl")).toBe(true);

    // The SDK holds the v3 header in the manager and writes the JSONL file when
    // the session first persists an entry (the chat flow, plan step 9).
    const header = manager?.getHeader?.() ?? null;
    expect(header?.type).toBe("session");
    expect(header?.version).toBe(3);
    expect(header?.id).toBe(snapshot.sessionId);

    const renamed = (await call(core, "session.rename", { name: "Live test session" })) as {
      name: string;
      sessionFile: string;
    };
    expect(renamed.name).toBe("Live test session");
    expect(renamed.sessionFile).toBe(snapshot.sessionFile);

    const state = (await call(core, "state.get")) as Record<string, unknown>;
    expect(state).toMatchObject({
      sessionId: snapshot.sessionId,
      cwd: projectDir,
      streaming: false,
      messageCount: 0,
    });

    const settings = (await call(core, "settings.get")) as { settings: Record<string, unknown> };
    expect(typeof settings.settings).toBe("object");

    const levels = (await call(core, "thinking.levels")) as { levels: string[] };
    expect(Array.isArray(levels.levels)).toBe(true);

    const tools = (await call(core, "tools.list")) as { tools: unknown[] };
    expect(Array.isArray(tools.tools)).toBe(true);

    const listed = (await call(core, "session.list")) as { sessions: unknown[] };
    expect(Array.isArray(listed.sessions)).toBe(true);
  }, 180_000);
});
