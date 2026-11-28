import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_FAILURE_CODES,
  EXTRACTION_FORMATS,
  EXTRACTION_WARNING_CODES,
} from "../../src/shared/extraction";

/** The step-17 fixture inventory is a reviewable contract, not parser output. */
const manifest = JSON.parse(
  readFileSync(new URL("../fixtures/documents/manifest.json", import.meta.url), "utf8"),
) as {
  version: number;
  fixtures: Array<{
    id: string;
    format: string;
    class: string;
    covers: string;
    expected: string;
    warnings?: string[];
    failure?: string;
  }>;
};

describe("document fixture inventory", () => {
  it("covers every milestone-B format with representative and hostile fixtures", () => {
    expect(manifest.version).toBe(1);
    const formats = new Set(manifest.fixtures.map((fixture) => fixture.format));
    for (const format of EXTRACTION_FORMATS) expect(formats).toContain(format);
    expect(manifest.fixtures.some((fixture) => fixture.class === "representative")).toBe(true);
    expect(manifest.fixtures.some((fixture) => fixture.class === "hostile")).toBe(true);
    for (const format of EXTRACTION_FORMATS) {
      expect(
        manifest.fixtures.some(
          (fixture) => fixture.format === format && fixture.class === "representative",
        ),
      ).toBe(true);
    }
  });

  it("uses only the closed expected-outcome vocabulary and unique ids", () => {
    const ids = manifest.fixtures.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of manifest.fixtures) {
      expect(fixture.id).toMatch(/^[a-z0-9-]+$/);
      expect(fixture.covers.length).toBeGreaterThan(0);
      expect(["success", "warnings", "failure"]).toContain(fixture.expected);
      for (const warning of fixture.warnings ?? []) {
        expect(EXTRACTION_WARNING_CODES).toContain(warning);
      }
      if (fixture.expected === "failure") {
        expect(fixture.failure).toBeTruthy();
        expect(EXTRACTION_FAILURE_CODES).toContain(fixture.failure);
        expect(fixture.warnings ?? []).toHaveLength(0);
      }
      if (fixture.expected === "warnings") {
        expect((fixture.warnings ?? []).length).toBeGreaterThan(0);
        expect(fixture.failure).toBeUndefined();
      }
      // The inventory must not smuggle paths, owners or content into the spec.
      expect(fixture).not.toHaveProperty("path");
      expect(fixture).not.toHaveProperty("owner");
    }
  });

  it("includes the hostile classes the worker must survive", () => {
    const covers = manifest.fixtures
      .map((fixture) => `${fixture.id} ${fixture.covers}`.toLowerCase())
      .join(" ");
    for (const term of [
      "traversal",
      "duplicate",
      "bomb",
      "encrypted",
      "macro",
      "external",
      "malformed",
      "cell",
      "page",
    ]) {
      expect(covers).toContain(term);
    }
  });
});
