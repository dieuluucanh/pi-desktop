import { describe, expect, it } from "vitest";

import {
  COMMAND_ARGUMENT_DESCRIPTION_MAX,
  COMMAND_ARGUMENT_LIMIT,
  COMMAND_ARGUMENT_VALUE_MAX,
  parseCommandCompleteResult,
  parseCommandRunResult,
  sanitizeCommandArgumentItems,
} from "../../src/shared/commands";

/** The command-argument wire contract (2026-10-24 command parity plan). */

describe("sanitizeCommandArgumentItems", () => {
  it("keeps values, labels and descriptions", () => {
    expect(
      sanitizeCommandArgumentItems([
        { value: "use none", label: "none", description: "no profile" },
        { value: "allow ", label: "allow" },
      ]),
    ).toEqual([
      { value: "use none", label: "none", description: "no profile" },
      { value: "allow ", label: "allow" },
    ]);
  });

  it("preserves a trailing space in the value", () => {
    const [item] = sanitizeCommandArgumentItems([{ value: "use ", label: "use" }]);
    expect(item?.value).toBe("use ");
  });

  it("falls back to the value when the label is missing or empty", () => {
    expect(sanitizeCommandArgumentItems([{ value: "global" }])).toEqual([
      { value: "global", label: "global" },
    ]);
    expect(sanitizeCommandArgumentItems([{ value: "global", label: "" }])).toEqual([
      { value: "global", label: "global" },
    ]);
  });

  it("drops malformed entries instead of throwing", () => {
    expect(
      sanitizeCommandArgumentItems([
        null,
        "nope",
        {},
        { value: 3, label: "three" },
        { value: "", label: "empty" },
        { value: "ok", label: "ok", description: 7 },
      ]),
    ).toEqual([{ value: "ok", label: "ok" }]);
    expect(sanitizeCommandArgumentItems("not-an-array")).toEqual([]);
  });

  it("caps the number of items and the string lengths", () => {
    const many = Array.from({ length: COMMAND_ARGUMENT_LIMIT + 10 }, (_, index) => ({
      value: `value-${index}`,
      label: `label-${index}`,
    }));
    expect(sanitizeCommandArgumentItems(many)).toHaveLength(COMMAND_ARGUMENT_LIMIT);

    const [long] = sanitizeCommandArgumentItems([
      {
        value: "v".repeat(COMMAND_ARGUMENT_VALUE_MAX + 20),
        label: "l".repeat(1000),
        description: "d".repeat(COMMAND_ARGUMENT_DESCRIPTION_MAX + 20),
      },
    ]);
    expect(long?.value).toHaveLength(COMMAND_ARGUMENT_VALUE_MAX);
    expect(long?.label).toHaveLength(512);
    expect(long?.description).toHaveLength(COMMAND_ARGUMENT_DESCRIPTION_MAX);
  });
});

describe("parseCommandCompleteResult", () => {
  it("reads a host response", () => {
    expect(parseCommandCompleteResult({ items: [{ value: "use ", label: "use" }] })).toEqual([
      { value: "use ", label: "use" },
    ]);
  });

  it("returns null for empty or malformed responses", () => {
    expect(parseCommandCompleteResult({ items: null })).toBeNull();
    expect(parseCommandCompleteResult({ items: [] })).toBeNull();
    expect(parseCommandCompleteResult({})).toBeNull();
    expect(parseCommandCompleteResult(undefined)).toBeNull();
  });
});

describe("parseCommandRunResult", () => {
  it("reads a successful run with an optional error", () => {
    expect(parseCommandRunResult({ ran: true })).toEqual({ ran: true });
    expect(parseCommandRunResult({ ran: true, error: "boom" })).toEqual({
      ran: true,
      error: "boom",
    });
  });

  it("treats anything else as not run", () => {
    expect(parseCommandRunResult({ ran: false })).toEqual({ ran: false });
    expect(parseCommandRunResult({})).toEqual({ ran: false });
    expect(parseCommandRunResult(null)).toEqual({ ran: false });
  });
});
