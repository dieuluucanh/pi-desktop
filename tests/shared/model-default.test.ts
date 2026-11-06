import { describe, expect, it } from "vitest";

import {
  catalogueHasModel,
  defaultModelProblem,
  readDefaultModelRef,
} from "../../src/shared/model-default";

/**
 * "Which model does a new session start on?" (2026-11-06 plan, step 12).
 *
 * Pi prefers the first scoped model, then a saved default it can resolve, then
 * whatever is first in the catalogue. A default that names a missing id is
 * therefore silent — this module is what lets the app say it out loud.
 */

describe("readDefaultModelRef", () => {
  it("prefers the project document over the global one", () => {
    expect(
      readDefaultModelRef({
        global: { defaultProvider: "synthetic", defaultModel: "g" },
        project: { defaultProvider: "opencode-go", defaultModel: "p" },
      }),
    ).toEqual({ provider: "opencode-go", id: "p" });
  });

  it("ignores an incomplete pair instead of inventing one", () => {
    expect(readDefaultModelRef({ global: { defaultProvider: "synthetic" } })).toBeNull();
    expect(readDefaultModelRef(null)).toBeNull();
  });
});

describe("catalogueHasModel", () => {
  it("understands raw rows, catalog entries and ScopedModel wrappers", () => {
    const ref = { provider: "synthetic", id: "hf:x" };
    expect(catalogueHasModel([{ provider: "synthetic", id: "hf:x" }], ref)).toBe(true);
    expect(
      catalogueHasModel([{ key: "synthetic/hf:x", provider: "synthetic", id: "hf:x" }], ref),
    ).toBe(true);
    expect(catalogueHasModel([{ model: { provider: "synthetic", id: "hf:x" } }], ref)).toBe(true);
    expect(catalogueHasModel([{ provider: "synthetic", id: "hf:y" }], ref)).toBe(false);
  });
});

describe("defaultModelProblem", () => {
  it("stays quiet before the catalogue has loaded", () => {
    expect(
      defaultModelProblem(
        { global: { defaultProvider: "synthetic", defaultModel: "hf:gone" } },
        [],
      ),
    ).toBeNull();
  });

  it("stays quiet when the saved default resolves", () => {
    expect(
      defaultModelProblem({ global: { defaultProvider: "synthetic", defaultModel: "hf:x" } }, [
        { provider: "synthetic", id: "hf:x" },
      ]),
    ).toBeNull();
  });

  it("names the missing id and the consequence", () => {
    const problem = defaultModelProblem(
      { global: { defaultProvider: "synthetic", defaultModel: "hf:gone" } },
      [{ provider: "synthetic", id: "hf:other" }],
    );

    expect(problem).toMatchObject({ provider: "synthetic", id: "hf:gone" });
    expect(problem?.message).toContain("synthetic/hf:gone");
    expect(problem?.message).toContain("starts on another model");
  });
});
