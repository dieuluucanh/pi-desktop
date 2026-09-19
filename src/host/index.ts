import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BLOB_DIR_ENV, SERVICE_ENV, SERVICE_FLAG, SESSION_ID_ENV } from "../shared/host-protocol";
import { createHostService } from "./service";

/**
 * Pi host entry point — the process that runs the Pi SDK (plan D4, D16).
 *
 * Two shapes:
 *
 * 1. **CLI shape** (default): behaves exactly like the `pi` binary by delegating
 *    to the SDK's exported `main()`. The bundled `bin/pi` shim points here, so
 *    extensions that shell out to `pi` (workflow's `explore` subagent, reviewer
 *    subagents) keep working with no global install (plan D16, risk R4).
 *
 * 2. **Service shape** (`--service`, or `PI_DESKTOP_HOST_MODE=service`): the
 *    JSONL protocol the Electron main process drives (plan step 4). Session
 *    semantics are injected in plan step 5.
 *
 * Service mode is selected only by an explicit flag or environment variable, so
 * no legitimate `pi` argument can ever be shadowed by the app.
 */

export const BLOB_DIR_DEFAULT = join(tmpdir(), "pi-desktop-blobs");

// Re-exported so the supervisor and tests import the protocol constants from the
// host entry point as well as from `src/shared/host-protocol.ts`.
export { SERVICE_ENV, SERVICE_FLAG, SESSION_ID_ENV };

export type HostInvocation = { mode: "cli"; args: string[] } | { mode: "service"; args: string[] };

export function classifyInvocation(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): HostInvocation {
  const wantsService = argv.includes(SERVICE_FLAG) || env[SERVICE_ENV] === "service";
  const args = argv.filter((arg) => arg !== SERVICE_FLAG);
  return wantsService ? { mode: "service", args } : { mode: "cli", args };
}

/** Delegates to the Pi coding agent CLI (the SDK's `main`). */
export async function runCli(args: readonly string[]): Promise<void> {
  const { main } = await import("@earendil-works/pi-coding-agent");
  await main([...args]);
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

/**
 * Runs the host protocol service on stdio until the supervisor shuts it down.
 * Returns only when the process is about to exit.
 */
export function runService(
  args: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const blobDir = env[BLOB_DIR_ENV]?.trim() || BLOB_DIR_DEFAULT;
  const bridgePort = flagValue(args, "--port") ?? env.PI_OFFICE_BRIDGE_PORT ?? null;

  return new Promise<void>((resolve) => {
    const service = createHostService({
      stdin: process.stdin,
      stdout: process.stdout,
      blobDir,
      info: {
        sessionId: flagValue(args, "--session") ?? env[SESSION_ID_ENV] ?? null,
        cwd: flagValue(args, "--cwd") ?? process.cwd(),
        bridgePort: bridgePort === null ? null : Number(bridgePort),
        nodeVersion: process.version,
        piVersion: null,
        startedAt: Date.now(),
      },
      onShutdown: () => {
        service.stop();
        // Give the response frame a tick to flush before the process ends.
        setTimeout(() => resolve(), 10);
      },
    });

    service.start();
  });
}

export async function hostMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const invocation = classifyInvocation(argv, env);
  if (invocation.mode === "service") {
    await runService(invocation.args, env);
    return;
  }
  await runCli(invocation.args);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  hostMain(process.argv.slice(2), process.env)
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`pi-desktop host failed: ${detail}\n`);
      process.exit(1);
    });
}
