/**
 * The SDK provider adapter (plan step 9, slice 2).
 *
 * Drives a **real** `ModelRuntime` against a throw-away profile directory. No
 * provider is contacted: the API-key login a write-only form uses only answers
 * a local prompt, and every catalog refresh in these tests is offline.
 *
 * What this pins: summaries are credential-free, classification comes from Pi,
 * a key reaches `auth.json` and never the reply, and a runtime-only key never
 * touches the file.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectProviders,
  ProviderError,
  type ModelCompletionInput,
} from "../../src/host/providers";
import {
  completionResultFromMessage,
  createCompletion,
  createSdkProviderPort,
  keyOnlyInteraction,
  type CompletionMessageLike,
  type CompletionRuntimeLike,
} from "../../src/host/sdk/providers";

const SECRET = "sk-test-provider-secret-value";

function tempProfile(): string {
  return mkdtempSync(join(tmpdir(), "pi-desktop-providers-"));
}

const created: string[] = [];
function profile(): string {
  const dir = tempProfile();
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("keyOnlyInteraction", () => {
  it("answers Pi's secret prompt with the key it was given", async () => {
    const interaction = keyOnlyInteraction(SECRET);
    await expect(interaction.prompt({ type: "secret", message: "Enter API key" })).resolves.toBe(
      SECRET,
    );
  });

  it("refuses a provider that needs more than an API key", async () => {
    const interaction = keyOnlyInteraction(SECRET);
    await expect(interaction.prompt({ type: "text", message: "Server URL" })).rejects.toMatchObject(
      { code: "needs_interaction" },
    );
  });

  it("cannot answer the secret prompt twice", async () => {
    const interaction = keyOnlyInteraction(SECRET);
    await interaction.prompt({ type: "secret", message: "key" });
    await expect(
      interaction.prompt({ type: "secret", message: "key again" }),
    ).rejects.toMatchObject({ code: "needs_interaction" });
  });
});

describe("sdk provider port", () => {
  it("lists Pi's providers with credential-free summaries", async () => {
    const port = createSdkProviderPort({ agentDir: profile() });
    const providers = await collectProviders(port);

    expect(providers.length).toBeGreaterThan(10);
    const anthropic = providers.find((provider) => provider.id === "anthropic");
    expect(anthropic).toMatchObject({ id: "anthropic", label: "Anthropic" });
    expect(anthropic?.authTypes).toContain("api_key");
    expect(anthropic?.authTypes).toContain("oauth");
    expect(anthropic?.modelCount).toBeGreaterThan(0);
    // Sorted by label, and never carrying a credential-shaped field.
    const labels = providers.map((provider) => provider.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
    expect(JSON.stringify(providers)).not.toContain(SECRET);
  });

  it("detects an environment key with no stored credential", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = SECRET;
    try {
      const port = createSdkProviderPort({
        agentDir: profile(),
        env: { ANTHROPIC_API_KEY: SECRET },
      });
      const providers = await collectProviders(port);
      const anthropic = providers.find((provider) => provider.id === "anthropic");
      expect(anthropic).toMatchObject({
        configured: true,
        source: "environment",
        envAvailable: true,
        subscription: false,
      });
      expect(anthropic?.envVars).toContain("ANTHROPIC_API_KEY");
      // The value itself is nowhere in the summary.
      expect(JSON.stringify(anthropic)).not.toContain(SECRET);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("persists an API key through Pi and never returns it", async () => {
    const agentDir = profile();
    const port = createSdkProviderPort({ agentDir });
    await port.setKey("anthropic", SECRET);

    const authFile = join(agentDir, "auth.json");
    expect(existsSync(authFile)).toBe(true);
    expect(readFileSync(authFile, "utf8")).toContain(SECRET);

    const providers = await collectProviders(port);
    const anthropic = providers.find((provider) => provider.id === "anthropic");
    expect(anthropic).toMatchObject({ configured: true, source: "stored" });
    // The key reached Pi, never a summary.
    expect(JSON.stringify(providers)).not.toContain(SECRET);
  });

  it("writes the credential file with owner-only permissions (plan step 23)", async () => {
    const agentDir = profile();
    const port = createSdkProviderPort({ agentDir });
    await port.setKey("anthropic", SECRET);

    // Windows does not model POSIX mode bits; on a POSIX host the file Pi writes
    // must not be group/world readable.
    if (process.platform === "win32") return;
    const { statSync } = await import("node:fs");
    const mode = statSync(join(agentDir, "auth.json")).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("keeps a runtime-only key out of auth.json", async () => {
    const agentDir = profile();
    const authFile = join(agentDir, "auth.json");
    const port = createSdkProviderPort({ agentDir });
    await port.setRuntimeKey("anthropic", SECRET);

    // Pi may create the file/directory lazily; the rule is that the key is not in
    // it (a runtime key must not survive the process).
    if (existsSync(authFile)) expect(readFileSync(authFile, "utf8")).not.toContain(SECRET);
    const providers = await collectProviders(port);
    const anthropic = providers.find((provider) => provider.id === "anthropic");
    expect(anthropic?.configured).toBe(true);
    expect(anthropic?.source).toBe("runtime");

    await port.clearRuntimeKey("anthropic");
    if (existsSync(authFile)) expect(readFileSync(authFile, "utf8")).not.toContain(SECRET);
    const after = (await collectProviders(port)).find((provider) => provider.id === "anthropic");
    expect(after?.configured).toBe(false);
  });

  it("logs out by removing the stored credential", async () => {
    const agentDir = profile();
    const port = createSdkProviderPort({ agentDir });
    await port.setKey("anthropic", SECRET);
    await port.logout("anthropic");

    const authFile = join(agentDir, "auth.json");
    if (existsSync(authFile)) {
      expect(readFileSync(authFile, "utf8")).not.toContain(SECRET);
    }
    const anthropic = (await collectProviders(port)).find(
      (provider) => provider.id === "anthropic",
    );
    expect(anthropic?.configured).toBe(false);
  });

  it("refuses an unknown provider and a provider without an API-key login", async () => {
    const port = createSdkProviderPort({ agentDir: profile() });
    await expect(port.setKey("no-such-provider", SECRET)).rejects.toBeInstanceOf(ProviderError);
    await expect(port.setKey("no-such-provider", SECRET)).rejects.toMatchObject({
      code: "unknown_provider",
    });
  });

  it("reports an unknown provider as unconfigured", () => {
    const port = createSdkProviderPort({ agentDir: profile() });
    expect(port.authStatus("no-such-provider")).toEqual({ configured: false });
    expect(port.modelCount("no-such-provider")).toBe(0);
  });
});

/**
 * The `AssistantMessage` → result mapping (2026-11-25 plan, step 16; advisory
 * R5). Pi reports a provider failure as a *value* (`stopReason: "error"` plus
 * `errorMessage`), so the adapter has to turn it into a typed error instead of
 * returning the empty joined text as a successful message.
 */
describe("completionResultFromMessage", () => {
  function message(overrides: Partial<CompletionMessageLike> = {}): CompletionMessageLike {
    return {
      content: [
        { type: "thinking" },
        { type: "text", text: "feat: " },
        { type: "text", text: "add a thing" },
      ],
      stopReason: "stop",
      usage: { input: 21, output: 7 },
      ...overrides,
    };
  }

  it("joins the text blocks and reports the usage", () => {
    expect(completionResultFromMessage(message())).toEqual({
      text: "feat: add a thing",
      usage: { input: 21, output: 7 },
    });
  });

  it("maps stopReason 'error' to provider_error with the provider's message", () => {
    let thrown: unknown;
    try {
      completionResultFromMessage(
        message({ stopReason: "error", errorMessage: "quota exceeded", content: [] }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({ code: "provider_error", message: "quota exceeded" });
  });

  it("falls back to a generic provider_error when the error carries no message", () => {
    expect(() => completionResultFromMessage(message({ stopReason: "error" }))).toThrow(
      /the provider returned an error/,
    );
  });

  it("maps stopReason 'aborted' to the aborted code even when text arrived", () => {
    expect(() => completionResultFromMessage(message({ stopReason: "aborted" }))).toThrow(
      expect.objectContaining({ code: "aborted" }),
    );
  });

  it("returns a 'length' reply as a success: the text is real, only cut off", () => {
    expect(completionResultFromMessage(message({ stopReason: "length" }))).toMatchObject({
      text: "feat: add a thing",
    });
  });

  it("refuses an empty reply instead of returning an empty message", () => {
    expect(() =>
      completionResultFromMessage(
        message({ content: [{ type: "thinking" }, { type: "text", text: "  " }] }),
      ),
    ).toThrow(
      expect.objectContaining({ code: "provider_error", message: "the model returned no text" }),
    );
  });
});

/**
 * The one-shot completion factory (plan step 2).
 *
 * pi-ai reads the request-level conversation id from `options.sessionId`, and an
 * empty one is dropped — which is what made OpenCode Go/Zen answer HTTP 400
 * `MissingSessionID`. So the port must always send a non-empty, stable token and
 * never branch on the provider itself (whether a header/body field is emitted is
 * pi-ai's decision). A recording runtime keeps this test off the network and off
 * a real `ModelRuntime`.
 */
describe("createCompletion", () => {
  interface CompletionCall {
    model: { provider: string; id: string; name: string };
    context: {
      systemPrompt: string;
      messages: { role: "user"; content: string; timestamp: number }[];
    };
    options: { signal: AbortSignal; maxTokens: number; sessionId: string };
  }

  function recordingRuntime(knownModel = true): {
    runtime: CompletionRuntimeLike;
    calls: CompletionCall[];
  } {
    const calls: CompletionCall[] = [];
    const runtime: CompletionRuntimeLike = {
      getModel: (provider, id) => (knownModel ? { provider, id, name: "Test Model" } : undefined),
      completeSimple: async (model, context, options) => {
        calls.push({ model, context, options });
        return {
          content: [{ type: "text", text: "feat: add a thing" }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        };
      },
    };
    return { runtime, calls };
  }

  function input(overrides: Partial<ModelCompletionInput> = {}): ModelCompletionInput {
    return {
      model: { provider: "deepseek", id: "deepseek-v4.1-flash" },
      system: "You write commit messages.",
      prompt: "diff --git a/x b/x\n+one line",
      maxTokens: 64,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  function onlyCall(calls: CompletionCall[]): CompletionCall {
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) throw new Error("no completion call was recorded");
    return call;
  }

  const TOKEN = /^[A-Za-z0-9._-]+$/;

  it("sends a non-empty conversation id and the same one on every call", async () => {
    const { runtime, calls } = recordingRuntime();
    const complete = createCompletion(async () => runtime);

    await complete(input());
    await complete(input());

    expect(calls).toHaveLength(2);
    const ids = calls.map((call) => call.options.sessionId);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(TOKEN);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it("passes an injected conversation id verbatim", async () => {
    const { runtime, calls } = recordingRuntime();
    const complete = createCompletion(async () => runtime, "conversation-1");

    await complete(input());

    expect(onlyCall(calls).options.sessionId).toBe("conversation-1");
  });

  it("falls back to a generated id when the injected one is blank", async () => {
    for (const blank of ["", "   "]) {
      const { runtime, calls } = recordingRuntime();
      const complete = createCompletion(async () => runtime, blank);

      await complete(input());

      const id = onlyCall(calls).options.sessionId;
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(TOKEN);
      expect(id).not.toBe(blank);
    }
  });

  it("forwards the system prompt, the single user message and maxTokens unchanged", async () => {
    const { runtime, calls } = recordingRuntime();
    const complete = createCompletion(async () => runtime);
    const request = input();

    await complete(request);

    const call = onlyCall(calls);
    expect(call.context.systemPrompt).toBe("You write commit messages.");
    expect(call.context.messages).toHaveLength(1);
    expect(call.context.messages[0]).toMatchObject({
      role: "user",
      content: "diff --git a/x b/x\n+one line",
    });
    expect(call.options.maxTokens).toBe(64);
    expect(call.options.signal).toBe(request.signal);
    expect(call.model).toEqual({
      provider: "deepseek",
      id: "deepseek-v4.1-flash",
      name: "Test Model",
    });
  });

  it("sends the conversation id for a non-OpenCode model ref too", async () => {
    const { runtime, calls } = recordingRuntime();
    const complete = createCompletion(async () => runtime, "conversation-2");

    await complete(
      input({ model: { provider: "command-code", id: "deepseek/deepseek-v4.1-flash" } }),
    );

    const call = onlyCall(calls);
    expect(call.model).toEqual({
      provider: "command-code",
      id: "deepseek/deepseek-v4.1-flash",
      name: "Test Model",
    });
    // Only pi-ai decides whether a header/body field is emitted; the adapter
    // never drops the id based on the provider.
    expect(call.options.sessionId).toBe("conversation-2");
  });

  it("throws unknown_model without calling completeSimple for an unknown model", async () => {
    const { runtime, calls } = recordingRuntime(false);
    const complete = createCompletion(async () => runtime);

    let thrown: unknown;
    try {
      await complete(input());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({ code: "unknown_model" });
    expect(calls).toHaveLength(0);
  });
});
