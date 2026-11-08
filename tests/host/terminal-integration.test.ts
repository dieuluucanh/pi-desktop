import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../src/shared/jsonl";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalDataEvent,
  type TerminalFrame,
  type TerminalInfo,
} from "../../src/shared/terminal-protocol";

/**
 * The real-shell contract (2026-11-05 terminal plan, step 11).
 *
 * This is the one test that loads `node-pty` and starts a real shell inside the
 * built terminal host. It is skipped when the bundle has not been built, so a
 * plain `npm test` on a clean checkout stays green; the CI/package smoke path
 * runs `npm run build:host` first.
 */

const HOST_BUNDLE = join(process.cwd(), "out", "host", "terminal.mjs");
const PROCEDURE_TIMEOUT_MS = 15_000;

function shellPath(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

interface Harness {
  child: ChildProcessWithoutNullStreams;
  frames: TerminalFrame[];
  send(frame: TerminalFrame): void;
  waitFor<T extends TerminalFrame>(
    predicate: (frame: TerminalFrame) => frame is T,
    timeoutMs?: number,
  ): Promise<T>;
  stop(): void;
}

function startHost(): Harness {
  const child = spawn(process.execPath, [HOST_BUNDLE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const decoder = new JsonlDecoder<TerminalFrame>(decodeTerminalFrame, 5 * 1024 * 1024);
  const frames: TerminalFrame[] = [];
  const waiters: Array<{
    predicate: (frame: TerminalFrame) => boolean;
    resolve: (frame: TerminalFrame) => void;
  }> = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const result = decoder.push(chunk);
    for (const frame of result.frames) {
      frames.push(frame);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!;
        if (waiter.predicate(frame)) {
          waiters.splice(index, 1);
          waiter.resolve(frame);
        }
      }
    }
  });

  return {
    child,
    frames,
    send(frame) {
      child.stdin.write(encodeTerminalFrame(frame));
    },
    waitFor<T extends TerminalFrame>(
      predicate: (frame: TerminalFrame) => frame is T,
      timeoutMs = PROCEDURE_TIMEOUT_MS,
    ): Promise<T> {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("terminal host timed out")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame as T);
          },
        });
      });
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

const REQUIRED = process.env.PI_REQUIRE_TERMINAL_HOST === "1";
const HAS_HOST_BUNDLE = existsSync(HOST_BUNDLE);

describe("terminal host integration", () => {
  // CI builds `out/host/terminal.mjs` first and sets this flag. Without the
  // flag a clean checkout may skip; with it, a missing bundle is a failure, not
  // a green skip (the 0.8.0 Linux package shipped a terminal nobody had run).
  it("has a built host bundle when the gate requires one", () => {
    if (!REQUIRED) return;
    expect(
      HAS_HOST_BUNDLE,
      `run \`npm run build:host\` before \`npm test\` (expected ${HOST_BUNDLE})`,
    ).toBe(true);
  });

  describe.skipIf(!HAS_HOST_BUNDLE)("real shell", () => {
    it(
      "starts a real shell, streams its output and kills it on close",
      async () => {
        const host = startHost();
        try {
          host.send({
            id: 1,
            method: "terminal.open",
            params: {
              spec: {
                cwd: process.cwd(),
                shell: shellPath(),
                args: [],
                env: { ...hostEnv(), TERM: "xterm-256color" },
                cols: 80,
                rows: 24,
                name: "xterm-256color",
              },
            },
          });
          const opened = await host.waitFor(
            (frame): frame is Extract<TerminalFrame, { id: number; result?: unknown }> =>
              "id" in frame && frame.id === 1,
          );
          expect(opened).toMatchObject({ id: 1 });
          const info = (opened as { result: TerminalInfo }).result;
          expect(info.id).toMatch(/^t-/);
          expect(info.cols).toBe(80);
          expect(info.rows).toBe(24);

          host.send({
            id: 2,
            method: "terminal.write",
            params: { terminalId: info.id, data: `echo terminal-integration\r` },
          });
          const output = await host.waitFor(
            (frame): frame is Extract<TerminalFrame, { event: string }> => {
              if (!("event" in frame) || frame.event !== "terminal.data") return false;
              const payload = frame.payload as TerminalDataEvent;
              return Buffer.from(payload.data, "base64")
                .toString("utf8")
                .includes("terminal-integration");
            },
          );
          expect("event" in output).toBe(true);

          host.send({
            id: 3,
            method: "terminal.close",
            params: { terminalId: info.id, force: true },
          });
          const closed = await host.waitFor(
            (frame): frame is Extract<TerminalFrame, { id: number }> =>
              "id" in frame && frame.id === 3,
          );
          expect(closed).toMatchObject({ id: 3, result: { closed: true } });
        } finally {
          host.stop();
        }
      },
      PROCEDURE_TIMEOUT_MS,
    );
  });
});
