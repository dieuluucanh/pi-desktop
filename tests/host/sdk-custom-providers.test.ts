import { describe, expect, it, vi } from "vitest";
import type { ModelsFileIo } from "../../src/host/custom-providers";
import { createSdkCustomProviderStore } from "../../src/host/sdk/custom-providers";

/**
 * The SDK custom-gateway store (plan step 9, slice 5).
 *
 * The write is verified before it is kept: if Pi cannot load the entry, the
 * previous bytes are restored, so a typo in `models.json` cannot break the
 * profile. The verifier is injected so this stays a unit test.
 */

const PATH = "C:\\profile\\models.json";
const SECRET = "sk-gateway-secret-value";

function memoryIo(initial: string | null = null) {
  let current = initial;
  let writes = 0;
  let deletes = 0;
  const io: ModelsFileIo = {
    read: async () => current,
    write: async (_path, text) => {
      writes += 1;
      current = text;
    },
    delete: async () => {
      deletes += 1;
      current = null;
    },
  };
  return {
    io,
    text: () => current,
    counts: () => ({ writes, deletes }),
  };
}

const INPUT = {
  id: "my-gateway",
  name: "My Gateway",
  baseUrl: "https://gateway.example.com/v1",
  api: "openai-completions",
  apiKey: SECRET,
  models: [{ id: "gpt-5" }],
};

describe("createSdkCustomProviderStore", () => {
  it("reads existing entries without exposing the key", async () => {
    const memory = memoryIo(
      JSON.stringify({
        providers: { a: { baseUrl: "https://a.test", apiKey: SECRET, models: [{ id: "m" }] } },
      }),
    );
    const store = createSdkCustomProviderStore({
      modelsPath: PATH,
      io: memory.io,
      verify: async () => true,
    });
    const providers = await store.list();
    expect(providers).toEqual([
      {
        id: "a",
        name: "a",
        baseUrl: "https://a.test",
        api: null,
        modelIds: ["m"],
        hasApiKey: true,
        headerNames: [],
      },
    ]);
    expect(JSON.stringify(providers)).not.toContain(SECRET);
  });

  it("writes an entry, verifies it and returns a redacted summary", async () => {
    const memory = memoryIo();
    const verify = vi.fn(async () => true);
    const store = createSdkCustomProviderStore({ modelsPath: PATH, io: memory.io, verify });

    const summary = await store.set(INPUT);
    expect(verify).toHaveBeenCalledWith(PATH, "my-gateway");
    expect(summary).toMatchObject({ id: "my-gateway", hasApiKey: true, modelIds: ["gpt-5"] });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(memory.text()).toContain("my-gateway");
    expect(memory.text()).toContain(SECRET);
  });

  it("restores the previous bytes when Pi cannot load the entry", async () => {
    const original = JSON.stringify({ providers: { keep: { baseUrl: "https://keep.test" } } });
    const memory = memoryIo(original);
    const store = createSdkCustomProviderStore({
      modelsPath: PATH,
      io: memory.io,
      verify: async () => false,
    });

    await expect(store.set(INPUT)).rejects.toMatchObject({ code: "validation_failed" });
    expect(memory.text()).toBe(original);
  });

  // The summary must describe the file after the merge, not the input: an edit
  // keeps unrendered keys and (when the field is blank) the stored key.
  describe("summarizing the stored entry", () => {
    const HAND_WRITTEN = JSON.stringify({
      providers: {
        "my-gateway": {
          name: "Old",
          baseUrl: "https://old.test/v1",
          apiKey: SECRET,
          headers: { "x-tenant": "acme" },
          compat: { supportsReasoning: true },
          modelOverrides: { "gpt-5": { name: "Renamed" } },
          models: [{ id: "gpt-5", cost: { input: 1, output: 2 } }],
        },
      },
    });

    it("keeps unrendered keys and the stored key when the input omits them", async () => {
      const memory = memoryIo(HAND_WRITTEN);
      const store = createSdkCustomProviderStore({
        modelsPath: PATH,
        io: memory.io,
        verify: async () => true,
      });

      const summary = await store.set({
        ...INPUT,
        name: "Updated",
        baseUrl: "https://new.test/v1",
        apiKey: undefined,
      });

      const stored = (
        JSON.parse(memory.text()!) as { providers: Record<string, Record<string, unknown>> }
      ).providers["my-gateway"] as Record<string, unknown>;
      expect(stored.modelOverrides).toEqual({ "gpt-5": { name: "Renamed" } });
      expect(stored.compat).toEqual({ supportsReasoning: true });
      expect(stored.apiKey).toBe(SECRET);
      // The summary reflects the file, so the kept key still reads as stored…
      expect(summary).toMatchObject({ name: "Updated", baseUrl: "https://new.test/v1" });
      expect(summary.hasApiKey).toBe(true);
      expect(summary.headerNames).toEqual(["x-tenant"]);
      // …and it still never carries the key itself.
      expect(JSON.stringify(summary)).not.toContain(SECRET);
    });

    it("reports a rich model id verbatim from the file", async () => {
      const memory = memoryIo(null);
      const store = createSdkCustomProviderStore({
        modelsPath: PATH,
        io: memory.io,
        verify: async () => true,
      });

      const summary = await store.set({
        ...INPUT,
        id: "hf-router",
        models: [{ id: "hf:deepseek-ai/DeepSeek-V4.1-Flash" }],
      });

      expect(memory.text()).toContain("hf:deepseek-ai/DeepSeek-V4.1-Flash");
      expect(summary.modelIds).toEqual(["hf:deepseek-ai/DeepSeek-V4.1-Flash"]);
    });

    it("still reverts when the merged entry cannot load", async () => {
      // The merge can change what Pi sees (e.g. a stale unrendered `oauth`), so
      // the revert path has to cover it: the file goes back untouched.
      const memory = memoryIo(HAND_WRITTEN);
      const store = createSdkCustomProviderStore({
        modelsPath: PATH,
        io: memory.io,
        verify: async () => false,
      });

      await expect(
        store.set({ ...INPUT, name: "Updated", apiKey: undefined }),
      ).rejects.toMatchObject({ code: "validation_failed" });
      expect(memory.text()).toBe(HAND_WRITTEN);
    });
  });

  it("removes the file again when a first-ever write fails verification", async () => {
    const memory = memoryIo(null);
    const store = createSdkCustomProviderStore({
      modelsPath: PATH,
      io: memory.io,
      verify: async () => false,
    });
    await expect(store.set(INPUT)).rejects.toMatchObject({ code: "validation_failed" });
    expect(memory.text()).toBeNull();
    expect(memory.counts().deletes).toBe(1);
  });

  it("leaves a malformed file alone", async () => {
    const memory = memoryIo("{ broken");
    const store = createSdkCustomProviderStore({
      modelsPath: PATH,
      io: memory.io,
      verify: async () => true,
    });
    await expect(store.set(INPUT)).rejects.toMatchObject({ code: "parse_failed" });
    expect(memory.counts().writes).toBe(0);
    expect(memory.text()).toBe("{ broken");
  });

  it("removes an entry and is a no-op on a missing file", async () => {
    const memory = memoryIo(
      JSON.stringify({
        providers: { a: { baseUrl: "https://a.test" }, b: { baseUrl: "https://b.test" } },
      }),
    );
    const store = createSdkCustomProviderStore({
      modelsPath: PATH,
      io: memory.io,
      verify: async () => true,
    });
    await store.remove("a");
    expect(Object.keys((JSON.parse(memory.text()!) as { providers: object }).providers)).toEqual([
      "b",
    ]);

    const empty = memoryIo(null);
    const other = createSdkCustomProviderStore({
      modelsPath: PATH,
      io: empty.io,
      verify: async () => true,
    });
    await other.remove("a");
    expect(empty.counts().writes).toBe(0);
  });
});
