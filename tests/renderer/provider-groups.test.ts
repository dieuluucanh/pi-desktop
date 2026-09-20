import { describe, expect, it } from "vitest";
import {
  canAddKey,
  canSignIn,
  groupProviders,
  isLocalProvider,
  providerGroupOf,
  statusLabel,
  statusTone,
} from "../../src/renderer/src/connections/provider-groups";
import type { ProviderSummary } from "../../src/shared/providers";

/**
 * Connections grouping (plan step 9, slice 4). Pure rules, so they are pinned
 * without a DOM: subscription vs API key vs local, and the status badge text.
 */

function provider(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: "anthropic",
    label: "Anthropic",
    authTypes: ["api_key", "oauth"],
    subscription: false,
    configured: false,
    modelCount: 3,
    envVars: [],
    envAvailable: false,
    ...overrides,
  };
}

describe("providerGroupOf", () => {
  it("puts a subscription provider in its own group", () => {
    expect(providerGroupOf(provider({ id: "claude-max", subscription: true }))).toBe(
      "subscription",
    );
  });

  it("recognises local runtimes by id and name", () => {
    expect(isLocalProvider(provider({ id: "llama.cpp", label: "llama.cpp" }))).toBe(true);
    expect(isLocalProvider(provider({ id: "ollama", label: "Ollama" }))).toBe(true);
    expect(isLocalProvider(provider({ id: "x", label: "Local server" }))).toBe(true);
    expect(isLocalProvider(provider({ id: "openai", label: "OpenAI" }))).toBe(false);
    expect(providerGroupOf(provider({ id: "ollama", label: "Ollama" }))).toBe("local");
  });

  it("defaults to the API-key group", () => {
    expect(providerGroupOf(provider())).toBe("apiKey");
  });
});

describe("groupProviders", () => {
  it("drops empty groups and keeps a stable order", () => {
    const groups = groupProviders([
      provider({ id: "openai", label: "OpenAI" }),
      provider({ id: "claude-max", label: "Claude Max", subscription: true }),
      provider({ id: "ollama", label: "Ollama" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["subscription", "apiKey", "local"]);
    expect(groups[1]?.providers.map((entry) => entry.id)).toEqual(["openai"]);
  });
});

describe("statusLabel / statusTone", () => {
  it("names the credential source the way a user thinks about it", () => {
    expect(statusLabel(provider({ configured: true, source: "stored" }))).toBe("signed in");
    expect(statusLabel(provider({ configured: true, source: "environment" }))).toBe(
      "from environment",
    );
    expect(statusLabel(provider({ configured: true, source: "runtime" }))).toBe("this run only");
    expect(statusLabel(provider({ configured: false, envAvailable: true }))).toBe("env var set");
    expect(statusLabel(provider())).toBe("not set up");
    expect(statusTone(provider({ configured: true }))).toBe("ok");
    expect(statusTone(provider({ envAvailable: true }))).toBe("accent");
    expect(statusTone(provider())).toBe("neutral");
  });
});

describe("capability checks", () => {
  it("only offers sign-in for OAuth providers", () => {
    expect(canSignIn(provider())).toBe(true);
    expect(canSignIn(provider({ authTypes: ["api_key"] }))).toBe(false);
  });

  it("does not offer a key form for a local server", () => {
    expect(canAddKey(provider())).toBe(true);
    expect(canAddKey(provider({ id: "ollama", label: "Ollama" }))).toBe(false);
  });
});
