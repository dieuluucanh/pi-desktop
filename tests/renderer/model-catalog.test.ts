import { describe, expect, it } from "vitest";
import {
  authFor,
  contextUsageOf,
  filterModels,
  findExactModelEntry,
  formatTokens,
  groupByProvider,
  modelKeyOf,
  ringFraction,
  thinkingLevelsOf,
  toAuthBadge,
  toCatalog,
  toCatalogEntry,
  withFavoritesFirst,
  type ModelCatalogEntry,
} from "../../src/renderer/src/session/model-catalog";
import { contextFooterText } from "../../src/renderer/src/session/ComposerFooter";

/**
 * Model/usage helpers (plan step 8). Two things here are easy to get wrong and
 * are pinned deliberately: Pi's `contextUsage.percent` is 0–100 (not a fraction),
 * and a scoped model arrives wrapped as `{ model, thinkingLevel? }`.
 */

describe("the catalog", () => {
  it("normalises a bare model into a stable key", () => {
    const entry = toCatalogEntry({
      id: "claude-sonnet-4-5",
      provider: "anthropic",
      name: "Sonnet 4.5",
    });
    expect(entry).toMatchObject({
      key: "anthropic/claude-sonnet-4-5",
      id: "claude-sonnet-4-5",
      provider: "anthropic",
      label: "Sonnet 4.5",
    });
  });

  it("unwraps a scoped model and keeps its thinking level", () => {
    const entry = toCatalogEntry({
      model: { id: "gpt-5", provider: "openai", name: "GPT-5" },
      thinkingLevel: "high",
    });
    expect(entry).toMatchObject({
      key: "openai/gpt-5",
      label: "GPT-5",
      thinkingLevel: "high",
      // The raw payload sent back to model.set is the model, not the wrapper.
      raw: { id: "gpt-5", provider: "openai", name: "GPT-5" },
    });
  });

  it("falls back to the id as a label and rejects entries without identity", () => {
    expect(toCatalogEntry({ id: "x", provider: "p" })?.label).toBe("x");
    expect(toCatalogEntry({ id: "x" })).toBeNull();
    expect(toCatalogEntry({ provider: "p" })).toBeNull();
    expect(toCatalogEntry("nope")).toBeNull();
  });

  it("drops duplicates and malformed entries", () => {
    const catalog = toCatalog([
      { id: "a", provider: "p" },
      { id: "a", provider: "p" },
      { id: "b", provider: "p" },
      null,
      {},
    ]);
    expect(catalog.map((entry) => entry.key)).toEqual(["p/a", "p/b"]);
  });

  it("groups by provider with that provider's auth badge", () => {
    const catalog = toCatalog([
      { id: "a", provider: "zeta" },
      { id: "b", provider: "alpha" },
      { id: "c", provider: "alpha" },
    ]);
    const groups = groupByProvider(catalog, { alpha: { configured: true, source: "stored" } });
    expect(groups.map((group) => group.provider)).toEqual(["alpha", "zeta"]);
    expect(groups[0]?.auth.configured).toBe(true);
    expect(groups[1]?.auth.configured).toBe(false);
    expect(groups[0]?.models.map((entry) => entry.key)).toEqual(["alpha/b", "alpha/c"]);
  });

  it("matches a search against the label and the provider/id key", () => {
    const catalog = toCatalog([
      { id: "claude-sonnet-4-5", provider: "anthropic", name: "Sonnet 4.5" },
      { id: "gpt-5", provider: "openai", name: "GPT-5" },
    ]);
    expect(filterModels(catalog, "sonnet").map((entry) => entry.id)).toEqual(["claude-sonnet-4-5"]);
    expect(filterModels(catalog, "openai").map((entry) => entry.id)).toEqual(["gpt-5"]);
    expect(filterModels(catalog, "")).toHaveLength(2);
  });

  it("finds an exact model reference, and a bare id only when unambiguous", () => {
    const entries = toCatalog([
      { id: "gpt-5", provider: "openai" },
      { id: "shared", provider: "openai" },
      { id: "shared", provider: "anthropic" },
    ]);

    expect(findExactModelEntry(entries, "openai/gpt-5")?.id).toBe("gpt-5");
    expect(findExactModelEntry(entries, "gpt-5")?.id).toBe("gpt-5");
    expect(findExactModelEntry(entries, "shared")).toBeNull();
    expect(findExactModelEntry(entries, "nope")).toBeNull();
    expect(findExactModelEntry(entries, " ")).toBeNull();
  });

  it("puts favourites first, in the user's order", () => {
    const catalog = toCatalog([
      { id: "a", provider: "p" },
      { id: "b", provider: "p" },
      { id: "c", provider: "p" },
    ]);
    const split = withFavoritesFirst(catalog, ["p/c", "p/a"]);
    expect(split.favorites.map((entry) => entry.key)).toEqual(["p/c", "p/a"]);
    expect(split.others.map((entry) => entry.key)).toEqual(["p/b"]);
  });

  it("ignores a favourite whose model is not in the catalog", () => {
    const catalog = toCatalog([{ id: "a", provider: "p" }]);
    expect(withFavoritesFirst(catalog, ["gone/model"]).favorites).toEqual([]);
  });

  it("reads a model key from either spelling Pi uses", () => {
    expect(modelKeyOf({ id: "a", provider: "p" })).toBe("p/a");
    expect(modelKeyOf({ modelId: "a", providerId: "p" })).toBe("p/a");
    expect(modelKeyOf({ id: "a" })).toBeNull();
  });

  it("treats anything but an explicit true as not configured", () => {
    expect(toAuthBadge({ configured: true, source: "environment", label: "OPENAI_KEY" })).toEqual({
      configured: true,
      source: "environment",
      label: "OPENAI_KEY",
    });
    expect(toAuthBadge(undefined).configured).toBe(false);
    expect(toAuthBadge({ configured: "yes" }).configured).toBe(false);
    expect(authFor({ p: { configured: true } }, "p").configured).toBe(true);
    expect(authFor({}, "p").configured).toBe(false);
  });
});

describe("context usage (Pi reports 0-100)", () => {
  it("passes Pi's percentage through unchanged", () => {
    const usage = contextUsageOf({
      contextUsage: { tokens: 42_000, contextWindow: 100_000, percent: 42 },
    });
    expect(usage).toEqual({ tokens: 42_000, contextWindow: 100_000, percent: 42 });
    expect(ringFraction(usage)).toBeCloseTo(0.42);
  });

  it("keeps an unknown token count unknown rather than calling it zero", () => {
    const usage = contextUsageOf({
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    });
    expect(usage).toEqual({ tokens: null, contextWindow: 200_000, percent: null });
    expect(ringFraction(usage)).toBeNull();
  });

  it("clamps a fraction to the ring's range", () => {
    expect(ringFraction({ percent: 140, tokens: 1, contextWindow: 1 })).toBe(1);
    expect(ringFraction({ percent: -5, tokens: 1, contextWindow: 1 })).toBe(0);
    expect(ringFraction(null)).toBeNull();
    expect(contextUsageOf({})).toBeNull();
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(947)).toBe("947");
    expect(formatTokens(12_340)).toBe("12.3k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(null)).toBe("unknown");
  });

  it("renders the footer context line as a percentage, not a fraction times 100", () => {
    // Regression: Pi reports 42 meaning 42%, so the line must not read "4200%".
    // The line moved from the session header to the composer footer (2026-10-19
    // UI rework), so the guard moved with it.
    const line = contextFooterText({ tokens: 42_000, contextWindow: 100_000, percent: 42 }, 0.0432);
    expect(line).toBe("42% of 100.0k · 42.0k tokens · $0.0432");
  });

  it("reads thinking levels the host reported", () => {
    expect(thinkingLevelsOf({ thinkingLevels: ["off", "high"] })).toEqual(["off", "high"]);
    expect(thinkingLevelsOf({ thinkingLevels: ["off", 7] })).toEqual(["off"]);
    expect(thinkingLevelsOf({})).toEqual([]);
  });

  it("keeps the catalog entry type usable by the picker", () => {
    const entry: ModelCatalogEntry = toCatalogEntry({ id: "a", provider: "p" })!;
    expect(entry.label).toBe("a");
  });
});
