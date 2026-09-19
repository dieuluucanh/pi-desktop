import { pathToFileURL } from "node:url";

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
 *    JSONL host protocol the Electron main process talks to. Implemented in
 *    plan step 4.
 *
 * Service mode is selected only by an explicit flag or environment variable, so
 * no legitimate `pi` argument can ever be shadowed by the app.
 */

export const SERVICE_FLAG = "--service";
export const SERVICE_ENV = "PI_DESKTOP_HOST_MODE";

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

/** Placeholder until plan step 4 implements the host protocol. */
export function runService(): never {
  process.stderr.write(
    "pi-desktop host: service mode is not implemented yet (plan step 4). " +
      "Run without --service to use the pi CLI.\n",
  );
  process.exit(1);
}

export async function hostMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const invocation = classifyInvocation(argv, env);
  if (invocation.mode === "service") runService();
  await runCli(invocation.args);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  hostMain(process.argv.slice(2), process.env).catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`pi-desktop host failed: ${detail}\n`);
    process.exitCode = 1;
  });
}
