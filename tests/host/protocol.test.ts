import { describe, expect, it } from "vitest";
import {
  HOST_METHODS,
  HOST_PROTOCOL_VERSION,
  JsonlFrameDecoder,
  byteLength,
  decodeFrame,
  encodeFrame,
  exceedsThreshold,
  isBlobRef,
  isEventFrame,
  isHostMethod,
  isRequestFrame,
  isResponseFrame,
  type HostFrame,
} from "../../src/shared/host-protocol";

describe("frame codec", () => {
  it("round-trips every frame kind", () => {
    const frames: HostFrame[] = [
      { id: 1, method: "host.ping" },
      { id: 1, ok: true, result: { pong: true } },
      { id: 2, ok: false, error: { message: "boom", code: "host_error" } },
      { event: "agent_start", sessionId: "s1", payload: { at: 1 } },
    ];

    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("answers null for blank or malformed lines instead of throwing", () => {
    expect(decodeFrame("")).toBeNull();
    expect(decodeFrame("   ")).toBeNull();
    expect(decodeFrame("{not json")).toBeNull();
    expect(decodeFrame("[1,2,3]")).toBeNull();
    expect(decodeFrame("42")).toBeNull();
  });

  it("classifies frames", () => {
    expect(isRequestFrame({ id: 1, method: "host.ping" })).toBe(true);
    expect(isResponseFrame({ id: 1, ok: true, result: null })).toBe(true);
    expect(isEventFrame({ event: "turn_end" })).toBe(true);
    expect(isRequestFrame({ event: "turn_end" })).toBe(false);
  });
});

describe("JsonlFrameDecoder", () => {
  it("emits frames split across chunks", () => {
    const decoder = new JsonlFrameDecoder();
    const first = decoder.push('{"id":1,"method":"host.pi');
    expect(first.frames).toEqual([]);

    const second = decoder.push('ng"}\n{"event":"x"}\n');
    expect(second.frames).toEqual([{ id: 1, method: "host.ping" }, { event: "x" }]);
    expect(second.overflow).toBe(false);
  });

  it("ignores blank lines and keeps the remainder buffered", () => {
    const decoder = new JsonlFrameDecoder();
    const result = decoder.push('\n\n{"event":"a"}\n{"event":');

    expect(result.frames).toEqual([{ event: "a" }]);
    expect(decoder.push('"b"}\n').frames).toEqual([{ event: "b" }]);
  });

  it("reports an oversized frame once and resynchronises", () => {
    const decoder = new JsonlFrameDecoder(64);
    const overflow = decoder.push(`${"x".repeat(200)}\n{"event":"after"}\n`);

    expect(overflow.overflow).toBe(true);
    expect(overflow.frames).toEqual([{ event: "after" }]);
  });
});

describe("host methods", () => {
  it("recognises only known methods", () => {
    expect(isHostMethod("host.ping")).toBe(true);
    expect(isHostMethod("session.create")).toBe(true);
    expect(isHostMethod("nope")).toBe(false);
    expect(isHostMethod(null)).toBe(false);
  });

  it("covers the transport methods the supervisor relies on", () => {
    for (const method of ["host.hello", "host.ping", "host.shutdown", "host.blobs.read"]) {
      expect(HOST_METHODS).toContain(method);
    }
    expect(HOST_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe("sizing helpers", () => {
  it("measures utf-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
  });

  it("flags values above the spill threshold", () => {
    expect(exceedsThreshold({ small: true }, 1024)).toBe(false);
    expect(exceedsThreshold({ big: "x".repeat(2048) }, 1024)).toBe(true);
  });

  it("recognises blob references", () => {
    expect(isBlobRef({ $blob: "C:/cache/1.json", bytes: 10 })).toBe(true);
    expect(isBlobRef({ $blob: "C:/cache/1.json" })).toBe(false);
    expect(isBlobRef({ bytes: 10 })).toBe(false);
    expect(isBlobRef(null)).toBe(false);
  });
});
