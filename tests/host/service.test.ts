import { PassThrough } from "node:stream";
import { join, normalize } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHostService, type HostServiceOptions } from "../../src/host/service";
import {
  decodeFrame,
  isBlobRef,
  type HostFrame,
  type HostResponseFrame,
} from "../../src/shared/host-protocol";

/**
 * Host-side protocol tests: dispatch, error mapping, blob spilling and the
 * shutdown handshake. Everything runs over in-memory streams.
 */

const BLOB_DIR = normalize("C:/blobs");

interface BlobReadResult {
  path: string;
  contents: string | null;
}

function isBlobReadResult(value: unknown): value is BlobReadResult {
  if (typeof value !== "object" || value === null || !("contents" in value)) return false;
  return typeof value.contents === "string" || value.contents === null;
}

function harness(options: Partial<HostServiceOptions> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  const blobs = new Map<string, string>();
  let shutdowns = 0;

  stdout.on("data", (chunk: Buffer) => {
    written.push(chunk.toString());
  });

  const service = createHostService({
    stdin,
    stdout,
    blobDir: BLOB_DIR,
    info: {
      sessionId: "session-1",
      cwd: normalize("C:/work"),
      bridgePort: 38618,
      nodeVersion: "v24.21.0",
      piVersion: "0.85.1",
      startedAt: 1_700_000_000_000,
    },
    writeBlob: async (name, contents) => {
      const path = join(BLOB_DIR, name);
      blobs.set(path, contents);
      return path;
    },
    readBlob: async (path) => blobs.get(path) ?? null,
    onShutdown: () => {
      shutdowns += 1;
    },
    ...options,
  });

  const frames = (): HostFrame[] =>
    written
      .join("")
      .split("\n")
      .map((line) => decodeFrame(line))
      .filter((frame): frame is HostFrame => frame !== null);

  const last = (): HostResponseFrame => {
    const response = frames().at(-1);
    if (!response || !("ok" in response)) throw new Error("no response frame written");
    return response;
  };

  /** The result of the last response; throws when the host answered with an error. */
  const lastResult = (): unknown => {
    const response = last();
    if (!response.ok)
      throw new Error(
        `expected ok, got ${response.error.code ?? "error"}: ${response.error.message}`,
      );
    return response.result;
  };

  return {
    service,
    frames,
    last,
    lastResult,
    blobs,
    shutdowns: () => shutdowns,
    send: async (line: string) => service.handleLine(line),
    request: async (id: number, method: string, params?: unknown) =>
      service.handleLine(
        JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
      ),
  };
}

describe("host service dispatch", () => {
  it("answers host.ping", async () => {
    const host = harness();
    await host.request(1, "host.ping");

    expect(host.last().ok).toBe(true);
    expect(host.lastResult()).toMatchObject({ pong: true });
  });

  it("reports its identity in host.hello", async () => {
    const host = harness();
    await host.request(1, "host.hello");

    expect(host.lastResult()).toMatchObject({
      protocolVersion: 1,
      nodeVersion: "v24.21.0",
      piVersion: "0.85.1",
      sessionId: "session-1",
      bridgePort: 38618,
      pids: { pid: process.pid },
    });
  });

  it("rejects an unknown method without dropping the connection", async () => {
    const host = harness();
    await host.request(1, "definitely.not.a.method");
    await host.request(2, "host.ping");

    const all = host.frames();
    expect(all[0]).toMatchObject({ id: 1, ok: false, error: { code: "unknown_method" } });
    expect(all[1]).toMatchObject({ id: 2, ok: true });
  });

  it("reports not_implemented for methods the session core owns (plan step 5)", async () => {
    const host = harness();
    await host.request(1, "session.create");

    expect(host.last()).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  });

  it("keeps an error's code and data when it crosses the frame boundary", async () => {
    // Package failures carry the captured npm output as `data`, and the UI needs
    // the code to tell "offline" from "not found" (plan step 14).
    const host = harness({
      handlers: {
        "packages.list": () => {
          const error = new Error("npm ERR! code ENOTFOUND") as Error & {
            code: string;
            data: unknown;
          };
          error.code = "offline";
          error.data = { output: "npm ERR! code ENOTFOUND" };
          throw error;
        },
      },
    });
    await host.request(1, "packages.list");

    expect(host.last()).toMatchObject({
      ok: false,
      error: { code: "offline", data: { output: "npm ERR! code ENOTFOUND" } },
    });
  });

  it("lets injected handlers answer a method", async () => {
    const host = harness({
      handlers: {
        "state.get": () => ({ model: "claude-sonnet", streaming: false }),
      },
    });

    await host.request(7, "state.get");

    expect(host.last()).toEqual({
      id: 7,
      ok: true,
      result: { model: "claude-sonnet", streaming: false },
    });
  });

  it("maps a thrown handler error to an error frame", async () => {
    const host = harness({
      handlers: {
        prompt: () => {
          throw new Error("no session");
        },
      },
    });

    await host.request(3, "prompt", { text: "hi" });

    expect(host.last()).toMatchObject({ id: 3, ok: false, error: { message: "no session" } });
  });

  it("handles the shutdown handshake", async () => {
    const host = harness();
    await host.request(9, "host.shutdown");

    expect(host.last()).toMatchObject({ id: 9, ok: true });
    expect(host.shutdowns()).toBe(1);
  });
});

describe("host service blob cache", () => {
  it("spills an oversized result and hands back a blob reference", async () => {
    const big = "x".repeat(1024 * 1024 + 16);
    const host = harness({ handlers: { "messages.get": () => ({ text: big }) } });

    await host.request(1, "messages.get", { limit: 1 });

    const result = host.lastResult();
    expect(isBlobRef(result)).toBe(true);
    if (!isBlobRef(result)) throw new Error("expected a blob reference");
    expect(result.bytes).toBeGreaterThan(1024 * 1024);
    expect(host.blobs.has(result.$blob)).toBe(true);
  });

  it("keeps a small result inline", async () => {
    const host = harness({ handlers: { "state.get": () => ({ ok: true }) } });
    await host.request(1, "state.get");

    expect(host.lastResult()).toEqual({ ok: true });
  });

  it("reads a spilled blob back", async () => {
    const host = harness({
      handlers: { "messages.get": () => ({ text: "y".repeat(1024 * 1024 + 1) }) },
    });
    await host.request(1, "messages.get");
    const ref = host.lastResult();
    if (!isBlobRef(ref)) throw new Error("expected a blob reference");

    await host.request(2, "host.blobs.read", { path: ref.$blob });

    const result = host.lastResult();
    expect(isBlobReadResult(result)).toBe(true);
    if (!isBlobReadResult(result)) throw new Error("expected blob contents");
    expect(result.contents?.length).toBeGreaterThan(1024 * 1024);
  });

  it("refuses to read outside the blob directory", async () => {
    const host = harness();
    await host.request(1, "host.blobs.read", { path: normalize("C:/secrets/auth.json") });

    expect(host.last()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("refuses a sibling whose name merely shares the blob directory's prefix", async () => {
    // `C:/blobs-evil/x.json` starts with `C:/blobs`; a prefix check would let it
    // through, the containment check does not (plan step 23).
    const host = harness();
    await host.request(1, "host.blobs.read", { path: normalize("C:/blobs-evil/x.json") });
    expect(host.last()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("requires a path", async () => {
    const host = harness();
    await host.request(1, "host.blobs.read", {});
    expect(host.last()).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});

describe("host service resource metrics (plan step 24)", () => {
  it("reports a fixed memory sample supplied by the reader", async () => {
    const host = harness({
      readMemory: () => ({
        rssBytes: 424_242,
        heapUsedBytes: 100,
        heapTotalBytes: 200,
        uptimeMs: 9_000,
        at: 1_700_000_000_000,
      }),
    });

    await host.request(1, "host.metrics");

    expect(host.lastResult()).toEqual({
      rssBytes: 424_242,
      heapUsedBytes: 100,
      heapTotalBytes: 200,
      uptimeMs: 9_000,
      at: 1_700_000_000_000,
    });
  });

  it("samples this process's own RSS by default", async () => {
    const host = harness();
    await host.request(1, "host.metrics");
    const result = host.lastResult() as { rssBytes?: unknown; heapUsedBytes?: unknown };
    expect(typeof result.rssBytes).toBe("number");
    expect(result.rssBytes as number).toBeGreaterThan(0);
    expect(typeof result.heapUsedBytes).toBe("number");
  });
});

describe("host service event spilling (plan step 24)", () => {
  it("spills an oversized event field in place, keeping the event identity", async () => {
    const host = harness();

    host.service.emit("tool_execution_end", {
      toolName: "read",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "y".repeat(1024 * 1024 + 1) }] },
    });

    await vi.waitFor(() => {
      expect(
        host.frames().some((frame) => "event" in frame && frame.event === "tool_execution_end"),
      ).toBe(true);
    });
    const frame = host
      .frames()
      .find((entry) => "event" in entry && entry.event === "tool_execution_end");
    if (!frame || !("event" in frame)) throw new Error("no event frame");
    const payload = frame.payload as { toolName?: unknown; toolCallId?: unknown; result?: unknown };

    // The card still knows which tool ran; only the body became a reference.
    expect(payload.toolName).toBe("read");
    expect(payload.toolCallId).toBe("call-1");
    expect(isBlobRef(payload.result)).toBe(true);

    // And the blob reads back on demand.
    if (!isBlobRef(payload.result)) throw new Error("expected a blob ref");
    await host.request(1, "host.blobs.read", { path: payload.result.$blob });
    const read = host.lastResult() as { contents?: string | null };
    expect(read.contents?.length).toBeGreaterThan(1024 * 1024);
  });

  it("keeps small events untouched and their order", async () => {
    const host = harness();
    host.service.emit("message_update", { delta: "a" });
    host.service.emit("message_update", { delta: "b" });
    host.service.emit("message_end", { message: { role: "assistant" } });

    await vi.waitFor(() => {
      expect(host.frames().filter((frame) => "event" in frame)).toHaveLength(3);
    });
    const events = host
      .frames()
      .filter((frame): frame is { event: string; payload: unknown } => "event" in frame)
      .map((frame) => frame.event);
    expect(events).toEqual(["message_update", "message_update", "message_end"]);
  });
});
