import { describe, expect, it } from "vitest";
import { buildResourcesSnapshot, createResourceHandlers } from "../../src/host/resources";
import { createSessionCore } from "../../src/host/session-core";
import { resolveWorkflowBuiltin } from "../../src/host/workflow-builtin";
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

/**
 * The bundled Workflow builtin in the hub (plan step 27).
 *
 * Pi hides a `builtin:` extension from its *startup* list, not from the resource
 * collection, and a builtin it disables through settings never reaches the
 * loader at all. The hub must therefore show:
 *
 *  - the loaded builtin row with its name, pinned version and replaceability;
 *  - the settings-disabled row (`-builtin:workflow`) with the same badge;
 *  - Pi's replacement warning as a diagnostic, so a builtin that stepped aside
 *    for an installed copy is explained instead of silently missing.
 */
describe("builtin:workflow in the hub", () => {
  function builtinRow(overrides: Record<string, unknown> = {}) {
    return {
      path: "builtin:workflow",
      resolvedPath: "builtin:workflow",
      sourceInfo: {
        path: "builtin:workflow",
        source: "builtin",
        scope: "user",
        origin: "top-level",
      },
      hidden: true,
      commands: new Map([["/workflow", { name: "workflow", description: "Workflow modes" }]]),
      ...overrides,
    };
  }

  function resolution() {
    return resolveWorkflowBuiltin({
      bundleDir: "C:/resources/extensions/workflow",
      exists: () => true,
      readFile: () =>
        JSON.stringify({
          schema: 1,
          package: "@dieulc/workflow",
          version: "0.13.0",
          entry: "index.ts",
          license: "MIT",
          integrity: "sha512-abc=",
          hostPeers: ["typebox"],
          files: [{ path: "index.ts", sha256: "a".repeat(64) }],
        }),
    });
  }

  it("shows the loaded builtin with its pinned version and replacement policy", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        builtin: resolution(),
        source: {
          extensions: { extensions: [builtinRow()], errors: [], warnings: [] },
          skills: { skills: [], diagnostics: [] },
          prompts: { prompts: [], diagnostics: [] },
          themes: { themes: [], diagnostics: [] },
        },
      }),
    );
    const row = snapshot.resources.find((entry) => entry.overridePath === "builtin:workflow");
    expect(row).toMatchObject({
      kind: "extensions",
      name: "workflow",
      source: "builtin",
      enabled: true,
      hidden: true,
      builtin: { name: "workflow", version: "0.13.0", source: "bundled", replaceable: true },
    });
    expect(row?.contributed?.[0]).toMatchObject({ kind: "command", name: "workflow" });
  });

  it("keeps the settings-disabled opt-out as a re-enableable builtin row", () => {
    const snapshot = buildResourcesSnapshot(
      baseInput({
        builtin: resolution(),
        settings: {
          global: { extensions: ["-builtin:workflow"] },
          project: {},
        },
        source: {
          extensions: { extensions: [], errors: [], warnings: [] },
          skills: { skills: [], diagnostics: [] },
          prompts: { prompts: [], diagnostics: [] },
          themes: { themes: [], diagnostics: [] },
        },
      }),
    );
    const row = snapshot.resources.find((entry) => entry.overridePath === "builtin:workflow");
    expect(row).toMatchObject({
      name: "workflow",
      enabled: false,
      override: "-builtin:workflow",
      builtin: { name: "workflow", version: "0.13.0" },
    });
  });

  it("surfaces Pi's replacement warning so a replaced builtin is explained", () => {
    const message =
      "Extension C:/profile/extensions/workflow/index.ts registers command `/workflow`, so built-in extension `workflow` was not loaded.";
    const snapshot = buildResourcesSnapshot(
      baseInput({
        builtin: resolution(),
        source: {
          extensions: {
            extensions: [extensionRecord({ path: "C:/profile/extensions/workflow/index.ts" })],
            errors: [],
            warnings: [{ path: "builtin:workflow", warning: message }],
          },
          skills: { skills: [], diagnostics: [] },
          prompts: { prompts: [], diagnostics: [] },
          themes: { themes: [], diagnostics: [] },
        },
      }),
    );
    expect(snapshot.diagnostics).toContainEqual({
      type: "warning",
      message,
      path: "builtin:workflow",
    });
    // The installed copy is what loaded; the builtin row is absent, not invented.
    expect(snapshot.resources.some((entry) => entry.overridePath === "builtin:workflow")).toBe(
      false,
    );
  });

  it("reports a missing staged bundle as a repair diagnostic, not silence", () => {
    const missing = resolveWorkflowBuiltin({ bundleDir: null });
    const snapshot = buildResourcesSnapshot(
      baseInput({
        builtin: missing,
        source: {
          extensions: { extensions: [], errors: [], warnings: [] },
          skills: { skills: [], diagnostics: [] },
          prompts: { prompts: [], diagnostics: [] },
          themes: { themes: [], diagnostics: [] },
        },
      }),
    );
    expect(missing).toMatchObject({ registered: false, disabledBy: "missing-bundle" });
    expect(snapshot.diagnostics).toContainEqual({
      type: "error",
      message:
        "bundled Workflow is not loaded: no staged Workflow bundle was found for this install",
      path: "builtin:workflow",
    });
    expect(snapshot.diagnostics).toContainEqual({
      type: "warning",
      message: `repair: ${missing.hint}`,
      path: "builtin:workflow",
    });
    // Nothing is invented: there is no resource row for a bundle that is absent.
    expect(snapshot.resources).toEqual([]);
  });

  it("reports a corrupt staged bundle with its own problem and repair hint", () => {
    const invalid = resolveWorkflowBuiltin({
      bundleDir: "C:/resources/extensions/workflow",
      exists: () => true,
      readFile: () => "{ not json",
    });
    const snapshot = buildResourcesSnapshot(
      baseInput({
        builtin: invalid,
        source: {
          extensions: { extensions: [], errors: [], warnings: [] },
          skills: { skills: [], diagnostics: [] },
          prompts: { prompts: [], diagnostics: [] },
          themes: { themes: [], diagnostics: [] },
        },
      }),
    );
    expect(invalid.disabledBy).toBe("invalid-bundle");
    expect(snapshot.diagnostics).toContainEqual({
      type: "error",
      message:
        "bundled Workflow is not loaded: the staged Workflow copy has an invalid workflow-bundle.json",
      path: "builtin:workflow",
    });
  });

  it("adds no repair diagnostic for a loaded copy or for safe mode", () => {
    const emptySource = {
      extensions: { extensions: [builtinRow()], errors: [], warnings: [] },
      skills: { skills: [], diagnostics: [] },
      prompts: { prompts: [], diagnostics: [] },
      themes: { themes: [], diagnostics: [] },
    };
    const loaded = buildResourcesSnapshot(
      baseInput({ builtin: resolution(), source: emptySource }),
    );
    expect(loaded.diagnostics).toEqual([]);

    const safe = buildResourcesSnapshot(
      baseInput({ builtin: resolveWorkflowBuiltin({ safeMode: true }), source: emptySource }),
    );
    expect(safe.diagnostics).toEqual([]);
  });
});
