import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalCore,
  TerminalCoreError,
  TerminalRingBuffer,
  type TerminalCoreOptions,
} from "../../src/host/terminal-core";
import {
  base64ToBytes,
  MAX_TERMINAL_INPUT_BYTES,
  type TerminalAttachResult,
  type TerminalDataEvent,
  type TerminalEventFrame,
  type TerminalExitEvent,
  type TerminalSpawnSpec,
} from "../../src/shared/terminal-protocol";
import { createFakePtyPort, createFakeTreeKill } from "./fakes/pty";

function spec(overrides: Partial<TerminalSpawnSpec> = {}): TerminalSpawnSpec {
  return {
    cwd: "/work/app",
    shell: "/bin/bash",
    args: ["-l"],
    env: { TERM: "xterm-256color", PATH: "/usr/bin" },
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    ...overrides,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(payload: TerminalDataEvent): string {
  return new TextDecoder().decode(base64ToBytes(payload.data));
}

function dataEvents(events: TerminalEventFrame[]): TerminalDataEvent[] {
  return events
    .filter((event) => event.event === "terminal.data")
    .map((event) => event.payload as TerminalDataEvent);
}

function exitEvents(events: TerminalEventFrame[]): TerminalExitEvent[] {
  return events
    .filter((event) => event.event === "terminal.exit")
    .map((event) => event.payload as TerminalExitEvent);
}

function createCore(overrides: Partial<TerminalCoreOptions> = {}) {
  const pty = createFakePtyPort();
  const treeKill = createFakeTreeKill();
  const events: TerminalEventFrame[] = [];
  let nextId = 0;
  const core = new TerminalCore({
    pty,
    treeKill,
    emit: (frame) => events.push(frame),
    newId: () => `t-${(nextId += 1)}`,
    batchBytes: 4,
    batchMs: 1000,
    highWaterBytes: 1024,
    lowWaterBytes: 256,
    replayBytes: 64,
    closeGraceMs: 2000,
    ...overrides,
  });
  return { core, pty, treeKill, events };
}

function codeOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof TerminalCoreError ? error.code : "not-a-core-error";
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalCore.open", () => {
  it("spawns the shell and returns its identity", () => {
    const { core, pty } = createCore();
    const info = core.open(spec({ shell: "/bin/zsh", cols: 100, rows: 40 }));
    expect(info).toEqual({
      id: "t-1",
      pid: 100,
      title: "zsh",
      cwd: "/work/app",
      cols: 100,
      rows: 40,
    });
    expect(pty.inputs).toHaveLength(1);
    expect(pty.inputs[0]).toMatchObject({
      shell: "/bin/zsh",
      args: ["-l"],
      cwd: "/work/app",
      cols: 100,
      rows: 40,
      name: "xterm-256color",
    });
    expect(core.list()).toEqual([info]);
  });

  it("keeps a Windows shell basename as the title", () => {
    const { core } = createCore();
    expect(core.open(spec({ shell: "C:\\Windows\\System32\\cmd.exe" })).title).toBe("cmd.exe");
  });

  it("rejects an invalid spec before spawning anything", () => {
    const { core, pty } = createCore();
    expect(codeOf(() => core.open(spec({ shell: "" })))).toBe("bad_request");
    expect(codeOf(() => core.open(spec({ cols: 0 })))).toBe("bad_request");
    expect(pty.inputs).toHaveLength(0);
    expect(core.list()).toEqual([]);
  });

  it("reports a spawn failure as spawn_failed and registers nothing", () => {
    const { core, pty } = createCore();
    pty.failNext = new Error("ENOENT: no such shell");
    expect(codeOf(() => core.open(spec()))).toBe("spawn_failed");
    expect(core.list()).toEqual([]);
  });

  it("keeps a typed port failure instead of relabelling it", () => {
    const { core, pty } = createCore();
    pty.failNext = new TerminalCoreError(
      "node-pty could not be loaded: version `GLIBC_2.42' not found",
      "native_unavailable",
    );
    expect(codeOf(() => core.open(spec()))).toBe("native_unavailable");
    expect(core.list()).toEqual([]);
  });

  it("enforces the per-window terminal limit", () => {
    const { core } = createCore({ maxTerminals: 1 });
    core.open(spec());
    expect(codeOf(() => core.open(spec()))).toBe("limit");
    expect(core.list()).toHaveLength(1);
  });
});

describe("TerminalCore output batching", () => {
  it("coalesces small chunks until the batch timer fires", () => {
    vi.useFakeTimers();
    const { core, pty, events } = createCore({ batchBytes: 1024, batchMs: 16 });
    const id = core.open(spec()).id;
    pty.processes[0]?.emitData("ab");
    pty.processes[0]?.emitData("cd");
    expect(dataEvents(events)).toHaveLength(0);

    vi.advanceTimersByTime(16);
    const [first] = dataEvents(events);
    expect(first).toMatchObject({ terminalId: id, seq: 1, bytes: 4 });
    expect(text(first!)).toBe("abcd");
  });

  it("splits a large chunk into batch-sized frames", () => {
    vi.useFakeTimers();
    const { core, pty, events } = createCore({ batchBytes: 4, batchMs: 1000 });
    core.open(spec());
    pty.processes[0]?.emitData("abcdefghij");

    // Two full batches flush immediately; the 2-byte tail waits for the timer.
    expect(dataEvents(events).map((payload) => payload.bytes)).toEqual([4, 4]);
    vi.advanceTimersByTime(1000);

    const payloads = dataEvents(events);
    expect(payloads.map((payload) => payload.bytes)).toEqual([4, 4, 2]);
    expect(payloads.map(text).join("")).toBe("abcdefghij");
    expect(payloads.map((payload) => payload.seq)).toEqual([1, 2, 3]);
  });

  it("keeps sequence numbers independent per terminal", () => {
    const { core, pty, events } = createCore({ batchBytes: 1 });
    core.open(spec());
    core.open(spec());
    pty.processes[0]?.emitData("a");
    pty.processes[1]?.emitData("b");
    pty.processes[0]?.emitData("c");
    expect(dataEvents(events).map((payload) => [payload.terminalId, payload.seq])).toEqual([
      ["t-1", 1],
      ["t-2", 1],
      ["t-1", 2],
    ]);
  });
});

describe("TerminalCore flow control", () => {
  it("pauses at the high-water mark and resumes on ack", () => {
    const { core, pty, events } = createCore({
      batchBytes: 4,
      highWaterBytes: 8,
      lowWaterBytes: 4,
    });
    const id = core.open(spec()).id;
    pty.processes[0]?.emitData("abcdefghijkl");

    expect(dataEvents(events).map(text)).toEqual(["abcd", "efgh"]);
    expect(pty.processes[0]?.pauseCount).toBe(1);
    expect(pty.processes[0]?.paused).toBe(true);

    core.ack(id, 8);
    expect(pty.processes[0]?.resumeCount).toBe(1);
    expect(pty.processes[0]?.paused).toBe(false);
    expect(dataEvents(events).map(text)).toEqual(["abcd", "efgh", "ijkl"]);
  });

  it("clamps an oversized ack and ignores an unknown terminal", () => {
    const { core, pty, events } = createCore({
      batchBytes: 4,
      highWaterBytes: 8,
      lowWaterBytes: 4,
    });
    const id = core.open(spec()).id;
    pty.processes[0]?.emitData("abcdefgh");
    expect(pty.processes[0]?.pauseCount).toBe(1);

    core.ack(id, 10_000);
    expect(pty.processes[0]?.resumeCount).toBe(1);
    const before = dataEvents(events).length;
    core.ack(id, 5);
    core.ack("t-999", 5);
    core.ack(id, Number.NaN);
    core.ack(id, -1);
    expect(dataEvents(events)).toHaveLength(before);
  });

  it("does not schedule an endless flush timer while paused", () => {
    vi.useFakeTimers();
    const { core, pty, events } = createCore({
      batchBytes: 4,
      batchMs: 16,
      highWaterBytes: 8,
      lowWaterBytes: 4,
    });
    const id = core.open(spec()).id;
    pty.processes[0]?.emitData("abcdefghijkl");
    expect(dataEvents(events)).toHaveLength(2);

    vi.advanceTimersByTime(1000);
    expect(dataEvents(events)).toHaveLength(2);

    core.ack(id, 8);
    expect(dataEvents(events).map(text).join("")).toBe("abcdefghijkl");
  });
});

describe("TerminalCore attach and replay", () => {
  it("replays the tail ring buffer with the current sequence", () => {
    const { core, pty } = createCore({ batchBytes: 4, replayBytes: 8 });
    const id = core.open(spec()).id;
    pty.processes[0]?.emitData("0123456789");

    const snapshot = core.attach(id);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.bytes).toBe(8);
    expect(snapshot?.seq).toBe(3);
    expect(new TextDecoder().decode(base64ToBytes(snapshot!.data))).toBe("23456789");

    pty.processes[0]?.emitData("AB");
    const next = core.attach(id) as TerminalAttachResult;
    expect(new TextDecoder().decode(base64ToBytes(next.data))).toBe("456789AB");
    expect(next.seq).toBe(4);
  });

  it("flushes pending output into the snapshot exactly once", () => {
    const { core, pty, events } = createCore({ batchBytes: 1024, batchMs: 10_000 });
    const id = core.open(spec()).id;
    pty.processes[0]?.emitData("hello");

    const snapshot = core.attach(id);
    expect(new TextDecoder().decode(base64ToBytes(snapshot!.data))).toBe("hello");
    expect(snapshot?.seq).toBe(1);
    // The flush emitted the same bytes once; attach did not duplicate them.
    expect(dataEvents(events).map(text)).toEqual(["hello"]);
  });

  it("returns null for an unknown or closed terminal", () => {
    const { core } = createCore();
    expect(core.attach("t-999")).toBeNull();
    const id = core.open(spec()).id;
    core.close(id, { force: true });
    expect(core.attach(id)).toBeNull();
  });
});

describe("TerminalRingBuffer", () => {
  it("keeps exactly the last capacity bytes across chunk boundaries", () => {
    const ring = new TerminalRingBuffer(5);
    ring.push(bytes("abc"));
    ring.push(bytes("def"));
    expect(new TextDecoder().decode(ring.snapshot())).toBe("bcdef");

    ring.push(bytes("0123456789"));
    expect(ring.size).toBe(5);
    expect(new TextDecoder().decode(ring.snapshot())).toBe("56789");
  });

  it("ignores empty chunks and starts empty", () => {
    const ring = new TerminalRingBuffer(4);
    expect(ring.size).toBe(0);
    ring.push(new Uint8Array(0));
    expect(ring.size).toBe(0);
    expect(ring.snapshot()).toEqual(new Uint8Array(0));
  });
});

describe("TerminalCore write and resize", () => {
  it("forwards input bytes to the shell", () => {
    const { core, pty } = createCore();
    const id = core.open(spec()).id;
    core.write(id, "ls\r");
    core.write(id, "");
    expect(pty.processes[0]?.writes).toEqual(["ls\r"]);
  });

  it("rejects an unknown terminal and an oversized write", () => {
    const { core } = createCore();
    const id = core.open(spec()).id;
    expect(codeOf(() => core.write("t-999", "x"))).toBe("not_found");
    expect(codeOf(() => core.write("bad id", "x"))).toBe("bad_request");
    expect(codeOf(() => core.write(id, "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1)))).toBe("limit");
  });

  it("forwards a real resize only when the size changed", () => {
    const { core, pty } = createCore();
    const id = core.open(spec()).id;
    core.resize(id, 100, 40);
    core.resize(id, 100, 40);
    core.resize(id, 120, 40);
    expect(pty.processes[0]?.resizes).toEqual([
      [100, 40],
      [120, 40],
    ]);
    expect(codeOf(() => core.resize(id, 0, 40))).toBe("bad_request");
  });
});

describe("TerminalCore exit and close", () => {
  it("emits the pending tail, then one exit event, and drops the terminal", () => {
    const { core, pty, events } = createCore({ batchBytes: 1024, batchMs: 10_000 });
    const id = core.open(spec()).id;
    pty.processes[0]?.emitData("bye");
    pty.processes[0]?.emitExit(7, 15);

    expect(dataEvents(events).map(text)).toEqual(["bye"]);
    expect(exitEvents(events)).toEqual([{ terminalId: id, exitCode: 7, signal: 15 }]);
    expect(core.list()).toEqual([]);
    expect(codeOf(() => core.write(id, "x"))).toBe("not_found");
    expect(core.close(id)).toBe(false);

    // A second exit report is ignored.
    pty.processes[0]?.emitExit(1);
    expect(exitEvents(events)).toHaveLength(1);
  });

  it("kills gracefully, then SIGKILLs the tree after the grace period", () => {
    vi.useFakeTimers();
    const { core, pty, treeKill, events } = createCore({ closeGraceMs: 2000 });
    const id = core.open(spec()).id;

    expect(core.close(id)).toBe(true);
    expect(pty.processes[0]?.kills).toEqual(["SIGHUP"]);
    expect(treeKill.calls).toEqual([{ pid: 100, signal: "SIGTERM" }]);
    expect(exitEvents(events)).toHaveLength(0);

    vi.advanceTimersByTime(2000);
    expect(treeKill.calls).toEqual([
      { pid: 100, signal: "SIGTERM" },
      { pid: 100, signal: "SIGKILL" },
    ]);
    expect(pty.processes[0]?.kills).toEqual(["SIGHUP", "SIGKILL"]);
    expect(exitEvents(events)).toEqual([{ terminalId: id, exitCode: -1, signal: 9 }]);
    expect(core.list()).toEqual([]);
  });

  it("does not force-kill after a clean exit during the grace period", () => {
    vi.useFakeTimers();
    const { core, pty, treeKill, events } = createCore({ closeGraceMs: 2000 });
    const id = core.open(spec()).id;
    core.close(id);
    pty.processes[0]?.emitExit(0, 15);

    expect(exitEvents(events)).toEqual([{ terminalId: id, exitCode: 0, signal: 15 }]);
    vi.advanceTimersByTime(5000);
    expect(treeKill.calls).toEqual([{ pid: 100, signal: "SIGTERM" }]);
    expect(pty.processes[0]?.kills).toEqual(["SIGHUP"]);
  });

  it("force-closes immediately and stays idempotent", () => {
    const { core, pty, treeKill, events } = createCore();
    const id = core.open(spec()).id;
    expect(core.close(id, { force: true })).toBe(true);
    expect(treeKill.calls).toEqual([{ pid: 100, signal: "SIGKILL" }]);
    expect(pty.processes[0]?.kills).toEqual(["SIGKILL"]);
    expect(exitEvents(events)).toEqual([{ terminalId: id, exitCode: -1, signal: 9 }]);
    expect(core.close(id)).toBe(false);
    expect(exitEvents(events)).toHaveLength(1);
  });

  it("detaches the data listener when closing, so late output is dropped", () => {
    const { core, pty, events } = createCore({ batchBytes: 1 });
    const id = core.open(spec()).id;
    expect(pty.processes[0]?.listenerCounts.data).toBe(1);
    core.close(id);
    expect(pty.processes[0]?.listenerCounts.data).toBe(0);
    pty.processes[0]?.emitData("late");
    expect(dataEvents(events)).toHaveLength(0);
  });
});

describe("TerminalCore.dispose", () => {
  it("force-closes every live terminal", () => {
    const { core, treeKill, events } = createCore();
    core.open(spec());
    core.open(spec());
    core.dispose();
    expect(core.list()).toEqual([]);
    expect(exitEvents(events)).toHaveLength(2);
    expect(treeKill.calls).toEqual([
      { pid: 100, signal: "SIGKILL" },
      { pid: 101, signal: "SIGKILL" },
    ]);
  });

  it("is a no-op with no terminals", () => {
    const { core, treeKill } = createCore();
    core.dispose();
    expect(treeKill.calls).toEqual([]);
  });
});
