import { describe, expect, it } from "vitest";
import { buildResourcesSnapshot, createResourceHandlers } from "../../src/host/resources";
import { createSessionCore } from "../../src/host/session-core";
import type { HostRequestContext } from "../../src/host/service";
import type { ResourcesSnapshot } from "../../src/shared/resources";

/**
 * The Extensions hub's host-side collector (plan step 13). These fixtures mirror
 * the SDK's real shapes (Map-based `Extension`, `LoadExtensionsResult`, skill/
 * prompt/theme collections) without starting a Pi process, so the provenance,
 * contribution and disabled-resource logic is pinned by unit tests.
 */

function extensionSourceInfo(scope: string, source: string, origin = "top-level") {
  return { path: `C:\\res\\${source}`, source, scope, origin };
}

function extensionRecord(overrides: Record<string, unknown> = {}) {
  return {
    path: "C:\\res\\foo\\index.ts",
    resolvedPath: "C:\\res\\foo\\index.ts",
    sourceInfo: extensionSourceInfo("user", "user"),
    tools: new Map([
      ["do_thing", { definition: { name: "do_thing", description: "does a thing" } }],
    ]),
    commands: new Map([["/foo", { name: "foo", description: "the foo command" }]]),
    flags: new Map([
      ["foo-debug", { name: "foo-debug", description: "debug mode", type: "boolean" }],
    ]),
    shortcuts: new Map([["ctrl+alt+f", { shortcut: "ctrl+alt+f", description: "Foo" }]]),
    ...overrides,
  };
}

function skillsResult() {
  return {
    skills: [
      {
        name: "review",
        description: "reviews code",
        filePath: "C:\\res\\skills\\review\\SKILL.md",
        sourceInfo: extensionSourceInfo("project", "project"),
        disableModelInvocation: true,
      },
    ],
    diagnostics: [
      { type: "warning", message: "duplicate skill", path: "C:\\res\\skills\\review\\SKILL.md" },
    ],
  };
}

function promptsResult() {
  return {
    prompts: [
      {
        name: "plan",
        description: "write a plan",
        argumentHint: "<topic>",
        filePath: "C:\\res\\prompts\\plan.md",
        sourceInfo: extensionSourceInfo("user", "user"),
      },
    ],
    diagnostics: [],
  };
}

function themesResult() {
  return {
    themes: [
      {
        name: "midnight",
        sourcePath: "C:\\res\\themes\\midnight.json",
        sourceInfo: extensionSourceInfo("user", "npm:themes", "package"),
      },
    ],
    diagnostics: [],
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "C:\\project",
    scope: "session" as const,
    settings: { global: {}, project: {} },
    source: {
      extensions: { extensions: [extensionRecord()], errors: [] },
      skills: skillsResult(),
      prompts: promptsResult(),
      themes: themesResult(),
    },
    now: () => 1234,
    ...overrides,
  };
}

describe("buildResourcesSnapshot", () => {
  it("collects every resource kind with provenance and contributions", () => {
    const snapshot = buildResourcesSnapshot(baseInput());
    expect(snapshot.loadedAt).toBe(1234);
    expect(snapshot.scope).toBe("session");

    const extension = snapshot.resources.find((entry) => entry.kind === "extensions");
    expect(extension).toMatchObject({
      name: "index.ts",
      path: "C:\\res\\foo\\index.ts",
      overridePath: "C:/res/foo/index.ts",
      source: "user",
      scope: "user",
      origin: "top-level",
      enabled: true,
    });
    expect(extension?.contributed).toEqual([
      { kind: "tool", name: "do_thing", description: "does a thing" },
      { kind: "command", name: "foo", description: "the foo command" },
      { kind: "flag", name: "foo-debug", description: "debug mode", detail: "boolean" },
      { kind: "shortcut", name: "ctrl+alt+f", description: "Foo" },
    ]);

    const skill = snapshot.resources.find((entry) => entry.kind === "skills");
    expect(skill).toMatchObject({
      name: "review",
      scope: "project",
      disableModelInvocation: true,
    });

    const prompt = snapshot.resources.find((entry) => entry.kind === "prompts");
    expect(prompt).toMatchObject({ name: "plan", argumentHint: "<topic>" });

    const theme = snapshot.resources.find((entry) => entry.kind === "themes");
    expect(theme).toMatchObject({ name: "midnight", origin: "package", source: "npm:themes" });

    // Resources are sorted by kind then name, so the UI never depends on load order.
    expect(snapshot.resources.map((entry) => entry.kind)).toEqual([
      "extensions",
      "skills",
      "prompts",
      "themes",
    ]);

    expect(snapshot.diagnostics).toEqual([
      { type: "warning", message: "duplicate skill", path: "C:\\res\\skills\\review\\SKILL.md" },
    ]);
  });

  it("attaches a loader error to the extension it belongs to", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        source: {
          extensions: {
            extensions: [extensionRecord()],
            errors: [{ path: "C:/res/foo/index.ts", error: "boom" }],
          },
          skills: { skills: [], diagnostics: [] },
          prompts: { prompts: [], diagnostics: [] },
          themes: { themes: [], diagnostics: [] },
        },
      }),
    );
    expect(snapshot.resources[0]?.error).toBe("boom");
  });

  it("does not lose a load error for an extension that never loaded", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        source: {
          extensions: {
            extensions: [],
            errors: [{ path: "C:/res/broken.ts", error: "cannot parse" }],
          },
          skills: { skills: [], diagnostics: [] },
          prompts: { prompts: [], diagnostics: [] },
          themes: { themes: [], diagnostics: [] },
        },
      }),
    );
    expect(snapshot.diagnostics).toContainEqual({
      type: "error",
      message: "cannot parse",
      path: "C:/res/broken.ts",
    });
  });

  it("turns a -path override into a disabled, re-enableable resource", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        settings: {
          global: { extensions: ["-C:/res/other/index.ts", "C:/res/plain.ts"] },
          project: { skills: ["-C:/res/skills/off/SKILL.md"] },
        },
      }),
    );
    const disabled = snapshot.resources.find((entry) => entry.enabled === false);
    expect(disabled).toMatchObject({
      kind: "extensions",
      name: "index.ts",
      overridePath: "C:/res/other/index.ts",
      override: "-C:/res/other/index.ts",
      scope: "user",
      enabled: false,
    });
    const projectDisabled = snapshot.resources.find(
      (entry) => entry.kind === "skills" && entry.enabled === false,
    );
    expect(projectDisabled).toMatchObject({ scope: "project", enabled: false });
    // A plain (non-override) entry is an include, not a resource.
    expect(snapshot.resources.some((entry) => entry.path === "C:/res/plain.ts")).toBe(false);
  });

  it("does not duplicate a loaded resource that an override names", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        settings: { global: { extensions: ["-C:/res/foo/index.ts"] }, project: {} },
      }),
    );
    expect(snapshot.resources.filter((entry) => entry.kind === "extensions")).toHaveLength(1);
    expect(snapshot.resources[0]?.enabled).toBe(true);
  });

  it("keeps glob overrides raw and warns about an unloaded force-include", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        settings: {
          global: { extensions: ["!C:/res/**/*.ts", "+C:/res/missing/index.ts"] },
          project: {},
        },
      }),
    );
    expect(snapshot.overrides).toEqual([
      { kind: "extensions", scope: "global", entry: "!C:/res/**/*.ts" },
    ]);
    expect(snapshot.diagnostics).toContainEqual({
      type: "warning",
      message: "+C:/res/missing/index.ts was force-included but Pi did not load it",
      path: "C:/res/missing/index.ts",
    });
    expect(snapshot.resources.some((entry) => entry.enabled === false)).toBe(false);
  });

  it("carries live extension errors and never fabricates one", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        runtimeErrors: [
          {
            extensionPath: "C:\\res\\foo\\index.ts",
            event: "agent_end",
            error: "kaboom",
            stack: "s",
            at: 9,
          },
          { nope: true },
        ],
      }),
    );
    expect(snapshot.runtimeErrors).toEqual([
      {
        extensionPath: "C:\\res\\foo\\index.ts",
        event: "agent_end",
        error: "kaboom",
        stack: "s",
        at: 9,
      },
    ]);
  });

  it("survives a source with no collections at all", () => {
    const snapshot = buildResourcesSnapshot({
      cwd: null,
      scope: "control",
      settings: { global: {}, project: {} },
      source: {},
      now: () => 0,
    });
    expect(snapshot).toMatchObject({ cwd: null, scope: "control", resources: [], loadedAt: 0 });
  });
});

describe("createResourceHandlers", () => {
  it("passes an optional cwd through to the inspector", async () => {
    const seen: Array<string | null> = [];
    const handlers = createResourceHandlers({
      inspect: (cwd) => {
        seen.push(cwd);
        return buildResourcesSnapshot({ ...baseInput(), cwd, scope: "control" });
      },
    }).handlers();
    await handlers["resources.list"]?.({ cwd: "C:\\project" }, {} as never);
    await handlers["resources.list"]?.({}, {} as never);
    expect(seen).toEqual(["C:\\project", null]);
  });
});

describe("the session host's resources.list", () => {
  it("reports live resources and captures extension_error history", async () => {
    let errorListener: ((error: unknown) => void) | undefined;
    const session = {
      sessionId: "s1",
      sessionFile: "C:/profile/s1.jsonl",
      messages: [],
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      resourceLoader: {
        getExtensions: () => ({ extensions: [extensionRecord()], errors: [] }),
        getSkills: () => skillsResult(),
        getPrompts: () => promptsResult(),
        getThemes: () => themesResult(),
      },
      extensionRunner: {
        getRegisteredCommands: () => [],
        onError: (listener: (error: unknown) => void) => {
          errorListener = listener;
          return () => {
            errorListener = undefined;
          };
        },
      },
    };
    const runtime = {
      get session() {
        return session;
      },
      get services() {
        return {
          cwd: "C:/project",
          settingsManager: {
            getGlobalSettings: () => ({ extensions: ["-C:/res/off.ts"] }),
            getProjectSettings: () => ({}),
          },
        };
      },
      dispose: async () => undefined,
    };
    const emitted: string[] = [];
    const core = createSessionCore({
      cwd: "C:/project",
      agentDir: "C:/agent",
      createRuntime: async () => ({ runtime, session }),
      newSessionManager: () => ({}),
      requiresTrust: () => false,
      emit: (event) => {
        emitted.push(event);
      },
    });
    const context: HostRequestContext = {
      method: "resources.list",
      requestId: 1,
      emit: () => undefined,
      readBlob: async () => null,
    };

    await core.handlers()["session.create"]?.({}, context);
    const snapshot = (await core.handlers()["resources.list"]?.({}, context)) as ResourcesSnapshot;
    expect(snapshot.scope).toBe("session");
    expect(snapshot.cwd).toBe("C:/project");
    expect(snapshot.resources.some((entry) => entry.kind === "extensions")).toBe(true);
    // The global disabled override is derived even though the resource is loaded.
    expect(snapshot.resources.some((entry) => entry.enabled === false)).toBe(true);

    errorListener?.({ extensionPath: "C:/res/foo/index.ts", event: "agent_end", error: "boom" });
    const after = (await core.handlers()["resources.list"]?.({}, context)) as ResourcesSnapshot;
    expect(after.runtimeErrors[0]).toMatchObject({ error: "boom", event: "agent_end" });

    await core.dispose();
    expect(errorListener).toBeUndefined();
    expect(emitted).toContain("session_started");
  });
});
