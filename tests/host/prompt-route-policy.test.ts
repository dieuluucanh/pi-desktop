import { describe, expect, it } from "vitest";
import { evaluateModelChange, evaluatePromptRoute } from "../../src/host/prompt-route-policy";

const visionModel = {
  provider: "openai",
  id: "vision",
  api: "openai-completions",
  input: ["text", "image"],
  inputLimits: {
    maxRequestBytes: 20_000_000,
    images: {
      maxPerMessage: 4,
      maxPerRequest: 8,
      resize: { maxBytes: 4 * 1024 * 1024, maxWidth: 2048, maxHeight: 2048 },
    },
  },
};
const textModel = {
  provider: "openai",
  id: "text-only",
  api: "openai-completions",
  input: ["text"],
  inputLimits: {
    maxRequestBytes: 20_000_000,
    images: {
      maxPerMessage: 0,
      maxPerRequest: 0,
      resize: { maxBytes: 0, maxWidth: 0, maxHeight: 0 },
    },
  },
};

describe("Desktop prompt-route policy", () => {
  it("leaves plain text on an image-free context alone on any model", () => {
    expect(
      evaluatePromptRoute({ model: textModel, historyImageCount: 0, addingImages: false }),
    ).toEqual([]);
    expect(
      evaluatePromptRoute({
        model: { provider: "x", id: "y" },
        historyImageCount: 0,
        addingImages: false,
      }),
    ).toEqual([]);
  });

  it("refuses a text-only model when the active context holds images", () => {
    expect(
      evaluatePromptRoute({ model: textModel, historyImageCount: 2, addingImages: false }),
    ).toEqual(["model_modality_unsupported"]);
    expect(
      evaluatePromptRoute({ model: visionModel, historyImageCount: 2, addingImages: false }),
    ).toEqual([]);
  });

  it("refuses new legacy images on a model that cannot accept them", () => {
    expect(
      evaluatePromptRoute({ model: textModel, historyImageCount: 0, addingImages: true }),
    ).toEqual(["model_modality_unsupported"]);
    expect(
      evaluatePromptRoute({ model: visionModel, historyImageCount: 0, addingImages: true }),
    ).toEqual([]);
  });

  it("fails closed for a model with unknown image support", () => {
    expect(
      evaluatePromptRoute({
        model: { provider: "x", id: "y" },
        historyImageCount: 1,
        addingImages: false,
      }),
    ).toEqual(["model_unknown"]);
    expect(
      evaluatePromptRoute({ model: textModel, historyImageCount: 1_500, addingImages: false }),
    ).toEqual(["model_modality_unsupported"]);
    expect(
      evaluatePromptRoute({ model: visionModel, historyImageCount: 1_500, addingImages: false }),
    ).toEqual(["image_limit_exceeded"]);
  });
});

describe("Desktop model-change policy", () => {
  it("allows any switch while idle; the route policy blocks dispatch instead", () => {
    expect(
      evaluateModelChange({ model: textModel, historyImageCount: 2, streaming: false }),
    ).toEqual([]);
  });

  it("refuses an incompatible target during an active image run", () => {
    expect(
      evaluateModelChange({ model: textModel, historyImageCount: 2, streaming: true }),
    ).toEqual(["model_modality_unsupported"]);
    expect(
      evaluateModelChange({ model: visionModel, historyImageCount: 2, streaming: true }),
    ).toEqual([]);
    expect(
      evaluateModelChange({ model: textModel, historyImageCount: 0, streaming: true }),
    ).toEqual([]);
  });
});
