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
