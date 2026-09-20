import { describe, expect, it, vi } from "vitest";

import { createSessionCore } from "../../src/host/session-core";
import type { HostMethod } from "../../src/shared/host-protocol";

/**
 * `files.read` / `files.write` through the real session core (plan step 23).
 *
 * The containment rules live in `workspace-files.ts` and are tested there; this
 * suite pins the handler contract — a malformed request is refused before the
 * port is touched, the session's own cwd is the root, and a host without the
 * port answers `unsupported` instead of pretending.
 */

const session = {
  sessionId: "s1",
  sessionFile: "/profile/sessions/s1.jsonl",
  sessionName: null,
  model: { id: "m", provider: "test" },
  thinkingLevel: "medium",
  isStreaming: false,
  isIdle: true,
  messages: [],
  pendingMessageCount: 0,
  subscribe: () => () => undefined,
  getAllTools: () => [],
  getActiveToolNames: () => ["read"],
  getAvailableThinkingLevels: () => ["off", "high"],
  getSteeringMessages: () => [],
  getFollowUpMessages: () => [],
};

function build(deps: Record<string, unknown> = {}) {
  const runtime = { session, services: { settingsManager: {} } };
  const core = createSessionCore({
    cwd: "/work/app",
    agentDir: "/profile",
    emit: () => undefined,
    createRuntime: async () => ({ runtime, session }) as never,
    newSessionManager: () => ({}) as never,
    openSessionManager: () => ({}) as never,
    ...deps,
  });
  const handlers = core.handlers();
  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {} as never);
  };
  return { core, call };
}

describe("files.read", () => {
  it("reads through the injected port, rooted at the session cwd", async () => {
    const readWorkspaceFile = vi.fn(async (cwd: string, path: string, options?: unknown) => ({
      path: `${cwd}/${path}`,
      relativePath: path,
      text: "hello",
      bytes: 5,
      truncated: false,
      options,
    }));
    const { call } = build({ readWorkspaceFile });
    const result = (await call("files.read", { path: "src/a.ts", limit: 100 })) as {
      text: string;
    };
    expect(result.text).toBe("hello");
    expect(readWorkspaceFile).toHaveBeenCalledWith("/work/app", "src/a.ts", { limit: 100 });
  });

  it("accepts the `file` alias and drops a non-numeric limit", async () => {
    const readWorkspaceFile = vi.fn(async () => ({ text: "x" }));
    const { call } = build({ readWorkspaceFile });
    await call("files.read", { file: "a.txt", limit: "big" });
    expect(readWorkspaceFile).toHaveBeenCalledWith("/work/app", "a.txt", undefined);
  });

  it("refuses a missing path before the port is touched", async () => {
    const readWorkspaceFile = vi.fn();
    const { call } = build({ readWorkspaceFile });
    await expect(call("files.read", {})).rejects.toMatchObject({ code: "bad_request" });
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("answers unsupported when the host has no workspace port", async () => {
    const { call } = build();
    await expect(call("files.read", { path: "a.txt" })).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});

describe("files.write", () => {
  it("writes through the injected port", async () => {
    const writeWorkspaceFile = vi.fn(async (cwd: string, path: string, text: string) => ({
      path: `${cwd}/${path}`,
      relativePath: path,
      bytes: text.length,
    }));
    const { call } = build({ writeWorkspaceFile });
    const result = (await call("files.write", { path: "a.txt", text: "hi" })) as { bytes: number };
    expect(result.bytes).toBe(2);
    expect(writeWorkspaceFile).toHaveBeenCalledWith("/work/app", "a.txt", "hi");
  });

  it("accepts the `content` alias", async () => {
    const writeWorkspaceFile = vi.fn(async () => ({ bytes: 0 }));
    const { call } = build({ writeWorkspaceFile });
    await call("files.write", { path: "a.txt", content: "body" });
    expect(writeWorkspaceFile).toHaveBeenCalledWith("/work/app", "a.txt", "body");
  });

  it("refuses a non-string payload", async () => {
    const writeWorkspaceFile = vi.fn();
    const { call } = build({ writeWorkspaceFile });
    await expect(call("files.write", { path: "a.txt", text: 5 })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("answers unsupported when the host has no workspace port", async () => {
    const { call } = build();
    await expect(call("files.write", { path: "a.txt", text: "x" })).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});
