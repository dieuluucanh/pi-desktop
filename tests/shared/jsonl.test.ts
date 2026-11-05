import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../src/shared/jsonl";

/** Accepts lines that start with "ok" and drops everything else. */
function decoder(maxBytes = 64): JsonlDecoder<string> {
  return new JsonlDecoder<string>((line) => (line.startsWith("ok") ? line : null), maxBytes);
}

describe("JsonlDecoder", () => {
  it("splits one chunk into frames and keeps the partial tail", () => {
    const instance = decoder();
    const first = instance.push("ok 1\nok 2\nok 3");
    expect(first).toEqual({ frames: ["ok 1", "ok 2"], overflow: false });
    expect(instance.push("\n")).toEqual({ frames: ["ok 3"], overflow: false });
  });

  it("drops a line the decoder rejects without reporting overflow", () => {
    const instance = decoder();
    expect(instance.push("nope\nok\n")).toEqual({ frames: ["ok"], overflow: false });
  });

  it("drops an oversized complete frame and resynchronises", () => {
    const instance = decoder(8);
    const atCap = `ok${"x".repeat(6)}`;
    expect(instance.push(`${atCap}\nok\n`)).toEqual({ frames: [atCap, "ok"], overflow: false });
    const oversized = `ok${"x".repeat(18)}`;
    expect(instance.push(`${oversized}\nok\n`)).toEqual({ frames: ["ok"], overflow: true });
  });

  it("drops an oversized partial frame until the newline arrives", () => {
    const instance = decoder(8);
    expect(instance.push("x".repeat(12))).toEqual({ frames: [], overflow: true });
    expect(instance.push("more\nok\n")).toEqual({ frames: ["ok"], overflow: true });
  });

  it("resets to a clean buffer", () => {
    const instance = decoder();
    instance.push("ok 1\nok 2");
    instance.reset();
    expect(instance.push("ok 3\n")).toEqual({ frames: ["ok 3"], overflow: false });
  });

  it("returns no frames for an empty chunk", () => {
    expect(decoder().push("")).toEqual({ frames: [], overflow: false });
  });
});
