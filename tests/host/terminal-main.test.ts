import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalCore } from "../../src/host/terminal-core";
import {
  TerminalLineReader,
  createHostRuntime,
  createTerminalHostService,
  dispatchTerminalRequest,
} from "../../src/host/terminal-main";
import {
  base64ToBytes,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalAttachResult,
  type TerminalFrame,
  type TerminalHostInfo,
  type TerminalRequestFrame,
  type TerminalResponseFrame,
  type TerminalSpawnSpec,
} from "../../src/shared/terminal-protocol";
import { createFakePtyPort, createFakeTreeKill } from "./fakes/pty";

function spec(overrides: Partial<TerminalSpawnSpec> = {}): TerminalSpawnSpec {
  return {
    cwd: "/work/app",
    shell: "/bin/bash",
    args: [],
    env: { TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    ...overrides,
  };
}

function createCore(options: { batchBytes?: number; batchMs?: number } = {}) {
  const pty = createFakePtyPort();
  const treeKill = createFakeTreeKill();
  const events: TerminalFrame[] = [];
  let nextId = 0;
  const core = new TerminalCore({
    pty,
    treeKill,
    emit: (frame) => events.push(frame),
    newId: () => `t-${(nextId += 1)}`,
    batchBytes: options.batchBytes ?? 1024,
    batchMs: options.batchMs ?? 10_000,
    replayBytes: 64,
  });
  return { core, pty, treeKill, events };
}

function request(
  overrides: Partial<TerminalRequestFrame> & { method: TerminalRequestFrame["method"] },
) {
  return { id: 1, ...overrides } as TerminalRequestFrame;
}

function errorOf(response: TerminalResponseFrame): string | undefined {
  return response.error?.code;
}

describe("dispatchTerminalRequest", () => {
  it("opens, lists, writes, resizes, acks and closes", () => {
    const { core, pty } = createCore();
    const opened = dispatchTerminalRequest(
      core,
      request({ method: "terminal.open", params: { spec: spec() } }),
    );
    expect(opened.error).toBeUndefined();
    expect(opened.result).toMatchObject({ id: "t-1", pid: 100, cols: 80, rows: 24 });

    const list = dispatchTerminalRequest(core, request({ method: "terminal.list" }));
    expect(list.result).toHaveLength(1);

    expect(
      dispatchTerminalRequest(
        core,
        request({ method: "terminal.write", params: { terminalId: "t-1", data: "ls\r" } }),
      ),
    ).toEqual({ id: 1, result: {} });
    expect(pty.processes[0]?.writes).toEqual(["ls\r"]);

    dispatchTerminalRequest(
      core,
      request({ method: "terminal.resize", params: { terminalId: "t-1", cols: 100, rows: 40 } }),
    );
    expect(pty.processes[0]?.resizes).toEqual([[100, 40]]);

    dispatchTerminalRequest(
      core,
      request({ method: "terminal.ack", params: { terminalId: "t-1", bytes: 12 } }),
    );

    const closed = dispatchTerminalRequest(
      core,
      request({ method: "terminal.close", params: { terminalId: "t-1", force: true } }),
    );
    expect(closed.result).toEqual({ closed: true });
    const again = dispatchTerminalRequest(
      core,
      request({ method: "terminal.close", params: { terminalId: "t-1" } }),
    );
    expect(again.result).toEqual({ closed: false });
  });

  it("returns a replay snapshot for attach, and null once the terminal is gone", () => {
    const { core, pty } = createCore({ batchBytes: 1024 });
    dispatchTerminalRequest(core, request({ method: "terminal.open", params: { spec: spec() } }));
    pty.processes[0]?.emitData("hello");

    const attached = dispatchTerminalRequest(
      core,
      request({ method: "terminal.attach", params: { terminalId: "t-1" } }),
    );
    const snapshot = attached.result as TerminalAttachResult;
    expect(snapshot.bytes).toBe(5);
    expect(new TextDecoder().decode(base64ToBytes(snapshot.data))).toBe("hello");

    dispatchTerminalRequest(
      core,
      request({ method: "terminal.close", params: { terminalId: "t-1", force: true } }),
    );
    const gone = dispatchTerminalRequest(
      core,
      request({ method: "terminal.attach", params: { terminalId: "t-1" } }),
    );
    expect(gone.result).toBeNull();
  });

  it("answers an unknown method with bad_request", () => {
    const { core } = createCore();
    const response = dispatchTerminalRequest(
      core,
      request({ method: "terminal.nope" as TerminalRequestFrame["method"] }),
    );
    expect(errorOf(response)).toBe("bad_request");
  });

  it("turns a core failure into a typed frame error", () => {
    const { core } = createCore();
    const missing = dispatchTerminalRequest(
      core,
      request({ method: "terminal.write", params: { terminalId: "t-9", data: "x" } }),
    );
    expect(missing.error).toMatchObject({ code: "not_found" });

    const badParams = dispatchTerminalRequest(
      core,
      request({ method: "terminal.write", params: { data: "x" } }),
    );
    expect(errorOf(badParams)).toBe("bad_request");

    const noParams = dispatchTerminalRequest(core, request({ method: "terminal.resize" }));
    expect(errorOf(noParams)).toBe("bad_request");
  });

  it("reports a spawn failure without throwing", () => {
    const { core, pty } = createCore();
    pty.failNext = new Error("ENOENT");
    const response = dispatchTerminalRequest(
      core,
      request({ method: "terminal.open", params: { spec: spec() } }),
    );
    expect(response.error).toMatchObject({ code: "spawn_failed" });
  });
});

describe("terminal.info", () => {
  it("reports the host info it was given, including a failed native load", () => {
    const { core } = createCore();
    const info: TerminalHostInfo = {
      protocol: 1,
      platform: "linux",
      arch: "x64",
      node: "v24.22.2",
      pty: {
        loaded: false,
        path: null,
        candidates: [
          {
            path: "/app/node-pty/build/Release/pty.node",
            error: "version `GLIBC_2.42' not found",
          },
        ],
        error: "version `GLIBC_2.42' not found",
      },
    };
    expect(dispatchTerminalRequest(core, request({ method: "terminal.info" }), info)).toEqual({
      id: 1,
      result: info,
    });
  });

  it("answers with a not-probed report when the caller supplies none", () => {
    const { core } = createCore();
    const response = dispatchTerminalRequest(core, request({ method: "terminal.info" }));
    expect(response.result).toMatchObject({
      protocol: 1,
      pty: { loaded: false, error: "not reported" },
    });
  });

  it("keeps the host alive and answers terminal.open with native_unavailable", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: TerminalFrame[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        const frame = decodeTerminalFrame(line);
        if (frame) frames.push(frame);
      }
    });

    const runtime = createHostRuntime(
      {
        ok: false,
        error: "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.42' not found",
        candidates: [
          {
            path: "/app/node-pty/build/Release/pty.node",
            error: "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.42' not found",
          },
          { path: "/app/node-pty/prebuilds/linux-x64/pty.node", error: "Cannot find module" },
        ],
      },
      () => undefined,
    );

    const service = createTerminalHostService({
      core: async () => runtime,
      input,
      output,
    });

    input.write(encodeTerminalFrame({ id: 1, method: "terminal.info" }));
    input.write(encodeTerminalFrame({ id: 2, method: "terminal.open", params: { spec: spec() } }));
    await new Promise((resolve) => setImmediate(resolve));

    // The process is still serving: the info frame came first, then the typed
    // error, and nothing threw out of the read loop.
    expect(frames[0]).toMatchObject({ id: 1, result: { pty: { loaded: false } } });
    expect(frames[1]).toMatchObject({ id: 2, error: { code: "native_unavailable" } });
    expect((frames[1] as { error?: { message?: string } }).error?.message).toContain("GLIBC_2.42");

    // A later request is still answered (the failure is not sticky).
    input.write(encodeTerminalFrame({ id: 3, method: "terminal.list" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(frames[2]).toEqual({ id: 3, result: [] });

    service.dispose();
  });
});

describe("TerminalLineReader", () => {
  it("splits one chunk into several frames and keeps the partial tail", () => {
    const reader = new TerminalLineReader(1024);
    expect(reader.push('{"id":1}\n{"id":2}\n{"id":3')).toEqual(['{"id":1}', '{"id":2}']);
    expect(reader.push("}\n")).toEqual(['{"id":3}']);
  });

  it("strips a CR from a CRLF frame", () => {
    const reader = new TerminalLineReader(1024);
    expect(reader.push('{"id":1}\r\n')).toEqual(['{"id":1}']);
  });

  it("drops an oversized complete frame and resyncs", () => {
    const reader = new TerminalLineReader(8);
    // Exactly at the cap is still a valid frame.
    expect(reader.push(`${"x".repeat(8)}\nok\n`)).toEqual(["xxxxxxxx", "ok"]);
    expect(reader.push(`${"x".repeat(20)}\nok\n`)).toEqual(["ok"]);
  });

  it("drops an oversized partial frame once it exceeds the cap", () => {
    const reader = new TerminalLineReader(8);
    expect(reader.push("x".repeat(12))).toEqual([]);
    // The newline ends the dropped frame; the next line is delivered.
    expect(reader.push("\nok\n")).toEqual(["ok"]);
  });
});

describe("createTerminalHostService", () => {
  it("answers requests written to stdin and writes events to stdout", async () => {
    const { core, pty, events } = createCore({ batchBytes: 1 });
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: TerminalFrame[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        const frame = decodeTerminalFrame(line);
        if (frame) frames.push(frame);
      }
    });
    const service = createTerminalHostService({ core, input, output });

    input.write(encodeTerminalFrame({ id: 1, method: "terminal.open", params: { spec: spec() } }));
    input.write(
      encodeTerminalFrame({
        id: 2,
        method: "terminal.write",
        params: { terminalId: "t-1", data: "hi\r" },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(frames[0]).toMatchObject({ id: 1, result: { id: "t-1" } });
    expect(frames[1]).toEqual({ id: 2, result: {} });
    expect(pty.processes[0]?.writes).toEqual(["hi\r"]);

    pty.processes[0]?.emitData("out");
    await new Promise((resolve) => setImmediate(resolve));
    // The core's event sink is the host's own stdout writer; the test collects
    // the same frames in `events` and the responses in `frames`.
    expect(events.at(-1)).toMatchObject({ event: "terminal.data" });

    service.dispose();
    expect(pty.processes[0]?.kills).toEqual(["SIGKILL"]);
  });

  it("ignores malformed lines and frames that are not requests", async () => {
    const { core } = createCore();
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    createTerminalHostService({ core, input, output });

    input.write("not json\n");
    input.write(encodeTerminalFrame({ event: "terminal.data", payload: {} }));
    input.write(encodeTerminalFrame({ id: 9, result: {} }));
    input.write(encodeTerminalFrame({ id: 1, method: "terminal.list" }));
    await new Promise((resolve) => setImmediate(resolve));

    const frames = chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => decodeTerminalFrame(line))
      .filter((frame): frame is TerminalFrame => frame !== null);
    expect(frames).toEqual([{ id: 1, result: [] }]);
  });

  it("kills every PTY when stdin ends", async () => {
    const { core, pty } = createCore();
    const input = new PassThrough();
    const output = new PassThrough();
    createTerminalHostService({ core, input, output });

    input.write(encodeTerminalFrame({ id: 1, method: "terminal.open", params: { spec: spec() } }));
    input.end();
    // PassThrough emits `end` after the writable side flushes.
    await new Promise((resolve) => setImmediate(resolve));

    expect(pty.processes[0]?.kills).toEqual(["SIGKILL"]);
    expect(core.list()).toEqual([]);
  });

  it("disposes idempotently", () => {
    const { core } = createCore();
    const input = new PassThrough();
    const output = new PassThrough();
    const service = createTerminalHostService({ core, input, output });
    service.dispose();
    service.dispose();
    expect(core.list()).toEqual([]);
  });
});
