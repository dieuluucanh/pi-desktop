import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.GIT_AUTHOR_NAME ??= "Test";
process.env.GIT_AUTHOR_EMAIL ??= "test@example.com";
process.env.GIT_COMMITTER_NAME ??= "Test";
process.env.GIT_COMMITTER_EMAIL ??= "test@example.com";

/**
 * Command / mode / config / policy parity against the **actual staged artifact**
 * (Workflow plan step 31).
 *
 * Earlier rows proved the *generic host seam* with hand-made contributions. This
 * suite loads the real staged `@dieulc/workflow` bundle that Desktop ships
 * (`out/extensions/workflow`, byte-verified by `npm run workflow:verify`) and
 * drives its registered command surface through a fake ExtensionAPI. That makes
 * the evidence "the artifact really registers and behaves this way", not "our
 * own fixture says so".
 *
 * Scope of this row: the mode ring (Default → Plan → Orchestrator → Build) and
 * Tab/`/workflow-cycle`, `/workflow`, `/role`, `/profile`, model/thinking/default
 * settings, and the policy commands `/permissions`, `/write-policy`,
 * `/read-policy`, `/folder-policy`, `/shell-guard`, `/commit-policy`, `/commit`.
 *
 * It also pins the invariants the plan requires of these flows:
 *  - the main model / roles / profiles / default settings are never changed by
 *    configuring the refinement model;
 *  - project-scope policy writes are ignored for an untrusted project and no
 *    dialog grants authority;
 *  - entering a mode performs no execution (no parent turn, no write, no commit);
 *  - Desktop source never parses a command by the Workflow name.
 *
 * Everything is hermetic: `PI_CODING_AGENT_DIR` and the session cwd point at a
 * throwaway directory, so a developer's real roles/profiles/policies/settings
 * are never read or written.
 */

const ARTIFACT_DIR = join(process.cwd(), "out", "extensions", "workflow");
const ARTIFACT_ENTRY = join(ARTIFACT_DIR, "index.ts");

if (process.env.PI_REQUIRE_WORKFLOW_BUNDLE === "1" && !existsSync(ARTIFACT_ENTRY)) {
  throw new Error(
    `PI_REQUIRE_WORKFLOW_BUNDLE=1 but ${ARTIFACT_ENTRY} is missing; run npm run workflow:stage.`,
  );
}

// ── Fake ExtensionAPI ─────────────────────────────────────────────────

interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: unknown) => unknown;
  getArgumentCompletions?: (prefix: string) => unknown;
}

interface Completion {
  value: string;
  label?: string;
  description?: string;
}

interface TimelineEntry {
  kind: "tools" | "send" | "model" | "entry";
  [key: string]: unknown;
}

function createFakePi(over: { activeTools?: string[] } = {}) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const busHandlers = new Map<string, Array<(payload: unknown) => unknown>>();
  const commands = new Map<string, RegisteredCommand>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
  const tools = new Map<string, { name: string }>();
  const flags = new Map<string, unknown>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const sent: Array<{ content: unknown; options?: unknown }> = [];
  const timeline: TimelineEntry[] = [];
  const renderers: string[] = [];

  const pi = {
    handlers,
    commands,
    shortcuts,
    tools,
    flags,
    entries,
    sent,
    timeline,
    renderers,
    activeTools: over.activeTools ?? ["read", "write", "edit", "bash"],
    model: undefined as unknown,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, opts: Omit<RegisteredCommand, "name">) {
      commands.set(name, { name, ...opts });
    },
    registerTool(definition: { name?: string }) {
      if (definition?.name) tools.set(definition.name, definition as { name: string });
    },
    registerShortcut(
      key: string,
      opts: { description?: string; handler: (ctx: unknown) => unknown },
    ) {
      shortcuts.set(String(key), opts);
    },
    registerFlag(name: string, options: unknown) {
      flags.set(name, options);
    },
    registerEntryRenderer(type: string) {
      renderers.push(type);
    },
    registerMessageRenderer() {},
    registerMarkdownTransformer() {},
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
      timeline.push({ kind: "entry", type });
    },
    getActiveTools() {
      return [...pi.activeTools];
    },
    setActiveTools(next: string[]) {
      pi.activeTools = [...next];
      timeline.push({ kind: "tools", tools: [...next] });
    },
    getAllTools() {
      return [];
    },
    getFlagValue() {
      return undefined;
    },
    setModel(model: unknown) {
      pi.model = model;
      timeline.push({ kind: "model", model });
    },
    sendMessage(content: unknown, options?: unknown) {
      sent.push({ content, options });
      timeline.push({ kind: "send", content });
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sent.push({ content, options });
      timeline.push({ kind: "send", content });
    },
    exec(command: string, args?: string[], options?: { signal?: AbortSignal; cwd?: string }) {
      // The artifact's checkpoint/rewind path shells out through pi.exec; run it
      // for real so `isDirty`/`restore` see the temp repository, not an empty
      // stub. The fake host only ever issues git here.
      const run = promisify(execFile);
      return run(command, args ?? [], {
        maxBuffer: 4 * 1024 * 1024,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      })
        .then(({ stdout, stderr }) => ({ stdout, stderr, code: 0 }))
        .catch((error: { stdout?: string; stderr?: string; code?: number }) => ({
          stdout: String(error?.stdout ?? ""),
          stderr: String(error?.stderr ?? ""),
          code: typeof error?.code === "number" ? error.code : 1,
        }));
    },
    events: {
      on(event: string, handler: (payload: unknown) => unknown) {
        const list = busHandlers.get(event) ?? [];
        list.push(handler);
        busHandlers.set(event, list);
        return () => {
          const live = busHandlers.get(event);
          const index = live?.indexOf(handler) ?? -1;
          if (live && index >= 0) live.splice(index, 1);
        };
      },
      emit(event: string, payload?: unknown) {
        for (const handler of busHandlers.get(event) ?? []) {
          try {
            void handler(payload);
          } catch {
            /* listener failures never break the fake host */
          }
        }
      },
      listenerCount(event?: string) {
        if (event === undefined) {
          return [...busHandlers.values()].reduce((total, list) => total + list.length, 0);
        }
        return busHandlers.get(event)?.length ?? 0;
      },
    },
    async emit(event: string, payload: unknown = {}, ctx?: unknown) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
  };
  return pi;
}

type FakePi = ReturnType<typeof createFakePi>;

// ── Fake extension context ────────────────────────────────────────────

interface FakeCtxOptions {
  cwd: string;
  projectTrusted?: boolean;
  hasUI?: boolean;
  modelRegistry?: unknown;
  /** Answers returned by successive `ui.custom` dialogs (questionnaire, rewind). */
  customAnswers?: unknown[];
  /** Answer returned by `ui.select` (rewind dirty-file prompt, handoff menus). */
  selectAnswer?: string | undefined;
  /** Answer returned by `ui.confirm`. */
  confirmAnswer?: boolean;
  /** Session branch entries seen by commands (rewind checkpoints, reload restore). */
  branch?: unknown[];
}

function createFakeCtx(over: FakeCtxOptions) {
  const notifies: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const widgets: Array<{ key: string; value: unknown }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const customs: unknown[] = [];
  const selects: Array<{ title: string; options: unknown }> = [];
  const editorTexts: string[] = [];
  /** `ctx.navigateTree` calls (rewind moves the conversation branch). */
  const navigations: Array<{ id: string; options?: unknown }> = [];
  /** Custom transcript messages appended through the SDK fallback. */
  const customMessages: Array<{ customType?: string; content?: unknown; display?: unknown }> = [];
  const customAnswers = [...(over.customAnswers ?? [])];
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
  };
  const ctx = {
    cwd: over.cwd,
    mode: "tui",
    hasUI: over.hasUI === true,
    signal: undefined,
    scopedModels: [],
    isIdle: () => true,
    abort: () => {},
    isProjectTrusted: () => over.projectTrusted !== false,
    modelRegistry: over.modelRegistry ?? {
      find: (provider: string, id: string) => ({ provider, id }),
      getAvailable: () => [],
      getAll: () => [],
    },
    settings: {},
    sessionManager: {
      getSessionId: () => "fake-session",
      getBranch: () => (over.branch ?? []) as unknown[],
      buildContextEntries: () => [],
      appendCustomMessageEntry: (customType: string, content: unknown, display?: unknown) => {
        customMessages.push({ customType, content, display });
        return "fake-entry";
      },
    },
    ui: {
      async select(title: string, options: unknown) {
        selects.push({ title, options });
        return over.selectAnswer;
      },
      async custom() {
        const answer = customAnswers.length > 0 ? customAnswers.shift() : null;
        customs.push(answer);
        return answer;
      },
      async editor() {
        return undefined;
      },
      async input() {
        return undefined;
      },
      async confirm(title: string, message: string) {
        confirms.push({ title, message });
        return over.confirmAnswer === true;
      },
      notify(message: string, level?: string) {
        notifies.push({ message, level });
      },
      setStatus(key: string, value: unknown) {
        statuses.push({ key, value });
      },
      setWidget(key: string, value: unknown) {
        widgets.push({ key, value });
      },
      setWorkingMessage() {},
      setWorkingVisible() {},
      setEditorComponent() {},
      getEditorText() {
        return "";
      },
      setEditorText(text: string) {
        editorTexts.push(text);
      },
      theme,
    },
    theme,
    async navigateTree(id: string, options?: unknown) {
      navigations.push({ id, options });
    },
  };
  return {
    ctx,
    notifies,
    statuses,
    widgets,
    confirms,
    selects,
    customs,
    customMessages,
    editorTexts,
    navigations,
  };
}

// ── Boot the real staged artifact ─────────────────────────────────────

interface Boot {
  pi: FakePi;
  ui: ReturnType<typeof createFakeCtx>;
  cwd: string;
  agentDir: string;
  /** Run one registered command by name. */
  run(name: string, args?: string): Promise<void>;
  /** Run one registered tool by name (real artifact definition). */
  runTool(name: string, params: unknown, ctx?: unknown): Promise<unknown>;
  completions(name: string, prefix: string): Completion[] | null;
  /** Emit a bus event the artifact may be listening to. */
  bus(event: string, payload?: unknown): void;
  /** Every `session-host:request` the artifact emitted (external child asks). */
  relatedRequests(): unknown[];
  /** Last accepted `host-contributions:update` payload, if any. */
  latestContributions(): Array<Record<string, unknown>>;
  /** Last value written to a status key, if any. */
  statusValue(key: string): unknown;
  /** All visible notification text joined, for substring assertions. */
  notices(): string;
  cleanup(): Promise<void>;
}

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(
  options: {
    projectTrusted?: boolean;
    hasUI?: boolean;
    modelRegistry?: unknown;
    customAnswers?: unknown[];
    selectAnswer?: string;
    confirmAnswer?: boolean;
    branch?: unknown[];
  } = {},
): Promise<Boot> {
  const root = mkdtempSync(join(tmpdir(), "wf-artifact-parity-"));
  temporary.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const pi = createFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const mod = (await import(/* @vite-ignore */ ARTIFACT_ENTRY)) as {
    default: (api: FakePi, deps?: unknown) => unknown;
  };
  await mod.default(pi, {
    // Never open a browser or wait for Plannotator in this harness.
    plannotatorRequestTimeoutMs: 1,
    plannotatorRecoveryTimeoutMs: 1,
    isTerminalHost: () => true,
  });

  const ui = createFakeCtx({
    cwd,
    projectTrusted: options.projectTrusted,
    hasUI: options.hasUI,
    modelRegistry: options.modelRegistry,
    customAnswers: options.customAnswers,
    selectAnswer: options.selectAnswer,
    confirmAnswer: options.confirmAnswer,
    branch: options.branch,
  });

  // Capture the generic contribution stream exactly the way a host would: a
  // versioned envelope per accepted change, newest last.
  const envelopes: Array<{ revision?: number; contributions?: Array<Record<string, unknown>> }> =
    [];
  pi.events.on("host-contributions:update", (payload: unknown) => {
    if (payload && typeof payload === "object") {
      envelopes.push(payload as (typeof envelopes)[number]);
    }
  });
  // The related-session bridge is the only authenticated external-child path.
  // The current Orchestrator is in-process, so this must stay empty for every
  // Orchestrator/refinement action below.
  const relatedRequests: unknown[] = [];
  pi.events.on("session-host:request", (payload: unknown) => {
    relatedRequests.push(payload);
  });

  await pi.emit("session_start", { reason: "startup" }, ui.ctx);

  // A host that speaks the contract announces itself; the artifact probes on
  // session_start, so this is the answer it is waiting for. Everything below
  // can then assert on real published contributions instead of status prose.
  pi.events.emit("host-contributions:hello", {
    contractVersion: 1,
    kinds: ["mode", "progress", "status", "action", "input", "related-session", "composer-control"],
    slots: ["mode", "progress", "status", "action", "input", "sessions", "composer-actions"],
  });

  return {
    pi,
    ui,
    cwd,
    agentDir,
    async run(name, args = "") {
      const command = pi.commands.get(name);
      if (!command) throw new Error(`command /${name} is not registered by the artifact`);
      await command.handler(args, ui.ctx);
    },
    async runTool(name, params, ctx = ui.ctx) {
      const tool = pi.tools.get(name) as
        { execute?: (...args: unknown[]) => Promise<unknown> } | undefined;
      if (!tool?.execute) throw new Error(`tool ${name} is not registered by the artifact`);
      return tool.execute("tool-call", params, new AbortController().signal, () => {}, ctx);
    },
    completions(name, prefix) {
      const command = pi.commands.get(name);
      if (!command?.getArgumentCompletions) return null;
      return command.getArgumentCompletions(prefix) as Completion[] | null;
    },
    bus(event, payload) {
      pi.events.emit(event, payload);
    },
    relatedRequests() {
      return [...relatedRequests];
    },
    latestContributions() {
      return [...(envelopes.at(-1)?.contributions ?? [])];
    },
    statusValue(key) {
      const hit = [...ui.statuses].reverse().find((entry) => entry.key === key);
      return hit?.value;
    },
    notices() {
      return ui.notifies.map((entry) => entry.message).join("\n");
    },
    async cleanup() {
      try {
        await pi.emit("session_shutdown", { reason: "quit" }, ui.ctx);
      } catch {
        /* shutdown is best-effort in the fake host */
      }
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

/** Run git in a temp repo without inheriting a developer config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

/** Last active-tool set the artifact applied. */
function lastToolSet(pi: FakePi): string[] | undefined {
  const entry = [...pi.timeline].reverse().find((item) => item.kind === "tools");
  return entry && Array.isArray(entry.tools) ? (entry.tools as string[]) : undefined;
}

/** Nothing the plan forbids on mode entry: no turn, no write, no commit. */
function assertNoExecution(pi: FakePi): void {
  expect(pi.sent, "mode entry must not send a user/model turn").toEqual([]);
  expect(pi.timeline.filter((entry) => entry.kind === "send")).toEqual([]);
}

const MODE_COMMANDS = [
  "plan",
  "workflow",
  "build",
  "default",
  "orchestrator",
  "workflow-cycle",
] as const;

const POLICY_COMMANDS = [
  "permissions",
  "write-policy",
  "read-policy",
  "folder-policy",
  "shell-guard",
  "commit-policy",
  "commit",
] as const;

/**
 * Row commands the **currently pinned** artifact does not register. The staged
 * 0.17.5 release registers the whole row set, including `/workflow` (the
 * 0.13.0 release predated it). Keeping this an exact ledger makes the test fail
 * in both directions: a newly missing command, or a re-pin that is not
 * reflected here.
 */
const PINNED_ARTIFACT_MISSING: readonly string[] = [];

/** The local tarball version staged by row 13; 0.17.5 carries the child-todo fixes. */
const STAGED_WORKFLOW_VERSION = "0.17.5";

describe.skipIf(!existsSync(ARTIFACT_ENTRY))(
  "staged Workflow artifact: command/mode/config/policy parity",
  () => {
    it("is the byte-verified staged bundle, not the developer checkout", () => {
      const metadata = JSON.parse(
        readFileSync(join(ARTIFACT_DIR, "workflow-bundle.json"), "utf8"),
      ) as { package: string; version: string; entry: string };
      expect(metadata.package).toBe("@dieulc/workflow");
      expect(metadata.entry).toBe("index.ts");
      // A newly staged bundle must be reflected here, so an old copy left on
      // disk (or a W checkout) can never satisfy this suite silently. Both
      // shipped copies are staged from the same local tarball.
      expect(metadata.version).toBe(STAGED_WORKFLOW_VERSION);
      const shipped = JSON.parse(
        readFileSync(
          join(process.cwd(), "resources", "extensions", "workflow", "workflow-bundle.json"),
          "utf8",
        ),
      ) as { package: string; version: string };
      expect(shipped.package).toBe("@dieulc/workflow");
      expect(shipped.version).toBe(STAGED_WORKFLOW_VERSION);
    });

    it("registers the command inventory this row exercises", async () => {
      const booted = await boot();
      try {
        const registered = [...booted.pi.commands.keys()].sort();
        for (const name of [...MODE_COMMANDS, ...POLICY_COMMANDS]) {
          if (PINNED_ARTIFACT_MISSING.includes(name)) continue;
          expect(registered, `/${name} must be registered by the artifact`).toContain(name);
        }
        for (const name of ["role", "profile", "prompt", "prompt-model", "todos", "review"]) {
          expect(registered).toContain(name);
        }
        // The mode controls are contributed as generic actions; the artifact must
        // still register the command they resolve to (host-owned action args).
        expect(registered).toContain("workflow-cycle");
        expect(booted.pi.shortcuts.has("tab"), "Tab is registered for the mode cycle").toBe(true);

        // Pinned-artifact ledger: the set of row commands the *staged* artifact
        // does not register yet. It must match exactly, so restaging the bundle
        // fails this test until the ledger is updated (and a newly missing
        // command fails immediately). See docs/workflow-parity-matrix.md §7.
        const missing = [...MODE_COMMANDS, ...POLICY_COMMANDS].filter(
          (name) => !registered.includes(name),
        );
        expect(missing.sort()).toEqual([...PINNED_ARTIFACT_MISSING].sort());

        // The hyphenated siblings are gone: each family has one command and a
        // verb argument. The canonical grammar lives in `command.name +
        // command.args`, so a removed name must never be registered again.
        for (const removed of [
          "orchestrator-pause",
          "orchestrator-resume",
          "orchestrator-abort",
          "orchestrator-view",
          "review-mode",
          "review-prompt",
          "review-status",
          "review-pause",
          "review-resume",
          "review-abort",
        ]) {
          expect(registered, `/${removed} must not be registered`).not.toContain(removed);
        }
      } finally {
        await booted.cleanup();
      }
    });

    it("cycles Default → Plan → Orchestrator → Build through /workflow-cycle and Tab", async () => {
      const booted = await boot();
      try {
        const seen: Array<string | undefined> = [];
        const record = () => {
          const status = booted.statusValue("workflow");
          seen.push(typeof status === "string" ? status : undefined);
        };

        expect(String(booted.statusValue("workflow") ?? "")).not.toMatch(/plan|orchestrator|build/);
        await booted.run("workflow-cycle");
        record();
        await booted.run("workflow-cycle");
        record();
        await booted.run("workflow-cycle");
        record();
        await booted.run("workflow-cycle");
        record();

        // Default → Plan → Orchestrator → Build → Default
        expect(seen[0]).toMatch(/plan/);
        expect(seen[1]).toMatch(/orchestrator/);
        expect(seen[2]).toMatch(/build/);
        // Back to Default: the mode segment is either unset or the default badge.
        expect(seen[3] ?? "").not.toMatch(/plan|orchestrator|build/);

        // Tab drives the same serialized cycle as the command.
        const tab = booted.pi.shortcuts.get("tab");
        expect(tab).toBeTruthy();
        await tab!.handler(booted.ui.ctx);
        expect(booted.statusValue("workflow")).toMatch(/plan/);

        // `/workflow` is the Plan-mode entry (alias for /plan in this host).
        // The 0.17.5 artifact registers it; the ledger above would record a
        // regression to an older bundle that predates it.
        if (!PINNED_ARTIFACT_MISSING.includes("workflow")) {
          await booted.run("workflow");
          expect(booted.statusValue("workflow")).toMatch(/plan/);
        }
        assertNoExecution(booted.pi);
      } finally {
        await booted.cleanup();
      }
    });

    it("gates the active tool set per mode without executing anything", async () => {
      const plan = await boot();
      try {
        await plan.run("plan");
        const planTools = lastToolSet(plan.pi) ?? [];
        expect(planTools).toContain("workflow_todo");
        expect(planTools).toContain("questionnaire");
        expect(planTools).not.toContain("orchestrator_start");
        assertNoExecution(plan.pi);
      } finally {
        await plan.cleanup();
      }

      const build = await boot();
      try {
        await build.run("build");
        const buildTools = lastToolSet(build.pi) ?? [];
        expect(buildTools).toContain("workflow_todo");
        expect(buildTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
        assertNoExecution(build.pi);
      } finally {
        await build.cleanup();
      }

      // `/build` directly after `/plan` restores the pre-Plan tool set instead of
      // re-deriving it; that is the documented Build path from Plan.
      const fromPlan = await boot();
      try {
        await fromPlan.run("plan");
        await fromPlan.run("build");
        expect(lastToolSet(fromPlan.pi) ?? []).toEqual(["read", "write", "edit", "bash"]);
        assertNoExecution(fromPlan.pi);
      } finally {
        await fromPlan.cleanup();
      }
    });

    it("/role and /profile list the configured catalogue without touching the live model", async () => {
      const booted = await boot();
      try {
        const modelBefore = booted.pi.model;
        await booted.run("role", "list");
        const roles = booted.notices();
        expect(roles).toMatch(/planner/i);
        expect(roles).toMatch(/builder/i);
        expect(roles).toMatch(/explorer/i);
        expect(roles).toMatch(/reviewer/i);

        await booted.run("profile", "list");
        expect(booted.notices()).toMatch(/profile/i);

        // Listing must not select or change a model.
        expect(booted.pi.model).toBe(modelBefore);
        expect(booted.pi.timeline.filter((entry) => entry.kind === "model")).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("/role set validates an unknown model instead of silently switching", async () => {
      const booted = await boot();
      try {
        await booted.run("role", "use planner 1");
        expect(booted.notices()).toMatch(/unknown|not found|no such|role/i);
        // A rejected pick never reaches pi.setModel.
        expect(booted.pi.timeline.filter((entry) => entry.kind === "model")).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("keeps the refinement model separate from the main model/default settings", async () => {
      const booted = await boot();
      try {
        const modelBefore = booted.pi.model;
        await booted.run("prompt-model", "status");
        expect(booted.notices()).toMatch(/refine|prompt/i);

        // Configuring the refiner must not select a model in the session, nor
        // write the Pi default mirror / workflow.modelDefault / roles / profiles.
        await booted.run("prompt-model", "set openai/gpt-5 thinking:low");
        expect(booted.pi.model).toBe(modelBefore);
        expect(booted.pi.timeline.filter((entry) => entry.kind === "model")).toEqual([]);

        const settingsPath = join(booted.agentDir, "settings.json");
        if (existsSync(settingsPath)) {
          const raw = readFileSync(settingsPath, "utf8");
          const settings = JSON.parse(raw) as Record<string, unknown>;
          const refinement = (settings.workflow as Record<string, unknown> | undefined)
            ?.promptRefinement;
          expect(refinement).toBeTruthy();
          for (const foreign of [
            "defaultProvider",
            "defaultModel",
            "defaultThinkingLevel",
            "modelDefault",
            "roles",
            "profiles",
          ]) {
            expect(raw, `refinement must not write ${foreign}`).not.toContain(foreign);
          }
        }

        // The refinement model never becomes the session model when the user
        // returns to Default mode either.
        await booted.run("plan");
        await booted.run("default");
        expect(booted.pi.model).not.toBe(
          (booted.pi.timeline.find((entry) => entry.kind === "model")?.model as { id?: string })
            ?.id,
        );
        expect(booted.notices()).toMatch(/default|mode/i);
      } finally {
        await booted.cleanup();
      }
    });

    it("answers /permissions explain for a command and never executes it", async () => {
      const booted = await boot();
      try {
        await booted.run("permissions", "explain git status");
        expect(booted.notices()).toMatch(/allow|refus|deny|permission/i);
        expect(booted.pi.sent).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("round-trips /write-policy, /commit-policy and /read-policy in a trusted project", async () => {
      const booted = await boot({ projectTrusted: true });
      try {
        await booted.run("write-policy", "never");
        const text = booted.notices();
        expect(text).toMatch(/write policy/i);
        expect(text).toMatch(/never/);
        await booted.run("write-policy", "status");
        expect(booted.notices()).toMatch(/never/);

        await booted.run("commit-policy", "ask");
        expect(booted.notices()).toMatch(/commit policy/i);
        expect(booted.notices()).toMatch(/ask/);

        await booted.run("read-policy", "shell strict");
        expect(booted.notices()).toMatch(/strict/i);
        await booted.run("read-policy", "status");
        expect(booted.notices()).toMatch(/strict/i);

        // Writing a policy never runs a shell command or opens a chat turn.
        expect(booted.pi.sent).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("ignores a project-scope policy write for an untrusted project", async () => {
      const booted = await boot({ projectTrusted: false });
      try {
        await booted.run("folder-policy", "repo project");
        await booted.run("folder-policy", "status");
        expect(booted.notices()).toMatch(/folder policy/i);
        // The status names the ignored project source instead of claiming it.
        expect(booted.notices()).toMatch(/ignored|not trusted|project/i);
        expect(booted.pi.sent).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("names sensitive paths and refuses to widen them from a project file", async () => {
      const booted = await boot({ projectTrusted: false });
      try {
        await booted.run("folder-policy", "sensitive");
        const text = booted.notices();
        expect(text).toMatch(/sensitive/i);
        // The default deny list is the shared floor for read/write/commit.
        expect(text).toMatch(/\.env|\.git|secret|key/i);

        // /permissions explains a command that touches a sensitive path; it must
        // report the refusal instead of executing anything.
        booted.ui.notifies.length = 0;
        await booted.run("permissions", "explain cat .env");
        expect(booted.notices()).toMatch(/refus|deny|sensitive|block|allow/i);
        expect(booted.pi.sent).toEqual([]);
        expect(booted.ui.confirms).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("keeps /commit approval ownership: no commit without an explicit confirmation", async () => {
      const booted = await boot();
      try {
        git(booted.cwd, "init", "-b", "main");
        git(booted.cwd, "config", "user.email", "test@example.com");
        git(booted.cwd, "config", "user.name", "Test");
        writeFileSync(join(booted.cwd, "a.txt"), "one\n");
        git(booted.cwd, "add", "a.txt");

        // Default commit policy is `never`: the agent may not commit. `/commit`
        // starts a proposal turn but never arms an authorization or writes
        // history by itself; the fake questionnaire never confirms.
        await booted.run("commit");
        // `git log` exits non-zero while the repository has no commits yet — that
        // is exactly the assertion: `/commit` wrote no history by itself.
        const log = (() => {
          try {
            return git(booted.cwd, "log", "--oneline");
          } catch {
            return "";
          }
        })();
        expect(log.trim()).toBe("");
        // A real staged diff starts ONE proposal turn that ends in the commit
        // questionnaire. No dialog was answered, so nothing was armed.
        const proposals = booted.pi.sent.filter((entry) =>
          JSON.stringify(entry.content).includes("STAGED FILES"),
        );
        expect(proposals).toHaveLength(1);
        expect(booted.ui.customs).toEqual([]);
        expect(booted.pi.timeline.filter((entry) => entry.kind === "send")).toHaveLength(1);
      } finally {
        await booted.cleanup();
      }
    });

    it("reports /folder-policy and /shell-guard status without a dialog or side effect", async () => {
      const booted = await boot();
      try {
        await booted.run("folder-policy", "status");
        expect(booted.notices()).toMatch(/folder policy/i);
        expect(booted.notices()).toMatch(/sensitive/i);

        await booted.run("shell-guard", "status");
        expect(booted.notices()).toMatch(/shell/i);

        expect(booted.ui.confirms).toEqual([]);
        expect(booted.pi.sent).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("refuses /commit cleanly with no staged changes and no authorization", async () => {
      const booted = await boot();
      try {
        // No git repository: the flow must report, not run `git commit`.
        await booted.run("commit");
        expect(booted.notices()).toMatch(/commit|no changes|nothing|failed|repo/i);
        expect(
          booted.pi.sent.filter((entry) => String(entry.content).includes("\ncommit")),
        ).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("completes command arguments from the artifact (Tab completion contract)", async () => {
      const booted = await boot();
      try {
        const commitFlags = booted.completions("commit", "-");
        expect(commitFlags).toBeTruthy();
        expect(commitFlags!.map((entry) => entry.value)).toContain("-a");

        const commitPolicy = booted.completions("commit-policy", "");
        expect(commitPolicy).toBeTruthy();
        // Values replace the whole typed argument text, so the mode verbs carry a
        // trailing space for the optional scope token.
        expect(commitPolicy!.map((entry) => entry.value.trim())).toEqual(
          expect.arrayContaining(["never", "ask", "allow"]),
        );

        const readPolicy = booted.completions("read-policy", "");
        expect(readPolicy).toBeTruthy();

        const role = booted.completions("role", "set ");
        expect(role).toBeTruthy();

        // A value replaces the whole typed argument text (pi-tui contract).
        for (const completion of [...commitPolicy!, ...role!]) {
          expect(typeof completion.value).toBe("string");
          expect(completion.value.length).toBeGreaterThan(0);
        }
      } finally {
        await booted.cleanup();
      }
    });
  },
);

describe.skipIf(!existsSync(ARTIFACT_ENTRY))(
  "staged Workflow artifact: questionnaire, todos, btw, review, handoff and rewind parity",
  () => {
    it("runs a questionnaire through the native dialog and reports the selected answer", async () => {
      const answer = {
        cancelled: false,
        answers: [
          {
            header: "Export format",
            question: "Which format should the export use?",
            answer: "CSV (recommended)",
            wasCustom: false,
          },
        ],
      };
      const booted = await boot({ customAnswers: [answer] });
      try {
        const result = (await booted.runTool("questionnaire", {
          questions: [
            {
              header: "Export format",
              question: "Which format should the export use?",
              options: [
                { label: "CSV (recommended)", description: "Matches the reports page" },
                { label: "XLSX" },
              ],
            },
          ],
        })) as { content: Array<{ text: string }>; details: Record<string, unknown> };

        // The tool delegates to the one native dialog surface (ctx.ui.custom).
        expect(booted.ui.customs).toEqual([answer]);
        expect(result.content[0]!.text).toContain('selected "CSV (recommended)"');
        expect(result.details.cancelled).toBe(false);
        // Answering a question is not execution: no turn, no write, no commit.
        expect(booted.pi.sent).toEqual([]);
        expect(booted.ui.confirms).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("treats a cancelled questionnaire as a cancellation, not an approval", async () => {
      const booted = await boot({ customAnswers: [null] });
      try {
        const result = (await booted.runTool("questionnaire", {
          question: "Proceed?",
          options: [{ label: "Yes" }, { label: "No" }],
        })) as { content: Array<{ text: string }>; details: Record<string, unknown> };
        expect(result.content[0]!.text).toMatch(/cancelled/i);
        expect(result.details.cancelled).toBe(true);
        expect(booted.pi.sent).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("refuses the questionnaire tool without a TUI instead of implying an answer", async () => {
      const booted = await boot();
      try {
        const nonTui = { ...booted.ui.ctx, mode: "rpc" };
        const result = (await booted.runTool(
          "questionnaire",
          { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
          nonTui,
        )) as { content: Array<{ text: string }> };
        expect(result.content[0]!.text).toMatch(/UI not available/i);
        expect(booted.ui.customs).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("publishes todo progress, panel visibility and command-backed actions", async () => {
      const booted = await boot();
      try {
        // 0.17.3+ Plan is read-only for the list: the parent setup must enter
        // Build before mutating workflow_todo, and Plan must refuse the add.
        await booted.run("plan");
        const refused = (await booted.runTool("workflow_todo", {
          action: "add",
          text: "Must not be created in Plan",
        })) as {
          isError?: boolean;
          content: Array<{ text: string }>;
          details?: { error?: string; todos?: unknown[] };
        };
        expect(refused.isError).toBe(true);
        expect(refused.details?.error).toBe("plan-mode-read-only");
        expect(refused.content[0]!.text).toMatch(/Plan mode is read-only/);
        expect(refused.details?.todos).toEqual([]);

        await booted.run("build");
        await booted.runTool("workflow_todo", { action: "add", text: "Wire CSV export" });
        await booted.runTool("workflow_todo", { action: "add", text: "Add export tests" });

        await booted.run("todos", "expand");
        const expanded = booted.latestContributions();
        const progress = expanded.find(
          (entry) => entry.kind === "progress" && entry.id === "todos",
        );
        expect(progress, "todos progress contribution is published").toBeTruthy();
        expect(progress!.done).toBe(0);
        expect(progress!.total).toBe(2);
        expect(progress!.detail).toBe("Expanded");

        const todoActions = expanded.filter(
          (entry) => entry.kind === "action" && String(entry.id).startsWith("todos-"),
        );
        expect(todoActions.length).toBeGreaterThan(0);
        for (const action of todoActions) {
          // Actions reference a registered command; the host owns the args.
          expect((action.command as { name?: string }).name).toBe("todos");
          expect(action.enabled).toBe(true);
        }
        expect(todoActions.map((entry) => entry.id)).toEqual(
          expect.arrayContaining(["todos-auto", "todos-expand", "todos-collapse", "todos-hide"]),
        );

        await booted.run("todos", "hide");
        const hidden = booted
          .latestContributions()
          .find((entry) => entry.kind === "progress" && entry.id === "todos");
        expect(hidden!.detail).toBe("Hidden");

        // Panel visibility is display state only; no model turn, no tool swap.
        expect(booted.pi.sent).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("queues a /btw note as one persisted entry and starts no model turn", async () => {
      const booted = await boot();
      try {
        await booted.run("btw", "keep the CSV header order stable");

        const persisted = booted.pi.entries.filter((entry) => entry.type === "workflow-btw");
        expect(persisted).toHaveLength(1);
        expect((persisted[0]!.data as { note?: string }).note).toBe(
          "keep the CSV header order stable",
        );
        expect(booted.notices()).toMatch(/note added|queued/i);
        // A note is not an execution turn: the only send is the custom
        // transcript message, never a user/model prompt.
        const sends = booted.pi.timeline.filter((entry) => entry.kind === "send");
        for (const send of sends) {
          expect((send.content as { customType?: string }).customType).toBe("workflow-btw");
        }

        // The next turn sees it through the artifact's own context hook.
        await booted.pi.emit(
          "before_agent_start",
          { messageType: "user", prompt: "continue" },
          booted.ui.ctx,
        );
      } finally {
        await booted.cleanup();
      }
    });

    it("reports /btw usage instead of recording an empty note", async () => {
      const booted = await boot();
      try {
        await booted.run("btw", "   ");
        expect(booted.pi.entries.filter((entry) => entry.type === "workflow-btw")).toEqual([]);
        expect(booted.notices()).toMatch(/usage/i);
      } finally {
        await booted.cleanup();
      }
    });

    it("keeps the Review control commands safe when no review round exists", async () => {
      const booted = await boot();
      try {
        // One `/review` command with verb arguments; the hyphenated siblings are
        // no longer registered (asserted in the inventory test above).
        await booted.run("review", "status");
        expect(booted.notices()).toMatch(/review/i);

        booted.ui.notifies.length = 0;
        await booted.run("review", "pause");
        expect(booted.notices()).toMatch(/no .*review|not (?:running|paused)|nothing/i);

        booted.ui.notifies.length = 0;
        await booted.run("review", "resume");
        await booted.run("review", "abort");
        await booted.run("review", "prompt");

        // No reviewer was started, so no model/provider/tool work happened and
        // no prompt was routed to a phantom session.
        expect(booted.pi.sent).toEqual([]);
        expect(booted.pi.timeline.filter((entry) => entry.kind === "tools")).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("reports /handoff configuration without granting an execution decision", async () => {
      const booted = await boot();
      try {
        await booted.run("handoff", "status");
        const status = booted.notices();
        expect(status).toMatch(/handoff/i);
        // The optional Plannotator integration is absent in this harness, and
        // the report says so instead of pretending a browser review is live.
        expect(status).toMatch(/no Plannotator host detected/i);
        expect(status).toMatch(/native questionnaire|auto/i);
        expect(status).toMatch(/separately|direct Build|Orchestrator/i);
        expect(booted.pi.sent).toEqual([]);
        expect(booted.ui.customs).toEqual([]);

        // Switching the presenter preference writes configuration only; it
        // cannot approve a plan or manufacture an execution grant.
        await booted.run("handoff", "native project");
        await booted.run("handoff", "status");
        expect(booted.notices()).toMatch(/native/i);
        expect(booted.pi.sent).toEqual([]);
        expect(booted.ui.customs).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("restores a persisted Plan handoff without executing it", async () => {
      const booted = await boot({ hasUI: false });
      try {
        const today = new Date().toISOString().slice(0, 10);
        const planPath = join(booted.cwd, ".pi", "plans", `${today}-restored.md`);
        mkdirSync(join(booted.cwd, ".pi", "plans"), { recursive: true });
        writeFileSync(planPath, "# Plan: restored\n\n## Plan Steps\n\n1. Keep it simple\n");

        // A resumed/reloaded session re-reads its branch. The artifact must
        // restore the Plan handoff as state only — never as an execution.
        const restoredCtx = {
          ...booted.ui.ctx,
          sessionManager: {
            ...booted.ui.ctx.sessionManager,
            getBranch: () => [
              {
                id: "wf-restore",
                type: "custom",
                customType: "workflow",
                data: {
                  mode: "plan",
                  planFile: planPath,
                  todos: [],
                  awaitingDecision: true,
                  awaitingDecisionAt: Date.now(),
                  lastReviewId: null,
                  pendingHandoffPlanPath: planPath,
                },
              },
              {
                id: "user-1",
                type: "message",
                message: { role: "user", content: "write the plan" },
              },
            ],
          },
        };
        await booted.pi.emit("session_start", { reason: "resume" }, restoredCtx);

        expect(booted.pi.sent).toEqual([]);
        expect(booted.pi.timeline.filter((entry) => entry.kind === "send")).toEqual([]);
        expect(String(booted.statusValue("workflow") ?? "")).toMatch(/plan/i);
      } finally {
        await booted.cleanup();
      }
    });

    it("/rewind refuses with no history and never touches the working tree", async () => {
      const booted = await boot({ branch: [] });
      try {
        writeFileSync(join(booted.cwd, "tracked.txt"), "original\n");
        await booted.run("rewind");
        expect(booted.notices()).toMatch(/no history/i);
        expect(booted.ui.customs).toEqual([]);
        expect(booted.ui.navigations).toEqual([]);
        expect(readFileSync(join(booted.cwd, "tracked.txt"), "utf8")).toBe("original\n");
      } finally {
        await booted.cleanup();
      }
    });

    it("/rewind cancels without navigating or restoring files", async () => {
      const branch = userBranch();
      const booted = await boot({ branch, customAnswers: [null] });
      try {
        writeFileSync(join(booted.cwd, "tracked.txt"), "original\n");
        await booted.run("rewind");
        expect(booted.notices()).toMatch(/rewind cancelled/i);
        expect(booted.ui.navigations).toEqual([]);
        expect(readFileSync(join(booted.cwd, "tracked.txt"), "utf8")).toBe("original\n");
      } finally {
        await booted.cleanup();
      }
    });

    it("/rewind needs an explicit confirmation before reverting a dirty tree", async () => {
      const branch = userBranch();
      const booted = await boot({
        branch,
        // The rewind picker returns the first user entry; the dirty-tree prompt
        // then answers Cancel.
        customAnswers: [String(branch[0]!.id)],
        selectAnswer: "Cancel",
        hasUI: true,
      });
      try {
        git(booted.cwd, "init", "-b", "main");
        git(booted.cwd, "config", "user.email", "test@example.com");
        git(booted.cwd, "config", "user.name", "Test");
        writeFileSync(join(booted.cwd, "tracked.txt"), "committed\n");
        git(booted.cwd, "add", "tracked.txt");
        git(booted.cwd, "commit", "-qm", "init");

        // Establish the branch leaf and take a real shadow checkpoint, exactly
        // as a turn would, BEFORE dirtying the tree.
        await booted.pi.emit(
          "tool_result",
          { toolName: "read", isError: false, input: { path: "tracked.txt" }, content: [] },
          booted.ui.ctx,
        );
        await booted.pi.emit("turn_start", {}, booted.ui.ctx);
        await vi.waitFor(
          () =>
            expect(booted.pi.entries.some((entry) => entry.type === "workflow-checkpoint")).toBe(
              true,
            ),
          { timeout: 10_000 },
        );

        // Dirty the tree after the checkpoint was taken.
        writeFileSync(join(booted.cwd, "tracked.txt"), "dirty\n");

        await booted.run("rewind");
        expect(booted.ui.selects.map((entry) => entry.title)).toEqual(
          expect.arrayContaining([expect.stringMatching(/uncommitted|dirty/i)]),
        );
        // Cancelling the dirty prompt preserves both messages and files.
        expect(booted.ui.navigations).toEqual([]);
        expect(readFileSync(join(booted.cwd, "tracked.txt"), "utf8")).toBe("dirty\n");
        expect(booted.notices()).toMatch(/cancelled|preserved/i);
      } finally {
        await booted.cleanup();
      }
    });

    it("keeps Workflow /rewind authority independent of Desktop checkpoints", async () => {
      const artifactDir = ARTIFACT_DIR;
      const checkpointSource = readFileSync(join(artifactDir, "checkpoint.ts"), "utf8");
      const entrySource = readFileSync(join(artifactDir, "index.ts"), "utf8");

      // Workflow's shadow repo lives under the Pi agent dir; it never imports or
      // mutates Desktop's checkpoint service/storage.
      expect(checkpointSource).toContain("checkpoints");
      for (const foreign of [
        "@dieulc/checkpoints",
        "checkpoint-service",
        "src/checkpoints",
        "checkpointExtension",
      ]) {
        expect(entrySource, `Workflow entry must not reference ${foreign}`).not.toContain(foreign);
        expect(
          checkpointSource,
          `Workflow checkpoints must not reference ${foreign}`,
        ).not.toContain(foreign);
      }
    });
  },
);

/** Two user checkpoints the rewind picker can offer. */
function userBranch(): Array<Record<string, unknown>> {
  return [
    {
      id: "entry-1",
      type: "message",
      timestamp: new Date("2026-11-24T10:00:00Z").toISOString(),
      message: { role: "user", content: "add CSV export" },
    },
    {
      id: "entry-2",
      type: "message",
      timestamp: new Date("2026-11-24T10:05:00Z").toISOString(),
      message: { role: "user", content: "include headers" },
    },
  ];
}

describe.skipIf(!existsSync(ARTIFACT_ENTRY))(
  "staged Workflow artifact: Orchestrator / related-session parity",
  () => {
    it("enters Orchestrator mode, keeps the run status read-only and dispatches nothing", async () => {
      const booted = await boot();
      try {
        // Mode entry is display-only: 0.17.5 keeps the full Build tool set and
        // adds the three parent tools; nothing is dispatched on entry.
        await booted.run("orchestrator");
        const tools = lastToolSet(booted.pi) ?? [];
        expect(tools).toEqual(
          expect.arrayContaining([
            "orchestrator_start",
            "orchestrator_status",
            "orchestrator_retry",
          ]),
        );
        // The mutation gate is the tool-call hook. In 0.17.5 the parent keeps
        // full Build authority until a run is bound and a Build child owns the
        // worktree, so an edit with no run/child is not refused here; the
        // bound-child refusal ("A Build child owns this worktree") is pinned by
        // the Workflow package's own parent-exclusion tests.
        expect(
          booted.pi.handlers.get("tool_call")?.length ?? 0,
          "the tool-call mutation gate is registered",
        ).toBeGreaterThan(0);
        const verdicts = await booted.pi.emit(
          "tool_call",
          { toolName: "edit", input: { path: "src/child-owned.ts" } },
          booted.ui.ctx,
        );
        const verdict = verdicts[0] as { block?: boolean; reason?: string } | undefined;
        expect(verdict?.block).toBeFalsy();
        assertNoExecution(booted.pi);

        const status = await booted.runTool("orchestrator_status", {});
        expect(JSON.stringify(status)).toMatch(/no run|not bound|no orchestrator/i);
        await booted.run("orchestrator", "status");
        expect(booted.notices()).toMatch(/No orchestrator run is bound yet/i);
        expect(booted.notices()).toMatch(/Nothing was launched/i);
        assertNoExecution(booted.pi);
        // The in-process child is the contract: no external session was asked
        // for, so the authenticated related-session bridge stays untouched.
        expect(booted.relatedRequests()).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("refuses an Orchestrator start with no approved plan", async () => {
      const booted = await boot();
      try {
        // `start` requires Orchestrator mode and no longer switches implicitly.
        await booted.run("orchestrator");
        await booted.run("orchestrator", "start");
        expect(booted.notices()).toMatch(/No approved plan is bound/);
        expect(booted.notices()).toMatch(/\/orchestrator start <path>/);
        assertNoExecution(booted.pi);
        expect(booted.relatedRequests()).toEqual([]);
        // No child tool can run from a mode/start command.
        expect(booted.pi.timeline.filter((entry) => entry.kind === "send")).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("keeps child controls honest and inert when no in-process child exists", async () => {
      const booted = await boot();
      try {
        expect(booted.pi.commands.has("orchestrator"), "/orchestrator is registered").toBe(true);
        // The child verbs require Orchestrator mode; enter it without a run so
        // the controls hit the no-run guard before any child effect.
        await booted.run("orchestrator");
        for (const verb of ["pause", "resume", "abort"]) {
          await booted.run("orchestrator", verb);
        }
        expect(booted.notices()).toMatch(/No Orchestrator run is bound yet/);
        // Pause/resume/abort never claim success without a live child or run.
        expect(booted.notices()).not.toMatch(/Child paused\.|Child resumed\.|Child aborted\./);

        await booted.run("orchestrator", "view child");
        expect(booted.notices()).toMatch(/View: child/);
        expect(booted.notices()).toMatch(/No child is active\./);
        await booted.run("orchestrator", "view auto");

        assertNoExecution(booted.pi);
        expect(booted.relatedRequests()).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("publishes the child todo display verbs before any child row and keeps the parent panel detail", async () => {
      const booted = await boot();
      try {
        // Parent rows with a non-default, assertable panel state.
        await booted.run("build");
        await booted.runTool("workflow_todo", { action: "add", text: "Parent row one" });
        await booted.runTool("workflow_todo", { action: "add", text: "Parent row two" });
        await booted.run("todos", "expand");
        const parentBefore = booted
          .latestContributions()
          .find((entry) => entry.kind === "progress" && entry.id === "todos");
        expect(parentBefore, "the parent panel publishes its progress").toBeTruthy();
        expect(parentBefore!.detail).toBe("Expanded");
        expect(parentBefore!.total).toBe(2);

        // A standalone run binds explicit steps as the parent roadmap. It
        // creates no child state/header, which is exactly the presentation
        // case this test owns (a live child widget is covered by the package).
        await booted.run("orchestrator");
        const started = await booted.runTool("orchestrator_start", {
          title: "Standalone child-view parity",
          steps: ["Wire CSV export", "Add export tests"],
        });
        expect(JSON.stringify(started)).toMatch(/created with 2 row/);

        await booted.run("orchestrator", "view child");
        expect(booted.notices()).toMatch(/View: child/);

        const childContributions = booted.latestContributions();
        // The four display verbs publish before a child header/row exists; the
        // progress contribution stays independently gated on total > 0, so no
        // fabricated 0/0 row appears just to make the controls reachable.
        expect(childContributions.filter((entry) => entry.kind === "progress")).toEqual([]);
        const childActions = childContributions.filter(
          (entry) => entry.kind === "action" && String(entry.id).startsWith("todos-"),
        );
        expect(childActions.map((entry) => String(entry.id)).sort()).toEqual(
          ["todos-auto", "todos-collapse", "todos-expand", "todos-hide"].sort(),
        );

        const expectedChildActions: Array<[string, string, string]> = [
          ["todos-auto", "Auto todos", "auto"],
          ["todos-expand", "Show todos", "expand"],
          ["todos-collapse", "Collapse todos", "collapse"],
          ["todos-hide", "Hide todos", "hide"],
        ];
        for (const [id, label, args] of expectedChildActions) {
          const action = childActions.find((entry) => entry.id === id);
          expect(action, `/todos ${args} is contributed in child view`).toBeTruthy();
          expect(action).toMatchObject({
            kind: "action",
            slot: "action",
            id,
            label,
            tone: "neutral",
            order: 11,
            enabled: true,
          });
          // Stable group identity/order/placement and the command-backed wire
          // shape the generic working bar dispatches. No Workflow-specific
          // Desktop adapter exists for these verbs.
          expect(action!.group).toEqual({
            id: "todos",
            label: "Child todos",
            order: 40,
            placement: "menu",
          });
          expect(action!.command).toEqual({ name: "todos", args });
        }

        // No child header/state exists, so no child TODO widget frame is
        // installed: the last write for the key is an explicit clear.
        const todoWidgets = booted.ui.widgets.filter((entry) => entry.key === "workflow-todos");
        expect(todoWidgets.length).toBeGreaterThan(0);
        expect(todoWidgets.at(-1)!.value).toBeUndefined();

        // Show/Collapse/Hide/Auto target the active child view. The stream
        // keeps the same four verbs and still publishes no progress row.
        for (const verb of ["show", "collapse", "hide", "auto"]) {
          await booted.run("todos", verb);
          const after = booted.latestContributions();
          expect(
            after.filter((entry) => entry.kind === "progress"),
            `/todos ${verb} must not invent a zero-total child progress row`,
          ).toEqual([]);
          const actions = after.filter(
            (entry) => entry.kind === "action" && String(entry.id).startsWith("todos-"),
          );
          expect(actions).toHaveLength(4);
          for (const action of actions) {
            expect((action.group as { label?: string } | undefined)?.label).toBe("Child todos");
          }
        }

        await booted.run("orchestrator", "view parent");
        const parentAfter = booted.latestContributions();
        const parentProgress = parentAfter.find(
          (entry) => entry.kind === "progress" && entry.id === "todos",
        );
        expect(parentProgress, "the parent panel is published again").toBeTruthy();
        // Child display changes never rewrote the parent preference/detail.
        expect(parentProgress!.detail).toBe("Expanded");
        expect(parentProgress!.done).toBe(0);
        expect(parentProgress!.total).toBe(2);

        const parentActions = parentAfter.filter(
          (entry) => entry.kind === "action" && String(entry.id).startsWith("todos-"),
        );
        expect(parentActions.map((entry) => String(entry.id)).sort()).toEqual(
          ["todos-auto", "todos-collapse", "todos-expand", "todos-hide"].sort(),
        );
        for (const action of parentActions) {
          // Back in parent view the same group id is labelled `Todos`.
          expect(action.enabled).toBe(true);
          expect((action.group as { label?: string } | undefined)?.label).toBe("Todos");
        }

        // Presentation and view switches dispatch no work and never use the
        // authenticated external-session bridge.
        assertNoExecution(booted.pi);
        expect(booted.relatedRequests()).toEqual([]);
      } finally {
        await booted.cleanup();
      }
    });

    it("refinement shows usage and cannot approve, propose or dispatch orchestration work", async () => {
      const booted = await boot();
      try {
        expect(booted.pi.commands.has("prompt"), "/prompt is registered").toBe(true);
        const orchestratorCommand = booted.pi.commands.get("orchestrator")!;
        let orchestratorCalls = 0;
        booted.pi.commands.set("orchestrator", {
          ...orchestratorCommand,
          handler: async (args, ctx) => {
            orchestratorCalls += 1;
            return orchestratorCommand.handler(args, ctx);
          },
        });
        const startTool = booted.pi.tools.get("orchestrator_start") as
          { execute?: (...args: unknown[]) => Promise<unknown> } | undefined;
        let startCalls = 0;
        if (startTool?.execute) {
          const original = startTool.execute;
          startTool.execute = async (...args: unknown[]) => {
            startCalls += 1;
            return original(...args);
          };
        }

        await booted.run("prompt");
        expect(booted.notices()).toMatch(/Usage: \/prompt <your draft request>/);
        await booted.run("prompt", "   ");

        // Refinement may prepare prose for a human send. It never gains an
        // approval, proposal or dispatch path of its own.
        expect(orchestratorCalls).toBe(0);
        expect(startCalls).toBe(0);
        expect(booted.relatedRequests()).toEqual([]);
        assertNoExecution(booted.pi);
      } finally {
        await booted.cleanup();
      }
    });
  },
);

describe("no Workflow command parsing in Desktop source", () => {
  it("never branches on a Workflow command/mode name", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const repoRoot = process.cwd();
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(join(repoRoot, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
      }
    };
    await walk("src");

    const forbidden = [
      // A host must resolve actions by registered source, never by this name.
      /["'`]workflow-cycle["'`]/,
      /\bcommand(?:Name)?(?:\s*\.\s*name)?\s*===\s*["'`](?:prompt|workflow|plan|build|orchestrator|default)["'`]/,
      /\bcase\s+["'`](?:prompt|workflow|plan|build|orchestrator|default)["'`]\s*:/,
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(join(repoRoot, file), "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) hits.push(`${file}: ${pattern}`);
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
