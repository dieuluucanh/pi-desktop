import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionCore, type SessionCore } from "../../src/host/session-core";
import { createExtensionUiPort } from "../../src/host/extension-ui";
import {
  ProjectTrustStore,
  SessionManager,
  createSdkCommandRunner,
  createSdkExtensionBinder,
  createSdkSessionRuntime,
  createSdkTuiSurface,
  hasTrustRequiringProjectResources,
  observeSdkModelChanges,
} from "../../src/host/sdk";
import type { HostMethod } from "../../src/shared/host-protocol";
import { createFakeProvider, type FakeProvider } from "./fixtures/fake-provider";
import { createFixtureProfile, type FixtureProfile } from "./fixtures/fixture-profile";

/**
 * Host integration harness (plan step 25).
 *
 * Drives the **real** session core with the **real** SDK runtime and a
 * deterministic fake provider (a local OpenAI-compatible SSE server). Nothing
 * here is a hand-written `HostSession` double: prompts stream through the SDK's
 * agent loop, tools execute for real, compaction and retries run Pi's own code,
 * and `/reload` replaces the session the way the app does. Only the model's bytes
 * are scripted.
 */

interface Harness {
  core: SessionCore;
  call(method: HostMethod, params?: unknown): Promise<unknown>;
  events(): string[];
  payloads(event: string): unknown[];
  provider: FakeProvider;
  profile: FixtureProfile;
}

let active: Harness | null = null;

afterEach(async () => {
  await active?.core.dispose();
  await active?.provider.close();
  active?.profile.remove();
  active = null;
});

async function startHarness(
  options: { extensions?: boolean; modelIds?: string[] } = {},
): Promise<Harness> {
  const provider = await createFakeProvider();
  const profile = createFixtureProfile({
    baseUrl: provider.baseUrl,
    ...(options.modelIds ? { modelIds: options.modelIds } : {}),
  });
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const emit = (event: string, payload?: unknown): void => {
    emitted.push({ event, payload });
  };

  // A real extension UI binder, so an extension loaded from the fixture profile
  // can open a dialog and be answered through the `oi.request`/`oi.respond` path.
  let bindSession: ((session: never, runtime: never) => Promise<void>) | undefined;
  let portHandlers: ReturnType<ReturnType<typeof createExtensionUiPort>["handlers"]> | null = null;
  if (options.extensions) {
    const port = createExtensionUiPort({ emit });
    // The composition root merges the UI port's handlers (`oi.respond`, `oi.state`,
    // …) beside the core's; this harness does the same so the test can answer.
    portHandlers = port.handlers();
    const tuiSurface = createSdkTuiSurface({ emit, terminalInput: () => [] });
    bindSession = createSdkExtensionBinder({
      port,
      emit,
      tuiSurface,
      readKeybindings: async () => ({}),
    }) as unknown as (session: never, runtime: never) => Promise<void>;
  }

  const core = createSessionCore({
    cwd: profile.projectDir,
    agentDir: profile.dir,
    ...(bindSession ? { bindSession } : {}),
    // The composition root's adapters (the real implementations): command
    // execution/completion and extension-driven model changes must go through
    // the same SDK paths the app uses.
    wrapCommandRunner: (runner) => createSdkCommandRunner(runner as never),
    observeModelChanges: observeSdkModelChanges,
    emit: (event, payload) => emitted.push({ event, payload }),
    trustStore: new ProjectTrustStore(profile.dir),
    requiresTrust: (cwd) => hasTrustRequiringProjectResources(cwd),
    newSessionManager: (cwd, sessionDir) =>
      SessionManager.create(cwd, sessionDir ?? profile.sessionsDir) as never,
    openSessionManager: (sessionFile, cwd, sessionDir) =>
      SessionManager.open(sessionFile, sessionDir ?? profile.sessionsDir, cwd) as never,
    listSessions: (cwd) => SessionManager.list(cwd) as Promise<never[]>,
    createRuntime: async (request) => {
      const created = await createSdkSessionRuntime({
        cwd: request.cwd,
        agentDir: profile.dir,
        sessionManager: request.sessionManager as never,
      });
      return { runtime: created.runtime, session: created.session };
    },
  });

  const handlers = { ...core.handlers(), ...(portHandlers ?? {}) };
  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {} as never);
  };

  active = {
    core,
    call,
    events: () => emitted.map((entry) => entry.event),
    payloads: (event) => emitted.filter((entry) => entry.event === event).map((e) => e.payload),
    provider,
    profile,
  };
  return active;
}

/** Polls until `predicate` is true, or rejects after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the expected state");
}

/** Waits for the first event of a kind and returns its payload. */
async function waitForEvent(harness: Harness, event: string): Promise<Record<string, unknown>> {
  await waitFor(() => harness.payloads(event).length > 0);
  return harness.payloads(event)[0] as Record<string, unknown>;
}

/** The assistant text the SDK accumulated from the streamed turns. */
async function lastAssistantText(harness: Harness): Promise<string> {
  const result = (await harness.call("session.lastAssistantText")) as { text: string };
  return result.text;
}

describe("host integration: prompts", () => {
  it("streams a prompt through the real SDK and reports the reply", async () => {
    const harness = await startHarness();
    harness.provider.enqueue({ kind: "text", text: "Hello from the fake model" });

    await harness.call("session.create");
    expect(harness.events()).toContain("session_started");

    const snapshot = (await harness.call("prompt", { text: "Say hello" })) as {
      sessionId: string;
      messageCount: number;
      streaming: boolean;
    };
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.messageCount).toBeGreaterThanOrEqual(2);

    // The SDK's real agent loop ran: start, streamed updates and end all arrived.
    expect(harness.events()).toContain("agent_start");
    expect(harness.events()).toContain("message_update");
    expect(harness.events()).toContain("agent_end");
    expect(harness.events()).toContain("state");

    // The provider saw the user prompt, and the reply is the scripted text.
    expect(harness.provider.requests).toHaveLength(1);
    const sent = JSON.stringify(harness.provider.requests[0]?.body);
    expect(sent).toContain("Say hello");
    expect(await lastAssistantText(harness)).toBe("Hello from the fake model");
  });

  it("carries an image through the prompt to the provider", async () => {
    const harness = await startHarness();
    harness.provider.enqueue({ kind: "text", text: "I see it" });

    await harness.call("session.create");
    await harness.call("prompt", {
      text: "What is this?",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    });

    const body = JSON.stringify(harness.provider.requests[0]?.body);
    // The SDK serializes the image as a data URL in the user message.
    expect(body).toContain("data:image/png;base64,aGVsbG8=");
  });
});

describe("host integration: tools", () => {
  it("executes a tool call and continues the turn with the result", async () => {
    const harness = await startHarness();
    writeFileSync(join(harness.profile.projectDir, "note.txt"), "the secret word is GIZMO\n");
    harness.provider.enqueue(
      { kind: "toolCall", name: "read", arguments: { path: "note.txt" } },
      { kind: "text", text: "The file contains GIZMO" },
    );

    await harness.call("session.create");
    await harness.call("prompt", { text: "Read note.txt" });

    // Two requests: the tool call, then the follow-up with the tool result.
    expect(harness.provider.requests).toHaveLength(2);
    expect(harness.events()).toContain("tool_execution_start");
    expect(harness.events()).toContain("tool_execution_end");

    const followUp = JSON.stringify(harness.provider.requests[1]?.body);
    expect(followUp).toContain("GIZMO");
    expect(followUp).toContain("tool");
    expect(await lastAssistantText(harness)).toBe("The file contains GIZMO");
  });
});

describe("host integration: retries", () => {
  it("recovers from a provider 500 using Pi's own retry loop", async () => {
    const harness = await startHarness();
    harness.provider.enqueue(
      { kind: "error", status: 500, message: "temporarily unavailable" },
      { kind: "text", text: "recovered after a retry" },
    );

    await harness.call("session.create");
    await harness.call("prompt", { text: "Are you there?" });

    // The first request failed; the SDK retried and the second succeeded.
    expect(harness.provider.requests.length).toBeGreaterThanOrEqual(2);
    expect(await lastAssistantText(harness)).toBe("recovered after a retry");
  });
});

describe("host integration: compaction", () => {
  it("compacts the conversation through the SDK's summarizer", async () => {
    const harness = await startHarness();
    harness.provider.enqueue(
      { kind: "text", text: "first answer" },
      { kind: "text", text: "second answer" },
      // The compact call asks the model for a summary.
      { kind: "text", text: "summary of the conversation" },
    );

    await harness.call("session.create");
    await harness.call("prompt", { text: "first question" });
    await harness.call("prompt", { text: "second question" });

    const requestsBefore = harness.provider.requests.length;
    const result = (await harness.call("compact", { instructions: "be terse" })) as {
      state: { sessionId: string };
    };
    expect(result.state.sessionId).toBeTruthy();
    expect(harness.provider.requests.length).toBeGreaterThan(requestsBefore);
  });
});

describe("host integration: cancellation", () => {
  it("aborts an in-flight stream and returns the session to idle", async () => {
    const harness = await startHarness();
    harness.provider.enqueue({
      kind: "slowText",
      text: "one two three four five six seven eight nine ten eleven twelve",
      delayMs: 25,
    });

    await harness.call("session.create");
    const pending = harness.call("prompt", { text: "count for me" });

    // Wait until the model is actually streaming before aborting.
    await waitFor(
      async () => ((await harness.call("state.get")) as { streaming: boolean }).streaming,
    );
    await harness.call("abort");
    // An aborted run settles the prompt rather than hanging it.
    await pending.catch(() => undefined);

    const state = (await harness.call("state.get")) as { streaming: boolean };
    expect(state.streaming).toBe(false);
    expect(harness.events()).toContain("agent_end");
  });
});

describe("host integration: extension UI round-trip", () => {
  it("answers an extension's confirm() through oi.request/oi.respond", async () => {
    const harness = await startHarness({ extensions: true });
    harness.profile.writeExtension(
      "ask.js",
      `export default function (pi) {
  pi.registerCommand("ask", {
    description: "Ask a question",
    handler: async (args, ctx) => {
      const ok = await ctx.ui.confirm("Proceed?", "Do you want to proceed?");
      ctx.ui.notify(ok ? "confirmed by user" : "denied by user", ok ? "info" : "warning");
    },
  });
}
`,
    );

    await harness.call("session.create");
    const pending = harness.call("prompt", { text: "/ask" });

    // The extension command runs in the host; its confirm() becomes an event the
    // app must answer. No model request is made for an extension command.
    const request = await waitForEvent(harness, "oi.request");
    expect(request.method).toBe("confirm");
    await harness.call("oi.respond", { id: request.id, confirmed: true });
    await pending;

    expect(harness.provider.requests).toHaveLength(0);
    const notify = harness.payloads("oi.notify").at(-1) as { message: string };
    expect(notify.message).toBe("confirmed by user");
  });
});

describe("host integration: extension command arguments", () => {
  it("completes a command's arguments and runs its handler directly", async () => {
    const harness = await startHarness({ extensions: true });
    harness.profile.writeExtension(
      "args.js",
      `export default function (pi) {
  pi.registerCommand("test-args", {
    description: "Exercise argument completion",
    getArgumentCompletions: (prefix) => [
      { value: "use ", label: "use", description: "activate" },
      { value: "list", label: "list" },
    ].filter((item) => item.label.startsWith(prefix)),
    handler: async (args, ctx) => {
      ctx.ui.notify("args:" + args, "info");
    },
  });
}
`,
    );

    await harness.call("session.create");
    await expect(
      harness.call("commands.complete", { name: "test-args", prefix: "u" }),
    ).resolves.toEqual({
      items: [{ value: "use ", label: "use", description: "activate" }],
    });
    await expect(
      harness.call("commands.run", { name: "test-args", args: "use Profile-A" }),
    ).resolves.toEqual({ ran: true });

    const notify = harness.payloads("oi.notify").at(-1) as { message: string };
    expect(notify.message).toBe("args:use Profile-A");
    expect(harness.provider.requests).toHaveLength(0);
  });
});

describe("host integration: extension model changes", () => {
  it("emits a state snapshot and drives the next request after an extension switch", async () => {
    const harness = await startHarness({
      extensions: true,
      modelIds: ["fake-1", "fake-2"],
    });
    harness.profile.writeExtension(
      "switch-model.js",
      `export default function (pi) {
  pi.registerCommand("test-switch-model", {
    description: "Switch to the second fake model",
    handler: async (args, ctx) => {
      const model = ctx.modelRegistry.find("fake", "fake-2");
      if (!model) throw new Error("fake-2 is not in the registry");
      const switched = await pi.setModel(model);
      if (!switched) throw new Error("fake-2 has no configured auth");
      ctx.ui.notify("switched to fake-2", "info");
    },
  });
}
`,
    );

    await harness.call("session.create");
    const before = (await harness.call("state.get")) as { model?: { id?: string } };
    expect(before.model?.id).toBe("fake-1");

    await harness.call("prompt", { text: "/test-switch-model" });

    // The workflow `/profile` path is exactly this: an extension calls
    // `pi.setModel`, which the session bus never reports. Without the observer
    // the last state frame would still say fake-1.
    const states = harness.payloads("state") as Array<{ model?: { id?: string } }>;
    expect(states.at(-1)?.model?.id).toBe("fake-2");
    const after = (await harness.call("state.get")) as { model?: { id?: string } };
    expect(after.model?.id).toBe("fake-2");

    // The actual session (not only the app's snapshot) moved: the next prompt
    // goes to the new model, matching terminal Pi after `/profile use`.
    harness.provider.enqueue({ kind: "text", text: "on the new model" });
    await harness.call("prompt", { text: "hello from the new model" });
    expect(harness.provider.requests.at(-1)?.body.model).toBe("fake-2");
  });
});

describe("host integration: session replacement", () => {
  it("starts a new session in place and rebinds the subscription", async () => {
    const harness = await startHarness();
    harness.provider.enqueue(
      { kind: "text", text: "old answer" },
      { kind: "text", text: "new answer" },
    );

    await harness.call("session.create");
    await harness.call("prompt", { text: "old question" });
    const oldFile = (await harness.call("state.get")) as { sessionFile: string };

    await harness.call("session.new");
    expect(harness.events()).toContain("session_replaced");
    const newState = (await harness.call("state.get")) as { sessionFile: string };
    expect(newState.sessionFile).not.toBe(oldFile.sessionFile);

    // The rebound session still streams, which proves the listener moved with it.
    await harness.call("prompt", { text: "new question" });
    expect(await lastAssistantText(harness)).toBe("new answer");
  });

  it("resumes a stored session from its JSONL with its messages intact", async () => {
    const harness = await startHarness();
    harness.provider.enqueue({ kind: "text", text: "stored answer" });
    await harness.call("session.create");
    await harness.call("prompt", { text: "stored question" });
    const before = (await harness.call("state.get")) as {
      sessionFile: string;
      messageCount: number;
    };
    expect(before.messageCount).toBeGreaterThanOrEqual(2);

    // A fresh core over the same profile, resuming the same file.
    const resumed = await startHarness();
    const snapshot = (await resumed.call("session.resume", {
      sessionFile: before.sessionFile,
    })) as { sessionId: string; sessionFile: string };
    expect(snapshot.sessionFile).toBe(before.sessionFile);
    const state = (await resumed.call("state.get")) as { messageCount: number };
    expect(state.messageCount).toBeGreaterThanOrEqual(2);
    expect(await lastAssistantText(resumed)).toBe("stored answer");
  });

  it("reloads the running session on /reload without losing the conversation", async () => {
    const harness = await startHarness();
    harness.provider.enqueue(
      { kind: "text", text: "kept answer" },
      { kind: "text", text: "after reload" },
    );

    await harness.call("session.create");
    await harness.call("prompt", { text: "remember this" });

    await harness.call("session.reload");
    expect(harness.events()).toContain("session_replaced");

    // The JSONL was re-read: the earlier answer is still the last assistant text.
    expect(await lastAssistantText(harness)).toBe("kept answer");

    await harness.call("prompt", { text: "still there?" });
    expect(await lastAssistantText(harness)).toBe("after reload");
  });
});

const workflowExtension = process.env.PI_WORKFLOW_EXTENSION ?? "";

/**
 * Optional live check (2026-10-24 stale-host plan): set
 * `PI_WORKFLOW_EXTENSION` to a local `@dieulc/workflow/index.ts` to run the
 * real extension's argument hooks through the same host path the app uses.
 * Skipped by default so CI does not depend on a developer's profile.
 */
describe.skipIf(workflowExtension.length === 0)(
  "host integration: real workflow extension (live)",
  () => {
    it("serves /profile and /commit-policy argument completions", async () => {
      const harness = await startHarness({ extensions: true });
      harness.profile.writeExtension(
        "workflow-live.js",
        `export { default } from ${JSON.stringify(workflowExtension)};`,
      );
      // The extension reads its own profile for defaults; never touch the
      // developer's real `~/.pi/agent` from a test.
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = harness.profile.dir;
      try {
        await harness.call("session.create");

        const profile = (await harness.call("commands.complete", {
          name: "profile",
          prefix: "",
        })) as { items?: Array<{ value: string; label: string }> | null };
        const profileLabels = profile.items?.map((item) => item.label) ?? [];
        expect(profileLabels).toEqual(expect.arrayContaining(["list"]));
        expect(profileLabels.some((label) => label.startsWith("use"))).toBe(true);
        expect(profileLabels.some((label) => label.startsWith("rename"))).toBe(true);

        const policy = (await harness.call("commands.complete", {
          name: "commit-policy",
          prefix: "",
        })) as { items?: Array<{ value: string; label: string }> | null };
        expect(policy.items?.map((item) => item.label)).toEqual(
          expect.arrayContaining(["never", "ask", "allow"]),
        );
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    }, 120_000);
  },
);
