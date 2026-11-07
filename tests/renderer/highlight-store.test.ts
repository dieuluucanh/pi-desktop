import { describe, expect, it } from "vitest";
import {
  createHighlightStore,
  type HighlightLines,
  type HighlighterLike,
} from "../../src/renderer/src/session/highlight-store";

/**
 * Unit contract for the transcript's token cache
 * (2026-11-07 transcript-highlight-stability).
 *
 * The store is pure: a fake highlighter is injected, so these tests pin the
 * timing/bounding rules that make a remounted code block paint colour, without
 * waiting on Shiki's real grammars.
 */

interface FakeHighlighter {
  highlighter: HighlighterLike;
  loadLanguage: string[];
  tokenized: string[];
}

function fakeHighlighter(
  options: {
    failLanguageOnce?: boolean;
    throwOnce?: boolean;
  } = {},
): FakeHighlighter {
  const loadLanguage: string[] = [];
  const tokenized: string[] = [];
  let failedLanguage = false;
  let threw = false;
  return {
    loadLanguage,
    tokenized,
    highlighter: {
      async loadLanguage(language: string) {
        loadLanguage.push(language);
        if (options.failLanguageOnce && !failedLanguage) {
          failedLanguage = true;
          throw new Error(`no grammar for ${language}`);
        }
      },
      codeToTokens(code: string) {
        if (options.throwOnce && !threw) {
          threw = true;
          throw new Error("tokenizer exploded");
        }
        tokenized.push(code);
        return {
          tokens: code.split("\n").map((line) => [{ content: line, color: "#ff0000" }]),
        };
      },
    },
  };
}

function storeFor(fake: FakeHighlighter, options = {}) {
  return createHighlightStore(async () => fake.highlighter, options);
}

function textOf(lines: HighlightLines | null): string {
  return (lines ?? []).map((line) => line.map((token) => token.content).join("")).join("\n");
}

describe("cache", () => {
  it("returns the cached lines for a key and does not tokenize again", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);

    const first = await store.load("ts\u0000const a = 1;", "const a = 1;", "ts");
    const second = await store.load("ts\u0000const a = 1;", "const a = 1;", "ts");

    expect(textOf(first)).toBe("const a = 1;");
    expect(second).toBe(first);
    expect(fake.tokenized).toEqual(["const a = 1;"]);
    expect(store.cached("ts\u0000const a = 1;")).toBe(first);
  });

  it("never tokenizes from cached()", () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);

    expect(store.cached("nothing")).toBeNull();
    expect(fake.tokenized).toEqual([]);
  });

  it("dedupes concurrent loads for the same key", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);

    const [left, right] = await Promise.all([
      store.load("k", "shared code", "ts"),
      store.load("k", "shared code", "ts"),
    ]);

    expect(left).toBe(right);
    expect(fake.tokenized).toEqual(["shared code"]);
  });

  it("loads one grammar for several blocks with the same language", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);

    await Promise.all([
      store.load("a", "one", "shellscript"),
      store.load("b", "two", "shellscript"),
      store.load("c", "three", "shellscript"),
    ]);

    expect(fake.loadLanguage).toEqual(["shellscript"]);
  });
});

describe("synchronous warm path", () => {
  it("returns null before the highlighter and grammar are ready", () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);

    expect(store.sync("k", "const a = 1;", "ts")).toBeNull();
    expect(fake.tokenized).toEqual([]);
  });

  it("tokenizes synchronously once a grammar is warm", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);

    await store.load("warm", "const a = 1;", "ts");
    // A different key with the same warm language is the remount case: the
    // first paint must already have tokens.
    const immediate = store.sync("fresh", "let b = 2;", "ts");

    expect(textOf(immediate)).toBe("let b = 2;");
    expect(fake.tokenized).toContain("let b = 2;");
  });

  it("does not tokenize a block above maxSyncChars", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake, { maxSyncChars: 4 });
    await store.load("warm", "ok", "ts");

    expect(store.sync("big", "far too long", "ts")).toBeNull();
  });

  it("returns the cached lines before trying to tokenize", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);
    const loaded = await store.load("k", "cached", "ts");

    expect(store.sync("k", "cached", "ts")).toBe(loaded);
    expect(fake.tokenized).toEqual(["cached"]);
  });
});

describe("bounds", () => {
  it("evicts the oldest entry when maxEntries is exceeded", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake, { maxEntries: 2 });

    await store.load("one", "1", "ts");
    await store.load("two", "2", "ts");
    await store.load("three", "3", "ts");

    expect(store.cached("one")).toBeNull();
    expect(store.cached("two")).not.toBeNull();
    expect(store.cached("three")).not.toBeNull();
  });

  it("evicts oldest entries to stay inside maxChars", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake, { maxChars: 10 });

    await store.load("one", "aaaa", "ts");
    await store.load("two", "bbbb", "ts");
    await store.load("three", "cccc", "ts");

    expect(store.cached("one")).toBeNull();
    expect(store.cached("two")).not.toBeNull();
    expect(store.cached("three")).not.toBeNull();
  });

  it("refuses to cache an oversized block and keeps the resident entries", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake, { maxChars: 10 });
    await store.load("one", "aaaa", "ts");
    await store.load("two", "bbbb", "ts");

    const oversized = "x".repeat(20);
    const lines = await store.load("huge", oversized, "ts");

    expect(textOf(lines)).toBe(oversized);
    expect(store.cached("huge")).toBeNull();
    expect(store.cached("one")).not.toBeNull();
    expect(store.cached("two")).not.toBeNull();
  });
});

describe("failures", () => {
  it("resolves null when the grammar fails, then retries on the next load", async () => {
    const fake = fakeHighlighter({ failLanguageOnce: true });
    const store = storeFor(fake);

    expect(await store.load("k", "const a = 1;", "ts")).toBeNull();
    const retried = await store.load("k", "const a = 1;", "ts");

    expect(textOf(retried)).toBe("const a = 1;");
    expect(fake.loadLanguage).toEqual(["ts", "ts"]);
  });

  it("resolves null when tokenizing throws, then retries on the next load", async () => {
    const fake = fakeHighlighter({ throwOnce: true });
    const store = storeFor(fake);

    expect(await store.load("k", "const a = 1;", "ts")).toBeNull();
    const retried = await store.load("k", "const a = 1;", "ts");

    expect(textOf(retried)).toBe("const a = 1;");
    expect(fake.tokenized).toEqual(["const a = 1;"]);
  });

  it("resolves null and never retries when the highlighter cannot load", async () => {
    let loads = 0;
    const store = createHighlightStore(async () => {
      loads += 1;
      return null;
    });

    expect(await store.load("k", "code", "ts")).toBeNull();
    expect(await store.load("k", "code", "ts")).toBeNull();
    // The shared start promise is reused, so a missing Shiki is not re-imported
    // for every code block in the session.
    expect(loads).toBe(1);
  });
});

describe("reset", () => {
  it("drops tokens and grammar readiness so a load starts over", async () => {
    const fake = fakeHighlighter();
    const store = storeFor(fake);

    await store.load("k", "const a = 1;", "ts");
    expect(store.cached("k")).not.toBeNull();

    store.reset();

    expect(store.cached("k")).toBeNull();
    expect(store.sync("k", "const a = 1;", "ts")).toBeNull();

    await store.load("k", "const a = 1;", "ts");
    expect(fake.loadLanguage).toEqual(["ts", "ts"]);
  });
});
