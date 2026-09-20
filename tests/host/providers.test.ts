import { describe, expect, it, vi } from "vitest";
import {
  MAX_API_KEY_LENGTH,
  collectProviders,
  createProviderHandlers,
  summarizeProvider,
  type ProviderPort,
} from "../../src/host/providers";
import type { HostMethod } from "../../src/shared/host-protocol";

/**
 * Providers and credentials (plan step 9).
 *
 * The acceptance rule this file exists for: **a key goes in and never comes
 * back**. Every response is serialised and searched for the secret, and a
 * recursive scan rejects any credential-shaped field name.
 */

const SECRET = "sk-ant-super-secret-value-1234567890";

function fakePort(overrides: Partial<ProviderPort> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const port: ProviderPort = {
    listProviders: async () => [
      { id: "openai", label: "OpenAI", authTypes: ["api_key"], envVars: ["OPENAI_API_KEY"] },
      {
        id: "anthropic",
        label: "Anthropic",
        authTypes: ["api_key", "oauth"],
        subscription: false,
        envVars: ["ANTHROPIC_API_KEY"],
      },
      { id: "claude-max", label: "Claude Max", authTypes: ["oauth"], subscription: true },
    ],
    authStatus: (providerId) =>
      providerId === "claude-max"
        ? { configured: true, source: "stored", label: "subscription" }
        : { configured: false },
    modelCount: (providerId) => (providerId === "openai" ? 12 : 3),
    setKey: async (providerId, apiKey) => record("setKey")(providerId, apiKey),
    logout: async (providerId) => record("logout")(providerId),
    setRuntimeKey: async (providerId, apiKey) => record("setRuntimeKey")(providerId, apiKey),
    clearRuntimeKey: async (providerId) => record("clearRuntimeKey")(providerId),
    refresh: async () => record("refresh")(),
    envHas: (name) => name === "ANTHROPIC_API_KEY",
    ...overrides,
  };
  return { port, calls };
}

async function call(
  handlers: ReturnType<typeof createProviderHandlers>,
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

/** Every field name that would indicate a credential travelling to the app. */
const CREDENTIAL_FIELD = /(apikey|api_key|secret|token|password|bearer|authorization)/i;

function findCredentialFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => findCredentialFields(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    ...(CREDENTIAL_FIELD.test(key) ? [`${path}.${key}`] : []),
    ...findCredentialFields(entry, `${path}.${key}`),
  ]);
}

describe("provider summaries", () => {
  it("classifies subscription vs key and counts models, without credentials", async () => {
    const { port } = fakePort();
    const providers = await collectProviders(port);

    // Sorted by label; env availability comes from the injected lookup.
    expect(providers.map((provider) => provider.id)).toEqual(["anthropic", "claude-max", "openai"]);
    const anthropic = providers[0]!;
    expect(anthropic).toMatchObject({
      label: "Anthropic",
      subscription: false,
      configured: false,
      modelCount: 3,
      envVars: ["ANTHROPIC_API_KEY"],
      envAvailable: true,
    });
    const claudeMax = providers[1]!;
    expect(claudeMax).toMatchObject({
      subscription: true,
      configured: true,
      source: "stored",
      statusLabel: "subscription",
      envAvailable: false,
    });
    expect(providers[2]?.envAvailable).toBe(false);
    expect(findCredentialFields(providers)).toEqual([]);
  });

  it("drops a descriptor without an id", async () => {
    const { port } = fakePort({
      listProviders: async () => [{ id: "ok" }, { id: "" }, {} as never],
    });
    expect((await collectProviders(port)).map((provider) => provider.id)).toEqual(["ok"]);
  });

  it("falls back to the id as a label and treats unknown status as unconfigured", () => {
    expect(summarizeProvider({ id: "x" }, { configured: false }, 0)).toMatchObject({
      label: "x",
      authTypes: [],
      subscription: false,
      configured: false,
      envAvailable: false,
    });
  });
});

describe("providers.list", () => {
  it("lists every provider with a timestamp", async () => {
    const { port } = fakePort();
    const handlers = createProviderHandlers(
      () => port,
      () => 1_700_000_000_000,
    );
    const result = (await call(handlers, "providers.list")) as {
      providers: unknown[];
      refreshedAt: number;
    };
    expect(result.providers).toHaveLength(3);
    expect(result.refreshedAt).toBe(1_700_000_000_000);
  });

  it("says so when this host cannot manage providers", async () => {
    const handlers = createProviderHandlers(() => null);
    await expect(call(handlers, "providers.list")).rejects.toMatchObject({
      code: "not_implemented",
    });
  });
});

describe("providers.setKey", () => {
  it("forwards the key to Pi and answers with a credential-free summary", async () => {
    const { port, calls } = fakePort();
    const handlers = createProviderHandlers(() => port);

    const result = (await call(handlers, "providers.setKey", {
      providerId: "anthropic",
      apiKey: SECRET,
    })) as { provider: unknown };

    expect(calls).toEqual([{ method: "setKey", args: ["anthropic", SECRET] }]);
    // The key reached Pi and nothing else: not the response, not a field name.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(findCredentialFields(result)).toEqual([]);
    expect(result.provider).toMatchObject({ id: "anthropic" });
  });

  it("accepts `id` as an alias for providerId", async () => {
    const { port, calls } = fakePort();
    const handlers = createProviderHandlers(() => port);
    await call(handlers, "providers.setKey", { id: "openai", apiKey: SECRET });
    expect(calls[0]).toEqual({ method: "setKey", args: ["openai", SECRET] });
  });

  it("requires a provider and a key, and bounds the key length", async () => {
    const { port, calls } = fakePort();
    const handlers = createProviderHandlers(() => port);

    await expect(call(handlers, "providers.setKey", { apiKey: SECRET })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      call(handlers, "providers.setKey", { providerId: "openai" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      call(handlers, "providers.setKey", {
        providerId: "openai",
        apiKey: "x".repeat(MAX_API_KEY_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toEqual([]);
  });
});

describe("providers.runtimeKey", () => {
  it("sets a runtime-only key", async () => {
    const { port, calls } = fakePort();
    const handlers = createProviderHandlers(() => port);
    const result = (await call(handlers, "providers.runtimeKey", {
      providerId: "openai",
      apiKey: SECRET,
    })) as { runtime: boolean };

    expect(calls[0]).toEqual({ method: "setRuntimeKey", args: ["openai", SECRET] });
    expect(result.runtime).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("clears the runtime key when given an empty one", async () => {
    const { port, calls } = fakePort();
    const handlers = createProviderHandlers(() => port);
    const result = (await call(handlers, "providers.runtimeKey", {
      providerId: "openai",
      apiKey: "",
    })) as { runtime: boolean };

    expect(calls[0]).toEqual({ method: "clearRuntimeKey", args: ["openai"] });
    expect(result.runtime).toBe(false);
  });
});

describe("logout and refresh", () => {
  it("forwards a logout and reports the new status", async () => {
    const { port, calls } = fakePort();
    const handlers = createProviderHandlers(() => port);
    const result = (await call(handlers, "providers.logout", { providerId: "claude-max" })) as {
      provider: { configured: boolean } | null;
    };
    expect(calls).toEqual([{ method: "logout", args: ["claude-max"] }]);
    // The fake keeps reporting configured; the point is that the status is re-read.
    expect(result.provider).toMatchObject({ configured: true });
  });

  it("re-reads the catalogs on refresh", async () => {
    const { port } = fakePort();
    const handlers = createProviderHandlers(() => port);
    const result = (await call(handlers, "providers.refresh")) as { providers: unknown[] };
    expect(result.providers).toHaveLength(3);
  });

  it("reports an unknown provider as null rather than inventing one", async () => {
    const { port } = fakePort();
    const handlers = createProviderHandlers(() => port);
    const result = (await call(handlers, "providers.logout", { providerId: "ghost" })) as {
      provider: unknown;
    };
    expect(result.provider).toBeNull();
  });
});

describe("the write-only guarantee", () => {
  it("never returns the secret from any provider method", async () => {
    const { port } = fakePort();
    const handlers = createProviderHandlers(() => port);
    const callsToCheck: Array<[string, unknown]> = [
      ["providers.list", undefined],
      ["providers.setKey", { providerId: "openai", apiKey: SECRET }],
      ["providers.runtimeKey", { providerId: "openai", apiKey: SECRET }],
      ["providers.runtimeKey", { providerId: "openai", apiKey: "" }],
      ["providers.logout", { providerId: "openai" }],
      ["providers.refresh", undefined],
    ];
    for (const [method, params] of callsToCheck) {
      const response = await call(handlers, method, params);
      expect(JSON.stringify(response), method).not.toContain(SECRET);
      expect(findCredentialFields(response), method).toEqual([]);
    }
  });

  it("does not log the key either", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port } = fakePort();
    const handlers = createProviderHandlers(() => port);
    await call(handlers, "providers.setKey", { providerId: "openai", apiKey: SECRET });

    const logged = [...spy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(logged).not.toContain(SECRET);
    spy.mockRestore();
    errorSpy.mockRestore();
  });
});
