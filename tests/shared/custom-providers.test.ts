import { describe, expect, it } from "vitest";
import {
  isValidModelId,
  isValidProviderId,
  modelIdError,
  providerIdError,
  MAX_MODEL_ID_LENGTH,
  MAX_PROVIDER_ID_LENGTH,
} from "../../src/shared/custom-providers";

/**
 * The id rules for a custom gateway (plan step 29).
 *
 * The bug these pin: the editor validated model ids with a *package-name*
 * charset, so a real gateway id such as `hf:deepseek-ai/DeepSeek-V4.1-Flash`
 * could not be entered — even though Pi's own schema only requires a non-empty
 * string and the shipped catalogs already contain `~anthropic/claude-opus-latest`
 * and `@cf/meta/llama-3.1-8b-instruct`.
 *
 * The restrictions that remain are app-level and each has one reason: the
 * provider id is a JSON object key and the left half of `provider/model`, and
 * model ids are typed into a comma-separated field.
 */

describe("modelIdError / isValidModelId", () => {
  it("accepts every id shape Pi accepts in practice", () => {
    for (const id of [
      "hf:deepseek-ai/DeepSeek-V4.1-Flash",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "~anthropic/claude-opus-latest",
      "@cf/meta/llama-3.1-8b-instruct",
      "openai/gpt-4o",
      "openrouter/auto:exacto",
      ":free",
      "aigc·hub/x",
      "DeepSeek-V4.1-Flash",
      "qwen2.5-coder-32b-instruct",
      "m",
      "m".repeat(MAX_MODEL_ID_LENGTH),
    ]) {
      expect(modelIdError(id), id).toBeNull();
      expect(isValidModelId(id), id).toBe(true);
    }
  });

  it("trims before deciding", () => {
    expect(modelIdError("  hf:deepseek-ai/x  ")).toBeNull();
  });

  it("rejects empty, whitespace-only and non-string values", () => {
    expect(modelIdError("")).toMatch(/required/i);
    expect(modelIdError("   ")).toMatch(/required/i);
    expect(modelIdError(undefined)).toMatch(/required/i);
    expect(modelIdError(42)).toMatch(/required/i);
    expect(isValidModelId(null)).toBe(false);
  });

  it("rejects internal whitespace and control characters", () => {
    expect(modelIdError("gpt 5")).toMatch(/spaces or control/i);
    expect(modelIdError("gpt\t5")).toMatch(/spaces or control/i);
    expect(modelIdError("gpt\n5")).toMatch(/spaces or control/i);
    expect(modelIdError("gpt\u00a05")).toMatch(/spaces or control/i);
    expect(modelIdError(`gpt${String.fromCharCode(7)}5`)).toMatch(/spaces or control/i);
  });

  it("rejects a comma, because the editor field is comma-separated", () => {
    expect(modelIdError("gpt-5,mini")).toMatch(/comma/i);
    // The message has to point at the way out, or the user is stuck.
    expect(modelIdError("gpt-5,mini")).toMatch(/models\.json/);
  });

  it("rejects anything longer than the cap", () => {
    expect(modelIdError("m".repeat(MAX_MODEL_ID_LENGTH + 1))).toMatch(/at most 200/i);
    expect(isValidModelId("m".repeat(MAX_MODEL_ID_LENGTH + 1))).toBe(false);
  });

  it("does not apply the provider-only guards", () => {
    // Pi accepts these, model ids are never object keys here, so refusing them
    // would contradict the "match Pi" rule this step exists to restore.
    for (const id of ["__proto__", "constructor", ".", ".."]) {
      expect(modelIdError(id), id).toBeNull();
    }
  });
});

describe("providerIdError / isValidProviderId", () => {
  it("accepts project-style names", () => {
    for (const id of [
      "hf-router",
      "my_gateway.2",
      "openrouter",
      "p".repeat(MAX_PROVIDER_ID_LENGTH),
    ]) {
      expect(providerIdError(id), id).toBeNull();
      expect(isValidProviderId(id), id).toBe(true);
    }
  });

  it("trims before deciding", () => {
    expect(providerIdError("  hf-router  ")).toBeNull();
  });

  it("rejects empty and non-string values", () => {
    expect(providerIdError("")).toMatch(/required/i);
    expect(providerIdError("   ")).toMatch(/required/i);
    expect(providerIdError(null)).toMatch(/required/i);
  });

  it("rejects whitespace, control characters and over-long ids", () => {
    expect(providerIdError("my gateway")).toMatch(/spaces or control/i);
    expect(providerIdError("my\tgateway")).toMatch(/spaces or control/i);
    expect(providerIdError("p".repeat(MAX_PROVIDER_ID_LENGTH + 1))).toMatch(/at most 64/i);
  });

  it('rejects "/", because Pi splits provider/model at the first slash', () => {
    expect(providerIdError("../escape")).toMatch(/cannot contain/i);
    expect(providerIdError("my/fleet")).toMatch(/first slash/i);
  });

  it("rejects the JSON-key hazards, since the id becomes an object key", () => {
    expect(providerIdError("__proto__")).toMatch(/reserved/i);
    expect(providerIdError("prototype")).toMatch(/reserved/i);
    expect(providerIdError("constructor")).toMatch(/reserved/i);
    expect(providerIdError(".")).toMatch(/not a usable/i);
    expect(providerIdError("..")).toMatch(/not a usable/i);
  });

  it("agrees with the predicate on every case it branches on", () => {
    const cases = ["", "ok", "a b", "a/b", "__proto__", ".", "..", "p".repeat(65), 7];
    for (const value of cases) {
      expect(isValidProviderId(value)).toBe(providerIdError(value) === null);
      expect(isValidModelId(value)).toBe(modelIdError(value) === null);
    }
  });
});
