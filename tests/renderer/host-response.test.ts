/**
 * Renderer-side spilled-response decoding (session browser fix, 2026-11-05).
 *
 * The host replaces any response at or above 1 MiB with `{ $blob, bytes }`.
 * The browser, transcript hydration and tree all read a field off the response;
 * this wrapper is the one place that fetches the blob back and parses it.
 */

import { describe, expect, it, vi } from "vitest";
import type { PiDesktopBridge } from "../../src/shared/ipc";
import type { SessionRequestInput } from "../../src/shared/session-ipc";
import {
  readBlobText,
  resolveBlobResult,
  wrapBridgeWithBlobResolution,
} from "../../src/renderer/src/state/host-response";

type Handler = (params?: unknown) => Promise<unknown>;

function fakeBridge(handlers: Record<string, Handler>): {
  api: PiDesktopBridge;
  calls: Array<Pick<SessionRequestInput, "method" | "params">>;
} {
  const calls: Array<Pick<SessionRequestInput, "method" | "params">> = [];
  const api = {
    sessions: {
      request: vi.fn(async (input: SessionRequestInput) => {
        calls.push({ method: input.method, params: input.params });
        const handler = handlers[input.method];
        if (!handler) throw new Error(`unexpected host method ${input.method}`);
        return handler(input.params);
      }),
    },
  } as unknown as PiDesktopBridge;
  return { api, calls };
}

function chunk(contents: string, offset: number, done: boolean, size = offset + contents.length) {
  return {
    path: "/blobs/session.json",
    contents,
    offset,
    nextOffset: offset + contents.length,
    size,
    done,
  };
}

describe("resolveBlobResult", () => {
  it("fetches and parses a one-chunk spill", async () => {
    const { api, calls } = fakeBridge({
      "messages.get": async () => ({ $blob: "/blobs/session.json", bytes: 42 }),
      "host.blobs.read": async () => chunk('{"messages":[1,2]}', 0, true),
    });

    await expect(
      resolveBlobResult(api, "tab-1", { $blob: "/blobs/session.json", bytes: 42 }),
    ).resolves.toEqual({ messages: [1, 2] });
    expect(calls.map((call) => call.method)).toEqual(["host.blobs.read"]);
  });

  it("concatenates multiple chunks", async () => {
    const { api } = fakeBridge({
      "host.blobs.read": async (params) => {
        const offset = (params as { offset?: number }).offset ?? 0;
        if (offset === 0) return chunk('{"sessions":["a"', 0, false, 22);
        return chunk(',"b"]}', 16, true, 22);
      },
    });

    await expect(
      resolveBlobResult(api, "tab-1", { $blob: "/blobs/session.json", bytes: 22 }),
    ).resolves.toEqual({ sessions: ["a", "b"] });
  });

  it("accepts a legacy full read without a done field", async () => {
    const { api } = fakeBridge({
      "host.blobs.read": async () => ({
        path: "/blobs/session.json",
        contents: '{"ok":true}',
      }),
    });

    await expect(
      resolveBlobResult(api, "tab-1", { $blob: "/blobs/session.json", bytes: 11 }),
    ).resolves.toEqual({ ok: true });
  });

  it("passes non-spilled results through untouched", async () => {
    const { api, calls } = fakeBridge({});
    await expect(resolveBlobResult(api, "tab-1", { sessions: [] })).resolves.toEqual({
      sessions: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid JSON with a clear error", async () => {
    const { api } = fakeBridge({
      "host.blobs.read": async () => chunk("not-json", 0, true),
    });
    await expect(
      resolveBlobResult(api, "tab-1", { $blob: "/blobs/session.json", bytes: 8 }),
    ).rejects.toThrow(/unreadable spilled result/i);
  });
});

describe("readBlobText", () => {
  it("rejects a blob that keeps returning the same offset", async () => {
    const { api } = fakeBridge({
      "host.blobs.read": async () => ({
        path: "/blobs/session.json",
        contents: "a",
        offset: 0,
        nextOffset: 0,
        size: 2,
        done: false,
      }),
    });
    await expect(
      readBlobText(api, "tab-1", { $blob: "/blobs/session.json", bytes: 2 }),
    ).rejects.toThrow(/unreadable spilled result/i);
  });

  it("rejects a chunk that belongs to another path", async () => {
    const { api } = fakeBridge({
      "host.blobs.read": async () => ({
        ...chunk("a", 0, true),
        path: "/blobs/other.json",
      }),
    });
    await expect(
      readBlobText(api, "tab-1", { $blob: "/blobs/session.json", bytes: 1 }),
    ).rejects.toThrow(/unreadable spilled result/i);
  });

  it("enforces the character budget", async () => {
    const { api } = fakeBridge({
      "host.blobs.read": async () => chunk("abcd", 0, false, 100),
    });
    await expect(
      readBlobText(api, "tab-1", { $blob: "/blobs/session.json", bytes: 100 }, { maxChars: 3 }),
    ).rejects.toThrow(/too large to read back/i);
  });

  it("enforces the chunk limit", async () => {
    const { api } = fakeBridge({
      "host.blobs.read": async (params) => {
        const offset = (params as { offset?: number }).offset ?? 0;
        return chunk("x", offset, false, 100);
      },
    });
    await expect(
      readBlobText(api, "tab-1", { $blob: "/blobs/session.json", bytes: 100 }, { maxChunks: 3 }),
    ).rejects.toThrow(/chunk limit/i);
  });
});

describe("wrapBridgeWithBlobResolution", () => {
  it("resolves every host response except host.blobs.read", async () => {
    const { api, calls } = fakeBridge({
      "session.list": async () => ({ $blob: "/blobs/session.json", bytes: 18 }),
      "host.blobs.read": async () => chunk('{"sessions":[]}', 0, true),
    });
    const bridge = wrapBridgeWithBlobResolution(api);

    await expect(
      bridge.sessions.request({ tabId: "control", method: "session.list" }),
    ).resolves.toEqual({ sessions: [] });
    expect(calls.map((call) => call.method)).toEqual(["session.list", "host.blobs.read"]);

    const passthrough = await bridge.sessions.request({
      tabId: "tab-1",
      method: "host.blobs.read",
      params: { path: "/blobs/session.json" },
    });
    expect(passthrough).toMatchObject({ contents: '{"sessions":[]}' });
    expect(calls.map((call) => call.method)).toEqual([
      "session.list",
      "host.blobs.read",
      "host.blobs.read",
    ]);
  });

  it("memoizes the wrapper for one raw bridge", () => {
    const { api } = fakeBridge({});
    expect(wrapBridgeWithBlobResolution(api)).toBe(wrapBridgeWithBlobResolution(api));
    const second = fakeBridge({}).api;
    expect(wrapBridgeWithBlobResolution(second)).not.toBe(wrapBridgeWithBlobResolution(api));
  });

  it("observes a later replacement of the raw request function", async () => {
    const { api } = fakeBridge({});
    const bridge = wrapBridgeWithBlobResolution(api);
    (api.sessions as unknown as { request: unknown }).request = async () => ({ sessions: [] });

    await expect(
      bridge.sessions.request({ tabId: "control", method: "session.list" }),
    ).resolves.toEqual({ sessions: [] });
  });
});
