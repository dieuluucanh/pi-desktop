import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createControlCore, CONTROL_METHODS } from "../../src/host/control-core";
import { resolveHostRole, resolveNpmCommand } from "../../src/host/index";
import { createHostService } from "../../src/host/service";
import { createFakeSettings } from "./fake-settings";

/**
 * Host roles (plan step 3, decision D-A3).
 *
 * A control host serves app-wide state and must never be able to run a session;
 * a session host owns exactly one Pi session. This is the guard that keeps the
 * two cores from drifting into one another. Settings (plan step 12) are supplied
 * as an in-memory port.
 */

function fakeSettings() {
  return createFakeSettings({
    global: { theme: "dark", model: "test-model" },
    project: { defaultTools: ["read"] },
    errors: [{ scope: "global", message: "one settings warning" }],
  });
}

function memoryStreams(): {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  lines: () => unknown[];
} {
  const written: string[] = [];
  const stdin = new PassThrough();
  const stdout = {
    write: (chunk: string): boolean => {
      written.push(chunk.toString());
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    stdin,
    stdout,
    lines: () =>
      written
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

describe("resolveHostRole", () => {
  it("prefers the flag, then the environment, then defaults to session", () => {
    expect(resolveHostRole(["--role", "control"], {})).toBe("control");
    expect(resolveHostRole([], { PI_DESKTOP_HOST_ROLE: "control" })).toBe("control");
    expect(resolveHostRole(["--role", "nonsense"], {})).toBe("session");
    expect(resolveHostRole([], {})).toBe("session");
    expect(resolveHostRole(["--role", "session"], { PI_DESKTOP_HOST_ROLE: "control" })).toBe(
      "session",
    );
  });
});

describe("resolveNpmCommand (plan step 14)", () => {
  it("builds [node, npm-cli.js] only when both paths are present", () => {
    expect(
      resolveNpmCommand({
        PI_DESKTOP_NODE: "C:/runtime/node.exe",
        PI_DESKTOP_NPM_CLI: "C:/runtime/npm-cli.js",
      }),
    ).toEqual(["C:/runtime/node.exe", "C:/runtime/npm-cli.js"]);
    expect(resolveNpmCommand({ PI_DESKTOP_NODE: "C:/runtime/node.exe" })).toBeNull();
    expect(resolveNpmCommand({ PI_DESKTOP_NPM_CLI: "C:/runtime/npm-cli.js" })).toBeNull();
    expect(resolveNpmCommand({ PI_DESKTOP_NODE: "  ", PI_DESKTOP_NPM_CLI: " " })).toBeNull();
    expect(resolveNpmCommand({})).toBeNull();
  });
});

describe("control core", () => {
  it("declares exactly the app-wide methods", () => {
    const core = createControlCore({ settings: fakeSettings(), listSessions: async () => [] });
    expect(Object.keys(core.handlers()).sort()).toEqual([...CONTROL_METHODS].sort());
    expect(Object.keys(core.handlers())).not.toContain("prompt");
    expect(core.role).toBe("control");
  });

  it("returns both settings scopes rather than an invented merge", async () => {
    const core = createControlCore({ settings: fakeSettings(), listSessions: async () => [] });
    const result = (await core.handlers()["settings.get"]?.({}, {} as never)) as {
      settings: { global: unknown; project: unknown };
      errors: unknown[];
    };
    expect(result.settings.global).toMatchObject({ theme: "dark" });
    expect(result.settings.project).toMatchObject({ defaultTools: ["read"] });
    expect(result.errors).toHaveLength(1);
  });

  it("reads settings only when asked, not at construction", async () => {
    const settings = fakeSettings();
    const core = createControlCore({ settings, listSessions: async () => [] });
    expect(settings.read).not.toHaveBeenCalled();
    await core.handlers()["settings.raw"]?.({}, {} as never);
    expect(settings.read).toHaveBeenCalledTimes(1);
    await core.handlers()["settings.raw"]?.({}, {} as never);
    expect(settings.read).toHaveBeenCalledTimes(2);
  });

  it("lists every session of the profile", async () => {
    const listSessions = vi.fn(async () => [{ sessionId: "a" }, { sessionId: "b" }]);
    const core = createControlCore({ settings: fakeSettings(), listSessions });
    const result = (await core.handlers()["session.list"]?.({}, {} as never)) as {
      sessions: unknown[];
    };
    expect(result.sessions).toHaveLength(2);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("resolves a listed session for deletion and refuses anything else", async () => {
    const listSessions = async (): Promise<unknown[]> => [
      { path: "/profile/sessions/--a--/s1.jsonl" },
    ];
    const core = createControlCore({ settings: fakeSettings(), listSessions });
    const resolve = core.handlers()["session.delete"];
    await expect(
      resolve?.({ sessionFile: "/profile/sessions/--a--/s1.jsonl" }, {} as never),
    ).resolves.toEqual({ path: "/profile/sessions/--a--/s1.jsonl" });
    // The host never deletes: it validates, and main trashes the returned path.
    await expect(resolve?.({ sessionFile: "/profile/auth.json" }, {} as never)).rejects.toThrow(
      /not part of this profile/,
    );
  });
});

describe("a control host over the protocol", () => {
  it("reports its role and refuses session methods", async () => {
    const streams = memoryStreams();
    const core = createControlCore({ settings: fakeSettings(), listSessions: async () => [] });
    const service = createHostService({
      stdin: streams.stdin,
      stdout: streams.stdout,
      blobDir: "/tmp/blobs",
      handlers: core.handlers(),
      info: {
        sessionId: null,
        cwd: "C:\\state",
        bridgePort: null,
        nodeVersion: "v24.0.0",
        piVersion: null,
        role: core.role,
        startedAt: 0,
      },
    });

    await service.handleLine(JSON.stringify({ id: 1, method: "host.hello" }));
    await service.handleLine(JSON.stringify({ id: 2, method: "settings.raw" }));
    await service.handleLine(JSON.stringify({ id: 3, method: "prompt", params: { text: "hi" } }));
    await service.handleLine(JSON.stringify({ id: 4, method: "session.create", params: {} }));

    const frames = streams.lines() as Array<Record<string, unknown>>;
    const hello = frames.find((frame) => frame.id === 1) as { result: { role: string } };
    expect(hello.result.role).toBe("control");

    const settings = frames.find((frame) => frame.id === 2) as { ok: boolean };
    expect(settings.ok).toBe(true);

    for (const id of [3, 4]) {
      const refusal = frames.find((frame) => frame.id === id) as {
        ok: boolean;
        error: { code: string };
      };
      expect(refusal.ok).toBe(false);
      expect(refusal.error.code).toBe("not_implemented");
    }
  });
});

describe("control core resources (plan step 13)", () => {
  it("answers not_implemented when no inspector is configured", async () => {
    const core = createControlCore({ settings: fakeSettings(), listSessions: async () => [] });
    await expect(core.handlers()["resources.list"]?.({}, {} as never)).rejects.toThrow(
      /no resource inspector/,
    );
  });

  it("answers packages.* with not_implemented when no package manager is configured", async () => {
    const core = createControlCore({ settings: fakeSettings(), listSessions: async () => [] });
    await expect(core.handlers()["packages.list"]?.({}, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("builds the hub snapshot from the inspector and the settings port", async () => {
    const load = vi.fn(async () => ({
      extensions: {
        extensions: [
          {
            path: "/p/foo.ts",
            sourceInfo: { source: "user", scope: "user", origin: "top-level" },
          },
        ],
        errors: [],
      },
      skills: { skills: [], diagnostics: [] },
      prompts: { prompts: [], diagnostics: [] },
      themes: { themes: [], diagnostics: [] },
    }));
    const core = createControlCore({
      settings: fakeSettings(),
      listSessions: async () => [],
      resources: { load },
      defaultCwd: "/home",
      now: () => 7,
    });

    const handlers = core.handlers();
    const snapshot = (await handlers["resources.list"]?.(
      { cwd: "/project", refresh: true },
      {} as never,
    )) as {
      scope: string;
      cwd: string | null;
      loadedAt: number;
      resources: unknown[];
    };
    expect(load).toHaveBeenCalledWith("/project", { refresh: true });
    expect(snapshot).toMatchObject({ scope: "control", cwd: "/project", loadedAt: 7 });
    expect(snapshot.resources[0]).toMatchObject({ name: "foo.ts" });
  });

  it("falls back to the host's own cwd", async () => {
    const load = vi.fn(async () => ({}));
    const core = createControlCore({
      settings: fakeSettings(),
      listSessions: async () => [],
      resources: { load },
      defaultCwd: "/home",
    });
    const handlers = core.handlers();
    const snapshot = (await handlers["resources.list"]?.({}, {} as never)) as {
      cwd: string | null;
    };
    expect(snapshot.cwd).toBe("/home");
    expect(load).toHaveBeenCalledWith("/home", { refresh: false });
  });
});
