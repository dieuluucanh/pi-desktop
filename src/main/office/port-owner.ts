/**
 * Freeing bridge port 38617 so another session can own it.
 *
 * The Office bridge is an ordinary Pi extension inside each session host: the
 * *extension* is what binds the port, and two extensions cannot share it. When the
 * user moves the bridge to another session, the old host is stopped first — but
 * stopping a process is asynchronous, and a *different* Pi instance (terminal Pi,
 * an earlier app run, a squatter) may hold the port for reasons this app cannot
 * see. The requested behaviour is therefore explicit: **the takeover really takes
 * the port**, terminating whatever listens on it.
 *
 * Three rules keep that from becoming a foot-gun:
 *
 *  1. **Never kill ourselves.** The caller passes the PIDs it already owns (the
 *     app process and every supervised host); they are skipped even if the port
 *     lookup names them, because a host is stopped through its own supervisor.
 *  2. **Never kill system processes.** PIDs at or below 4 are refused: on POSIX
 *     those are kernel threads, and on Windows `0`/`4` are the idle and System
 *     processes.
 *  3. **Re-read the owner immediately before each kill.** A PID can be recycled
 *     between the lookup and the signal; requiring the same PID makes a stale
 *     list harmless.
 *
 * Everything OS-specific goes through injected ports (`CommandRunner`, `kill`,
 * `sleep`, the health probe), so this module is Electron-free (architecture rule
 * 1) and unit-testable on any platform (rule 2).
 */

import { PI_OFFICE_BRIDGE } from "../../shared/office";
import type { BridgeHealthCheck } from "./verify";

/** The probe this module needs; `checkBridgeHealth` satisfies it structurally. */
export type PortProbe = (port: number) => Promise<Pick<BridgeHealthCheck, "status">>;

/** The command runner shape from `./exec`, restated so tests can pass a fake. */
export interface PortCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }>;
}

export interface PortOwnerDeps {
  runner: PortCommandRunner;
  /** Sends a kill signal. Injected so tests never touch a real process. */
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep: (ms: number) => Promise<void>;
  probe: PortProbe;
  /** `process.platform`, injected for the same reason. */
  platform?: NodeJS.Platform;
}

export interface ReleasePortInput {
  /** The port to free. Defaults to the bridge port. */
  port?: number;
  /**
   * PIDs this app already owns. They are never signalled: a supervised host is
   * stopped through the supervisor, which also waits for it to exit.
   */
  ownPids?: readonly number[];
  /** When false, the port is only inspected and never taken. */
  force?: boolean;
}

export interface ReleasePortResult {
  /** True when nothing listens on the port any more. */
  ok: boolean;
  /** The PIDs that were signalled (in order). */
  killed: number[];
  /** A user-readable reason when `ok` is false. */
  detail?: string;
}

/** Attempts before giving up on a port that refuses to come free. */
const MAX_WAIT_ROUNDS = 12;
const WAIT_MS = 250;
/** How long a SIGTERM gets before SIGKILL follows. */
const TERM_GRACE_MS = 500;
/**
 * Grace rounds for a port whose listener could not be signalled (all of them are
 * ours, or the OS tool could not name one). A socket can answer the probe for a
 * moment after its process exits, so the verdict is the **port**, checked over a
 * bounded window, never the kill list.
 */
const UNOWNED_GRACE_ROUNDS = 6;

/** PIDs that must never be signalled (kernel idle/System on Windows, init on POSIX). */
const MIN_SIGNABLE_PID = 5;

/**
 * The PIDs listening on `port`, best effort, deduplicated and numeric only.
 *
 * Windows is answered in two passes because neither tool alone is sufficient:
 *
 *  - `Get-NetTCPConnection -LocalPort <p> -State Listen` returns **structured**
 *    values, so it is immune to the localized `netstat` state word (German
 *    "ABHÖREN", Vietnamese "ĐANG LẮNG NGHE", …) and it covers both address
 *    families.
 *  - `netstat -ano` is the fallback. It is run **without** `-p tcp`: that filter
 *    lists IPv4 only, while a Node `listen(port)` binds a dual-stack `[::]`
 *    socket — the bridge's actual listener — which `netstat -p tcp` never
 *    prints (verified: 0 `[::]` rows with the filter, 27 without). The state
 *    filter stays English-only in this pass, which is exactly why PowerShell is
 *    tried first.
 *
 * POSIX: `lsof -nP -iTCP:38617 -sTCP:LISTEN -t` prints one PID per line.
 */
export async function listeningPids(port: number, deps: PortOwnerDeps): Promise<number[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return windowsListeningPids(port, deps);

  const result = await deps.runner.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    timeoutMs: 5_000,
  });
  if (result.missing || result.code !== 0) return [];
  const pids = new Set<number>();
  for (const token of result.stdout.split(/\s+/)) {
    const parsed = Number.parseInt(token, 10);
    if (Number.isFinite(parsed) && parsed > 0) pids.add(parsed);
  }
  return [...pids];
}

/**
 * PowerShell first, `netstat` when PowerShell cannot answer. `null` from the
 * first pass means "the tool is not available", not "no listener": an empty
 * answer from a working PowerShell is the truth and must not be second-guessed.
 */
async function windowsListeningPids(port: number, deps: PortOwnerDeps): Promise<number[]> {
  const viaPowerShell = await windowsListeningPidsViaPowerShell(port, deps);
  if (viaPowerShell !== null) return viaPowerShell;
  return windowsListeningPidsViaNetstat(port, deps);
}

async function windowsListeningPidsViaPowerShell(
  port: number,
  deps: PortOwnerDeps,
): Promise<number[] | null> {
  // The port is interpolated into a command line, so it must be a real port
  // number and nothing else.
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;

  const result = await deps.runner.run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
    ],
    { timeoutMs: 8_000 },
  );
  if (result.missing || result.code !== 0) return null;

  const pids = new Set<number>();
  for (const token of result.stdout.split(/\s+/)) {
    const parsed = Number.parseInt(token, 10);
    if (Number.isFinite(parsed) && parsed > 0) pids.add(parsed);
  }
  return [...pids];
}

async function windowsListeningPidsViaNetstat(
  port: number,
  deps: PortOwnerDeps,
): Promise<number[]> {
  // No `-p` filter: IPv4 and IPv6 rows must both be visible (see above).
  const result = await deps.runner.run("netstat", ["-ano"], { timeoutMs: 5_000 });
  if (result.missing || result.code !== 0) return [];

  const pids = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    // Protocol, local address, foreign address, state, pid.
    const [proto, local, , state, pid] = columns;
    if (!proto?.toUpperCase().startsWith("TCP")) continue;
    if (state?.toUpperCase() !== "LISTENING") continue;
    if (!endpointMatchesPort(local, port)) continue;
    const parsed = Number.parseInt(pid ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) pids.add(parsed);
  }
  return [...pids];
}

/**
 * True when a `local address` column (`127.0.0.1:38617`, `[::]:38617`, `*:38617`,
 * `0.0.0.0:38617`) names that port. Comparing the segment after the last colon
 * exactly is enough: `:386170` is a different port, and IPv6 brackets need no
 * special case because the port is always last.
 */
function endpointMatchesPort(endpoint: string | undefined, port: number): boolean {
  if (!endpoint) return false;
  const index = endpoint.lastIndexOf(":");
  if (index === -1) return false;
  return endpoint.slice(index + 1) === String(port);
}

/** Something human-readable for the failure message: the executable name. */
export async function describeOwner(pid: number, deps: PortOwnerDeps): Promise<string> {
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "win32") {
      const result = await deps.runner.run(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { timeoutMs: 5_000 },
      );
      const image = result.stdout.match(/"([^"]+)"/)?.[1];
      return image ? `${image} (pid ${pid})` : `pid ${pid}`;
    }
    const result = await deps.runner.run("ps", ["-o", "comm=", "-p", String(pid)], {
      timeoutMs: 5_000,
    });
    const name = result.stdout.trim();
    return name.length > 0 ? `${name} (pid ${pid})` : `pid ${pid}`;
  } catch {
    return `pid ${pid}`;
  }
}

/**
 * Make `port` free, terminating its owner when necessary.
 *
 * The sequence, and why each part exists:
 *
 *  1. Probe. A Pi Office bridge already answering means the app's own previous
 *     run left an orphan behind (a crashed main never stopped its host); any
 *     other HTTP answer means a foreign program; unreachable means nobody is
 *     there — the common case, and instant.
 *  2. Look up the listeners. Anything this app owns is skipped, as is anything
 *     below {@link MIN_SIGNABLE_PID}.
 *  3. With `force: false`, stop here and report what *would* be killed.
 *  4. Otherwise `SIGTERM` (Windows: `taskkill /T /F`), wait a grace period, then
 *     `SIGKILL`, re-reading the owner before each signal.
 *  5. Poll the probe until the port answers nothing, and fail with a message
 *     naming the owner when it never does.
 */
export async function releasePort(
  input: ReleasePortInput,
  deps: PortOwnerDeps,
): Promise<ReleasePortResult> {
  const port = input.port ?? PI_OFFICE_BRIDGE.defaultPort;
  const own = new Set(input.ownPids ?? []);
  const force = input.force !== false;

  const probeStatus = async (): Promise<string> => (await deps.probe(port)).status;

  const initial = await probeStatus();
  if (initial === "unreachable") return { ok: true, killed: [] };

  const pids = await listeningPids(port, deps);
  const targets = pids.filter((pid) => pid >= MIN_SIGNABLE_PID && !own.has(pid));
  if (targets.length === 0) {
    // Nothing is signalled here: either every listener is ours (the supervisor
    // owns that stop) or the OS tool could not name one. Either way the *port*
    // is the verdict — a takeover that reports `ok` while the probe still
    // answers spawns a host that cannot bind, and the Documents menu (rightly)
    // never comes back. Socket teardown can answer for a moment, so give it a
    // bounded grace period before calling it a failure.
    const waitForFree = async (): Promise<boolean> => {
      for (let round = 0; round < UNOWNED_GRACE_ROUNDS; round += 1) {
        if ((await probeStatus()) === "unreachable") return true;
        await deps.sleep(WAIT_MS);
      }
      return (await probeStatus()) === "unreachable";
    };

    if (!force) {
      return {
        ok: false,
        killed: [],
        detail: `port ${port} is in use but its owner is unknown (${initial}); close whatever is using it and retry`,
      };
    }

    if (await waitForFree()) return { ok: true, killed: [] };

    // The port is still answering. Naming the owner (when there is one) is what
    // makes the failure actionable; `ownPids` are still named so a slow exit is
    // distinguishable from a squatter.
    const owners = await Promise.all(pids.map((pid) => describeOwner(pid, deps)));
    return {
      ok: false,
      killed: [],
      detail:
        pids.length > 0
          ? `port ${port} is still held by ${owners.join(", ")} (this app's own host; it may still be exiting)`
          : `port ${port} is in use but its owner is unknown (${initial}); close whatever is using it and retry`,
    };
  }

  if (!force) {
    const owners = await Promise.all(targets.map((pid) => describeOwner(pid, deps)));
    return {
      ok: false,
      killed: [],
      detail: `port ${port} is held by ${owners.join(", ")}`,
    };
  }

  const killed: number[] = [];
  for (const pid of targets) {
    // PID reuse guard: the owner must still be the same process right before the
    // signal, or the list is stale and this kill would hit an innocent process.
    const current = await listeningPids(port, deps);
    if (!current.includes(pid)) continue;
    killProcess(pid, "SIGTERM", deps);
    killed.push(pid);
  }

  // Give the process time to exit cleanly. Whether to escalate is decided by the
  // **port**, not by a second lookup: a closing socket can still appear in
  // `netstat` for a moment, and a process that honoured SIGTERM must not be
  // SIGKILLed for it.
  await deps.sleep(TERM_GRACE_MS);
  if ((await probeStatus()) !== "unreachable") {
    const current = await listeningPids(port, deps);
    for (const pid of killed) {
      if (current.includes(pid)) killProcess(pid, "SIGKILL", deps);
    }
  }

  for (let round = 0; round < MAX_WAIT_ROUNDS; round += 1) {
    if ((await probeStatus()) === "unreachable") return { ok: true, killed };
    await deps.sleep(WAIT_MS);
  }

  const owners = await Promise.all(killed.map((pid) => describeOwner(pid, deps)));
  return {
    ok: false,
    killed,
    detail: `port ${port} is still in use by ${owners.join(", ")}`,
  };
}

/** One signal, going through the platform's own tool on Windows. */
function killProcess(pid: number, signal: "SIGTERM" | "SIGKILL", deps: PortOwnerDeps): void {
  try {
    deps.kill(pid, signal);
  } catch {
    // A process that is already gone is exactly the state we want.
  }
}

/** The production `kill`: `taskkill` on Windows (no portable signal for a tree). */
export function createKillProcess(
  runner: PortCommandRunner,
): (pid: number, signal: "SIGTERM" | "SIGKILL") => void {
  return (pid, signal) => {
    if ((process.platform as NodeJS.Platform) === "win32") {
      // `/T` also takes the child processes, which is what a host wrapper needs;
      // `/F` is required because Windows has no graceful termination for an
      // arbitrary process.
      void runner.run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 10_000 });
      return;
    }
    process.kill(pid, signal);
  };
}
