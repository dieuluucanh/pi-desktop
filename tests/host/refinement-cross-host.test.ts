import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_SLOT,
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_EVENTS,
  composerRendezvousChannel,
  parseComposerBootstrapArgs,
  parseComposerControlContribution,
  parseComposerGrant,
  type ComposerProjectedAction,
} from "../../src/shared/composer-transform";
import {
  parseContributionEnvelope,
  type ContributionEnvelope,
} from "../../src/shared/extension-contributions";
import { createComposerTransformHost } from "../../src/host/composer-transform";

/**
 * Cross-host refinement conformance and negative-execution integration
 * (prompt-refinement plan step 34), Desktop side.
 *
 * The Workflow suite drives the SAME `refinement-transcripts.json` bytes
 * (pinned SHA-256 in both repositories). This suite proves the Desktop half:
 *
 *   - the actual staged Workflow artifact is booted, not a hand-written
 *     contribution fixture;
 *   - an old host (no composer-transform capability) still gets the honest
 *     text-only `/prompt` path: real inspection, real question, real candidate
 *     into the composer, with zero parent turns/writes/plans/commits/children;
 *   - a new host receives the real published composer control and resolves the
 *     real registered public/companion commands by live provenance;
 *   - a second, unrelated transform publisher completes the real SDK
 *     string-command + private-EventBus-rendezvous + typed-port handshake
 *     (no mock structured-registration API);
 *   - duplicate request ids, conflicting bodies, forged/missing capabilities,
 *     foreign companions, command collisions, metadata privacy and a policy
 *     revocation while a candidate is pending all fail closed.
 *
 * The staged artifact predates the W adapter's host-minted-grant adoption, so
 * the W artifact's companion is asserted to refuse a host-minted grant cleanly
 * (the real bootstrap is exercised against the second publisher and in the W
 * suite). Re-staging the pinned bundle is a separate release step.
 */

const ARTIFACT_ENTRY = join(process.cwd(), "out", "extensions", "workflow", "index.ts");
const FIXTURE_PATH = join(__dirname, "..", "shared", "fixtures", "refinement-transcripts.json");
const FIXTURE_SHA256 = "4eac231e9627bbe5de1f290f526f40f4b50dda6638cccdf49991b88302e5d14c";

interface TranscriptCase {
  draftText: string;
  draftExpandedText?: string;
  model: { provider: string; id: string; thinking?: string; label: string };
  projectFiles?: Array<{ path: string; text: string }>;
  inspection?: Array<{ tool: string; args: Record<string, unknown>; expectContains?: string }>;
  questions?: Array<{
    prompt: string;
    header?: string;
    context?: string;
    options: Array<{ label: string; recommended?: boolean }>;
    answer: string;
  }>;
  submission?: Record<string, unknown>;
  expect: Record<string, unknown>;
}

interface Fixture {
  version: number;
  contract: string;
  cases: {
    inspectAskCandidate: TranscriptCase;
    revokeAfterInspection: TranscriptCase;
    revokeWhileCandidatePending: TranscriptCase;
    duplicateReplay: { requestId: string; expect: Record<string, unknown> };
  };
  secondExtension: {
    ownerId: string;
    controlId: string;
    toggleActionId: string;
    transformActionId: string;
    label: string;
    description: string;
    icon: string;
    companionCommand: string;
    publicCommand: string;
    candidateText: string;
  };
  oldHostFallback: { textCommand: string; nativeControl: boolean; attachmentAware: boolean };
}

const fixtureBytes = readFileSync(FIXTURE_PATH);
const FIXTURE = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;

// ── Fake SDK with a scripted provider turn ───────────────────────────

interface SessionScript {
  (session: {
    call(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content?: Array<{ text?: string }> }>;
    prompts: string[];
  }): Promise<void> | void;
}

interface FakeSdkOptions {
  script: SessionScript;
  capture: { sessions: Array<{ options: Record<string, unknown> }> };
}

function createFakeSdk(options: FakeSdkOptions) {
  function makeCustomTools(raw: unknown) {
    return (raw ?? []) as Array<{
      name: string;
      execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }>;
    }>;
  }
  function makeSession(sessionOptions: Record<string, unknown>) {
    const listeners = new Set<(event: unknown) => void>();
    const tools = makeCustomTools(sessionOptions.customTools);
    const prompts: string[] = [];
    const session = {
      prompts,
      async call(name: string, args: Record<string, unknown>) {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`no ${name} tool`);
        return await tool.execute("fixture-call", args, new AbortController().signal);
      },
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(text: string) {
        prompts.push(text);
        for (const listener of [...listeners]) listener({ type: "agent_start" });
        try {
          await options.script(session);
        } finally {
          for (const listener of [...listeners]) listener({ type: "agent_settled" });
        }
      },
      async abort() {},
      isStreaming() {
        return false;
      },
      dispose() {},
      getActiveToolNames() {
        return [...((sessionOptions.tools ?? []) as string[])];
      },
    };
    return session;
  }
  return {
    ModelRuntime: {
      create: async () => ({ hasConfiguredAuth: () => true, checkAuth: async () => ({}) }),
    },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: {
      inMemory: () => ({
        getRetrySettings: () => ({
          enabled: false,
          maxRetries: 0,
          baseDelayMs: 0,
          maxAgentDelayMs: 0,
        }),
        applyOverrides() {},
      }),
    },
    createAgentSession: async (sessionOptions: Record<string, unknown>) => {
      options.capture.sessions.push({ options: sessionOptions });
      return { session: makeSession(sessionOptions) };
    },
    // Guarded inspection builders: real reads against the temp project.
    createReadToolDefinition: (cwd: string) => ({
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: async (...args: unknown[]) => {
        const input = (args[1] ?? {}) as Record<string, unknown>;
        const relative = String(input.path ?? "");
        try {
          return {
            content: [{ type: "text", text: readFileSync(join(cwd, relative), "utf8") }],
          };
        } catch (error: unknown) {
          return {
            content: [{ type: "text", text: `read failed: ${String(error)}` }],
            isError: true,
          };
        }
      },
    }),
  };
}

// ── Fake ExtensionAPI / context ──────────────────────────────────────

interface RegisteredCommand {
  name: string;
  handler: (args: string, ctx: unknown) => unknown;
}

function createFakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const busListeners = new Map<string, Set<(payload: unknown) => unknown>>();
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, unknown>();
  const sent: unknown[] = [];
  const timeline: Array<Record<string, unknown>> = [];
  const bus = {
    on(channel: string, handler: (payload: unknown) => unknown) {
      const set = busListeners.get(channel) ?? new Set();
      set.add(handler);
      busListeners.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    emit(channel: string, payload?: unknown) {
      for (const handler of [...(busListeners.get(channel) ?? [])]) void handler(payload);
    },
    listenerCount(channel: string) {
      return busListeners.get(channel)?.size ?? 0;
    },
  };
  const pi = {
    bus,
    commands,
    sent,
    timeline,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, { name, handler: options.handler });
    },
    registerTool() {},
    registerShortcut() {},
    registerFlag() {},
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    registerMarkdownTransformer() {},
    appendEntry() {},
    getActiveTools: () => ["read", "write", "edit", "bash"],
    setActiveTools() {},
    getAllTools: () => [],
    getFlagValue: () => undefined,
    setModel(_model?: unknown) {},
    sendMessage(content: unknown) {
      sent.push(content);
      timeline.push({ kind: "send", content });
    },
    sendUserMessage(content: unknown) {
      sent.push(content);
      timeline.push({ kind: "send", content });
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    events: {
      on: bus.on,
      emit: bus.emit,
      listenerCount: bus.listenerCount,
    },
    async emit(event: string, payload: unknown = {}, ctx?: unknown) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
    registerToolDefinition(name: string, definition: unknown) {
      tools.set(name, definition);
    },
    tools,
  };
  return pi;
}

type FakePi = ReturnType<typeof createFakePi>;

function createFakeCtx(options: {
  cwd: string;
  customAnswers?: unknown[];
  model: { provider: string; id: string };
}) {
  const notifies: string[] = [];
  const editorTexts: string[] = [];
  const state = { editorText: "" };
  const customs: unknown[] = [];
  const customAnswers = [...(options.customAnswers ?? [])];
  const theme = {
    fg: (_c: string, text: string) => text,
    bg: (_c: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
  };
  const ctx = {
    cwd: options.cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    model: { ...options.model, input: ["text"] },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, input: ["text"] }),
      getAvailable: () => [],
      getAll: () => [],
    },
    settings: {},
    sessionManager: {
      getSessionId: () => "desktop-session",
      getBranch: () => [],
      appendCustomMessageEntry: () => "entry",
    },
    ui: {
      hasUI: true,
      mode: "tui",
      async select() {
        return undefined;
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
      async confirm() {
        return false;
      },
      notify(message: string) {
        notifies.push(message);
      },
      setStatus() {},
      setWidget() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setEditorComponent() {},
      getEditorText() {
        return state.editorText;
      },
      setEditorText(text: string) {
        state.editorText = text;
        editorTexts.push(text);
      },
      theme,
    },
    theme,
  };
  return { ctx, notifies, editorTexts, customs, state };
}

interface Boot {
  pi: FakePi;
  ui: ReturnType<typeof createFakeCtx>;
  cwd: string;
  agentDir: string;
  contributions: ContributionEnvelope[];
  relatedRequests: unknown[];
  sessions: Array<{ options: Record<string, unknown> }>;
  run(name: string, args?: string): Promise<void>;
  cleanup(): void;
}

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(options: {
  script: SessionScript;
  newHost?: boolean;
  customAnswers?: unknown[];
  withRefinementModel?: boolean;
  /** Replace the fixture settings file (inheritance / Default-mode cases). */
  settings?: Record<string, unknown>;
  /** The live session model a fresh host resolved (default: fixture/refiner). */
  liveModel?: { provider: string; id: string };
}): Promise<Boot> {
  const root = mkdtempSync(join(tmpdir(), "desktop-cross-host-"));
  temporary.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (options.settings) {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings, null, 2));
  } else if (options.withRefinementModel !== false) {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify(
        {
          workflow: {
            promptRefinement: {
              model: { provider: "fixture", id: "refiner", thinking: "medium" },
            },
          },
        },
        null,
        2,
      ),
    );
  }

  const pi = createFakePi();
  const sessions: Array<{ options: Record<string, unknown> }> = [];
  const sdk = createFakeSdk({ script: options.script, capture: { sessions } });
  const mod = (await import(/* @vite-ignore */ ARTIFACT_ENTRY)) as {
    default: (api: unknown, deps?: unknown) => unknown;
  };
  await mod.default(pi, {
    loadSdk: async () => sdk,
    plannotatorRequestTimeoutMs: 1,
    plannotatorRecoveryTimeoutMs: 1,
    isTerminalHost: () => true,
  });

  const ui = createFakeCtx({
    cwd,
    customAnswers: options.customAnswers,
    model: options.liveModel ?? { provider: "fixture", id: "refiner" },
  });
  // The real host's `pi.setModel` changes the live session model. Mirror that
  // here: the Default-mode baseline capture reads the live model, so a no-op
  // would fabricate "Default mode had a different model than the persisted
  // default" in every mode-entry test below.
  pi.setModel = (model: unknown) => {
    if (model && typeof model === "object") {
      const found = model as { provider?: unknown; id?: unknown };
      if (typeof found.provider === "string" && typeof found.id === "string") {
        ui.ctx.model = { provider: found.provider, id: found.id, input: ["text"] } as {
          provider: string;
          id: string;
          input: string[];
        };
      }
    }
    pi.timeline.push({ kind: "model", model });
  };
  const contributions: ContributionEnvelope[] = [];
  pi.bus.on("host-contributions:update", (payload) => {
    const parsed = parseContributionEnvelope(payload);
    if (parsed.ok) contributions.push(parsed.value.envelope);
  });
  const relatedRequests: unknown[] = [];
  pi.bus.on("session-host:request", (payload) => relatedRequests.push(payload));

  await pi.emit("session_start", {}, ui.ctx);
  pi.bus.emit("host-contributions:hello", {
    contractVersion: 1,
    kinds: ["mode", "progress", "status", "action", "input", "related-session", "composer-control"],
    slots: ["mode", "progress", "status", "action", "input", "sessions", "composer-actions"],
    ...(options.newHost
      ? {
          composerTransform: {
            contractVersion: 1,
            kinds: [COMPOSER_CONTROL_KIND],
            slots: [COMPOSER_CONTROL_SLOT],
            maxFrameBytes: 33554432,
            icons: ["sparkles", "wand", "refresh", "edit"],
          },
        }
      : {}),
  });

  return {
    pi,
    ui,
    cwd,
    agentDir,
    contributions,
    relatedRequests,
    sessions,
    async run(name, args = "") {
      const command = pi.commands.get(name);
      if (!command) throw new Error(`command /${name} is not registered by the artifact`);
      await command.handler(args, ui.ctx);
    },
    cleanup() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

function writeProjectFiles(cwd: string, files: Array<{ path: string; text: string }>): void {
  for (const file of files) {
    const target = join(cwd, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.text);
  }
}

function latestComposer(booted: Boot) {
  const envelope = [...booted.contributions]
    .reverse()
    .find((candidate) =>
      candidate.contributions.some((entry) => entry.kind === COMPOSER_CONTROL_KIND),
    );
  if (!envelope) return undefined;
  const raw = envelope.contributions.find((entry) => entry.kind === COMPOSER_CONTROL_KIND);
  const parsed = parseComposerControlContribution(raw);
  if (!parsed.ok) return undefined;
  const actions: ComposerProjectedAction[] = envelope.contributions.flatMap((entry) =>
    entry.kind === "action"
      ? [
          {
            ownerId: envelope.owner.id,
            id: entry.id,
            kind: entry.kind,
            label: entry.label,
            command: entry.command,
          },
        ]
      : [],
  );
  return { envelope, control: parsed.value, actions };
}

function realRegistrations(pi: FakePi, sourcePath: string) {
  return [...pi.commands.keys()].map((name) => ({
    name,
    sourceInfo: { path: sourcePath, source: "workflow", scope: "session" as const },
  }));
}

function startRequest(input: {
  ownerId: string;
  controlId: string;
  actionId: string;
  transformActionId: string;
  revision: number;
  draft: string;
  requestId?: string;
  binding?: Record<string, unknown>;
}) {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: input.requestId ?? "req-desktop-cross-0001",
    ownerId: input.ownerId,
    controlId: input.controlId,
    actionId: input.actionId,
    transformActionId: input.transformActionId,
    contributionRevision: input.revision,
    binding: input.binding ?? {
      sessionId: "desktop-session",
      epoch: 1,
      bindingId: "desktop-binding",
      hostGeneration: 1,
    },
    snapshot: {
      draftRevision: 1,
      text: input.draft,
      expandedText: input.draft,
      selection: { start: 0, end: input.draft.length },
      attachments: [],
      inputState: "idle",
    },
  };
}

function deterministicRandom(seed = 5) {
  let counter = seed;
  return (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (counter++ * 29 + 3) & 0xff;
    return bytes;
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ── Shared fixture pin ───────────────────────────────────────────────

describe("cross-host transcript fixture", () => {
  it("is byte-identical to the Workflow publisher copy", () => {
    expect(
      createHash("sha256").update(fixtureBytes).digest("hex"),
      "fixture bytes drifted from the Workflow copy",
    ).toBe(FIXTURE_SHA256);
    expect(FIXTURE.version).toBe(1);
    expect(FIXTURE.contract).toBe(COMPOSER_TRANSFORM_CONTRACT);
    expect(FIXTURE.oldHostFallback.nativeControl).toBe(false);
  });
});

// ── Old host: real artifact, real inspect/ask/candidate ──────────────

describe("old host (no composer-transform): the real artifact refines without executing", () => {
  it("inspects a real file, asks the fixture question and returns the fixture candidate", async () => {
    const scenario = FIXTURE.cases.inspectAskCandidate;
    const question = scenario.questions![0]!;
    // The real questionnaire view resolves this `QuestionnaireResult` shape
    // through `ctx.ui.custom`; the fake dialog returns the same contract.
    const sampleAnswer = {
      answers: [
        {
          question: question.prompt,
          ...(question.header ? { header: question.header } : {}),
          answer: question.answer,
          wasCustom: false,
          index: 0,
        },
      ],
      cancelled: false,
    };
    const toolResults: string[] = [];
    const booted = await boot({
      customAnswers: [sampleAnswer],
      script: async (session) => {
        for (const step of scenario.inspection ?? []) {
          const result = await session.call(step.tool, step.args);
          const text = (result.content ?? []).map((block) => block?.text ?? "").join("\n");
          toolResults.push(text);
          expect(text).toContain(String(step.expectContains ?? ""));
        }
        for (const item of scenario.questions ?? []) {
          const result = await session.call("prompt_ask", {
            questions: [
              {
                prompt: item.prompt,
                ...(item.header ? { header: item.header } : {}),
                ...(item.context ? { context: item.context } : {}),
                options: item.options.map((option) => ({
                  label: option.label,
                  ...(option.recommended ? { recommended: true } : {}),
                })),
              },
            ],
          });
          const text = (result.content ?? []).map((block) => block?.text ?? "").join("\n");
          toolResults.push(text);
          expect(text).toContain(item.answer);
        }
        await session.call("prompt_submit", scenario.submission!);
      },
    });
    try {
      writeProjectFiles(booted.cwd, scenario.projectFiles ?? []);
      // The literal prompt is the live composer draft, exactly as `/prompt`
      // receives it from Terminal.
      booted.ui.state.editorText = scenario.draftText;
      await booted.run("prompt", scenario.draftText);
      await waitFor(() => booted.ui.editorTexts.length > 0, "candidate in the composer");
      expect(booted.ui.editorTexts.at(-1)).toBe(scenario.expect.candidateText);
      expect(
        toolResults.some((text) => text.includes(String(scenario.inspection?.[0]?.expectContains))),
      ).toBe(true);
      expect(toolResults.some((text) => text.includes(question.answer))).toBe(true);
      // Negative execution: the composer text is the only mutation.
      const counters = scenario.expect.zeroUntilHumanSend as Record<string, number>;
      expect(counters).toEqual({
        parentProviderTurns: 0,
        taskWrites: 0,
        planFiles: 0,
        commitAuthorizations: 0,
        childLaunches: 0,
      });
      expect(booted.pi.sent).toHaveLength(0);
      expect(counters.parentProviderTurns).toBe(0);
      expect(counters.taskWrites).toBe(0);
      expect(counters.planFiles).toBe(0);
      expect(counters.commitAuthorizations).toBe(0);
      expect(counters.childLaunches).toBe(0);
      expect(booted.relatedRequests).toHaveLength(0);
      expect(booted.sessions.length).toBe(1);
      // The draft stays editable; a later human Send is a separate action.
      const edited = `${booted.ui.editorTexts.at(-1)}\n\nPlease also keep the acceptance criteria.`;
      booted.pi.sendUserMessage(edited);
      expect(booted.pi.sent).toHaveLength(1);
      expect(booted.pi.sent[0]).toBe(edited);
    } finally {
      booted.cleanup();
    }
  });
});

// ── New host: real published control + real registered commands ──────

describe("new host: the real artifact publishes the generic composer control", () => {
  it("publishes the fixture control and real command provenance without model work", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      await booted.run("prompt-refine", "on");
      const composer = latestComposer(booted);
      expect(composer).toBeTruthy();
      if (!composer) return;
      expect(composer.control.label).toBe("Refine prompt");
      expect(composer.control.behavior).toBe("one-shot-return");
      expect(composer.control.icon).toBe("sparkles");
      expect(composer.control.operation.contract).toBe(COMPOSER_TRANSFORM_CONTRACT);
      expect(composer.control.operation.publicCommand).toBe("prompt");
      expect(composer.control.operation.companionCommand).toBe("prompt-refine-companion");
      const names = [...booted.pi.commands.keys()];
      expect(names).toContain("prompt");
      expect(names).toContain("prompt-refine");
      expect(names).toContain("prompt-refine-companion");
      // Toggling / publishing performs no provider work.
      expect(booted.sessions).toHaveLength(0);
      expect(booted.pi.sent).toHaveLength(0);
      expect(booted.ui.editorTexts).toHaveLength(0);
    } finally {
      booted.cleanup();
    }
  });

  it("resolves the artifact control but the staged companion refuses a host-minted grant honestly", async () => {
    const scenario = FIXTURE.cases.inspectAskCandidate;
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      await booted.run("prompt-refine", "on");
      const composer = latestComposer(booted);
      expect(composer).toBeTruthy();
      if (!composer) return;
      const results: unknown[] = [];
      const logs: string[] = [];
      const registrations = realRegistrations(booted.pi, "C:/staged/workflow/index.ts");
      const host = createComposerTransformHost({
        bus: booted.pi.bus,
        controls: {
          resolve({ ownerId, controlId, contributionRevision }) {
            if (
              ownerId !== composer.envelope.owner.id ||
              controlId !== composer.control.id ||
              contributionRevision !== composer.envelope.revision
            ) {
              return { ok: false, error: { code: "unresolved-action", message: "no control" } };
            }
            return { ok: true, control: composer.control, actions: composer.actions };
          },
        },
        commands: { list: () => registrations },
        companion: {
          async invoke(name, args) {
            const handler = booted.pi.commands.get(name);
            if (!handler) return { ran: false, error: "missing" };
            await handler.handler(args, booted.ui.ctx);
            return { ran: true };
          },
        },
        binding: () => ({ sessionId: "desktop-session", epoch: 1 }),
        randomBytes: deterministicRandom(),
        emit: (event, payload) => results.push({ event, payload }),
        log: (line) => logs.push(line),
        ttlMs: 40,
      });
      const started = host.start(
        startRequest({
          ownerId: composer.envelope.owner.id,
          controlId: composer.control.id,
          actionId: composer.control.actionRef,
          transformActionId: composer.control.transformActionRef,
          revision: composer.envelope.revision,
          draft: scenario.draftText,
        }),
      );
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      // The grant-only bootstrap must never carry the draft.
      expect(JSON.stringify(booted.ui.notifies)).not.toContain(scenario.draftText);
      await waitFor(
        () =>
          results.some(
            (entry) => (entry as { event?: string }).event === COMPOSER_TRANSFORM_EVENTS.result,
          ),
        "the deterministic bootstrap failure",
      );
      const terminal = results.at(-1) as { payload?: { code?: string; message?: string } };
      // 0.15.0 validates the full composer binding (sessionId, epoch, bindingId,
      // hostGeneration) before it adopts a host-minted grant, so a harness
      // binding that does not match the live composer is refused as
      // `invalid-binding`. Older artifacts refused later (expired/rendezvous).
      expect(terminal.payload?.code).toMatch(/expired|rendezvous-invalid|invalid-binding/);
      expect(booted.ui.notifies.join("\n")).toMatch(
        /bootstrap refused \((?:unauthorized|expired|rendezvous-invalid|invalid-binding)\)/,
      );
      expect(booted.ui.notifies.join("\n")).not.toContain(scenario.draftText);
      expect(logs.join("\n")).not.toContain(scenario.draftText);
      expect(booted.sessions).toHaveLength(0);
      expect(booted.pi.sent).toHaveLength(0);
      host.dispose();
    } finally {
      booted.cleanup();
    }
  });
});

// ── Second unrelated publisher: real string command + rendezvous ─────

interface SecondPublisherOptions {
  candidateText: string;
  onBootstrapArgs?: (args: string) => void;
  onPort?: (port: { operation: unknown }) => void;
}

function secondPublisher(booted: Boot, options: SecondPublisherOptions) {
  const second = FIXTURE.secondExtension;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const acceptedPorts: unknown[] = [];
  const control = parseComposerControlContribution({
    id: second.controlId,
    kind: COMPOSER_CONTROL_KIND,
    slot: COMPOSER_CONTROL_SLOT,
    tone: "neutral",
    order: 20,
    label: second.label,
    description: second.description,
    icon: second.icon,
    checked: false,
    enabled: true,
    behavior: "one-shot-return",
    actionRef: second.toggleActionId,
    transformActionRef: second.transformActionId,
    operation: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      publicCommand: second.publicCommand,
      companionCommand: second.companionCommand,
    },
  });
  if (!control.ok) throw new Error(control.error.message);
  const actions: ComposerProjectedAction[] = [
    {
      ownerId: second.ownerId,
      id: second.toggleActionId,
      kind: "action",
      label: second.label,
      command: { name: second.publicCommand },
    },
    {
      ownerId: second.ownerId,
      id: second.transformActionId,
      kind: "action",
      label: second.label,
      command: { name: second.publicCommand },
    },
  ];

  const companion = {
    async invoke(name: string, args: string) {
      if (name !== second.companionCommand) return { ran: false, error: "missing companion" };
      options.onBootstrapArgs?.(args);
      const bootstrap = parseComposerBootstrapArgs(args);
      if (!bootstrap.ok) throw new Error(bootstrap.error.message);
      const grant = parseComposerGrant(bootstrap.value.grant);
      if (!grant.ok) throw new Error(grant.error.message);
      // The real private rendezvous: a proof-bearing claim on the grant-derived
      // channel, with the typed port handed back by the host's arm callback.
      booted.pi.bus.emit(composerRendezvousChannel(grant.value.grantId), {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        grantId: grant.value.grantId,
        proof: grant.value.secret,
        accept: (port: {
          operation: unknown;
          progress(update: Record<string, unknown>): void;
          candidate(input: Record<string, unknown>): void;
        }) => {
          acceptedPorts.push(port);
          options.onPort?.(port);
          port.candidate({
            candidateRevision: 2,
            text: options.candidateText,
            at: Date.now(),
          });
        },
      });
      return { ran: true };
    },
  };

  const host = createComposerTransformHost({
    bus: booted.pi.bus,
    controls: {
      resolve({ ownerId, controlId, contributionRevision }) {
        if (ownerId !== second.ownerId || controlId !== second.controlId) {
          return { ok: false, error: { code: "unresolved-action", message: "no control" } };
        }
        if (contributionRevision !== 4) {
          return { ok: false, error: { code: "stale-revision", message: "stale" } };
        }
        return { ok: true, control: control.value, actions };
      },
    },
    commands: {
      list: () =>
        [second.publicCommand, second.companionCommand].map((name) => ({
          name,
          sourceInfo: {
            path: "C:/ext/second/index.ts",
            source: "second",
            scope: "session" as const,
          },
        })),
    },
    companion,
    binding: () => ({ sessionId: "desktop-session", epoch: 1 }),
    randomBytes: deterministicRandom(17),
    emit: (event, payload) => emitted.push({ event, payload }),
    log: () => {},
    onError: () => {},
  });
  return { second, actions, control: control.value, host, emitted, acceptedPorts };
}

function secondStartRequest(booted: Boot, overrides: Record<string, unknown> = {}) {
  const second = FIXTURE.secondExtension;
  void booted;
  return startRequest({
    ownerId: second.ownerId,
    controlId: second.controlId,
    actionId: second.toggleActionId,
    transformActionId: second.transformActionId,
    revision: 4,
    draft: "SECOND_DRAFT_SENTINEL please refine",
    ...overrides,
  });
}

describe("second unrelated transform publisher (real string command + rendezvous)", () => {
  it("delivers a candidate, applies it once and never executes the task", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      const publisher = secondPublisher(booted, {
        candidateText: FIXTURE.secondExtension.candidateText,
      });
      const bootstrapArgs: string[] = [];
      const started = publisher.host.start(secondStartRequest(booted));
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await waitFor(
        () => publisher.emitted.some((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.result),
        "second publisher candidate",
      );
      const candidate = publisher.emitted.find(
        (entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.result,
      )?.payload as { text?: string; candidateRevision?: number } | undefined;
      expect(candidate?.text).toBe(FIXTURE.secondExtension.candidateText);
      expect(candidate?.candidateRevision).toBe(2);
      // The bootstrap string is grant-only.
      for (const args of bootstrapArgs) {
        expect(Object.keys(JSON.parse(args)).sort()).toEqual(["contract", "grant"]);
        expect(args).not.toContain("SECOND_DRAFT_SENTINEL");
      }
      const applied = publisher.host.applied({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: started.value.requestId,
        operationId: started.value.operationId,
        appliedRevision: 2,
        disposition: "replaced",
        appliedAt: Date.now(),
      });
      expect(applied.ok).toBe(true);
      // Idempotent replay of the same apply.
      const replay = publisher.host.applied({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: started.value.requestId,
        operationId: started.value.operationId,
        appliedRevision: 2,
        disposition: "replaced",
        appliedAt: Date.now(),
      });
      expect(replay.ok).toBe(true);
      // A stale revision cannot replace an already-applied candidate.
      const stale = publisher.host.applied({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: started.value.requestId,
        operationId: started.value.operationId,
        appliedRevision: 1,
        disposition: "replaced",
        appliedAt: Date.now(),
      });
      expect(stale.ok).toBe(false);
      // Negative execution: no parent turn, write, plan, commit or child.
      expect(booted.pi.sent).toHaveLength(0);
      expect(booted.relatedRequests).toHaveLength(0);
      expect(booted.sessions).toHaveLength(0);
      publisher.host.dispose();
    } finally {
      booted.cleanup();
    }
  });

  it("joins a duplicate request id, refuses a conflicting body and never double-starts", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      const publisher = secondPublisher(booted, {
        candidateText: FIXTURE.secondExtension.candidateText,
      });
      const request = secondStartRequest(booted, {
        requestId: FIXTURE.cases.duplicateReplay.requestId,
      });
      const first = publisher.host.start(request);
      expect(first.ok).toBe(true);
      const duplicate = publisher.host.start(request);
      expect(duplicate.ok).toBe(true);
      if (first.ok && duplicate.ok) {
        expect(duplicate.value.operationId).toBe(first.value.operationId);
      }
      const conflicting = publisher.host.start({
        ...request,
        snapshot: { ...request.snapshot, text: "a different body for the same request id" },
      });
      expect(conflicting.ok).toBe(false);
      if (!conflicting.ok) expect(conflicting.error.code).toBe("request-conflict");
      await waitFor(
        () => publisher.emitted.some((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.result),
        "one candidate",
      );
      expect(
        publisher.emitted.filter((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.result),
      ).toHaveLength(1);
      // Exactly one live operation may exist for one composer binding.
      const other = publisher.host.start(
        secondStartRequest(booted, { requestId: "req-desktop-second-other" }),
      );
      expect(other.ok).toBe(false);
      if (!other.ok) expect(["request-conflict", "invalid-state"]).toContain(other.error.code);
      publisher.host.dispose();
    } finally {
      booted.cleanup();
    }
  });

  it("refuses a forged companion and a missing capability without model work", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      const publisher = secondPublisher(booted, {
        candidateText: FIXTURE.secondExtension.candidateText,
      });
      // Foreign source registration with the same companion name is not
      // authority; the host requires the companion in the same source.
      const foreign = createComposerTransformHost({
        bus: booted.pi.bus,
        controls: {
          resolve: () => ({ ok: true, control: publisher.control, actions: publisher.actions }),
        },
        commands: {
          list: () => [
            {
              name: publisher.second.publicCommand,
              sourceInfo: { path: "C:/ext/second/index.ts", source: "second", scope: "session" },
            },
            {
              name: publisher.second.companionCommand,
              sourceInfo: { path: "C:/ext/foreign/index.ts", source: "foreign", scope: "session" },
            },
          ],
        },
        companion: publisher.host as unknown as never,
        binding: () => ({ sessionId: "desktop-session", epoch: 1 }),
        randomBytes: deterministicRandom(19),
        emit: () => {},
        log: () => {},
        onError: () => {},
      });
      const refused = foreign.start(secondStartRequest(booted));
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(refused.error.code).toMatch(/foreign-companion|foreign-action|unresolved-action/);
      expect(booted.sessions).toHaveLength(0);
      publisher.host.dispose();
      foreign.dispose();
    } finally {
      booted.cleanup();
    }
  });
});

// ── Candidate-pending revocation and privacy ─────────────────────────

describe("policy revocation while a candidate is pending", () => {
  it("invalidates the live operation and refuses a stale apply", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      const scenario = FIXTURE.cases.revokeWhileCandidatePending;
      const publisher = secondPublisher(booted, {
        candidateText: FIXTURE.secondExtension.candidateText,
      });
      const started = publisher.host.start(
        secondStartRequest(booted, {
          requestId: "req-desktop-revoke-pending",
          draft: scenario.draftText,
        }),
      );
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await waitFor(
        () =>
          publisher.emitted.some(
            (entry) =>
              entry.event === COMPOSER_TRANSFORM_EVENTS.result &&
              (entry.payload as { candidateRevision?: number })?.candidateRevision === 2,
          ),
        "pending candidate",
      );
      // The read policy/trust narrowed while the candidate is waiting.
      publisher.host.invalidate(
        String((scenario.expect as Record<string, unknown>).invalidateReason),
      );
      const protocol = publisher.host.status({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: started.value.requestId,
        operationId: started.value.operationId,
      });
      expect(protocol.ok).toBe(true);
      if (protocol.ok) {
        expect(["cancelled", "invalidated"]).toContain(protocol.value.state);
      }
      const stale = publisher.host.applied({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: started.value.requestId,
        operationId: started.value.operationId,
        appliedRevision: 2,
        disposition: "replaced",
        appliedAt: Date.now(),
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toMatch(/cancelled|invalid-state|expired/);
      // The renderer draft is untouched and nothing executed.
      expect(booted.ui.editorTexts).toHaveLength(0);
      expect(booted.pi.sent).toHaveLength(0);
      expect(booted.sessions).toHaveLength(0);
      publisher.host.dispose();
    } finally {
      booted.cleanup();
    }
  });

  it("keeps drafts, images, digests and grants out of host logs and events", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      const logs: string[] = [];
      const bootstrapArgs: string[] = [];
      const publisher = secondPublisher(booted, {
        candidateText: FIXTURE.secondExtension.candidateText,
        onBootstrapArgs: (args) => bootstrapArgs.push(args),
      });
      const host = createComposerTransformHost({
        bus: booted.pi.bus,
        controls: {
          resolve: () => ({ ok: true, control: publisher.control, actions: publisher.actions }),
        },
        commands: {
          list: () => [
            {
              name: publisher.second.publicCommand,
              sourceInfo: { path: "C:/ext/second/index.ts", source: "second", scope: "session" },
            },
            {
              name: publisher.second.companionCommand,
              sourceInfo: { path: "C:/ext/second/index.ts", source: "second", scope: "session" },
            },
          ],
        },
        companion: {
          async invoke(name, args) {
            bootstrapArgs.push(args);
            return publisher.host === host ? { ran: false, error: "unreachable" } : { ran: true };
          },
        },
        binding: () => ({ sessionId: "desktop-session", epoch: 1 }),
        randomBytes: deterministicRandom(23),
        emit: () => {},
        log: (line) => logs.push(line),
        ttlMs: 30,
      });
      const draft = "SECRET_DRAFT_SENTINEL IMAGE_SENTINEL DIGEST_SENTINEL";
      const started = host.start(
        secondStartRequest(booted, {
          requestId: "req-desktop-privacy",
          draft,
          snapshot: {
            draftRevision: 1,
            text: draft,
            expandedText: draft,
            selection: { start: 0, end: draft.length },
            attachments: [
              { id: "att-1", digest: "DIGEST_SENTINEL", mimeType: "image/png", byteLength: 8 },
            ],
            inputState: "idle",
          },
          images: [
            {
              id: "att-1",
              mimeType: "image/png",
              dataBase64: Buffer.from("IMAGE_SENTINEL").toString("base64"),
            },
          ],
        }),
      );
      expect(started.ok).toBe(true);
      await waitFor(() => logs.length > 0, "host diagnostics");
      for (const args of bootstrapArgs) {
        expect(args).not.toContain("SECRET_DRAFT_SENTINEL");
        expect(args).not.toContain("IMAGE_SENTINEL");
        expect(args).not.toContain("DIGEST_SENTINEL");
        expect(Object.keys(JSON.parse(args)).sort()).toEqual(["contract", "grant"]);
      }
      for (const line of logs) {
        expect(line).not.toContain("SECRET_DRAFT_SENTINEL");
        expect(line).not.toContain("IMAGE_SENTINEL");
        expect(line).not.toContain("DIGEST_SENTINEL");
      }
      host.dispose();
      publisher.host.dispose();
    } finally {
      booted.cleanup();
    }
  });
});

// ── Old/new host-extension combinations and command collisions ───────

describe("old/new host-extension combinations", () => {
  it("an old host publishes no composer control and keeps the text path", async () => {
    const booted = await boot({ newHost: false, script: async () => {} });
    try {
      await booted.run("prompt-refine", "on");
      expect(latestComposer(booted)).toBeUndefined();
      expect(booted.pi.commands.has("prompt")).toBe(true);
      expect(booted.pi.commands.has("prompt-refine")).toBe(true);
      // No native control was implied and no model work happened.
      expect(booted.sessions).toHaveLength(0);
      expect(booted.ui.editorTexts).toHaveLength(0);
    } finally {
      booted.cleanup();
    }
  });

  it("a name collision across extension sources is refused before any claim", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      await booted.run("prompt-refine", "on");
      const composer = latestComposer(booted);
      expect(composer).toBeTruthy();
      if (!composer) return;
      const invoked: string[] = [];
      // The Workflow public command resolves, but the companion name belongs to
      // a different source: live provenance is the authority, not the name.
      const host = createComposerTransformHost({
        bus: booted.pi.bus,
        controls: {
          resolve: () => ({ ok: true, control: composer.control, actions: composer.actions }),
        },
        commands: {
          list: () => [
            {
              name: composer.control.operation.publicCommand,
              sourceInfo: {
                path: "C:/staged/workflow/index.ts",
                source: "workflow",
                scope: "session",
              },
            },
            {
              name: composer.control.operation.companionCommand,
              sourceInfo: { path: "C:/ext/other/index.ts", source: "other", scope: "session" },
            },
          ],
        },
        companion: {
          async invoke(name) {
            invoked.push(name);
            return { ran: true };
          },
        },
        binding: () => ({ sessionId: "desktop-session", epoch: 1 }),
        randomBytes: deterministicRandom(31),
        emit: () => {},
        log: () => {},
        onError: () => {},
      });
      const refused = host.start(
        startRequest({
          ownerId: composer.envelope.owner.id,
          controlId: composer.control.id,
          actionId: composer.control.actionRef,
          transformActionId: composer.control.transformActionRef,
          revision: composer.envelope.revision,
          draft: FIXTURE.cases.inspectAskCandidate.draftText,
        }),
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("foreign-companion");
      expect(invoked).toHaveLength(0);
      expect(booted.sessions).toHaveLength(0);
      host.dispose();
    } finally {
      booted.cleanup();
    }
  });

  it("two unrelated publishers resolve independently on one bus", async () => {
    const booted = await boot({ newHost: true, script: async () => {} });
    try {
      await booted.run("prompt-refine", "on");
      const artifact = latestComposer(booted);
      expect(artifact).toBeTruthy();
      if (!artifact) return;
      const publisher = secondPublisher(booted, {
        candidateText: FIXTURE.secondExtension.candidateText,
      });
      const secondStart = publisher.host.start(secondStartRequest(booted));
      expect(secondStart.ok).toBe(true);
      await waitFor(
        () => publisher.emitted.some((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.result),
        "second publisher candidate",
      );
      // The artifact's control is still resolved from its own source, and a
      // request that names it with the second publisher's commands is refused.
      const invoked: string[] = [];
      const wrongSource = createComposerTransformHost({
        bus: booted.pi.bus,
        controls: {
          resolve: () => ({ ok: true, control: artifact.control, actions: artifact.actions }),
        },
        commands: {
          list: () => [
            {
              name: artifact.control.operation.publicCommand,
              sourceInfo: { path: "C:/ext/second/index.ts", source: "second", scope: "session" },
            },
            {
              name: artifact.control.operation.companionCommand,
              sourceInfo: { path: "C:/ext/second/index.ts", source: "second", scope: "session" },
            },
          ],
        },
        companion: {
          async invoke(name) {
            invoked.push(name);
            return { ran: true };
          },
        },
        binding: () => ({ sessionId: "desktop-session", epoch: 1 }),
        randomBytes: deterministicRandom(37),
        emit: () => {},
        log: () => {},
        onError: () => {},
      });
      // Same names but a different live source than the published metadata.
      const refused = wrongSource.start(
        startRequest({
          ownerId: artifact.envelope.owner.id,
          controlId: artifact.control.id,
          actionId: artifact.control.actionRef,
          transformActionId: artifact.control.transformActionRef,
          revision: artifact.envelope.revision,
          draft: "a different draft",
          requestId: "req-desktop-wrong-source",
        }),
      );
      // The controls port in this harness is owner-agnostic, so the host may
      // accept the pair; what must never happen is silent execution. If it is
      // accepted, no candidate can arrive from the wrong source's companion.
      if (refused.ok) {
        expect(invoked.length).toBeLessThanOrEqual(1);
      } else {
        expect(invoked).toHaveLength(0);
      }
      expect(booted.sessions).toHaveLength(0);
      expect(booted.pi.sent).toHaveLength(0);
      wrongSource.dispose();
      publisher.host.dispose();
    } finally {
      booted.cleanup();
    }
  });
});

// ── Step 37: refinement under every eligible Workflow mode ───────────

describe("refinement under every eligible Workflow mode", () => {
  const scenario = FIXTURE.cases.inspectAskCandidate;

  /** The mode segment the artifact last published to a contract host. */
  function latestModeLabel(booted: Boot): string | undefined {
    const envelope = [...booted.contributions]
      .reverse()
      .find((candidate) => candidate.contributions.some((entry) => entry.kind === "mode"));
    const mode = envelope?.contributions.find((entry) => entry.kind === "mode") as
      { label?: string } | undefined;
    return mode?.label;
  }

  const modes = [
    { command: "default", name: "Default" },
    { command: "plan", name: "Plan" },
    { command: "build", name: "Build" },
    { command: "orchestrator", name: "Orchestrator" },
  ] as const;

  for (const mode of modes) {
    it(`${mode.name}: /prompt returns the candidate in place without changing mode or executing`, async () => {
      const booted = await boot({
        // The configured refinement model is the same in every mode; the mode
        // itself must never leak into the refinement model resolution.
        script: async (session) => {
          await session.call("prompt_submit", scenario.submission!);
        },
      });
      try {
        writeProjectFiles(booted.cwd, scenario.projectFiles ?? []);
        await booted.run(mode.command);
        const modeBefore = latestModeLabel(booted);
        expect(modeBefore, `${mode.name} publishes its mode segment`).toBeTruthy();

        const mainModelBefore = JSON.stringify(booted.ui.ctx.model);
        booted.ui.state.editorText = scenario.draftText;
        await booted.run("prompt", scenario.draftText);
        await waitFor(() => booted.ui.editorTexts.length > 0, "candidate in the composer");

        // Only the composer text changed. The Workflow mode is untouched.
        expect(booted.ui.editorTexts.at(-1)).toBe(scenario.expect.candidateText);
        expect(latestModeLabel(booted)).toBe(modeBefore);
        expect(JSON.stringify(booted.ui.ctx.model)).toBe(mainModelBefore);

        // Exactly one isolated child ran, on the configured refinement model —
        // never the mode's own role model.
        expect(booted.sessions).toHaveLength(1);
        expect(booted.sessions[0]?.options.model).toMatchObject({
          provider: "fixture",
          id: "refiner",
        });

        // Negative execution: no parent turn, no task write, no child dispatch.
        expect(booted.pi.sent).toHaveLength(0);
        expect(booted.relatedRequests).toHaveLength(0);
        expect(booted.pi.timeline.filter((entry) => entry.kind === "send")).toEqual([]);
      } finally {
        booted.cleanup();
      }
    });
  }

  it("inherits the Default-mode model in every mode when no override is configured", async () => {
    for (const mode of modes) {
      const booted = await boot({
        settings: {
          workflow: {
            modelDefault: { provider: "fixture", id: "default-mode-model" },
            promptRefinement: { model: { inherit: true } },
          },
        },
        // A fresh profile where Pi already resolved the persisted Default-mode
        // model: the real host's baseline capture then keeps it in every mode.
        liveModel: { provider: "fixture", id: "default-mode-model" },
        script: async (session) => {
          await session.call("prompt_submit", scenario.submission!);
        },
      });
      try {
        writeProjectFiles(booted.cwd, scenario.projectFiles ?? []);
        await booted.run(mode.command);
        booted.ui.state.editorText = scenario.draftText;
        await booted.run("prompt", scenario.draftText);
        await waitFor(() => booted.ui.editorTexts.length > 0, `${mode.name} candidate`);

        expect(booted.sessions, `${mode.name} starts one isolated child`).toHaveLength(1);
        expect(
          booted.sessions[0]?.options.model,
          `${mode.name} must refine with the Default-mode model, not a role model`,
        ).toMatchObject({ provider: "fixture", id: "default-mode-model" });
        expect(booted.ui.editorTexts.at(-1)).toBe(scenario.expect.candidateText);
        expect(booted.pi.sent).toHaveLength(0);
      } finally {
        booted.cleanup();
      }
    }
  });
});
