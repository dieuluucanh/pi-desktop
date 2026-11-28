import { describe, expect, it } from "vitest";

import {
  DEFAULT_OUTPUT_TOKENS,
  MAX_MODEL_ID_LENGTH,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_CHARS,
  MAX_REQUEST_ID_LENGTH,
  MAX_SYSTEM_CHARS,
  formatModelRef,
  resolveCatalogueDefault,
  sameModelRef,
  sanitizeTextGenerationRequest,
  type ModelChoice,
  type TextGenerationRequest,
} from "../../src/shared/text-generation";

/**
 * The session-less text-generation contract (2026-11-25 plan, step 13).
 *
 * Every bound is a hard bound: the sanitiser either materialises a bounded
 * request or returns `null`. It never throws and never truncates silently.
 */

const base: TextGenerationRequest = {
  requestId: "req-1",
  cwd: null,
  model: null,
  system: "You write git commit messages.",
  prompt: "diff --git a/x b/x",
  maxTokens: DEFAULT_OUTPUT_TOKENS,
};

const catalogue: ModelChoice[] = [
  { provider: "synthetic", id: "hf:x", name: "Synthetic X" },
  { provider: "opencode-go", id: "glm", name: "GLM" },
];

describe("sanitizeTextGenerationRequest", () => {
  it("keeps a valid request and materialises the optional fields", () => {
    expect(sanitizeTextGenerationRequest({ ...base, maxTokens: undefined })).toEqual(base);
    expect(sanitizeTextGenerationRequest({ ...base, cwd: undefined, model: undefined })).toEqual(
      base,
    );
  });

  it("returns null for non-objects", () => {
    expect(sanitizeTextGenerationRequest(null)).toBeNull();
    expect(sanitizeTextGenerationRequest(undefined)).toBeNull();
    expect(sanitizeTextGenerationRequest("req")).toBeNull();
    expect(sanitizeTextGenerationRequest([])).toBeNull();
    expect(sanitizeTextGenerationRequest(42)).toBeNull();
  });

  it("requires a matching requestId", () => {
    expect(sanitizeTextGenerationRequest({ ...base, requestId: undefined })).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, requestId: 7 })).toBeNull();
  });

  it("pins the requestId charset at both ends of the length bound", () => {
    const valid = ["a", "A", "0", "_", "-", "a_B-9", "x".repeat(MAX_REQUEST_ID_LENGTH)];
    for (const requestId of valid) {
      expect(sanitizeTextGenerationRequest({ ...base, requestId }), requestId).not.toBeNull();
    }

    const invalid = [
      "",
      "x".repeat(MAX_REQUEST_ID_LENGTH + 1),
      "a b",
      "a/b",
      "a.b",
      "a:b",
      "a\n",
      " a",
      "ä",
      "a$",
    ];
    for (const requestId of invalid) {
      expect(sanitizeTextGenerationRequest({ ...base, requestId }), requestId).toBeNull();
    }
  });

  it("bounds the system prompt and trims it", () => {
    expect(sanitizeTextGenerationRequest({ ...base, system: "  hi  " })?.system).toBe("hi");
    expect(
      sanitizeTextGenerationRequest({ ...base, system: "x".repeat(MAX_SYSTEM_CHARS) }),
    ).not.toBeNull();
    expect(
      sanitizeTextGenerationRequest({ ...base, system: "x".repeat(MAX_SYSTEM_CHARS + 1) }),
    ).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, system: "" })).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, system: "   " })).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, system: undefined })).toBeNull();
  });

  it("bounds the prompt and trims it", () => {
    expect(sanitizeTextGenerationRequest({ ...base, prompt: "\n body \n" })?.prompt).toBe("body");
    expect(
      sanitizeTextGenerationRequest({ ...base, prompt: "x".repeat(MAX_PROMPT_CHARS) }),
    ).not.toBeNull();
    expect(
      sanitizeTextGenerationRequest({ ...base, prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }),
    ).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, prompt: "" })).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, prompt: " \n\t " })).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, prompt: 1 })).toBeNull();
  });

  it("defaults, floors, clamps and rejects maxTokens", () => {
    expect(sanitizeTextGenerationRequest({ ...base, maxTokens: undefined })?.maxTokens).toBe(
      DEFAULT_OUTPUT_TOKENS,
    );
    expect(sanitizeTextGenerationRequest({ ...base, maxTokens: null })?.maxTokens).toBe(
      DEFAULT_OUTPUT_TOKENS,
    );
    expect(sanitizeTextGenerationRequest({ ...base, maxTokens: 1 })?.maxTokens).toBe(1);
    expect(sanitizeTextGenerationRequest({ ...base, maxTokens: 10.9 })?.maxTokens).toBe(10);
    expect(
      sanitizeTextGenerationRequest({ ...base, maxTokens: MAX_OUTPUT_TOKENS })?.maxTokens,
    ).toBe(MAX_OUTPUT_TOKENS);
    expect(
      sanitizeTextGenerationRequest({ ...base, maxTokens: MAX_OUTPUT_TOKENS * 10 })?.maxTokens,
    ).toBe(MAX_OUTPUT_TOKENS);
    for (const maxTokens of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
      expect(sanitizeTextGenerationRequest({ ...base, maxTokens }), String(maxTokens)).toBeNull();
    }
  });

  it("trims cwd and treats blank or absent as unset", () => {
    expect(sanitizeTextGenerationRequest({ ...base, cwd: "  /work/app  " })?.cwd).toBe("/work/app");
    expect(sanitizeTextGenerationRequest({ ...base, cwd: "" })?.cwd).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, cwd: "   " })?.cwd).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, cwd: null })?.cwd).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, cwd: undefined })?.cwd).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, cwd: 12 })).toBeNull();
    expect(sanitizeTextGenerationRequest({ ...base, cwd: ["/work"] })).toBeNull();
  });

  it("accepts a bounded model ref and null for Default", () => {
    expect(
      sanitizeTextGenerationRequest({
        ...base,
        model: { provider: " synthetic ", id: " hf:x " },
      })?.model,
    ).toEqual({ provider: "synthetic", id: "hf:x" });
    expect(sanitizeTextGenerationRequest({ ...base, model: null })?.model).toBeNull();
    expect(
      sanitizeTextGenerationRequest({
        ...base,
        model: { provider: "synthetic", id: "x".repeat(MAX_MODEL_ID_LENGTH) },
      }),
    ).not.toBeNull();
  });

  it("rejects an incomplete, over-long or non-object model ref", () => {
    const tooLong = "x".repeat(MAX_MODEL_ID_LENGTH + 1);
    const invalid = [
      {},
      { provider: "synthetic" },
      { id: "hf:x" },
      { provider: "", id: "hf:x" },
      { provider: "   ", id: "hf:x" },
      { provider: "synthetic", id: "" },
      { provider: 1, id: "hf:x" },
      { provider: tooLong, id: "hf:x" },
      { provider: "synthetic", id: tooLong },
      "synthetic/hf:x",
      [],
    ];
    for (const model of invalid) {
      expect(sanitizeTextGenerationRequest({ ...base, model }), JSON.stringify(model)).toBeNull();
    }
  });

  it("never throws on hostile input", () => {
    const hostile: unknown[] = [
      { ...base, system: { toString: () => "x" } },
      { ...base, model: new Date() },
      Object.create(null),
    ];
    for (const input of hostile) {
      expect(() => sanitizeTextGenerationRequest(input)).not.toThrow();
      expect(sanitizeTextGenerationRequest(input)).toBeNull();
    }
  });
});

describe("formatModelRef", () => {
  it("joins provider and id with a slash", () => {
    expect(formatModelRef({ provider: "synthetic", id: "hf:x" })).toBe("synthetic/hf:x");
    expect(formatModelRef({ provider: "a", id: "b" })).toBe("a/b");
  });
});

describe("sameModelRef", () => {
  const ref = { provider: "synthetic", id: "hf:x" };

  it("compares both halves", () => {
    expect(sameModelRef(ref, { ...ref })).toBe(true);
    expect(sameModelRef(ref, { provider: "synthetic", id: "hf:y" })).toBe(false);
    expect(sameModelRef(ref, { provider: "other", id: "hf:x" })).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(sameModelRef(null, ref)).toBe(false);
    expect(sameModelRef(ref, undefined)).toBe(false);
    expect(sameModelRef(null, null)).toBe(false);
  });
});

describe("resolveCatalogueDefault", () => {
  it("prefers the project document over the global one", () => {
    expect(
      resolveCatalogueDefault(
        {
          global: { defaultProvider: "synthetic", defaultModel: "hf:x" },
          project: { defaultProvider: "opencode-go", defaultModel: "glm" },
        },
        catalogue,
      ),
    ).toEqual({ defaultModel: catalogue[1], defaultAvailable: true });
  });

  it("falls back to the global document", () => {
    expect(
      resolveCatalogueDefault(
        { global: { defaultProvider: "synthetic", defaultModel: "hf:x" } },
        catalogue,
      ),
    ).toEqual({ defaultModel: catalogue[0], defaultAvailable: true });
  });

  it("ignores an incomplete pair and never invents one", () => {
    expect(
      resolveCatalogueDefault({ global: { defaultProvider: "synthetic" } }, catalogue),
    ).toEqual({ defaultModel: null, defaultAvailable: false });
    expect(resolveCatalogueDefault(undefined, catalogue)).toEqual({
      defaultModel: null,
      defaultAvailable: false,
    });
    expect(resolveCatalogueDefault(null, catalogue)).toEqual({
      defaultModel: null,
      defaultAvailable: false,
    });
    expect(resolveCatalogueDefault({}, catalogue)).toEqual({
      defaultModel: null,
      defaultAvailable: false,
    });
  });

  it("reports a saved default the catalogue cannot resolve", () => {
    expect(
      resolveCatalogueDefault(
        { global: { defaultProvider: "synthetic", defaultModel: "hf:gone" } },
        catalogue,
      ),
    ).toEqual({
      defaultModel: { provider: "synthetic", id: "hf:gone", name: "hf:gone" },
      defaultAvailable: false,
    });
  });

  it("reports a saved default with an empty catalogue as unresolved", () => {
    expect(
      resolveCatalogueDefault(
        { global: { defaultProvider: "synthetic", defaultModel: "hf:x" } },
        [],
      ),
    ).toEqual({
      defaultModel: { provider: "synthetic", id: "hf:x", name: "hf:x" },
      defaultAvailable: false,
    });
    expect(resolveCatalogueDefault({}, [])).toEqual({
      defaultModel: null,
      defaultAvailable: false,
    });
  });

  it("returns a copy of the catalogue row, not the caller's object", () => {
    const models: ModelChoice[] = [{ provider: "synthetic", id: "hf:x", name: "Synthetic X" }];
    const resolved = resolveCatalogueDefault(
      { global: { defaultProvider: "synthetic", defaultModel: "hf:x" } },
      models,
    );
    expect(resolved.defaultModel).toEqual(models[0]);
    expect(resolved.defaultModel).not.toBe(models[0]);
  });
});
