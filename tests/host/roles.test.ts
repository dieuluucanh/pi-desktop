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

  it("projects the same page when no catalog is wired (legacy fallback)", async () => {
    const listSessions = vi.fn(async () => [
      {
        path: "C:\\p\\a.jsonl",
        id: "a",
        cwd: "C:\\work\\A",
        created: new Date("2026-09-01T10:00:00.000Z"),
        modified: new Date("2026-09-02T10:00:00.000Z"),
        messageCount: 1,
        firstMessage: "alpha",
        allMessagesText: "alpha",
      },
      {
        path: "C:\\p\\b.jsonl",
        id: "b",
        cwd: "C:\\work\\B",
        created: new Date("2026-09-01T10:00:00.000Z"),
        modified: new Date("2026-09-03T10:00:00.000Z"),
        messageCount: 1,
        firstMessage: "beta",
        allMessagesText: "beta",
      },
    ]);
    const core = createControlCore({ settings: fakeSettings(), listSessions });
    type Page = {
      sessions: Array<{ id: string; modified: number }>;
      total: number;
      matched: number;
      truncated: boolean;
      error: string | null;
    };
    const call = async (params: Record<string, unknown>): Promise<Page> =>
      (await core.handlers()["session.list"]?.(params, {} as never)) as Page;

    const all = await call({});
    expect(all.sessions.map((session) => session.id)).toEqual(["b", "a"]);
    expect(all.sessions[0]?.modified).toBe(Date.parse("2026-09-03T10:00:00.000Z"));
    expect(all).toMatchObject({ total: 2, matched: 2, truncated: false, error: null });

    const current = await call({ scope: "current", cwd: "c:\\WORK\\a" });
    expect(current.sessions.map((session) => session.id)).toEqual(["a"]);
    expect(current).toMatchObject({ total: 2, matched: 1, truncated: false, error: null });

    const bad = await call({ query: "re:(" });
    expect(bad.sessions).toEqual([]);
    expect(bad.error).toMatch(/group|parenth|unterminated/i);
    expect(listSessions).toHaveBeenCalledTimes(3);
  });

  it("delegates session.list to the page port with parsed filters", async () => {
    const listSessionPage = vi.fn(async () => ({
      sessions: [],
      total: 0,
      matched: 0,
      truncated: false,
      error: null,
    }));
    const core = createControlCore({
      settings: fakeSettings(),
      listSessions: async () => [],
      listSessionPage,
    });

    await core.handlers()["session.list"]?.(
      {
        query: "deep term",
        scope: "current",
        cwd: "/work/a",
        sort: "relevance",
        namedOnly: true,
        limit: 50,
        refresh: true,
      },
      {} as never,
    );

    expect(listSessionPage).toHaveBeenCalledWith({
      query: "deep term",
      scope: "current",
      cwd: "/work/a",
      sort: "relevance",
      namedOnly: true,
      limit: 50,
      refresh: true,
    });
  });

  it("disposes the catalog with the core", async () => {
    const disposeCatalog = vi.fn();
    const core = createControlCore({
      settings: fakeSettings(),
      listSessions: async () => [],
      disposeCatalog,
    });
    await core.dispose();
    expect(disposeCatalog).toHaveBeenCalledTimes(1);
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

describe("control core skills, themes and keybindings (plan step 15)", () => {
  it("answers themes.* and keybindings.* with not_implemented when unconfigured", async () => {
    const core = createControlCore({ settings: fakeSettings(), listSessions: async () => [] });
    const handlers = core.handlers();
    await expect(handlers["themes.list"]?.({}, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
    await expect(handlers["keybindings.get"]?.({}, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("never serves extension shortcuts (they need a live session)", () => {
    const core = createControlCore({ settings: fakeSettings(), listSessions: async () => [] });
    expect(core.handlers()["shortcuts.list"]).toBeUndefined();
    expect(core.handlers()["shortcuts.invoke"]).toBeUndefined();
    expect(CONTROL_METHODS).not.toContain("shortcuts.list");
    expect(CONTROL_METHODS).toContain("themes.list");
    expect(CONTROL_METHODS).toContain("keybindings.get");
  });

  it("lists themes for the requested project and keybindings from the port", async () => {
    const createThemePort = vi.fn((cwd: string) => ({
      listLoaded: async () => [],
      getActive: async () => "dark",
      readFile: async () => null,
      importFile: async (filename: string) => `/t/${cwd}/${filename}`,
    }));
    const keybindings = {
      path: () => "/profile/keybindings.json",
      read: async () => null,
      write: async () => undefined,
      remove: async () => undefined,
    };
    const core = createControlCore({
      settings: fakeSettings(),
      listSessions: async () => [],
      defaultCwd: "/home",
      createThemePort,
      keybindings,
    });
    const handlers = core.handlers();
    const themes = (await handlers["themes.list"]?.({ cwd: "/project" }, {} as never)) as {
      active: string;
      themes: Array<{ name: string }>;
    };
    expect(createThemePort).toHaveBeenCalledWith("/project");
    expect(themes.active).toBe("dark");
    expect(themes.themes.map((entry) => entry.name)).toEqual(["dark", "light"]);
    const bindings = (await handlers["keybindings.get"]?.({}, {} as never)) as {
      path: string;
    };
    expect(bindings.path).toBe("/profile/keybindings.json");
  });
});
