import { describe, expect, it } from "vitest";
import {
  createCustomProviderHandlers,
  parseModelsJson,
  removeCustomProvider,
  summarizeCustomProviders,
  upsertCustomProvider,
  validateCustomProvider,
} from "../../src/host/custom-providers";
import type { CustomProviderStore } from "../../src/host/custom-providers";
import type { HostMethod } from "../../src/shared/host-protocol";

/**
 * Custom gateways in models.json (plan step 9, slice 5).
 *
 * The rules: an entry is validated before anything touches disk, a malformed
 * file is surfaced rather than replaced, and a summary never carries the stored
 * API key.
 */

const PATH = "C:\\profile\\models.json";
const SECRET = "sk-gateway-secret-value";

const INPUT = {
  id: "my-gateway",
  name: "My Gateway",
  baseUrl: "https://gateway.example.com/v1/",
  api: "openai-completions",
  apiKey: SECRET,
  headers: { "x-tenant": "acme" },
  models: [{ id: "gpt-5", name: "GPT-5", contextWindow: 200_000, maxTokens: 8_000 }],
};

function call(
  handlers: ReturnType<typeof createCustomProviderHandlers>,
  method: HostMethod,
  params?: unknown,
) {
  const handler = handlers.handlers()[method];
  if (!handler) throw new Error(`no handler for ${method}`);
  return Promise.resolve(
    handler(params, { method, requestId: 1, emit: () => {}, readBlob: async () => null }),
  );
}

describe("validateCustomProvider", () => {
  it("normalises a valid entry and strips a trailing slash from the base URL", () => {
    const entry = validateCustomProvider(INPUT);
    expect(entry).toMatchObject({
      name: "My Gateway",
      baseUrl: "https://gateway.example.com/v1",
      api: "openai-completions",
      apiKey: SECRET,
      headers: { "x-tenant": "acme" },
      models: [{ id: "gpt-5", name: "GPT-5", contextWindow: 200_000, maxTokens: 8_000 }],
    });
  });

  it("rejects a bad id, base URL, headers and empty model list", () => {
    expect(() => validateCustomProvider({ ...INPUT, id: "../escape" })).toThrow(/provider id/i);
    expect(() => validateCustomProvider({ ...INPUT, id: "" })).toThrow(/provider id/i);
    expect(() => validateCustomProvider({ ...INPUT, baseUrl: "not a url" })).toThrow(/valid URL/i);
    expect(() => validateCustomProvider({ ...INPUT, baseUrl: "ftp://x.test" })).toThrow(/http/i);
    expect(() => validateCustomProvider({ ...INPUT, headers: { a: 1 } as never })).toThrow(
      /must be a string/i,
    );
    expect(() => validateCustomProvider({ ...INPUT, models: [] })).toThrow(/at least one model/i);
  });

  it("deduplicates model ids and drops unknown scalar fields", () => {
    const entry = validateCustomProvider({
      ...INPUT,
      models: [{ id: "a" }, { id: "a" }, { id: "b" }],
    });
    expect(entry.models.map((model) => model.id)).toEqual(["a", "b"]);
    expect(Object.keys(entry)).not.toContain("extra");
  });
});

describe("models.json editing", () => {
  it("keeps unknown top-level keys and other providers", () => {
    const original = JSON.stringify({
      providers: { other: { baseUrl: "https://other.test" } },
      unknownSetting: true,
    });
    const next = upsertCustomProvider(original, "my-gateway", validateCustomProvider(INPUT), PATH);
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect(parsed.unknownSetting).toBe(true);
    expect(Object.keys(parsed.providers as object).sort()).toEqual(["my-gateway", "other"]);
    expect(next.endsWith("\n")).toBe(true);
  });

  it("surfaces a malformed file instead of replacing it", () => {
    expect(() => parseModelsJson("{ not json", PATH)).toThrow(/not valid JSON/i);
    expect(() => parseModelsJson("[1,2,3]", PATH)).toThrow(/JSON object/i);
  });

  it("removes an entry without disturbing the rest", () => {
    const withTwo = upsertCustomProvider(
      null,
      "keep",
      validateCustomProvider({ ...INPUT, id: "keep" }),
      PATH,
    );
    const withBoth = upsertCustomProvider(
      withTwo,
      "drop",
      validateCustomProvider({ ...INPUT, id: "drop" }),
      PATH,
    );
    const parsed = JSON.parse(removeCustomProvider(withBoth, "drop", PATH)) as {
      providers: object;
    };
    expect(Object.keys(parsed.providers)).toEqual(["keep"]);
  });

  it("summarises providers without leaking a key", () => {
    const text = upsertCustomProvider(null, "my-gateway", validateCustomProvider(INPUT), PATH);
    const summaries = summarizeCustomProviders(text, PATH);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: "my-gateway",
      name: "My Gateway",
      hasApiKey: true,
      headerNames: ["x-tenant"],
      modelIds: ["gpt-5"],
    });
    expect(JSON.stringify(summaries)).not.toContain(SECRET);
  });
});

describe("providers.custom handler", () => {
  function store(overrides: Partial<CustomProviderStore> = {}): {
    store: CustomProviderStore;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      store: {
        list: async () => {
          calls.push("list");
          return [];
        },
        set: async (input) => {
          calls.push(`set:${input.id}`);
          return {
            id: input.id,
            name: input.name ?? input.id,
            baseUrl: input.baseUrl,
            api: input.api ?? null,
            modelIds: input.models.map((model) => model.id),
            hasApiKey: typeof input.apiKey === "string" && input.apiKey.length > 0,
            headerNames: Object.keys(input.headers ?? {}),
          };
        },
        remove: async (providerId) => {
          calls.push(`remove:${providerId}`);
        },
        ...overrides,
      },
    };
  }

  it("lists, sets and removes through the store", async () => {
    const { store: fake, calls } = store();
    const handlers = createCustomProviderHandlers({ resolveStore: () => fake });

    expect(await call(handlers, "providers.custom", { action: "list" })).toEqual({ providers: [] });
    const set = (await call(handlers, "providers.custom", { action: "set", provider: INPUT })) as {
      provider: { hasApiKey: boolean };
    };
    expect(set.provider.hasApiKey).toBe(true);
    expect(
      await call(handlers, "providers.custom", { action: "remove", providerId: "my-gateway" }),
    ).toEqual({
      removed: true,
      providerId: "my-gateway",
    });
    expect(calls).toEqual(["list", "set:my-gateway", "remove:my-gateway"]);
  });

  it("defaults to list and validates before reaching the store", async () => {
    const { store: fake, calls } = store();
    const handlers = createCustomProviderHandlers({ resolveStore: () => fake });
    await call(handlers, "providers.custom", {});
    await expect(
      call(handlers, "providers.custom", { action: "set", provider: { ...INPUT, baseUrl: "" } }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(call(handlers, "providers.custom", { action: "wat" })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(calls).toEqual(["list"]);
  });

  it("says so when the host cannot edit models.json", async () => {
    const handlers = createCustomProviderHandlers({ resolveStore: () => null });
    await expect(call(handlers, "providers.custom", { action: "list" })).rejects.toMatchObject({
      code: "not_implemented",
    });
  });
});
