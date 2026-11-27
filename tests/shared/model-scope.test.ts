import { describe, expect, it } from "vitest";
import {
  SCOPE_PATTERN_LIMIT,
  SCOPE_PATTERN_MAX_LENGTH,
  effectiveScopePatterns,
  hasExactScopeRef,
  isScopeThinkingLevel,
  materialiseScopePatterns,
  nextScopePatterns,
  normalizeScopePatterns,
  parseScopePattern,
  scopeKeyOf,
  scopeKeys,
  scopePatternFor,
  scopeStarKeys,
  scopeWriteTarget,
  toggleScopeKey,
} from "../../src/shared/model-scope";

/** A live `ScopedModel` entry as the SDK reports it. */
function scoped(provider: string, id: string, thinkingLevel?: string) {
  return {
    model: { provider, id },
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

describe("model scope helpers", () => {
  describe("normalizeScopePatterns", () => {
    it("keeps trimmed non-empty strings, in order, without duplicates", () => {
      expect(
        normalizeScopePatterns([
          " anthropic/claude ",
          "",
          "   ",
          42,
          null,
          "anthropic/claude",
          "openai/gpt-5",
        ]),
      ).toEqual(["anthropic/claude", "openai/gpt-5"]);
    });

    it("ignores a non-list value", () => {
      expect(normalizeScopePatterns(undefined)).toEqual([]);
      expect(normalizeScopePatterns("anthropic/claude")).toEqual([]);
      expect(normalizeScopePatterns({ 0: "anthropic/claude" })).toEqual([]);
    });

    it("drops an over-long pattern and caps the list", () => {
      const long = `provider/${"x".repeat(SCOPE_PATTERN_MAX_LENGTH)}`;
      expect(normalizeScopePatterns([long, "provider/ok"])).toEqual(["provider/ok"]);

      const many = Array.from({ length: SCOPE_PATTERN_LIMIT + 50 }, (_, index) => `p/m${index}`);
      expect(normalizeScopePatterns(many)).toHaveLength(SCOPE_PATTERN_LIMIT);
    });
  });

  describe("effectiveScopePatterns", () => {
    it("prefers the project list when the project defines one", () => {
      expect(
        effectiveScopePatterns({
          global: { enabledModels: ["global/a"] },
          project: { enabledModels: ["project/b"] },
        }),
      ).toEqual(["project/b"]);
    });

    it("treats an explicit empty project list as 'no scope' (it still wins)", () => {
      expect(
        effectiveScopePatterns({
          global: { enabledModels: ["global/a"] },
          project: { enabledModels: [] },
        }),
      ).toEqual([]);
    });

    it("falls back to global when the project value is malformed", () => {
      expect(
        effectiveScopePatterns({
          global: { enabledModels: ["global/a"] },
          project: { enabledModels: "project/b" },
        }),
      ).toEqual(["global/a"]);
    });

    it("reads global when the project has no key, and handles empty docs", () => {
      expect(effectiveScopePatterns({ global: { enabledModels: ["global/a"] } })).toEqual([
        "global/a",
      ]);
      expect(effectiveScopePatterns({})).toEqual([]);
      expect(effectiveScopePatterns({ global: null, project: null })).toEqual([]);
    });
  });

  describe("scopeWriteTarget", () => {
    it("writes the document that currently defines the effective value", () => {
      expect(scopeWriteTarget({ project: { enabledModels: [] } })).toBe("project");
      expect(scopeWriteTarget({ project: { enabledModels: ["a/b"] } })).toBe("project");
      expect(scopeWriteTarget({ global: { enabledModels: ["a/b"] }, project: {} })).toBe("global");
    });

    it("treats a malformed project key as present (so the edit repairs it there)", () => {
      expect(scopeWriteTarget({ project: { enabledModels: "not-a-list" } })).toBe("project");
    });

    it("honours an explicit target from the project settings toggle", () => {
      expect(scopeWriteTarget({ project: { enabledModels: ["a/b"] } }, "global")).toBe("global");
      expect(scopeWriteTarget({ global: { enabledModels: ["a/b"] } }, "project")).toBe("project");
    });
  });

  describe("scopeStarKeys", () => {
    it("keeps resolved models first and adds exact persisted refs", () => {
      expect(
        scopeStarKeys(["openai/gpt-5", "offline/gone"], [scoped("anthropic", "claude")]),
      ).toEqual(["anthropic/claude", "openai/gpt-5", "offline/gone"]);
    });

    it("dedupes case-insensitively and ignores globs/bare ids", () => {
      expect(
        scopeStarKeys(
          ["OpenAI/GPT-5", "openai/*", "gpt-5", "openai/gpt-5:high"],
          [scoped("openai", "gpt-5")],
        ),
      ).toEqual(["openai/gpt-5"]);
    });

    it("returns an empty list for an empty scope", () => {
      expect(scopeStarKeys([], [])).toEqual([]);
      expect(scopeStarKeys(undefined, [])).toEqual([]);
    });
  });

  describe("hasExactScopeRef", () => {
    it("matches a bare ref case-insensitively", () => {
      expect(hasExactScopeRef(["OpenAI/GPT-5"], "openai/gpt-5")).toBe(true);
      expect(hasExactScopeRef(["openai/gpt-5"], "openai/gpt-5")).toBe(true);
    });

    it("does not treat a thinking suffix or a glob as the bare ref", () => {
      expect(hasExactScopeRef(["openai/gpt-5:high"], "openai/gpt-5")).toBe(false);
      expect(hasExactScopeRef(["openai/*"], "openai/gpt-5")).toBe(false);
      expect(hasExactScopeRef([], "openai/gpt-5")).toBe(false);
      expect(hasExactScopeRef(["openai/gpt-5"], "  ")).toBe(false);
    });
  });

  describe("scopeKeys", () => {
    it("unwraps SDK scoped entries and accepts bare model objects", () => {
      expect(
        scopeKeys([
          { model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" },
          { provider: "openai", id: "gpt-5" },
          { model: { providerId: "custom", modelId: "m1" } },
        ]),
      ).toEqual(["anthropic/claude", "openai/gpt-5", "custom/m1"]);
    });

    it("dedupes and skips malformed entries", () => {
      expect(
        scopeKeys([
          { model: { provider: "a", id: "b" } },
          { model: { provider: "a", id: "b" } },
          { model: { provider: "a" } },
          { model: { id: "b" } },
          {},
          null,
        ]),
      ).toEqual(["a/b"]);
    });

    it("returns an empty list for a non-list", () => {
      expect(scopeKeys(undefined as never)).toEqual([]);
      expect(scopeKeys([])).toEqual([]);
    });
  });

  describe("materialiseScopePatterns", () => {
    it("keeps a pinned thinking level in the pattern", () => {
      expect(
        materialiseScopePatterns([
          scoped("anthropic", "claude", "high"),
          scoped("openai", "gpt-5"),
        ]),
      ).toEqual([
        { ref: "anthropic/claude", pattern: "anthropic/claude:high", thinkingLevel: "high" },
        { ref: "openai/gpt-5", pattern: "openai/gpt-5" },
      ]);
    });

    it("ignores an unknown thinking level (Pi would not parse it)", () => {
      expect(materialiseScopePatterns([scoped("a", "b", "turbo")])).toEqual([
        { ref: "a/b", pattern: "a/b" },
      ]);
    });

    it("keeps the first entry per ref", () => {
      const entries = materialiseScopePatterns([scoped("a", "b", "low"), scoped("a", "b", "high")]);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.pattern).toBe("a/b:low");
    });
  });

  describe("parseScopePattern", () => {
    it("returns the exact ref for a canonical pattern", () => {
      expect(parseScopePattern("anthropic/claude-sonnet-4-5")).toEqual({
        ref: "anthropic/claude-sonnet-4-5",
      });
    });

    it("strips a valid thinking suffix", () => {
      expect(parseScopePattern("anthropic/claude:high")).toEqual({
        ref: "anthropic/claude",
        thinkingLevel: "high",
      });
    });

    it("does not mistake a colon inside a model id for a thinking level", () => {
      expect(parseScopePattern("synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toEqual({
        ref: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
      });
      expect(parseScopePattern("provider/hf:foo:low")).toEqual({
        ref: "provider/hf:foo",
        thinkingLevel: "low",
      });
    });

    it("has no ref for globs, bare ids and empty patterns", () => {
      expect(parseScopePattern("opencode/*")).toEqual({ ref: null });
      expect(parseScopePattern("gpt-5")).toEqual({ ref: null });
      expect(parseScopePattern("-claude*")).toEqual({ ref: null });
      expect(parseScopePattern("provider/[abc]")).toEqual({ ref: null });
      expect(parseScopePattern("  ")).toEqual({ ref: null });
    });
  });

  describe("toggleScopeKey", () => {
    it("appends when enabling and preserves the existing order", () => {
      expect(toggleScopeKey(["a/b", "c/d"], "e/f", true)).toEqual(["a/b", "c/d", "e/f"]);
      expect(toggleScopeKey(["a/b", "c/d"], "a/b", true)).toEqual(["c/d", "a/b"]);
    });

    it("removes when disabling", () => {
      expect(toggleScopeKey(["a/b", "c/d", "e/f"], "c/d", false)).toEqual(["a/b", "e/f"]);
      expect(toggleScopeKey(["a/b"], "e/f", false)).toEqual(["a/b"]);
    });

    it("dedupes the input", () => {
      expect(toggleScopeKey(["a/b", "a/b", "c/d"], "a/b", false)).toEqual(["c/d"]);
    });
  });

  describe("scopePatternFor (2026-11-06 plan, step 10)", () => {
    it("writes an exact ref and a thinking suffix the parser reads back", () => {
      expect(scopePatternFor("a", "one")).toEqual({ ok: true, pattern: "a/one" });
      expect(scopePatternFor("a", "one", "high")).toEqual({ ok: true, pattern: "a/one:high" });
    });

    it("refuses an id whose colon Pi would read as a thinking level", () => {
      // The exact ref from the 2026-11-06 host logs.
      expect(scopePatternFor("synthetic", "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toEqual({
        ok: false,
        reason: "unrepresentable",
      });
    });

    it("a star click on an unrepresentable id writes nothing and reports it", () => {
      const id = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
      const result = nextScopePatterns({
        baseScoped: [scoped("a", "one")],
        preserved: [],
        provider: "synthetic",
        id,
        enabled: true,
      });

      expect(result.patterns).toEqual(["a/one"]);
      expect(result.rejected).toEqual([{ ref: `synthetic/${id}`, pattern: `synthetic/${id}` }]);
    });
  });

  describe("nextScopePatterns", () => {
    it("disabling one model materialises the rest of the live scope", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one", "high"), scoped("b", "two")],
          preserved: [],
          provider: "a",
          id: "one",
          enabled: false,
        }).patterns,
      ).toEqual(["b/two"]);
    });

    it("enabling a new model appends it and keeps pinned levels of existing entries", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one", "high")],
          preserved: [],
          provider: "c",
          id: "three",
          enabled: true,
        }).patterns,
      ).toEqual(["a/one:high", "c/three"]);
    });

    it("keeps patterns that matched nothing", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one")],
          preserved: ["offline/*", "gone/model"],
          provider: "a",
          id: "one",
          enabled: false,
        }).patterns,
      ).toEqual(["offline/*", "gone/model"]);
    });

    it("removing the last model with nothing preserved means 'no scope'", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one")],
          preserved: [],
          provider: "a",
          id: "one",
          enabled: false,
        }).patterns,
      ).toBeUndefined();
    });

    it("keeps a preserved pattern even when the last live model is removed", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one")],
          preserved: ["offline/*"],
          provider: "a",
          id: "one",
          enabled: false,
        }).patterns,
      ).toEqual(["offline/*"]);
    });

    it("does not duplicate a preserved pattern that is already explicit", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one")],
          preserved: ["a/one"],
          provider: "b",
          id: "two",
          enabled: true,
        }).patterns,
      ).toEqual(["a/one", "b/two"]);
    });

    it("stars every model as an explicit list rather than collapsing to no scope", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one")],
          preserved: [],
          provider: "b",
          id: "two",
          enabled: true,
        }).patterns,
      ).toEqual(["a/one", "b/two"]);
    });

    it("a disabled key that was never in scope is a re-normalisation", () => {
      expect(
        nextScopePatterns({
          baseScoped: [scoped("a", "one")],
          preserved: [],
          provider: "b",
          id: "two",
          enabled: false,
        }).patterns,
      ).toEqual(["a/one"]);
    });
  });

  describe("small helpers", () => {
    it("formats the catalog key", () => {
      expect(scopeKeyOf("opencode-go", "deepseek-v4.1-flash")).toBe(
        "opencode-go/deepseek-v4.1-flash",
      );
    });

    it("recognises only Pi's thinking levels", () => {
      expect(isScopeThinkingLevel("high")).toBe(true);
      expect(isScopeThinkingLevel("max")).toBe(true);
      expect(isScopeThinkingLevel("turbo")).toBe(false);
      expect(isScopeThinkingLevel("")).toBe(false);
    });
  });
});
