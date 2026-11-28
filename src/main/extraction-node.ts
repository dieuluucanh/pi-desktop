import { execFile, spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtractionChild, ExtractionSupervisorDeps } from "./extraction-supervisor";

const execFileAsync = promisify(execFile);

/**
 * Node adapter for the extraction supervisor (plan step 18).
 *
 * The child gets an absolute Node binary and the worker bundle; it never sees
 * the app/user environment, a workspace path, an Office/terminal module or a
 * credential. Temp directories are app-generated. Kill-tree and RSS facts are
 * platform-specific OS calls, not a security boundary — a child process is a
 * resource boundary, not an OS sandbox.
 */

function killTree(pid: number | null): Promise<void> {
  if (pid === null) return Promise.resolve();
  if (process.platform === "win32") {
    return execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5_000 })
      .then(() => undefined)
      .catch(() => undefined);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  return Promise.resolve();
}

async function readRss(pid: number): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
        { timeout: 2_000, windowsHide: true },
      );
      const value = Number(stdout.trim());
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], {
      timeout: 2_000,
    });
    const kilobytes = Number(stdout.trim());
    return Number.isSafeInteger(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

export function createNodeExtractionDeps(input: {
  readonly nodePath: string;
  readonly workerPath: string;
  readonly tempRoot: string;
  readonly enabled: boolean;
  readonly safeMode: boolean;
}): ExtractionSupervisorDeps {
  return {
    nodePath: input.nodePath,
    workerPath: input.workerPath,
    tempRoot: input.tempRoot,
    platform: process.platform,
    enabled: input.enabled,
    safeMode: input.safeMode,
    spawner: (command, args, options) => {
      const child = nodeSpawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: options.windowsHide,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      // SAFETY: with stdio ["pipe", "pipe", "pipe"], Node's ChildProcess exposes
      // exactly the stdin/stdout/stderr/on/kill/pid surface ExtractionChild
      // declares; the remaining ChildProcess fields are never read here.
      return child as unknown as ExtractionChild;
    },
    killTree,
    readRss,
    makeTempDir: (root) => mkdtemp(join(root, "job-")),
    removeTempDir: (path) => rm(path, { recursive: true, force: true }),
  };
}
