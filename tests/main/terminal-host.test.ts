import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalHost,
  TerminalHostRpcError,
  type TerminalHostExitInfo,
  type TerminalHostOptions,
  type TerminalHostSpawner,
} from "../../src/main/terminal-host";
import type { TerminalEventFrame, TerminalRequestFrame } from "../../src/shared/terminal-protocol";

const NODE_PATH = process.platform === "win32" ? "C:\\runtime\\node.exe" : "/runtime/bin/node";
const HOST_PATH =
  process.platform === "win32" ? "C:\\app\\out\\host\\terminal.mjs" : "/app/out/host/terminal.mjs";

/**
 * A `ChildProcess` stand-in built on PassThrough streams. The supervisor writes
 * JSONL to `stdin`; the test reads the requests and writes responses/events back
 * on `stdout`, exactly like the real host.
 */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed: string[] = [];
  readonly requests: TerminalRequestFrame[] = [];
  private buffer = "";

  constructor(readonly pid: number | undefined = 4242) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf("\n");
        if (line.trim().length === 0) continue;
        try {
          this.requests.push(JSON.parse(line) as TerminalRequestFrame);
        } catch {
          // A malformed request is the test's own business.
        }
      }
    });
  }

  /** A process that never started: Node reports no pid for a spawn failure. */
  markUnspawned(): void {
    Object.defineProperty(this, "pid", { value: undefined });
  }

  kill(signal = "SIGTERM"): boolean {
    this.killed.push(signal);
    this.emit("exit", null, signal);
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }

  respond(id: number, result: unknown): void {
    this.write({ id, result });
  }

  fail(id: number, code: string, message: string): void {
    this.write({ id, error: { code, message } });
  }

  event(frame: TerminalEventFrame): void {
    this.write(frame);
  }

  private write(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean };
}

function createSpawner() {
  const children: FakeChild[] = [];
  const calls: SpawnCall[] = [];
  const spawner: TerminalHostSpawner = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawner, children, calls };
}

function createHost(overrides: Partial<TerminalHostOptions> = {}) {
  const { spawner, children, calls } = createSpawner();
  const events: TerminalEventFrame[] = [];
  const exits: TerminalHostExitInfo[] = [];
  const host = new TerminalHost({
    nodePath: NODE_PATH,
    hostPath: HOST_PATH,
    cwd: "/work/app",
    profileDir: "/home/me/.pi/agent",
    binDir: "/app/runtime/bin",
    nodeBinDir: "/app/runtime/node/linux-x64/bin",
    env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", KEEP_ME: "yes" },
    spawner,
    requestTimeoutMs: 1000,
    onEvent: (frame) => events.push(frame),
    onExit: (info) => exits.push(info),
    ...overrides,
  });
  return { host, children, calls, events, exits };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalHost spawning", () => {
  it("spawns the bundled node with the composed environment", async () => {
    const { host, children, calls } = createHost();
    const pending = host.request("terminal.list");
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call.command).toBe(NODE_PATH);
    expect(call.args).toEqual([HOST_PATH]);
    expect(call.options.cwd).toBe("/work/app");
    expect(call.options.windowsHide).toBe(true);
    const path = call.options.env.PATH ?? "";
    expect(path).toContain("/app/runtime/bin");
    expect(path).toContain("/app/runtime/node/linux-x64/bin");
    expect(path).toContain("/usr/bin");
    expect(call.options.env.PI_CODING_AGENT_DIR).toBe("/home/me/.pi/agent");
    expect(call.options.env.PI_DESKTOP_TERMINAL_HOST).toBe("1");
    expect(call.options.env.TERM_PROGRAM).toBe("PiDesktop");
    expect(call.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(call.options.env.KEEP_ME).toBe("yes");

    children[0]?.respond(children[0].requests[0]!.id, []);
    await expect(pending).resolves.toEqual([]);
  });

  it("spawns lazily, once", () => {
    const { host, calls } = createHost();
    void host.request("terminal.list").catch(() => undefined);
    void host.request("terminal.list").catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it("strips the AppImage mount from the host's loader paths", async () => {
    const appDir = "/tmp/.mount_PiDesk123";
    const { host, children, calls } = createHost({
      env: {
        PATH: "/usr/bin",
        APPDIR: appDir,
        LD_LIBRARY_PATH: `${appDir}/usr/lib:/usr/local/lib`,
        LD_PRELOAD: `${appDir}/usr/lib/libfoo.so`,
      },
    });
    const pending = host.request("terminal.list");
    children[0]?.respond(children[0].requests[0]!.id, []);
    await expect(pending).resolves.toEqual([]);

    expect(calls[0]?.options.env.LD_LIBRARY_PATH).toBe("/usr/local/lib");
    expect(calls[0]?.options.env.LD_PRELOAD).toBeUndefined();
  });

  it("rejects a request when spawning throws", async () => {
    const spawner: TerminalHostSpawner = () => {
      throw new Error("ENOENT: node missing");
    };
    const { host } = createHost({ spawner });
    await expect(host.request("terminal.list")).rejects.toThrow("ENOENT");
    expect(host.running).toBe(false);
  });

  it("rejects a request after the host was disposed", async () => {
    const { host } = createHost();
    await host.dispose();
    await expect(host.request("terminal.list")).rejects.toThrow(/shutting down/);
  });
});

describe("TerminalHost stderr and spawn errors", () => {
  it("attaches the host's stderr to the exit rejection and names a native failure", async () => {
    const { host, children } = createHost();
    const pending = host.request("terminal.open", { spec: {} });
    children[0]!.stderr.write(
      "Error: Failed to load native module: pty.node, checked: build/Release\n",
    );
    children[0]!.stderr.write("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.42' not found\n");
    children[0]!.exit(1, null);

    await expect(pending).rejects.toThrow(/GLIBC_2\.42/);
    await expect(pending).rejects.toThrow(/Diagnostics → Terminal/);
    await expect(pending).rejects.toThrow(/exited \(1\) during "terminal.open"/);
  });

  it("does not add a native hint for an ordinary crash", async () => {
    const { host, children } = createHost();
    const pending = host.request("terminal.list");
    children[0]!.stderr.write("TypeError: something else\n");
    children[0]!.exit(1, null);

    const error = (await pending.catch((reason: Error) => reason)) as Error;
    expect(error.message).toContain("TypeError: something else");
    expect(error.message).not.toContain("Diagnostics → Terminal");
  });

  it("rejects pending work immediately on a spawn error and allows a respawn", async () => {
    const children: FakeChild[] = [];
    const spawner: TerminalHostSpawner = () => {
      const child = new FakeChild();
      child.markUnspawned();
      children.push(child);
      return child as unknown as ChildProcess;
    };
    const { host } = createHost({ spawner });

    const pending = host.request("terminal.list");
    children[0]!.emit("error", new Error("spawn EACCES"));

    await expect(pending).rejects.toThrow(/failed \(spawn EACCES\)/);
    expect(host.running).toBe(false);
    expect(host.diagnostics().lastError).toBe("spawn EACCES");

    const again = host.request<string[]>("terminal.list");
    expect(children).toHaveLength(2);
    children[1]!.respond(children[1]!.requests[0]!.id, ["ok"]);
    await expect(again).resolves.toEqual(["ok"]);
  });

  it("clears the stderr tail before a new spawn", async () => {
    const { host, children } = createHost();
    const first = host.request("terminal.list");
    children[0]!.stderr.write("OLD NATIVE ERROR GLIBC_2.42\n");
    children[0]!.exit(1, null);
    await first.catch(() => undefined);

    const second = host.request("terminal.list");
    children[1]!.exit(1, null);
    const error = (await second.catch((reason: Error) => reason)) as Error;
    expect(error.message).not.toContain("GLIBC_2.42");
    expect(host.diagnostics().stderrTail).toBe("");
  });

  it("reports paths, last exit and the tail through diagnostics()", async () => {
    const { host, children } = createHost();
    const pending = host.request("terminal.list");
    children[0]!.stderr.write("boom\n");
    children[0]!.exit(1, null);
    await pending.catch(() => undefined);

    expect(host.diagnostics()).toMatchObject({
      running: false,
      nodePath: NODE_PATH,
      hostPath: HOST_PATH,
      lastError: null,
      lastExit: { code: 1, signal: "", expected: false },
    });
    expect(host.diagnostics().stderrTail).toBe("boom\n");
  });

  it("sends stderr and exit lines to the log sink", async () => {
    const lines: string[] = [];
    const { host, children } = createHost({ log: (line) => lines.push(line) });
    const pending = host.request("terminal.list");
    children[0]!.stderr.write("native load failed\n");
    children[0]!.exit(1, null);
    await pending.catch(() => undefined);

    expect(lines.some((line) => line.includes("terminal host stderr: native load failed"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("terminal host exited (1)"))).toBe(true);
  });
});

describe("TerminalHost request correlation", () => {
  it("resolves out-of-order responses to the right request", async () => {
    const { host, children } = createHost();
    const first = host.request<string>("terminal.open", { spec: {} });
    const second = host.request<string[]>("terminal.list");
    const [requestA, requestB] = children[0]!.requests;

    children[0]!.respond(requestB!.id, ["second"]);
    children[0]!.respond(requestA!.id, "first");

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toEqual(["second"]);
  });

  it("rejects with the host's typed error code", async () => {
    const { host, children } = createHost();
    const pending = host.request("terminal.attach", { terminalId: "t-1" });
    children[0]!.fail(children[0]!.requests[0]!.id, "not_found", "gone");

    await expect(pending).rejects.toBeInstanceOf(TerminalHostRpcError);
    await expect(pending).rejects.toMatchObject({ code: "not_found" });
  });

  it("times out a request and keeps correlating afterwards", async () => {
    vi.useFakeTimers();
    const { host, children } = createHost();
    const pending = host.request("terminal.list");
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(1000);
    await assertion;

    const next = host.request<string[]>("terminal.list");
    const latest = children[0]!.requests.at(-1)!;
    children[0]!.respond(latest.id, ["ok"]);
    await expect(next).resolves.toEqual(["ok"]);
  });

  it("forwards event frames", () => {
    const { host, children, events } = createHost();
    void host.request("terminal.list");
    const frame: TerminalEventFrame = {
      event: "terminal.data",
      payload: { terminalId: "t-1", seq: 1, data: "", bytes: 0 },
    };
    children[0]!.event(frame);
    expect(events).toEqual([frame]);
  });

  it("ignores malformed lines, unknown responses and a request on stdout", async () => {
    const { host, children } = createHost();
    const pending = host.request<string[]>("terminal.list");
    const requestId = children[0]!.requests[0]!.id;

    children[0]!.stdout.write("garbage\n");
    children[0]!.respond(9999, ["ignored"]);
    children[0]!.stdout.write(`${JSON.stringify({ id: requestId, method: "terminal.list" })}\n`);

    children[0]!.respond(requestId, ["ok"]);
    await expect(pending).resolves.toEqual(["ok"]);
  });
});

describe("TerminalHost exit and dispose", () => {
  it("rejects pending work on an unexpected exit and restarts on the next request", async () => {
    const { host, children, exits } = createHost();
    const pending = host.request("terminal.list");
    children[0]!.exit(1, null);

    await expect(pending).rejects.toThrow(/exited/);
    expect(exits).toEqual([{ code: 1, signal: "", expected: false }]);
    expect(host.running).toBe(false);

    const again = host.request<string[]>("terminal.list");
    expect(children).toHaveLength(2);
    children[1]!.respond(children[1]!.requests[0]!.id, []);
    await expect(again).resolves.toEqual([]);
  });

  it("ends stdin, waits for the exit and does not report it as a crash", async () => {
    const { host, children, exits } = createHost();
    const pending = host.request("terminal.list");

    const disposing = host.dispose();
    await expect(pending).rejects.toThrow(/shutting down/);
    expect(children[0]!.stdin.writableEnded).toBe(true);

    children[0]!.exit(0, null);
    await disposing;
    expect(exits).toEqual([]);
    expect(host.running).toBe(false);
  });

  it("force-kills after the grace period", async () => {
    vi.useFakeTimers();
    const { host, children } = createHost();
    void host.request("terminal.list").catch(() => undefined);
    const disposing = host.dispose();
    vi.advanceTimersByTime(2000);
    await disposing;
    expect(children[0]!.killed).toEqual(["SIGKILL"]);
  });

  it("disposes idempotently and with no child", async () => {
    const { host } = createHost();
    await host.dispose();
    await host.dispose();
    expect(host.running).toBe(false);
  });
});
