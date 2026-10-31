import { describe, expect, it } from "vitest";

import { supportedThinkingLevels, thinkingByModel } from "../../src/host/sdk/model-thinking";

/** The user's model entry: minimal/medium are explicitly unsupported. */
const DEEPSEEK = {
  provider: "synthetic",
  id: "hf:deepseek-ai/DeepSeek-V4.1-Flash",
  reasoning: true,
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
};

describe("supportedThinkingLevels", () => {
  it("uses Pi's thinkingLevelMap rules, including xhigh/max opt-ins", () => {
    expect(supportedThinkingLevels(DEEPSEEK)).toEqual(["off", "low", "high", "xhigh", "max"]);
  });

  it("offers only off for a non-reasoning model", () => {
    expect(supportedThinkingLevels({ provider: "p", id: "plain", reasoning: false })).toEqual([
      "off",
    ]);
  });

  it("returns an empty list for a malformed model", () => {
    expect(supportedThinkingLevels(null)).toEqual([]);
    expect(supportedThinkingLevels("nope")).toEqual([]);
    expect(supportedThinkingLevels({})).toEqual(["off"]);
  });
});

describe("thinkingByModel", () => {
  it("keys bare and scoped catalog rows by provider/id", () => {
    expect(
      thinkingByModel([
        DEEPSEEK,
        { model: { provider: "openai", id: "gpt-5", reasoning: false }, thinkingLevel: "high" },
        { provider: "broken" },
      ]),
    ).toEqual({
      "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash": ["off", "low", "high", "xhigh", "max"],
      "openai/gpt-5": ["off"],
    });
  });
});
