import { describe, expect, it } from "vitest";
import {
  hashPromptText,
  MAX_PROMPT_ORIGINS,
  MAX_PROMPT_ORIGIN_LENGTH,
  promptOriginForText,
  rememberPromptOrigin,
  sanitizePromptOrigins,
} from "../../src/shared/prompt-origin";

const HEX = /^[0-9a-f]{16}$/;

describe("hashPromptText", () => {
  it("returns a stable 16-char lowercase hex hash", () => {
    expect(hashPromptText("hello")).toMatch(HEX);
    expect(hashPromptText("hello")).toBe(hashPromptText("hello"));
    expect(hashPromptText("")).toMatch(HEX);
  });

  it("distinguishes different texts, including order and unicode", () => {
    expect(hashPromptText("hello")).not.toBe(hashPromptText("hello!"));
    expect(hashPromptText("ab")).not.toBe(hashPromptText("ba"));
    expect(hashPromptText("café")).not.toBe(hashPromptText("cafe"));
    expect(hashPromptText("한글")).not.toBe(hashPromptText("한글 "));
  });
});

describe("sanitizePromptOrigins", () => {
  it("returns an empty map for junk", () => {
    expect(sanitizePromptOrigins(null)).toEqual({});
    expect(sanitizePromptOrigins("nope")).toEqual({});
    expect(sanitizePromptOrigins(42)).toEqual({});
    expect(sanitizePromptOrigins([])).toEqual({});
  });

  it("keeps only hash keys and trimmed command strings", () => {
    const key = hashPromptText("expanded body");
    expect(
      sanitizePromptOrigins({
        [key]: "  /commit -a  ",
        notAHash: "/x",
        [key.toUpperCase()]: "/upper",
        [hashPromptText("bad-value")]: 42,
        [hashPromptText("empty")]: "   ",
      }),
    ).toEqual({ [key]: "/commit -a" });
  });

  it("bounds the value length", () => {
    const key = hashPromptText("long");
    expect(sanitizePromptOrigins({ [key]: "x".repeat(MAX_PROMPT_ORIGIN_LENGTH + 1) })).toEqual({});
    expect(
      sanitizePromptOrigins({ [key]: "x".repeat(MAX_PROMPT_ORIGIN_LENGTH) })[key],
    ).toHaveLength(MAX_PROMPT_ORIGIN_LENGTH);
  });

  it("keeps the most recent entries up to the bound", () => {
    const entries = Object.fromEntries(
      Array.from({ length: MAX_PROMPT_ORIGINS + 5 }, (_, index) => [
        hashPromptText(`text-${index}`),
        `/command-${index}`,
      ]),
    );
    const result = sanitizePromptOrigins(entries);
    expect(Object.keys(result)).toHaveLength(MAX_PROMPT_ORIGINS);
    expect(result[hashPromptText("text-0")]).toBeUndefined();
    expect(result[hashPromptText(`text-${MAX_PROMPT_ORIGINS + 4}`)]).toBe(
      `/command-${MAX_PROMPT_ORIGINS + 4}`,
    );
  });
});

describe("rememberPromptOrigin", () => {
  it("adds an entry without mutating the input and can look it up", () => {
    const before = {};
    const after = rememberPromptOrigin(before, "expanded body", " /commit -a ");
    expect(before).toEqual({});
    expect(after).toEqual({ [hashPromptText("expanded body")]: "/commit -a" });
    expect(promptOriginForText(after, "expanded body")).toBe("/commit -a");
    expect(promptOriginForText(after, "another body")).toBeUndefined();
  });

  it("moves a re-recorded text to the most recent position", () => {
    const first = rememberPromptOrigin({}, "a", "/a");
    const second = rememberPromptOrigin(first, "b", "/b");
    const refreshed = rememberPromptOrigin(second, "a", "/a-updated");
    expect(Object.keys(refreshed)).toEqual([hashPromptText("b"), hashPromptText("a")]);
    expect(promptOriginForText(refreshed, "a")).toBe("/a-updated");
  });

  it("does not add an empty or over-long command", () => {
    expect(rememberPromptOrigin({}, "body", "   ")).toEqual({});
    expect(rememberPromptOrigin({}, "body", "x".repeat(MAX_PROMPT_ORIGIN_LENGTH + 1))).toEqual({});
  });
});
