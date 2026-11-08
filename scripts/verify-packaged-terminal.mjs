#!/usr/bin/env node
/**
 * Packaged terminal smoke test (2026-11-08 linux-terminal plan, step 6).
 *
 * `afterPack` proves the binary exists and that its ELF version needs fit the
 * support floor. It cannot prove that the packaged app can *open a PTY* — and a
 * binary can exist, pass a floor check, and still fail to dlopen. This script
 * runs the real thing: the bundled Node from the package, the packaged
 * `out/host/terminal.mjs`, the packaged `node-pty`, a real shell.
 *
 *   node scripts/verify-packaged-terminal.mjs --dir release/linux-unpacked
 *   node scripts/verify-packaged-terminal.mjs --resources /app/resources
 *   node scripts/verify-packaged-terminal.mjs --dir release/mac --arch x64
 *
 * Success is a `terminal.data` frame containing the marker echoed by the shell.
 * On failure it prints the host's stderr and the last frames — the same
 * evidence a user cannot see in a packaged app.
 *
 * The script imports only `node:*`, so the Linux release job can run it *inside*
 * the oldest supported glibc container (with the app's own bundled Node) to
 * prove the floor on a real distribution.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const MARKER = "pi-terminal-ok";
const TERMINAL_NAME = "xterm-256color";

/** Parses the CLI; `--resources` or `--dir` is required. */
export function parseVerifyArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      resources: { type: "string" },
      dir: { type: "string" },
      node: { type: "string" },
      shell: { type: "string" },
      cwd: { type: "string" },
      platform: { type: "string" },
      arch: { type: "string" },
      timeout: { type: "string" },
    },
  });
  if (!values.resources && !values.dir) {
    throw new Error("verify:terminal: pass --resources <dir> or --dir <app-out-dir>");
  }
  if (
    values.platform &&
    values.platform !== "win32" &&
    values.platform !== "darwin" &&
    values.platform !== "linux"
  ) {
    throw new Error(`verify:terminal: unsupported --platform "${values.platform}"`);
  }
  if (values.arch && values.arch !== "x64" && values.arch !== "arm64") {
    throw new Error(`verify:terminal: unsupported --arch "${values.arch}"`);
  }
  const timeout = values.timeout === undefined ? 20_000 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("verify:terminal: --timeout must be a positive integer (ms)");
  }
  return {
    resources: values.resources ?? null,
    dir: values.dir ?? null,
    node: values.node ?? null,
    shell: values.shell ?? null,
    cwd: values.cwd ?? process.cwd(),
    platform: values.platform ?? process.platform,
    arch: values.arch ?? process.arch,
    timeoutMs: timeout,
  };
}

/** Accepts either the `resources` dir or electron-builder's `<app>-unpacked`. */
export function resourcesDirFor(target) {
  const absolute = resolve(target);
  const nested = join(absolute, "resources");
  return existsSync(nested) ? nested : absolute;
}

export function runtimeTarget(platform, arch) {
  return `${platform}-${arch}`;
}

/** The packaged host bundle and the bundled Node that must run it. */
export function hostPaths(resourcesDir, platform = process.platform, arch = process.arch) {
  return {
    hostBundle: join(resourcesDir, "app.asar.unpacked", "out", "host", "terminal.mjs"),
    nodePath: join(
      resourcesDir,
      "runtime",
      "node",
      runtimeTarget(platform, arch),
      platform === "win32" ? "node.exe" : join("bin", "node"),
    ),
  };
}

function defaultShell(platform) {
  if (platform === "win32") return process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

/** A small, bounded env: the host validates it, and a shell needs no more. */
function shellEnv(platform) {
  const env = { TERM: TERMINAL_NAME, COLORTERM: "truecolor" };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (platform === "win32") {
    for (const key of ["SystemRoot", "windir", "PATHEXT", "ComSpec"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  }
  env.LANG = process.env.LANG ?? "C.UTF-8";
  return env;
}

function encode(value) {
  return `${JSON.stringify(value)}\n`;
}

/**
 * One host process with request correlation and an output buffer. Kept small on
 * purpose: the production protocol lives in `src/shared/terminal-protocol.ts`,
 * and this only needs the four frames the smoke sends.
 */
function startHost(nodePath, hostBundle, cwd) {
  const child = spawn(nodePath, [hostBundle], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  const waiters = new Set();
  const stderr = [];
  let stdout = "";
  let output = "";
  let exitError = null;
  let nextId = 1;

  const settle = (id, error, result) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result);
  };

  const onFrame = (frame) => {
    if (frame.event === "terminal.data") {
      const payload = frame.payload ?? {};
      output += Buffer.from(String(payload.data ?? ""), "base64").toString("utf8");
      for (const waiter of [...waiters]) waiter();
      return;
    }
    if (frame.event) return;
    if (frame.error) settle(frame.id, new Error(`${frame.error.code}: ${frame.error.message}`));
    else settle(frame.id, null, frame.result);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let index = stdout.indexOf("\n");
    while (index !== -1) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      index = stdout.indexOf("\n");
      if (line.trim().length > 0) {
        try {
          onFrame(JSON.parse(line));
        } catch {
          // A non-JSON line is a host bug; the failure report shows stdout.
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    if (stderr.length > 200) stderr.shift();
  });

  const failAll = (error) => {
    exitError = error;
    for (const [id] of pending) settle(id, error);
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  };

  child.on("error", (error) => failAll(error));
  child.on("exit", (code, signal) => {
    failAll(
      new Error(
        `the terminal host exited (${code ?? signal ?? "unknown"}) before the smoke finished`,
      ),
    );
  });

  const request = (method, params, timeoutMs) =>
    new Promise((res, rej) => {
      if (exitError) {
        rej(exitError);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`timed out after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve: res, reject: rej, timer });
      child.stdin.write(encode({ id, method, params }));
    });

  const waitForOutput = (marker, timeoutMs) =>
    new Promise((res, rej) => {
      if (output.includes(marker)) {
        res();
        return;
      }
      if (exitError) {
        rej(exitError);
        return;
      }
      const done = () => {
        if (output.includes(marker)) {
          clearTimeout(timer);
          waiters.delete(done);
          res();
        } else if (exitError) {
          clearTimeout(timer);
          waiters.delete(done);
          rej(exitError);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(done);
        rej(new Error(`the shell did not print ${JSON.stringify(marker)} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      waiters.add(done);
    });

  return {
    child,
    request,
    waitForOutput,
    get output() {
      return output;
    },
    get stderr() {
      return stderr.join("");
    },
    close() {
      try {
        child.stdin.end();
      } catch {
        // Already gone.
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

/** Runs the packaged host end to end; throws with the evidence on failure. */
export async function verifyPackagedTerminal(options) {
  const resources = options.resources ?? resourcesDirFor(options.dir);
  const paths = hostPaths(resources, options.platform, options.arch);
  const nodePath = options.node ?? paths.nodePath;
  for (const [label, target] of [
    ["terminal host bundle", paths.hostBundle],
    ["bundled Node", nodePath],
  ]) {
    if (!existsSync(target)) throw new Error(`verify:terminal: ${label} is missing at ${target}`);
  }

  const shell = options.shell ?? defaultShell(options.platform);
  const host = startHost(nodePath, paths.hostBundle, options.cwd);
  try {
    const info = await host.request("terminal.info", undefined, options.timeoutMs);
    if (!info?.pty?.loaded) {
      const candidates = (info?.pty?.candidates ?? [])
        .map((candidate) => `  ${candidate.path}: ${candidate.error ?? "ok"}`)
        .join("\n");
      throw new Error(
        `node-pty did not load${info?.pty?.error ? `: ${info.pty.error}` : ""}\n${candidates}`,
      );
    }

    const opened = await host.request(
      "terminal.open",
      {
        spec: {
          cwd: options.cwd,
          shell,
          args: [],
          env: shellEnv(options.platform),
          cols: 80,
          rows: 24,
          name: TERMINAL_NAME,
        },
      },
      options.timeoutMs,
    );
    const terminalId = opened?.id;
    if (!terminalId) throw new Error("terminal.open returned no terminal id");

    await host.request(
      "terminal.write",
      { terminalId, data: `echo ${MARKER}\r\n` },
      options.timeoutMs,
    );
    await host.waitForOutput(MARKER, options.timeoutMs);
    await host.request("terminal.close", { terminalId, force: true }, options.timeoutMs);

    return { binary: info.pty.path ?? null, nodePath, shell };
  } finally {
    host.close();
  }
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

async function main(argv) {
  const options = parseVerifyArgs(argv);
  try {
    const result = await verifyPackagedTerminal(options);
    process.stdout.write(
      `verify:terminal: ok (${result.binary ?? "node-pty"}, node ${result.nodePath}, shell ${result.shell})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `verify:terminal: FAILED — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main(process.argv.slice(2));
}

/** Kept for callers that shell out with a printed command. */
export { shellQuote };
