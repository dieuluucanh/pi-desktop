import { describe, expect, it } from "vitest";

import {
  isThinkingLevel,
  orderThinkingLevels,
  THINKING_DESCRIPTIONS,
  THINKING_FILL_LABELS,
  THINKING_LEVELS,
  thinkingFillLabel,
  thinkingFillStep,
  thinkingLevelOptions,
  thinkingLevelTitle,
} from "../../src/shared/thinking";

describe("thinking vocabulary", () => {
  it("is the one ordered level set", () => {
    expect([...THINKING_LEVELS]).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(isThinkingLevel("max")).toBe(true);
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel(null)).toBe(false);
  });

  it("describes every level", () => {
    for (const level of THINKING_LEVELS) {
      expect(THINKING_DESCRIPTIONS[level]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(THINKING_DESCRIPTIONS.max).toBe("Maximum reasoning effort");
  });

  it("maps levels to the fixed four-fill brain", () => {
    expect(thinkingFillStep("off")).toBe(0);
    expect(thinkingFillStep("minimal")).toBe(1);
    expect(thinkingFillStep("low")).toBe(1);
    expect(thinkingFillStep("medium")).toBe(2);
    expect(thinkingFillStep("high")).toBe(3);
    expect(thinkingFillStep("xhigh")).toBe(4);
    expect(thinkingFillStep("max")).toBe(4);
    expect(thinkingFillStep("custom")).toBe(0);
    expect(thinkingFillStep(null)).toBe(0);
    expect(THINKING_FILL_LABELS).toEqual(["empty", "1/4", "1/2", "3/4", "full"]);
    expect(thinkingFillLabel("high")).toBe("3/4");
  });

  it("orders a subset canonically and keeps unknown levels last", () => {
    expect(orderThinkingLevels(["max", "low", "custom-a", "off", "custom-b"])).toEqual([
      "off",
      "low",
      "max",
      "custom-a",
      "custom-b",
    ]);
    expect(orderThinkingLevels([])).toEqual([]);
  });

  it("returns the full scale with support flags per model", () => {
    expect(thinkingLevelOptions([])).toEqual(
      THINKING_LEVELS.map((level) => ({ level, supported: false })),
    );

    expect(thinkingLevelOptions(["off", "high"])).toEqual([
      { level: "off", supported: true },
      { level: "minimal", supported: false },
      { level: "low", supported: false },
      { level: "medium", supported: false },
      { level: "high", supported: true },
      { level: "xhigh", supported: false },
      { level: "max", supported: false },
    ]);

    // The host order is irrelevant; canonical order wins.
    expect(thinkingLevelOptions(["max", "low", "off"])).toEqual([
      { level: "off", supported: true },
      { level: "minimal", supported: false },
      { level: "low", supported: true },
      { level: "medium", supported: false },
      { level: "high", supported: false },
      { level: "xhigh", supported: false },
      { level: "max", supported: true },
    ]);
  });

  it("keeps a custom host level after the canonical scale, enabled", () => {
    expect(thinkingLevelOptions(["off", "ultra", "off"]).slice(-2)).toEqual([
      { level: "max", supported: false },
      { level: "ultra", supported: true },
    ]);
  });

  it("builds the composer tooltip with the exact level and model set", () => {
    expect(
      thinkingLevelTitle("max", ["off", "low", "high", "xhigh", "max"], "synthetic/deepseek"),
    ).toBe(
      [
        "Thinking: max (full)",
        "Maximum reasoning effort",
        "Model: synthetic/deepseek",
        "Supports: off, low, high, xhigh, max",
      ].join("\n"),
    );
    expect(thinkingLevelTitle("custom-level", ["off"])).toBe(
      ["Thinking: custom-level (empty)", "Custom level", "Supports: off"].join("\n"),
    );
    expect(thinkingLevelTitle(null)).toBe(
      ["Thinking level", "This model does not report a thinking level."].join("\n"),
    );
  });
});
