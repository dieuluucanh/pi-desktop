import { describe, expect, it, vi } from "vitest";
import { createControlCore } from "../../src/host/control-core";
import {
  ProviderError,
  type ModelCompletionInput,
  type ModelCompletionPort,
  type ProviderPort,
} from "../../src/host/providers";
import { createTextGenerationHandlers, TextGenerationError } from "../../src/host/text-generation";
import type { HostMethod } from "../../src/shared/host-protocol";
import { MAX_PROMPT_CHARS, type ModelChoice } from "../../src/shared/text-generation";
import { createFakeSettings } from "./fake-settings";

/**
 * Session-less text generation (2026-11-25 plan, step 16).
 *
 * A fake `ModelCompletionPort` and the in-memory settings port pin the whole
 * contract: the catalogue and its saved default, the explicit/default/first
 * model resolution, every refusal code, cancel and the timeout. Nothing here
 * touches a real provider, an `AgentSession` or a JSONL file.
 */

const CATALOGUE: ModelChoice[] = [
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
  { provider: "anthropic", id: "claude-x", name: "Claude X" },
];

interface FakeCompletionPort {
  port: ModelCompletionPort;
  calls: ModelCompletionInput[];
  available: () => number;
}

function fakePort(
  options: {
    models?: readonly ModelChoice[];
    complete?: (input: ModelCompletionInput) => Promise<{ text: string; usage?: unknown }>;
  } = {},
): FakeCompletionPort {
  const calls: ModelCompletionInput[] = [];
  let availableCalls = 0;
  const port: ModelCompletionPort = {
    availableModels: async () => {
      availableCalls += 1;
      return options.models ?? CATALOGUE;
    },
    complete: async (input) => {
      calls.push(input);
      if (options.complete) {
        const result = await options.complete(input);
        return result as { text: string; usage?: { input: number; output: number } };
      }
      return { text: "feat: add a thing", usage: { input: 10, output: 4 } };
    },
  };
  return { port, calls, available: () => availableCalls };
}

/** A port whose `complete` only ever settles when the signal aborts. */
function hangingPort(): FakeCompletionPort {
  return fakePort({
    complete: (input) =>
      new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
}

function handlersFor(
  port: ModelCompletionPort | null,
  options: {
    global?: Record<string, unknown>;
    project?: Record<string, unknown>;
    trusted?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const settings = createFakeSettings({
    ...(options.global ? { global: options.global } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
  });
  const handlers = createTextGenerationHandlers({
    resolvePort: () => port,
    settings,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { handlers, settings };
}

async function call(
  handlers: ReturnType<typeof createTextGenerationHandlers>,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const handler = handlers.handlers()[method as HostMethod];
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler(params, {
    method: method as HostMethod,
    requestId: 1,
    emit: () => {},
    readBlob: async () => null,
  });
}

const REQUEST = {
  requestId: "req-1",
  system: "You write git commit messages.",
  prompt: "Branch: main\n\n1 file changed\n\ndiff --git a/a.ts b/a.ts",
};

describe("text.models", () => {
  it("returns the available catalogue and the saved default", async () => {
    const { port, available } = fakePort();
    const { handlers } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-5" },
    });

    await expect(call(handlers, "text.models", { cwd: "C:/work/app" })).resolves.toEqual({
      models: CATALOGUE,
      defaultModel: { provider: "openai", id: "gpt-5", name: "GPT-5" },
      defaultAvailable: true,
    });
    expect(available()).toBe(1);
  });

  it("prefers the project default over the global one", async () => {
    const { port } = fakePort();
    const { handlers, settings } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-5" },
      project: { defaultProvider: "anthropic", defaultModel: "claude-x" },
    });

    const result = (await call(handlers, "text.models", { cwd: "C:/work/app" })) as {
      defaultModel: ModelChoice;
      defaultAvailable: boolean;
    };
    expect(result.defaultModel).toEqual({
      provider: "anthropic",
      id: "claude-x",
      name: "Claude X",
    });
    expect(result.defaultAvailable).toBe(true);
    expect(settings.read).toHaveBeenCalledWith("C:/work/app");
  });

  it("reports defaultAvailable: false when the saved default is out of the catalogue", async () => {
    const { port } = fakePort();
    const { handlers } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-4-removed" },
    });

    await expect(call(handlers, "text.models", {})).resolves.toEqual({
      models: CATALOGUE,
      defaultModel: { provider: "openai", id: "gpt-4-removed", name: "gpt-4-removed" },
      defaultAvailable: false,
    });
  });

  it("answers not_implemented when the host has no completion port", async () => {
    const { handlers } = handlersFor(null);
    await expect(call(handlers, "text.models", {})).rejects.toMatchObject({
      code: "not_implemented",
    });
  });
});

describe("text.generate", () => {
  it("calls an explicitly picked model and names it in the result", async () => {
    const { port, calls } = fakePort();
    const { handlers } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-5" },
    });

    const result = await call(handlers, "text.generate", {
      ...REQUEST,
      model: { provider: "anthropic", id: "claude-x" },
      maxTokens: 256,
    });

    expect(result).toEqual({
      requestId: "req-1",
      text: "feat: add a thing",
      model: { provider: "anthropic", id: "claude-x", name: "Claude X" },
      usage: { input: 10, output: 4 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: { provider: "anthropic", id: "claude-x" },
      system: REQUEST.system,
      prompt: REQUEST.prompt,
      maxTokens: 256,
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the saved default when the request names no model", async () => {
    const { port, calls } = fakePort();
    const { handlers } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-5" },
    });

    const result = (await call(handlers, "text.generate", REQUEST)) as { model: ModelChoice };
    expect(result.model).toEqual({ provider: "openai", id: "gpt-5", name: "GPT-5" });
    expect(calls[0]?.model).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it("falls back to the first catalogue row when no default is saved", async () => {
    const { port, calls } = fakePort();
    const { handlers } = handlersFor(port, { global: {}, project: {} });

    const result = (await call(handlers, "text.generate", REQUEST)) as { model: ModelChoice };
    expect(result.model).toEqual({ provider: "openai", id: "gpt-5", name: "GPT-5" });
    expect(calls[0]?.model).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it("skips a saved default the catalogue cannot resolve", async () => {
    const { port, calls } = fakePort();
    const { handlers } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-4-removed" },
    });

    const result = (await call(handlers, "text.generate", REQUEST)) as { model: ModelChoice };
    expect(result.model).toEqual({ provider: "openai", id: "gpt-5", name: "GPT-5" });
    expect(calls[0]?.model).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it("answers no_model when the catalogue is empty and nothing is saved", async () => {
    const { port, calls } = fakePort({ models: [] });
    const { handlers } = handlersFor(port, { global: {}, project: {} });

    await expect(call(handlers, "text.generate", REQUEST)).rejects.toMatchObject({
      code: "no_model",
    });
    expect(calls).toHaveLength(0);
  });

  it("answers unknown_model for an explicit model outside the catalogue", async () => {
    const { port, calls } = fakePort();
    const { handlers } = handlersFor(port);

    const failure = call(handlers, "text.generate", {
      ...REQUEST,
      model: { provider: "openai", id: "not-a-model" },
    });
    await expect(failure).rejects.toBeInstanceOf(TextGenerationError);
    await expect(failure).rejects.toMatchObject({
      code: "unknown_model",
      message: "unknown model openai/not-a-model",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed requestId, prompt and maxTokens as bad_request", async () => {
    const { port, calls } = fakePort();
    const { handlers } = handlersFor(port);

    await expect(
      call(handlers, "text.generate", { ...REQUEST, requestId: "bad id!" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      call(handlers, "text.generate", { ...REQUEST, prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      call(handlers, "text.generate", { ...REQUEST, system: "   " }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      call(handlers, "text.generate", { ...REQUEST, maxTokens: 0 }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  it("aborts through text.cancel with the aborted code", async () => {
    const { port, calls } = hangingPort();
    const { handlers } = handlersFor(port);

    const pending = call(handlers, "text.generate", REQUEST);
    const rejection = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await expect(call(handlers, "text.cancel", { requestId: REQUEST.requestId })).resolves.toEqual({
      ok: true,
    });
    await rejection;
  });

  it("answers timeout when the port outlives the host budget", async () => {
    const { port } = hangingPort();
    const { handlers } = handlersFor(port, { timeoutMs: 5 });

    await expect(
      call(handlers, "text.generate", { ...REQUEST, requestId: "slow" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("passes a provider code through unchanged", async () => {
    const { port } = fakePort({
      complete: async () => {
        throw new ProviderError("quota exceeded", "provider_error");
      },
    });
    const { handlers } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-5" },
    });

    await expect(call(handlers, "text.generate", REQUEST)).rejects.toMatchObject({
      code: "provider_error",
      message: "quota exceeded",
    });
  });

  it("refuses an empty reply instead of returning an empty message", async () => {
    const { port } = fakePort({ complete: async () => ({ text: "   " }) });
    const { handlers } = handlersFor(port, {
      global: { defaultProvider: "openai", defaultModel: "gpt-5" },
    });

    await expect(call(handlers, "text.generate", REQUEST)).rejects.toMatchObject({
      code: "provider_error",
      message: "the model returned no text",
    });
  });

  it("answers not_implemented when the host has no completion port", async () => {
    const { handlers } = handlersFor(null);
    await expect(call(handlers, "text.generate", REQUEST)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });
});

describe("text.cancel", () => {
  it("is idempotent for an unknown request id", async () => {
    const { handlers } = handlersFor(null);
    await expect(call(handlers, "text.cancel", { requestId: "never-started" })).resolves.toEqual({
      ok: true,
    });
    await expect(call(handlers, "text.cancel", {})).resolves.toEqual({ ok: true });
  });

  it("can cancel the same request twice", async () => {
    const { port, calls } = hangingPort();
    const { handlers } = handlersFor(port);

    const pending = call(handlers, "text.generate", { ...REQUEST, requestId: "twice" });
    const rejection = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await expect(call(handlers, "text.cancel", { requestId: "twice" })).resolves.toEqual({
      ok: true,
    });
    await expect(call(handlers, "text.cancel", { requestId: "twice" })).resolves.toEqual({
      ok: true,
    });
    await rejection;
  });
});

describe("control core wiring", () => {
  it("registers the three methods and answers not_implemented without a port", async () => {
    const core = createControlCore({
      settings: createFakeSettings(),
      listSessions: async () => [],
    });
    const keys = Object.keys(core.handlers());
    expect(keys).toContain("text.models");
    expect(keys).toContain("text.generate");
    expect(keys).toContain("text.cancel");
    await expect(core.handlers()["text.models"]?.({}, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("reaches the port through the control core", async () => {
    const { port } = fakePort();
    const core = createControlCore({
      settings: createFakeSettings({
        global: { defaultProvider: "openai", defaultModel: "gpt-5" },
      }),
      listSessions: async () => [],
      // Only `completion` is read by the text handlers, so the rest of the
      // credential surface is deliberately absent here.
      providers: { completion: port } as unknown as ProviderPort,
    });

    await expect(core.handlers()["text.generate"]?.(REQUEST, {} as never)).resolves.toMatchObject({
      requestId: "req-1",
      model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
    });
  });
});
