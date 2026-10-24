import { describe, expect, it } from "vitest";

import {
  appArgumentItems,
  completeLoginArgument,
  completeModelArgument,
  completeThinkingArgument,
} from "../../src/renderer/src/completion/app-arguments";
import type { ModelCatalogEntry } from "../../src/renderer/src/session/model-catalog";
import type { ProviderSummary } from "../../src/shared/providers";

/** App-owned argument completions for /model, /thinking and /login. */

function model(provider: string, id: string): ModelCatalogEntry {
  return {
    key: `${provider}/${id}`,
    id,
    provider,
    label: id,
    raw: { provider, id },
  };
}

const MODELS = [model("openai", "gpt-5"), model("anthropic", "claude-sonnet")];
const LEVELS = ["off", "low", "medium", "high"];
const PROVIDERS: ProviderSummary[] = [
  {
    id: "openai",
    label: "OpenAI",
    authTypes: ["api_key"],
    subscription: false,
    configured: true,
    modelCount: 1,
    envVars: ["OPENAI_API_KEY"],
    envAvailable: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    authTypes: ["oauth", "api_key"],
    subscription: true,
    configured: false,
    modelCount: 1,
    envVars: [],
    envAvailable: false,
  },
];

describe("completeModelArgument", () => {
  it("returns provider/id values with no automatic space", () => {
    expect(completeModelArgument(MODELS, "gpt")).toEqual([
      {
        value: "openai/gpt-5",
        label: "gpt-5",
        description: "openai",
        source: "app",
        appendSpace: false,
      },
    ]);
  });

  it("matches provider and label text", () => {
    expect(completeModelArgument(MODELS, "anth").map((item) => item.value)).toEqual([
      "anthropic/claude-sonnet",
    ]);
  });
});

describe("completeThinkingArgument", () => {
  it("returns the matching levels", () => {
    expect(completeThinkingArgument(LEVELS, "hi")).toEqual([
      { value: "high", label: "high", source: "app", appendSpace: false },
    ]);
    expect(completeThinkingArgument(LEVELS, "zzz")).toEqual([]);
  });
});

describe("completeLoginArgument", () => {
  it("returns provider ids with the label as the description", () => {
    expect(completeLoginArgument(PROVIDERS, "anth")).toEqual([
      {
        value: "anthropic",
        label: "anthropic",
        description: "Anthropic",
        source: "app",
        appendSpace: false,
      },
    ]);
  });
});

describe("appArgumentItems", () => {
  const sources = { models: MODELS, thinkingLevels: LEVELS, providers: PROVIDERS };

  it("dispatches by the command's argument kind", () => {
    expect(appArgumentItems("model", "gpt", sources)?.[0]?.value).toBe("openai/gpt-5");
    expect(appArgumentItems("thinking", "lo", sources)?.[0]?.value).toBe("low");
    expect(appArgumentItems("login", "open", sources)?.[0]?.value).toBe("openai");
  });

  it("returns null for commands without an argument kind or without matches", () => {
    expect(appArgumentItems("help", "", sources)).toBeNull();
    expect(appArgumentItems("model", "zzz", sources)).toBeNull();
  });
});
