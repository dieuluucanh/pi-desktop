import { describe, expect, it } from "vitest";
import {
  createCustomProviderHandlers,
  parseModelsJson,
  removeCustomProvider,
  storedCustomProviderEntry,
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

  // The bug this feature fixes: a real gateway id such as the HuggingFace form
  // was rejected by a package-name charset that Pi itself does not apply.
  it("accepts the model ids Pi accepts, verbatim", () => {
    const entry = validateCustomProvider({
      ...INPUT,
      models: [
        { id: "hf:deepseek-ai/DeepSeek-V4.1-Flash" },
        { id: "~anthropic/claude-opus-latest" },
        { id: "@cf/meta/llama-3.1-8b-instruct" },
        { id: "openrouter/auto:exacto" },
        { id: ":free" },
      ],
    });
    expect(entry.models.map((model) => model.id)).toEqual([
      "hf:deepseek-ai/DeepSeek-V4.1-Flash",
      "~anthropic/claude-opus-latest",
      "@cf/meta/llama-3.1-8b-instruct",
      "openrouter/auto:exacto",
      ":free",
    ]);
  });

  it("trims a model id before storing it", () => {
    const entry = validateCustomProvider({ ...INPUT, models: [{ id: "  hf:deepseek-ai/x  " }] });
    expect(entry.models[0]?.id).toBe("hf:deepseek-ai/x");
  });

  it("names the model, not the provider, when a model id is bad", () => {
    // The two errors must stay distinguishable: "a provider id …" on a model id
    // sends the user to the wrong field.
    for (const id of ["gpt 5", "gpt\t5", "gpt-5,mini", "m".repeat(201)]) {
      expect(() => validateCustomProvider({ ...INPUT, models: [{ id }] }), id).toThrow(
        /^a model id/i,
      );
    }
  });

  it("still refuses provider ids Pi cannot reference", () => {
    for (const id of ["a/b", "__proto__", "constructor", ".", "..", "p".repeat(65), "a b"]) {
      expect(() => validateCustomProvider({ ...INPUT, id }), id).toThrow(/provider id/i);
    }
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

  // The second half of the bug: the sheet only renders a few fields, and the
  // old wholesale replace deleted everything else — including hand-written
  // provider config and the stored key (whose placeholder says "leave blank to
  // keep").
  describe("merging over an existing entry", () => {
    const handWritten = JSON.stringify({
      providers: {
        existing: {
          name: "Old name",
          baseUrl: "https://old.test/v1",
          api: "openai-responses",
          apiKey: SECRET,
          headers: { "x-tenant": "acme" },
          compat: { supportsReasoning: true },
          oauth: "radius",
          authHeader: false,
          modelOverrides: { "gpt-5": { name: "Renamed" } },
          models: [
            { id: "gpt-5", name: "GPT-5", cost: { input: 1, output: 2 }, reasoning: true },
            { id: "drop-me", name: "Gone" },
          ],
        },
      },
    });

    function upsert(text: string, patch: Record<string, unknown>): Record<string, unknown> {
      const next = upsertCustomProvider(
        text,
        "existing",
        validateCustomProvider({ ...INPUT, id: "existing", ...patch }),
        PATH,
      );
      return (JSON.parse(next) as { providers: Record<string, Record<string, unknown>> }).providers
        .existing as Record<string, unknown>;
    }

    it("preserves keys the editor does not render", () => {
      const entry = upsert(handWritten, {
        name: "New name",
        baseUrl: "https://new.test/v1",
        api: "openai-completions",
        models: [{ id: "gpt-5" }],
      });
      expect(entry.oauth).toBe("radius");
      expect(entry.authHeader).toBe(false);
      expect(entry.modelOverrides).toEqual({ "gpt-5": { name: "Renamed" } });
    });

    it("keeps the stored key when the input omits one", () => {
      // `INPUT` always carries a key, so drop it explicitly: this is the
      // "stored — leave blank to keep" promise the placeholder makes.
      const next = upsertCustomProvider(
        handWritten,
        "existing",
        validateCustomProvider({ ...INPUT, id: "existing", apiKey: undefined }),
        PATH,
      );
      const entry = (JSON.parse(next) as { providers: Record<string, Record<string, unknown>> })
        .providers.existing as Record<string, unknown>;
      expect(entry.apiKey).toBe(SECRET);
    });

    it("lets a submitted key overwrite the stored one", () => {
      const entry = upsert(handWritten, { apiKey: "sk-replaced" });
      expect(entry.apiKey).toBe("sk-replaced");
    });

    it("lets the input overwrite headers and compat, and preserves them when absent", () => {
      // headers/compat are real input fields, so present wins...
      expect(upsert(handWritten, { headers: { "x-new": "1" } }).headers).toEqual({ "x-new": "1" });
      expect(upsert(handWritten, { compat: { streamUsage: true } }).compat).toEqual({
        streamUsage: true,
      });
      // ...while absent preserves what is on disk (clearing is a hand-edit).
      expect(upsert(handWritten, { headers: undefined }).headers).toEqual({ "x-tenant": "acme" });
      expect(upsert(handWritten, { compat: undefined }).compat).toEqual({
        supportsReasoning: true,
      });
    });

    it("merges models by id, keeping unrendered per-model keys", () => {
      const entry = upsert(handWritten, { models: [{ id: "gpt-5", contextWindow: 128_000 }] });
      expect(entry.models).toEqual([
        {
          id: "gpt-5",
          name: "GPT-5",
          cost: { input: 1, output: 2 },
          reasoning: true,
          contextWindow: 128_000,
        },
      ]);
    });

    it("removes a model id that the input no longer lists, in input order", () => {
      const entry = upsert(handWritten, { models: [{ id: "new-a" }, { id: "gpt-5" }] });
      expect((entry.models as Array<{ id: string }>).map((model) => model.id)).toEqual([
        "new-a",
        "gpt-5",
      ]);
    });

    it("clears a rendered scalar when the input omits it", () => {
      const entry = upsert(handWritten, { name: undefined, api: undefined });
      expect("name" in entry).toBe(false);
      expect("api" in entry).toBe(false);
    });

    it("applies the same merge through storedCustomProviderEntry after a reload", () => {
      const text = upsertCustomProvider(
        handWritten,
        "existing",
        validateCustomProvider({ ...INPUT, id: "existing", apiKey: undefined }),
        PATH,
      );
      const stored = storedCustomProviderEntry(text, PATH, "existing") as {
        apiKey?: string;
        oauth?: string;
      };
      expect(stored.apiKey).toBe(SECRET);
      expect(stored.oauth).toBe("radius");
      expect(storedCustomProviderEntry(text, PATH, "missing")).toBeUndefined();
    });
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
