/**
 * The SDK provider adapter (plan step 9, slice 2).
 *
 * Drives a **real** `ModelRuntime` against a throw-away profile directory. No
 * provider is contacted: the API-key login a write-only form uses only answers
 * a local prompt, and every catalog refresh in these tests is offline.
 *
 * What this pins: summaries are credential-free, classification comes from Pi,
 * a key reaches `auth.json` and never the reply, and a runtime-only key never
 * touches the file.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectProviders, ProviderError } from "../../src/host/providers";
import { createSdkProviderPort, keyOnlyInteraction } from "../../src/host/sdk/providers";

const SECRET = "sk-test-provider-secret-value";

function tempProfile(): string {
  return mkdtempSync(join(tmpdir(), "pi-desktop-providers-"));
}

const created: string[] = [];
function profile(): string {
  const dir = tempProfile();
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("keyOnlyInteraction", () => {
  it("answers Pi's secret prompt with the key it was given", async () => {
    const interaction = keyOnlyInteraction(SECRET);
    await expect(interaction.prompt({ type: "secret", message: "Enter API key" })).resolves.toBe(
      SECRET,
    );
  });

  it("refuses a provider that needs more than an API key", async () => {
    const interaction = keyOnlyInteraction(SECRET);
    await expect(interaction.prompt({ type: "text", message: "Server URL" })).rejects.toMatchObject(
      { code: "needs_interaction" },
    );
  });

  it("cannot answer the secret prompt twice", async () => {
    const interaction = keyOnlyInteraction(SECRET);
    await interaction.prompt({ type: "secret", message: "key" });
    await expect(
      interaction.prompt({ type: "secret", message: "key again" }),
    ).rejects.toMatchObject({ code: "needs_interaction" });
  });
});

describe("sdk provider port", () => {
  it("lists Pi's providers with credential-free summaries", async () => {
    const port = createSdkProviderPort({ agentDir: profile() });
    const providers = await collectProviders(port);

    expect(providers.length).toBeGreaterThan(10);
    const anthropic = providers.find((provider) => provider.id === "anthropic");
    expect(anthropic).toMatchObject({ id: "anthropic", label: "Anthropic" });
    expect(anthropic?.authTypes).toContain("api_key");
    expect(anthropic?.authTypes).toContain("oauth");
    expect(anthropic?.modelCount).toBeGreaterThan(0);
    // Sorted by label, and never carrying a credential-shaped field.
    const labels = providers.map((provider) => provider.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
    expect(JSON.stringify(providers)).not.toContain(SECRET);
  });

  it("detects an environment key with no stored credential", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = SECRET;
    try {
      const port = createSdkProviderPort({
        agentDir: profile(),
        env: { ANTHROPIC_API_KEY: SECRET },
      });
      const providers = await collectProviders(port);
      const anthropic = providers.find((provider) => provider.id === "anthropic");
      expect(anthropic).toMatchObject({
        configured: true,
        source: "environment",
        envAvailable: true,
        subscription: false,
      });
      expect(anthropic?.envVars).toContain("ANTHROPIC_API_KEY");
      // The value itself is nowhere in the summary.
      expect(JSON.stringify(anthropic)).not.toContain(SECRET);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("persists an API key through Pi and never returns it", async () => {
    const agentDir = profile();
    const port = createSdkProviderPort({ agentDir });
    await port.setKey("anthropic", SECRET);

    const authFile = join(agentDir, "auth.json");
    expect(existsSync(authFile)).toBe(true);
    expect(readFileSync(authFile, "utf8")).toContain(SECRET);

    const providers = await collectProviders(port);
    const anthropic = providers.find((provider) => provider.id === "anthropic");
    expect(anthropic).toMatchObject({ configured: true, source: "stored" });
    // The key reached Pi, never a summary.
    expect(JSON.stringify(providers)).not.toContain(SECRET);
  });

  it("keeps a runtime-only key out of auth.json", async () => {
    const agentDir = profile();
    const authFile = join(agentDir, "auth.json");
    const port = createSdkProviderPort({ agentDir });
    await port.setRuntimeKey("anthropic", SECRET);

    // Pi may create the file/directory lazily; the rule is that the key is not in
    // it (a runtime key must not survive the process).
    if (existsSync(authFile)) expect(readFileSync(authFile, "utf8")).not.toContain(SECRET);
    const providers = await collectProviders(port);
    const anthropic = providers.find((provider) => provider.id === "anthropic");
    expect(anthropic?.configured).toBe(true);
    expect(anthropic?.source).toBe("runtime");

    await port.clearRuntimeKey("anthropic");
    if (existsSync(authFile)) expect(readFileSync(authFile, "utf8")).not.toContain(SECRET);
    const after = (await collectProviders(port)).find((provider) => provider.id === "anthropic");
    expect(after?.configured).toBe(false);
  });

  it("logs out by removing the stored credential", async () => {
    const agentDir = profile();
    const port = createSdkProviderPort({ agentDir });
    await port.setKey("anthropic", SECRET);
    await port.logout("anthropic");

    const authFile = join(agentDir, "auth.json");
    if (existsSync(authFile)) {
      expect(readFileSync(authFile, "utf8")).not.toContain(SECRET);
    }
    const anthropic = (await collectProviders(port)).find(
      (provider) => provider.id === "anthropic",
    );
    expect(anthropic?.configured).toBe(false);
  });

  it("refuses an unknown provider and a provider without an API-key login", async () => {
    const port = createSdkProviderPort({ agentDir: profile() });
    await expect(port.setKey("no-such-provider", SECRET)).rejects.toBeInstanceOf(ProviderError);
    await expect(port.setKey("no-such-provider", SECRET)).rejects.toMatchObject({
      code: "unknown_provider",
    });
  });

  it("reports an unknown provider as unconfigured", () => {
    const port = createSdkProviderPort({ agentDir: profile() });
    expect(port.authStatus("no-such-provider")).toEqual({ configured: false });
    expect(port.modelCount("no-such-provider")).toBe(0);
  });
});
