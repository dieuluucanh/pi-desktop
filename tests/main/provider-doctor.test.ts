/**
 * The Command Code doctor check is read-only: it must spot a hand-written
 * provider that pins every model to one wire and point at the maintained
 * package, without ever claiming a healthy file is broken.
 */

import { describe, expect, it } from "vitest";

import {
  commandCodeProviderDoctorLine,
  commandCodeProviderWarning,
} from "../../src/main/provider-doctor";

function models(provider: Record<string, unknown>): string {
  return JSON.stringify({ providers: { "command-code": provider } });
}

const commandCodeProvider = {
  baseUrl: "https://api.commandcode.ai/provider/v1",
  api: "openai-completions",
  models: [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "deepseek/deepseek-v4-pro" }],
};

describe("commandCodeProviderWarning", () => {
  it("returns null for a missing or malformed file", () => {
    expect(commandCodeProviderWarning(undefined)).toBeNull();
    expect(commandCodeProviderWarning("")).toBeNull();
    expect(commandCodeProviderWarning("{not json")).toBeNull();
    expect(commandCodeProviderWarning("{}")).toBeNull();
    expect(commandCodeProviderWarning(JSON.stringify({ providers: [] }))).toBeNull();
  });

  it("ignores another gateway", () => {
    expect(
      commandCodeProviderWarning(
        models({ ...commandCodeProvider, baseUrl: "https://example.com/v1" }),
      ),
    ).toBeNull();
  });

  it("does not warn when the provider already selects Responses", () => {
    expect(
      commandCodeProviderWarning(models({ ...commandCodeProvider, api: "openai-responses" })),
    ).toBeNull();
  });

  it("warns about a single-wire Command Code provider", () => {
    const warning = commandCodeProviderWarning(models(commandCodeProvider));
    expect(warning).not.toBeNull();
    expect(warning?.providerId).toBe("command-code");
    expect(warning?.api).toBe("openai-completions");
    expect(warning?.modelIds).toEqual(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"]);
    expect(warning?.message).toContain("/responses");
    expect(warning?.hint).toContain("pi install npm:pi-commandcode-provider");
    expect(warning?.hint).toContain("command-code");
    expect(warning?.hint).toContain("commandcode");
  });

  it("names the default wire when the API family is omitted", () => {
    const warning = commandCodeProviderWarning(models({ ...commandCodeProvider, api: undefined }));
    expect(warning?.api).toBeNull();
    expect(warning?.message).toContain("the default wire");
  });

  it("ignores a Command Code provider with no model entries", () => {
    expect(commandCodeProviderWarning(models({ ...commandCodeProvider, models: [] }))).toBeNull();
    expect(
      commandCodeProviderWarning(models({ ...commandCodeProvider, models: "not-an-array" })),
    ).toBeNull();
  });

  it("reports a provider under any key when the host matches", () => {
    const text = JSON.stringify({
      providers: {
        commandcode: {
          baseUrl: "https://api.commandcode.ai/provider/v1",
          api: "openai-completions",
          models: [{ id: "deepseek/deepseek-v4.1-flash" }],
        },
      },
    });
    expect(commandCodeProviderWarning(text)?.providerId).toBe("commandcode");
  });
});

describe("commandCodeProviderDoctorLine", () => {
  it("returns an empty line for a healthy profile", () => {
    expect(
      commandCodeProviderDoctorLine(models({ ...commandCodeProvider, api: "openai-responses" })),
    ).toBe("");
  });

  it("renders the message and hint", () => {
    const line = commandCodeProviderDoctorLine(models(commandCodeProvider));
    expect(line).toContain("provider check");
    expect(line).toContain("hint");
    expect(line).toContain("pi-commandcode-provider");
  });
});
