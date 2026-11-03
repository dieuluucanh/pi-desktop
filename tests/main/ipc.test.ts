import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcDependencies } from "../../src/main/ipc";
import { IPC } from "../../src/shared/ipc";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SessionTabsEnvelope } from "../../src/shared/session-ipc";
import type { ProjectsSnapshot } from "../../src/shared/projects";
import { emptyGitSnapshot, type GitAction, type GitActionResult } from "../../src/shared/git";
import {
  emptyCheckpointState,
  type CheckpointAction,
  type CheckpointActionResult,
} from "../../src/shared/checkpoints";
import { requireProjectPath } from "../../src/shared/git";

/**
 * The IPC layer's refusals (git-checkpoint plan steps 7 and 21).
 *
 * `registerIpcHandlers` is thin on purpose — every rule it enforces is a *refusal*,
 * and a refusal is exactly what a test can pin: an unknown project folder, a `..`
 * path, a bad branch name, an action outside the closed union, an oversized
 * commit message, a ref that is not a sha. The services behind the handlers are
 * faked, so a leaked call would be obvious.
 */

type Handler = (...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  ipcMain: {
    handle: (channel: string, handler: Handler): void => {
      handlers.set(channel, handler);
    },
  },
  shell: { showItemInFolder: (): void => undefined },
}));

/** Records every call the fake services receive. */
interface Recording {
  gitCalls: { kind: string; arg?: unknown }[];
  checkpointCalls: { kind: string; arg?: unknown }[];
  officeCalls: { kind: string; tabId?: string; takeover?: boolean }[];
  workspaceCalls: { kind: string; input?: unknown }[];
  sessionCalls: { kind: string; arg?: unknown }[];
}

const OPEN_PROJECT = "/work/app";

function envelope(): SessionTabsEnvelope {
  return {
    tabs: [
      {
        id: "t1",
        kind: "session",
        cwd: OPEN_PROJECT,
        title: "app",
        sessionFile: null,
        status: "idle",
        createdAt: 0,
        lastActiveAt: 0,
        model: null,
      },
    ],
    activeTabId: "t1",
  };
}

function projects(): ProjectsSnapshot {
  return {
    activeProject: OPEN_PROJECT,
    projects: [{ path: OPEN_PROJECT, name: "app", lastOpenedAt: 0 }],
    trust: {},
  } as unknown as ProjectsSnapshot;
}

async function register(recording: Recording): Promise<void> {
  const { registerIpcHandlers } = await import("../../src/main/ipc");
  const knownProjects = [OPEN_PROJECT];
  const deps: IpcDependencies = {
    appInfo: () => ({ name: "Pi", version: "1.0.0" }) as never,
    openExternal: async () => true,
    pickDirectory: async () => null,
    pickFile: async () => null,
    shareSession: async () => ({}),
    shareBugReport: async () => ({}),
    openEditor: async () => ({}),
    revealPath: () => true,
    setTitle: () => true,
    relaunch: () => true,
    prefs: { get: async () => DEFAULT_PREFS, set: async () => DEFAULT_PREFS },
    sessions: {
      knownTabIds: () => ["t1"],
      list: envelope,
      create: async () => envelope(),
      close: async () => envelope(),
      closeAll: async (kind) => {
        recording.sessionCalls.push({ kind: "closeAll", arg: kind });
        return envelope();
      },
      closeOthers: async (tabId) => {
        recording.sessionCalls.push({ kind: "closeOthers", arg: tabId });
        return envelope();
      },
      closeProject: async (cwd) => {
        recording.sessionCalls.push({ kind: "closeProject", arg: cwd });
        return envelope();
      },
      setPinned: async (tabId, pinned) => {
        recording.sessionCalls.push({ kind: "setPinned", arg: { tabId, pinned } });
        return envelope();
      },
      retargetEditorTabs: async (input) => {
        recording.sessionCalls.push({ kind: "retargetEditorTabs", arg: input });
        return envelope();
      },
      reorder: async () => envelope(),
      promoteOfficeHost: async () => envelope(),
      activate: async () => envelope(),
      deactivate: async () => envelope(),
      reconcile: async () => envelope(),
      restore: async () => envelope(),
      restart: async () => envelope(),
      request: async () => null,
      deleteSession: async () => ({ ok: true }) as never,
    },
    projects: {
      get: async () => projects(),
      mutate: async () => projects(),
      create: async () => ({ ok: true }) as never,
      clone: async () => ({ ok: true }) as never,
      action: async () => true,
      setSettings: async () => ({ ok: true }) as never,
    },
    officeSetup: {} as never,
    integrations: { get: async () => ({}) as never, recordOffice: async () => ({}) as never },
    officeRun: { stop: async () => ({ ok: true }) as never },
    officeControl: {
      connect: async (tabId, options) => {
        recording.officeCalls.push({ kind: "connect", tabId, ...options });
        return { ok: true, reason: "connected" };
      },
      close: async (tabId) => {
        recording.officeCalls.push({ kind: "close", tabId });
        return { ok: true, reason: "closed" };
      },
      restart: async (tabId, options) => {
        recording.officeCalls.push({ kind: "restart", tabId, ...options });
        return { ok: true, reason: "connected" };
      },
    },
    officeDocuments: {
      get: () => ({ available: false, panes: [] }) as never,
      refresh: async () => ({ available: false, panes: [] }) as never,
    },
    web: {
      open: async () => envelope(),
      setBounds: () => true,
      command: () => true,
      decideNavigation: () => true,
    },
    diagnostics: {
      get: () => ({}) as never,
      export: async () => ({}) as never,
      save: async () => ({}) as never,
      record: () => true,
    },
    updates: {
      get: () => ({}) as never,
      check: async () => ({}) as never,
      download: async () => ({}) as never,
      install: () => true,
      clearProblem: () => ({}) as never,
    },
    git: {
      // The real allowlist function under test, not a stub.
      resolveProjectPath: async (value) => requireProjectPath(knownProjects, value),
      snapshot: async (projectPath) => {
        recording.gitCalls.push({ kind: "snapshot", arg: projectPath });
        return emptyGitSnapshot(projectPath);
      },
      refresh: async (projectPath) => {
        recording.gitCalls.push({ kind: "refresh", arg: projectPath });
        return emptyGitSnapshot(projectPath);
      },
      watch: () => true,
      action: async (_projectPath, action: GitAction): Promise<GitActionResult> => {
        recording.gitCalls.push({ kind: "action", arg: action });
        return { ok: true };
      },
      diff: async () => {
        recording.gitCalls.push({ kind: "diff" });
        return { scope: "working", files: [], tooLarge: false, truncated: false };
      },
      log: async () => {
        recording.gitCalls.push({ kind: "log" });
        return [];
      },
      headMessage: async () => null,
      branches: async () => [],
    },
    checkpoints: {
      resolveProjectPath: async (value) => requireProjectPath(knownProjects, value),
      get: async (projectPath) => {
        recording.checkpointCalls.push({ kind: "get", arg: projectPath });
        return emptyCheckpointState(projectPath, 0);
      },
      refresh: async (projectPath) => {
        recording.checkpointCalls.push({ kind: "refresh", arg: projectPath });
        return emptyCheckpointState(projectPath, 0);
      },
      action: async (_projectPath, action: CheckpointAction): Promise<CheckpointActionResult> => {
        recording.checkpointCalls.push({ kind: "action", arg: action });
        return { ok: true };
      },
    },
    workspace: {
      resolveProjectPath: async (value) => requireProjectPath(knownProjects, value),
      listDirectory: async (input) => ({
        ok: true as const,
        value: {
          root: input.projectPath,
          path: input.path,
          entries: [],
          truncated: false,
        },
      }),
      listFiles: async (input) => ({
        ok: true as const,
        value: { root: input.projectPath, files: [], truncated: false },
      }),
      searchFiles: async (input) => {
        recording.workspaceCalls.push({ kind: "search", input });
        return {
          ok: true as const,
          value: {
            root: input.projectPath,
            query: input.query,
            matches: [],
            truncated: false,
            scanned: 0,
          },
        };
      },
      readFile: async () => ({
        ok: false as const,
        error: { code: "not_found" as const, message: "no file" },
      }),
      stat: async () => ({
        ok: false as const,
        error: { code: "not_found" as const, message: "no file" },
      }),
      writeFile: async () => ({
        ok: false as const,
        error: { code: "bad_request" as const, message: "not implemented" },
      }),
      create: async (input) => {
        recording.workspaceCalls.push({ kind: "create", input });
        return {
          ok: true as const,
          value: { path: input.path, absolutePath: `/abs/${input.path}`, kind: input.kind },
        };
      },
      rename: async (input) => {
        recording.workspaceCalls.push({ kind: "rename", input });
        return {
          ok: true as const,
          value: {
            path: input.toPath,
            absolutePath: `/abs/${input.toPath}`,
            kind: "file" as const,
            previousPath: input.path,
          },
        };
      },
      delete: async (input) => {
        recording.workspaceCalls.push({ kind: "delete", input });
        return {
          ok: true as const,
          value: { path: input.path, absolutePath: `/abs/${input.path}`, kind: "file" as const },
        };
      },
      transfer: async (input) => {
        recording.workspaceCalls.push({ kind: "transfer", input });
        return {
          ok: true as const,
          value: { operation: input.operation, transferred: [] },
        };
      },
      reveal: async () => ({ ok: true as const, value: true }),
      editorConfig: async () => ({
        ok: true as const,
        value: {
          indentStyle: "space" as const,
          indentSize: 2,
          tabWidth: 2,
          endOfLine: "lf" as const,
          insertFinalNewline: true,
          trimTrailingWhitespace: true,
        },
      }),
      readBackup: async () => ({ ok: true as const, value: null }),
      writeBackup: async () => ({ ok: true as const, value: true }),
      deleteBackup: async () => ({ ok: true as const, value: true }),
      format: async () => ({
        ok: false as const,
        error: { code: "not_configured" as const, message: "no formatter" },
      }),
    },
  };
  registerIpcHandlers(deps);
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  // The first argument of a real `ipcMain.handle` callback is the event.
  return handler({}, ...args);
}

let recording: Recording;

beforeEach(async () => {
  handlers.clear();
  recording = {
    gitCalls: [],
    checkpointCalls: [],
    officeCalls: [],
    workspaceCalls: [],
    sessionCalls: [],
  };
  await register(recording);
});

describe("office bridge control channels", () => {
  it("forwards connect with the takeover flag", async () => {
    await invoke(IPC.officeBridgeConnect, { tabId: "t1", takeover: true });
    expect(recording.officeCalls).toEqual([{ kind: "connect", tabId: "t1", takeover: true }]);
  });

  it("forwards close and restart", async () => {
    await invoke(IPC.officeBridgeClose, "t1");
    await invoke(IPC.officeBridgeRestart, { tabId: "t1" });
    expect(recording.officeCalls).toEqual([
      { kind: "close", tabId: "t1" },
      { kind: "restart", tabId: "t1", takeover: false },
    ]);
  });

  it("requires a non-empty tab id", () => {
    expect(() => invoke(IPC.officeBridgeConnect, { tabId: "  " })).toThrow(/tab id/);
    expect(() => invoke(IPC.officeBridgeClose, null)).toThrow(/tab id/);
  });

  it("rejects a non-boolean takeover", () => {
    expect(() => invoke(IPC.officeBridgeRestart, { tabId: "t1", takeover: "yes" })).toThrow(
      /takeover must be a boolean/,
    );
  });
});

describe("the project-folder allowlist", () => {
  it("accepts a folder the app has open", async () => {
    const snapshot = await invoke(IPC.gitSnapshot, OPEN_PROJECT);
    expect(snapshot).toMatchObject({ projectPath: OPEN_PROJECT });
    expect(recording.gitCalls).toEqual([{ kind: "snapshot", arg: OPEN_PROJECT }]);
  });

  it("accepts a Windows spelling of the same folder", async () => {
    await invoke(IPC.gitSnapshot, "\\work\\app\\");
    expect(recording.gitCalls).toHaveLength(1);
  });

  it("refuses an unknown folder and never reaches the engine", async () => {
    await expect(invoke(IPC.gitSnapshot, "/etc")).rejects.toThrow(/not an open project/);
    expect(recording.gitCalls).toEqual([]);
  });

  it("refuses a traversal path", async () => {
    await expect(invoke(IPC.gitRefresh, "/work/app/../../etc")).rejects.toThrow(
      /not an open project/,
    );
  });

  it("refuses a non-string folder", async () => {
    await expect(invoke(IPC.gitSnapshot, { path: OPEN_PROJECT })).rejects.toThrow(
      /project folder is required/,
    );
  });

  it("applies the same rule to the checkpoint channels", async () => {
    await expect(invoke(IPC.checkpointsGet, "/etc")).rejects.toThrow(/not an open project/);
    expect(recording.checkpointCalls).toEqual([]);
  });
});

describe("git action validation", () => {
  const actions: GitAction[] = [
    { kind: "stage", paths: ["src/a.ts"] },
    { kind: "commit", message: "feat: x", amend: false },
    { kind: "checkout-branch", branch: "dev" },
  ];

  it.each(actions)("passes a valid $kind action through", async (action) => {
    await invoke(IPC.gitAction, OPEN_PROJECT, action);
    expect(recording.gitCalls.at(-1)).toEqual({ kind: "action", arg: action });
  });

  it("refuses an unknown action kind", async () => {
    await expect(invoke(IPC.gitAction, OPEN_PROJECT, { kind: "rm-rf" })).rejects.toThrow(
      /unsupported action/,
    );
    expect(recording.gitCalls).toEqual([]);
  });

  it("refuses a non-object action", async () => {
    await expect(invoke(IPC.gitAction, OPEN_PROJECT, "commit")).rejects.toThrow(
      /unsupported action/,
    );
  });

  it("refuses a branch name git itself would reject", async () => {
    await expect(
      invoke(IPC.gitAction, OPEN_PROJECT, { kind: "checkout-branch", branch: "..bad" }),
    ).rejects.toThrow(/unsupported action/);
  });

  it("refuses a `..` path inside a stage action", async () => {
    await expect(
      invoke(IPC.gitAction, OPEN_PROJECT, { kind: "stage", paths: ["../outside.txt"] }),
    ).rejects.toThrow(/unsupported action/);
  });

  it("refuses an oversized identity", async () => {
    await expect(
      invoke(IPC.gitAction, OPEN_PROJECT, {
        kind: "set-identity",
        name: "n".repeat(500),
        email: "a@b.c",
      }),
    ).rejects.toThrow(/unsupported action/);
  });
});

describe("checkpoint action validation", () => {
  it("accepts each action in the closed union", async () => {
    await invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "create" });
    await invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "preview", ref: "a".repeat(40) });
    await invoke(IPC.checkpointsAction, OPEN_PROJECT, {
      kind: "restore",
      ref: "b".repeat(40),
      removeAdded: true,
    });
    await invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "prune" });
    await invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "usage" });
    expect(recording.checkpointCalls).toHaveLength(5);
  });

  it("refuses a ref that is not a full sha", async () => {
    await expect(
      invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "restore", ref: "HEAD~1" }),
    ).rejects.toThrow(/unsupported action/);
    await expect(
      invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "preview", ref: "a".repeat(39) }),
    ).rejects.toThrow(/unsupported action/);
  });

  it("refuses a ref that tries to inject an option", async () => {
    await expect(
      invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "restore", ref: "--hard" }),
    ).rejects.toThrow(/unsupported action/);
  });

  it("refuses a non-boolean removeAdded", async () => {
    await expect(
      invoke(IPC.checkpointsAction, OPEN_PROJECT, {
        kind: "restore",
        ref: "c".repeat(40),
        removeAdded: "yes",
      }),
    ).rejects.toThrow(/unsupported action/);
  });

  it("refuses an unknown action kind", async () => {
    await expect(
      invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "rewind-all" }),
    ).rejects.toThrow(/unsupported action/);
    expect(recording.checkpointCalls).toEqual([]);
  });

  it("drops an over-long label rather than passing it to the store", async () => {
    await invoke(IPC.checkpointsAction, OPEN_PROJECT, { kind: "create", label: "x".repeat(900) });
    const action = recording.checkpointCalls[0]?.arg as CheckpointAction;
    expect(action.kind).toBe("create");
    expect((action as { label?: string }).label?.length).toBe(300);
  });
});

describe("session tab lifecycle channels", () => {
  it("forwards kind-scoped close, project close, pin and retarget", async () => {
    await invoke(IPC.sessionCloseAll, "editor");
    await invoke(IPC.sessionCloseProject, "/work/app/");
    await invoke(IPC.sessionSetPinned, "t1", true);
    await invoke(IPC.sessionRetargetEditor, {
      fromProjectPath: "/work/app",
      fromPath: "src",
      toProjectPath: "/work/app",
      toPath: "lib",
      kind: "directory",
    });

    expect(recording.sessionCalls).toEqual([
      { kind: "closeAll", arg: "editor" },
      { kind: "closeProject", arg: "/work/app/" },
      { kind: "setPinned", arg: { tabId: "t1", pinned: true } },
      {
        kind: "retargetEditorTabs",
        arg: {
          fromProjectPath: "/work/app",
          fromPath: "src",
          toProjectPath: "/work/app",
          toPath: "lib",
          kind: "directory",
        },
      },
    ]);
  });

  it("rejects malformed session lifecycle input", async () => {
    expect(() => invoke(IPC.sessionCloseAll, "popup")).toThrow(/unsupported tab kind/);
    expect(() => invoke(IPC.sessionCloseProject, "  ")).toThrow(/project folder/);
    expect(() => invoke(IPC.sessionSetPinned, "t1", "yes")).toThrow(/boolean/);
    expect(() =>
      invoke(IPC.sessionRetargetEditor, {
        fromProjectPath: "/work/app",
        fromPath: "../secret",
        toProjectPath: "/work/app",
        toPath: "lib",
        kind: "file",
      }),
    ).toThrow(/project-relative/);
    expect(recording.sessionCalls).toEqual([]);
  });
});

describe("workspace search channel", () => {
  it("resolves the project and forwards the search options", async () => {
    await invoke(IPC.workspaceSearchFiles, {
      projectPath: OPEN_PROJECT,
      query: "2026-11-01",
      includeHidden: true,
      includeIgnored: true,
      limit: 25,
    });
    expect(recording.workspaceCalls).toEqual([
      {
        kind: "search",
        input: {
          projectPath: OPEN_PROJECT,
          query: "2026-11-01",
          includeHidden: true,
          includeIgnored: true,
          limit: 25,
        },
      },
    ]);
  });

  it("defaults the flags when they are omitted", async () => {
    await invoke(IPC.workspaceSearchFiles, { projectPath: OPEN_PROJECT, query: "app" });
    expect(recording.workspaceCalls[0]?.input).toEqual({
      projectPath: OPEN_PROJECT,
      query: "app",
    });
  });

  it("refuses a missing query or an unknown folder", async () => {
    await expect(invoke(IPC.workspaceSearchFiles, { projectPath: OPEN_PROJECT })).rejects.toThrow(
      /search query/,
    );
    await expect(
      invoke(IPC.workspaceSearchFiles, { projectPath: "/etc", query: "app" }),
    ).rejects.toThrow(/not an open project/);
    expect(recording.workspaceCalls).toEqual([]);
  });

  it("refuses an oversized query", async () => {
    await expect(
      invoke(IPC.workspaceSearchFiles, {
        projectPath: OPEN_PROJECT,
        query: "x".repeat(513),
      }),
    ).rejects.toThrow(/too long/);
  });
});

describe("workspace mutation channels", () => {
  it("forwards create, rename and delete after resolving the project", async () => {
    await invoke(IPC.workspaceCreate, {
      projectPath: OPEN_PROJECT,
      path: "src/new.ts",
      kind: "file",
    });
    await invoke(IPC.workspaceRename, {
      projectPath: OPEN_PROJECT,
      path: "src/new.ts",
      toPath: "src/renamed.ts",
    });
    await invoke(IPC.workspaceDelete, { projectPath: OPEN_PROJECT, path: "src/renamed.ts" });

    expect(recording.workspaceCalls).toEqual([
      {
        kind: "create",
        input: { projectPath: OPEN_PROJECT, path: "src/new.ts", kind: "file" },
      },
      {
        kind: "rename",
        input: { projectPath: OPEN_PROJECT, path: "src/new.ts", toPath: "src/renamed.ts" },
      },
      { kind: "delete", input: { projectPath: OPEN_PROJECT, path: "src/renamed.ts" } },
    ]);
  });

  it("resolves both projects for a transfer", async () => {
    await invoke(IPC.workspaceTransfer, {
      sourceProjectPath: OPEN_PROJECT,
      targetProjectPath: OPEN_PROJECT,
      sources: ["a.ts"],
      targetDirectory: "src",
      operation: "copy",
    });
    expect(recording.workspaceCalls).toEqual([
      {
        kind: "transfer",
        input: {
          sourceProjectPath: OPEN_PROJECT,
          targetProjectPath: OPEN_PROJECT,
          sources: ["a.ts"],
          targetDirectory: "src",
          operation: "copy",
        },
      },
    ]);
  });

  it("rejects malformed mutation input before reaching the service", async () => {
    await expect(
      invoke(IPC.workspaceCreate, { projectPath: OPEN_PROJECT, path: "a.ts", kind: "symlink" }),
    ).rejects.toThrow(/file or a directory/);
    await expect(
      invoke(IPC.workspaceRename, { projectPath: OPEN_PROJECT, path: "a.ts" }),
    ).rejects.toThrow(/new path/);
    await expect(
      invoke(IPC.workspaceTransfer, {
        sourceProjectPath: OPEN_PROJECT,
        targetProjectPath: OPEN_PROJECT,
        sources: [],
        targetDirectory: "",
        operation: "copy",
      }),
    ).rejects.toThrow(/at least one/);
    await expect(
      invoke(IPC.workspaceTransfer, {
        sourceProjectPath: OPEN_PROJECT,
        targetProjectPath: "/etc",
        sources: ["a.ts"],
        targetDirectory: "",
        operation: "move",
      }),
    ).rejects.toThrow(/not an open project/);
    expect(recording.workspaceCalls).toEqual([]);
  });
});
