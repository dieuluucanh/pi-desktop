import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BLOB_DIR_ENV,
  HOST_ROLE_ENV,
  ROLE_FLAG,
  SERVICE_ENV,
  SERVICE_FLAG,
  SESSION_ID_ENV,
  isHostRole,
  type HostRole,
} from "../shared/host-protocol";
import { createControlCore } from "./control-core";
import { createExtensionUiBridge } from "./extension-ui";
import { createSessionCore, type SessionCore } from "./session-core";
import { createHostService, type HostHandler, type HostService } from "./service";
import {
  ProjectTrustStore,
  SessionManager,
  createSdkSessionRuntime,
  createSdkSettings,
  hasTrustRequiringProjectResources,
  listAllSessions,
} from "./sdk";

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
 * Builds the session core with the real SDK adapters. Split out so the service
 * loop stays readable and the SDK import stays inside `src/host/sdk`.
 */
function createCore(options: {
  cwd: string;
  agentDir: string;
  emit: (event: string, payload?: unknown, sessionId?: string) => void;
  npmCommand?: readonly string[] | null;
  bindSession?: (session: never) => Promise<void>;
}): SessionCore {
  const trustStore = new ProjectTrustStore(options.agentDir);

  return createSessionCore({
    cwd: options.cwd,
    agentDir: options.agentDir,
    ...(options.npmCommand ? { npmCommand: options.npmCommand } : {}),
    ...(options.bindSession ? { bindSession: options.bindSession as never } : {}),
    emit: options.emit,
    trustStore,
    requiresTrust: (cwd) => hasTrustRequiringProjectResources(cwd),
    newSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir) as never,
    openSessionManager: (sessionFile, cwd, sessionDir) =>
      SessionManager.open(sessionFile, sessionDir, cwd) as never,
    listSessions: (cwd) => SessionManager.list(cwd) as Promise<never[]>,
    createRuntime: async (request) => {
      // Annotated with the adapter's own parameter type: if the SDK adapter ever
      // requires another field, this line fails to compile instead of drifting.
      const runtimeRequest: Parameters<typeof createSdkSessionRuntime>[0] = {
        cwd: request.cwd,
        agentDir: request.agentDir,
        sessionManager: request.sessionManager as never,
        ...(request.npmCommand ? { npmCommand: request.npmCommand } : {}),
      };
      const created = await createSdkSessionRuntime(runtimeRequest);
      return { runtime: created.runtime, session: created.session };
    },
  });
}

/** Which core a host process builds (plan D-A3): flag first, then environment. */
export function resolveHostRole(
  args: readonly string[] = [],
  env: Record<string, string | undefined> = {},
): HostRole {
  const fromFlag = flagValue(args, ROLE_FLAG);
  if (isHostRole(fromFlag)) return fromFlag;
  const fromEnv = env[HOST_ROLE_ENV];
  return isHostRole(fromEnv) ? fromEnv : "session";
}

/**
 * The control core's real adapters: settings and the profile-wide session list.
 * Deliberately no session runtime — a control host never owns an `AgentSession`.
 */
function createControlHostCore(options: { cwd: string; agentDir: string }) {
  return createControlCore({
    createSettings: () => createSdkSettings(options.cwd, options.agentDir),
    listSessions: () => listAllSessions(),
  });
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
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(process.cwd(), ".pi", "agent");
  const bridgePort = flagValue(args, "--port") ?? env.PI_OFFICE_BRIDGE_PORT ?? null;
  const cwd = flagValue(args, "--cwd") ?? process.cwd();
  const role = resolveHostRole(args, env);

  return new Promise<void>((resolve) => {
    // The core is built before the service (which owns the frame writer), so the
    // emitter is forwarded through this small indirection.
    const forward = {
      emit: (_event: string, _payload?: unknown, _sessionId?: string): void => undefined,
    };

    const core =
      role === "control"
        ? createControlHostCore({ cwd, agentDir })
        : createCore({
            cwd,
            agentDir,
            emit: (event, payload, sessionId) => forward.emit(event, payload, sessionId),
          });

    const handlers: Partial<Record<string, HostHandler>> = { ...core.handlers() };

    // Extension dialogs block until the app answers `oi.respond`. The bridge owns
    // those promises, emits `oi.request`, and is torn down with the session so a
    // closing host never leaves an extension hanging (step 16 renders the dialogs).
    const ui = createExtensionUiBridge({
      emit: (event, payload) => forward.emit(event, payload, undefined),
    });
    Object.assign(handlers, ui.handlers());

    const service: HostService = createHostService({
      stdin: process.stdin,
      stdout: process.stdout,
      blobDir,
      handlers,
      info: {
        sessionId: flagValue(args, "--session") ?? env[SESSION_ID_ENV] ?? null,
        cwd,
        bridgePort: bridgePort === null ? null : Number(bridgePort),
        nodeVersion: process.version,
        piVersion: null,
        role,
        startedAt: Date.now(),
      },
      onShutdown: () => {
        service.stop();
        ui.dispose("the host is shutting down");
        void core.dispose();
        // Give the response frame a tick to flush before the process ends.
        setTimeout(() => resolve(), 10);
      },
    });

    forward.emit = (event, payload, sessionId) => service.emit(event, payload, sessionId);
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
