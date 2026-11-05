import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  decodeTerminalFrame,
  encodeTerminalFrame,
  isTerminalId,
  isTerminalMethod,
  isTerminalSize,
  isValidTerminalSpawnSpec,
  MAX_TERMINAL_FRAME_BYTES,
  MAX_TERMINAL_INPUT_BYTES,
  TERMINAL_HIGH_WATER_BYTES,
  TERMINAL_LOW_WATER_BYTES,
  TERMINAL_OUTPUT_BATCH_BYTES,
  TERMINAL_REPLAY_BYTES,
  terminalChunkBase64Length,
  terminalInputBytes,
  type TerminalSpawnSpec,
} from "../../src/shared/terminal-protocol";

function spec(overrides: Partial<TerminalSpawnSpec> = {}): TerminalSpawnSpec {
  return {
    cwd: "C:\\work\\app",
    shell: "C:\\Windows\\System32\\cmd.exe",
    args: [],
    env: { TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    ...overrides,
  };
}

describe("terminal frame codec", () => {
  it("round-trips a request, a response and an event", () => {
    const request = {
      id: 1,
      method: "terminal.write" as const,
      params: { terminalId: "t-1", data: "ls\r" },
    };
    const response = { id: 1, result: { id: "t-1" } };
    const event = {
      event: "terminal.data" as const,
      payload: { terminalId: "t-1", seq: 3, data: "aGk=", bytes: 2 },
    };

    expect(decodeTerminalFrame(encodeTerminalFrame(request).trimEnd())).toEqual(request);
    expect(decodeTerminalFrame(encodeTerminalFrame(response).trimEnd())).toEqual({
      ...response,
      result: { id: "t-1" },
    });
    expect(decodeTerminalFrame(encodeTerminalFrame(event).trimEnd())).toEqual(event);
  });

  it("preserves a response error", () => {
    const frame = { id: 7, error: { code: "spawn_failed" as const, message: "not found" } };
    expect(decodeTerminalFrame(encodeTerminalFrame(frame).trimEnd())).toEqual(frame);
  });

  it("returns null for blank, malformed, array and unknown shapes", () => {
    expect(decodeTerminalFrame("")).toBeNull();
    expect(decodeTerminalFrame("{")).toBeNull();
    expect(decodeTerminalFrame("[]")).toBeNull();
    expect(decodeTerminalFrame("null")).toBeNull();
    expect(decodeTerminalFrame('{"id":1}')).toBeNull();
    expect(decodeTerminalFrame('{"id":"1","method":"terminal.open"}')).toBeNull();
    expect(decodeTerminalFrame('{"id":-1,"method":"terminal.open"}')).toBeNull();
  });

  it("keeps an unknown method so the dispatcher can answer bad_request", () => {
    const decoded = decodeTerminalFrame('{"id":4,"method":"terminal.nope","params":{}}');
    expect(decoded).toMatchObject({ id: 4, method: "terminal.nope" });
    expect(isTerminalMethod((decoded as { method: string }).method)).toBe(false);
  });

  it("knows the terminal method allowlist", () => {
    expect(isTerminalMethod("terminal.open")).toBe(true);
    expect(isTerminalMethod("terminal.ack")).toBe(true);
    expect(isTerminalMethod("terminal.spawn")).toBe(false);
    expect(isTerminalMethod("session.create")).toBe(false);
  });
});

describe("terminal ids and sizes", () => {
  it("accepts host-generated ids only", () => {
    expect(isTerminalId("t-1")).toBe(true);
    expect(isTerminalId("a_b-c9")).toBe(true);
    expect(isTerminalId("")).toBe(false);
    expect(isTerminalId("t 1")).toBe(false);
    expect(isTerminalId("t/1")).toBe(false);
    expect(isTerminalId("x".repeat(65))).toBe(false);
    expect(isTerminalId(7)).toBe(false);
  });

  it("requires whole cols/rows inside the supported range", () => {
    expect(isTerminalSize(80, 24)).toBe(true);
    expect(isTerminalSize(1, 1)).toBe(true);
    expect(isTerminalSize(500, 300)).toBe(true);
    expect(isTerminalSize(0, 24)).toBe(false);
    expect(isTerminalSize(80.5, 24)).toBe(false);
    expect(isTerminalSize(501, 24)).toBe(false);
    expect(isTerminalSize("80", 24)).toBe(false);
  });
});

describe("spawn spec validation", () => {
  it("accepts a well-formed spec", () => {
    expect(isValidTerminalSpawnSpec(spec())).toBe(true);
  });

  it("rejects a missing or empty shell, cwd, name or size", () => {
    expect(isValidTerminalSpawnSpec({ ...spec(), shell: "" })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), cwd: "" })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), name: "" })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), cols: 0 })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), rows: 1000 })).toBe(false);
    expect(isValidTerminalSpawnSpec(null)).toBe(false);
    expect(isValidTerminalSpawnSpec([])).toBe(false);
  });

  it("rejects non-string argv and env entries", () => {
    expect(isValidTerminalSpawnSpec({ ...spec(), args: ["--login", 3] })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), env: { TERM: 1 } })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), env: { "BAD=KEY": "x" } })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), env: { "BAD\nKEY": "x" } })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), env: [] })).toBe(false);
  });

  it("accepts Windows environment names that are not POSIX identifiers", () => {
    expect(
      isValidTerminalSpawnSpec({
        ...spec(),
        env: {
          TERM: "xterm-256color",
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
          CommonProgramW6432: "C:\\Program Files\\Common Files",
        },
      }),
    ).toBe(true);
  });

  it("rejects NUL bytes in a path or environment value", () => {
    expect(isValidTerminalSpawnSpec({ ...spec(), cwd: "C:\\x\0y" })).toBe(false);
    expect(isValidTerminalSpawnSpec({ ...spec(), env: { TERM: "xterm\0" } })).toBe(false);
  });
});

describe("base64 chunks", () => {
  it("round-trips every byte value and an empty chunk", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
    expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it("round-trips a 64 KiB chunk", () => {
    const chunk = Uint8Array.from({ length: 64 * 1024 }, (_, index) => (index * 31) % 256);
    expect(base64ToBytes(bytesToBase64(chunk))).toEqual(chunk);
  });

  it("predicts the encoded length of an output batch", () => {
    const chunk = new Uint8Array(TERMINAL_OUTPUT_BATCH_BYTES);
    expect(bytesToBase64(chunk).length).toBe(terminalChunkBase64Length(chunk.length));
  });

  it("throws on a malformed payload instead of silently decoding", () => {
    expect(() => base64ToBytes("!!!!")).toThrow();
  });
});

describe("limits", () => {
  it("keeps the water marks ordered and inside one frame", () => {
    expect(TERMINAL_LOW_WATER_BYTES).toBeLessThan(TERMINAL_HIGH_WATER_BYTES);
    expect(TERMINAL_REPLAY_BYTES).toBeLessThanOrEqual(TERMINAL_HIGH_WATER_BYTES);
    // Base64 expansion must leave room under the frame cap.
    expect(terminalChunkBase64Length(TERMINAL_OUTPUT_BATCH_BYTES)).toBeLessThan(
      MAX_TERMINAL_FRAME_BYTES,
    );
    expect(MAX_TERMINAL_INPUT_BYTES).toBeLessThan(MAX_TERMINAL_FRAME_BYTES);
  });

  it("measures writes in UTF-8 bytes, not code units", () => {
    expect(terminalInputBytes("abc")).toBe(3);
    expect(terminalInputBytes("é")).toBe(2);
    expect(terminalInputBytes("🙂")).toBe(4);
  });
});
