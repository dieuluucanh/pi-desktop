import { describe, expect, it } from "vitest";
import { parseAttachmentReadinessVerdict } from "../../src/main/attachment-readiness";

const IDS = ["123e4567-e89b-42d3-a456-000000000001", "123e4567-e89b-42d3-a456-000000000002"];

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    model: { provider: "openai", id: "fixture", api: "openai-completions" },
    revision: "1:4",
    files: [
      { id: IDS[0], reasons: [] },
      { id: IDS[1], reasons: ["context_limit_exceeded"] },
    ],
    reasons: ["context_limit_exceeded"],
    estimatedTokens: 1200,
    ...overrides,
  };
}

describe("host readiness verdict validation", () => {
  it("accepts a bounded verdict correlated to exactly the requested files", () => {
    expect(parseAttachmentReadinessVerdict(verdict(), IDS)).toEqual({
      model: { provider: "openai", id: "fixture", api: "openai-completions" },
      revision: "1:4",
      files: [
        { id: IDS[0], reasons: [] },
        { id: IDS[1], reasons: ["context_limit_exceeded"] },
      ],
      reasons: ["context_limit_exceeded"],
      estimatedTokens: 1200,
    });
  });

  it("rejects reordered, substituted, duplicated or missing files", () => {
    expect(
      parseAttachmentReadinessVerdict(
        verdict({
          files: [
            { id: IDS[1], reasons: [] },
            { id: IDS[0], reasons: [] },
          ],
        }),
        IDS,
      ),
    ).toBeNull();
    expect(
      parseAttachmentReadinessVerdict(
        verdict({
          files: [
            { id: "123e4567-e89b-42d3-a456-000000000009", reasons: [] },
            { id: IDS[1], reasons: [] },
          ],
        }),
        IDS,
      ),
    ).toBeNull();
    expect(
      parseAttachmentReadinessVerdict(verdict({ files: [verdict().files[0]] }), IDS),
    ).toBeNull();
    expect(
      parseAttachmentReadinessVerdict(
        verdict({
          files: [
            { id: IDS[0], reasons: [] },
            { id: IDS[0], reasons: [] },
          ],
        }),
        IDS,
      ),
    ).toBeNull();
  });

  it("rejects unknown reasons, malformed model data, extra keys and bad numbers", () => {
    expect(
      parseAttachmentReadinessVerdict(verdict({ reasons: ["not-a-reason"], files: [] }), IDS),
    ).toBeNull();
    expect(
      parseAttachmentReadinessVerdict(
        verdict({ model: { provider: "openai", id: "fixture" } }),
        IDS,
      ),
    ).toBeNull();
    expect(parseAttachmentReadinessVerdict(verdict({ extra: true }), IDS)).toBeNull();
    expect(parseAttachmentReadinessVerdict(verdict({ estimatedTokens: -1 }), IDS)).toBeNull();
    expect(parseAttachmentReadinessVerdict(verdict({ estimatedTokens: 1.5 }), IDS)).toBeNull();
    expect(parseAttachmentReadinessVerdict(verdict({ revision: "" }), IDS)).toBeNull();
    expect(
      parseAttachmentReadinessVerdict(
        verdict({
          files: [{ id: IDS[0], reasons: ["busy"], status: "blocked" }, verdict().files[1]],
        }),
        IDS,
      ),
    ).toBeNull();
  });

  it("accepts an unknown model and a ready verdict", () => {
    const parsed = parseAttachmentReadinessVerdict(
      verdict({ model: null, reasons: [], files: IDS.map((id) => ({ id, reasons: [] })) }),
      IDS,
    );
    expect(parsed).toMatchObject({ model: null, reasons: [] });
  });
});
