import { describe, expect, it } from "vitest";

import {
  describeOwner,
  listeningPids,
  releasePort,
  type PortOwnerDeps,
} from "../../src/main/office/port-owner";

/**
 * Freeing bridge port 38617 (2026-10-30 project-scoped rail plan).
 *
 * Every OS fact goes through an injected port, so these tests script `netstat` /
 * `lsof` / `taskkill` output and a health probe, and assert what the reclaimer
 * does with them. The safety rules (never our own PIDs, never kernel PIDs, re-read
 * before kill) are the reason this module exists, so each has a test.
 */

const PORT = 38617;

interface Harness {
  deps: PortOwnerDeps;
  killed: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }>;
  commands: Array<{ command: string; args: readonly string[] }>;
  /** Flip the probe's answer to simulate a squatter dying. */
  setListening(pids: number[]): void;
  setProbe(status: "ok" | "unreachable" | "not-our-bridge"): void;
  sleeps: number[];
}

function harness(
  options: {
    platform?: NodeJS.Platform;
    /** PIDs the OS tools report, mutable per call for the reuse guard. */
    netstat?: string | ((call: number) => string);
    lsof?: string | ((call: number) => string);
    /**
     * `Get-NetTCPConnection` output. **Absent means the executable is missing**, so
     * the netstat fallback is exercised; an empty string is a working PowerShell
     * that found no listener (an answer, not an absence).
     */
    powershell?: string | ((call: number) => string);
    probe?: Array<"ok" | "unreachable" | "not-our-bridge">;
    missing?: boolean;
  } = {},
): Harness {
  const killed: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }> = [];
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  const sleeps: number[] = [];
  let call = 0;
  let probeIndex = 0;
  let probeStatus = options.probe?.[0] ?? "ok";
  const netstatText = (): string => {
    if (typeof options.netstat === "function") return options.netstat(call);
    return options.netstat ?? "";
  };
  const lsofText = (): string => {
    if (typeof options.lsof === "function") return options.lsof(call);
    return options.lsof ?? "";
  };

  const deps: PortOwnerDeps = {
    platform: options.platform ?? "win32",
    runner: {
      async run(command, args) {
        commands.push({ command, args });
        if (command === "netstat") {
          call += 1;
          return { code: 0, stdout: netstatText(), stderr: "", missing: options.missing ?? false };
        }
        if (command === "lsof") {
          call += 1;
          return { code: 0, stdout: lsofText(), stderr: "", missing: options.missing ?? false };
        }
        if (command === "powershell.exe") {
          if (options.powershell === undefined) {
            return { code: 127, stdout: "", stderr: "not found", missing: true };
          }
          const text =
            typeof options.powershell === "function"
              ? options.powershell(call)
              : options.powershell;
          return { code: 0, stdout: text, stderr: "", missing: false };
        }
        if (command === "tasklist") {
          return {
            code: 0,
            stdout: '"pi.exe","4242","Console","1","10,000 K"\n',
            stderr: "",
            missing: false,
          };
        }
        if (command === "ps") {
          return { code: 0, stdout: "pi\n", stderr: "", missing: false };
        }
        return { code: 0, stdout: "", stderr: "", missing: false };
      },
    },
    kill(pid, signal) {
      killed.push({ pid, signal });
    },
    async sleep(ms) {
      sleeps.push(ms);
      // Let a scripted test move the probe forward as time passes.
      if (options.probe) {
        probeIndex = Math.min(probeIndex + 1, options.probe.length - 1);
        probeStatus = options.probe[probeIndex] ?? probeStatus;
      }
    },
    async probe() {
      return { status: probeStatus as "ok" | "unreachable" | "not-our-bridge" };
    },
  };

  return {
    deps,
    killed,
    commands,
    sleeps,
    setListening() {
      /* scripted through the netstat/lsof callbacks */
    },
    setProbe(status) {
      probeStatus = status;
    },
  };
}

/** A Windows netstat row for one listening PID. */
function netstatRow(pid: number, port = PORT, state = "LISTENING"): string {
  return `  TCP    127.0.0.1:${port}        0.0.0.0:0              ${state}        ${pid}\r\n`;
}

/** The same row on a dual-stack socket: `netstat -p tcp` never prints this one. */
function netstatRowV6(pid: number, port = PORT, state = "LISTENING"): string {
  return `  TCP    [::]:${port}            [::]:0                 ${state}        ${pid}\r\n`;
}

describe("listeningPids", () => {
  it("reads the PID column of a LISTENING row on Windows", async () => {
    const { deps } = harness({
      netstat: [
        "Active Connections",
        "",
        "  Proto  Local Address          Foreign Address        State           PID",
        netstatRow(4242),
        netstatRow(5151, 38618),
        netstatRow(6161, PORT, "ESTABLISHED"),
      ].join("\r\n"),
    });

    expect(await listeningPids(PORT, deps)).toEqual([4242]);
  });

  it("ignores a port that merely shares a prefix", async () => {
    const { deps } = harness({ netstat: netstatRow(4242, 386170) });
    expect(await listeningPids(PORT, deps)).toEqual([]);
  });

  it("matches IPv6 and wildcard endpoints in the netstat fallback", async () => {
    const { deps } = harness({
      netstat: [netstatRowV6(111), netstatRow(222, PORT)].join("\r\n"),
    });

    expect(await listeningPids(PORT, deps)).toEqual([111, 222]);
  });

  it("prefers Get-NetTCPConnection, which is not locale-dependent", async () => {
    // `netstat` prints a localized state word, so a German Windows would never
    // match LISTENING. PowerShell answers with the PID itself.
    const { deps, commands } = harness({
      powershell: "4242\r\n5151\r\n4242\r\n",
      netstat: netstatRow(9999),
    });

    expect(await listeningPids(PORT, deps)).toEqual([4242, 5151]);
    expect(commands.some((entry) => entry.command === "netstat")).toBe(false);
  });

  it("treats a working PowerShell's empty answer as no listener", async () => {
    // PowerShell succeeded and found nothing, so a stale netstat row must not be
    // second-guessed into a kill.
    const { deps, commands } = harness({ powershell: "", netstat: netstatRow(4242) });

    expect(await listeningPids(PORT, deps)).toEqual([]);
    expect(commands.some((entry) => entry.command === "netstat")).toBe(false);
  });

  it("falls back to netstat when PowerShell is unavailable", async () => {
    const { deps, commands } = harness({ netstat: netstatRow(4242) });

    expect(await listeningPids(PORT, deps)).toEqual([4242]);
    expect(commands.some((entry) => entry.command === "netstat")).toBe(true);
  });

  it("never reads a localized state word as a listener", async () => {
    // The fallback is English-only on purpose: reporting no PID is recoverable
    // (the takeover then fails loudly), killing the wrong PID is not.
    const { deps } = harness({ netstat: netstatRow(4242, PORT, "ABHÖREN") });

    expect(await listeningPids(PORT, deps)).toEqual([]);
  });

  it("reads one PID per line from lsof on POSIX", async () => {
    const { deps } = harness({ platform: "linux", lsof: "4242\n4243\n" });
    expect(await listeningPids(PORT, deps)).toEqual([4242, 4243]);
  });

  it("reports nothing when the tool is missing", async () => {
    const { deps } = harness({ missing: true, netstat: netstatRow(1) });
    expect(await listeningPids(PORT, deps)).toEqual([]);
  });

  it("ignores non-numeric noise", async () => {
    const { deps } = harness({ platform: "darwin", lsof: "lsof: warning\n\n42\n" });
    expect(await listeningPids(PORT, deps)).toEqual([42]);
  });
});

describe("releasePort", () => {
  it("returns immediately when nothing answers the port", async () => {
    const { deps, commands } = harness({ probe: ["unreachable"] });

    const result = await releasePort({ port: PORT }, deps);

    expect(result).toEqual({ ok: true, killed: [] });
    // No OS probe is needed when the port is already free.
    expect(commands).toEqual([]);
  });

  it("kills a foreign listener, then confirms the port came free", async () => {
    const { deps, killed } = harness({
      netstat: netstatRow(4242),
      probe: ["ok", "unreachable"],
    });

    const result = await releasePort({ port: PORT }, deps);

    expect(result.ok).toBe(true);
    expect(result.killed).toEqual([4242]);
    expect(killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("never signals a PID this app owns", async () => {
    const { deps, killed } = harness({
      netstat: netstatRow(4242),
      probe: ["ok", "unreachable"],
    });

    const result = await releasePort({ port: PORT, ownPids: [4242] }, deps);

    expect(killed).toEqual([]);
    // Every listener was ours: stopping it belongs to the supervisor, and the
    // reclaimer reports the port free once it really is — no kill, no detail.
    expect(result.killed).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it("does not claim success while this app's own host still answers", async () => {
    // The promoted host would spawn, fail to bind, and the Documents menu would
    // never recover — the silent half-success this rule exists to remove.
    const { deps } = harness({ netstat: netstatRow(4242), probe: ["ok"] });

    const result = await releasePort({ port: PORT, ownPids: [4242] }, deps);

    expect(result.ok).toBe(false);
    expect(result.killed).toEqual([]);
    expect(result.detail).toMatch(/own host/i);
    expect(result.detail).toMatch(/4242/);
  });

  it("does not claim success when the owner cannot be identified", async () => {
    // Something answers on the port, but no OS tool names a listener. Claiming
    // success here is what left a promoted session unable to bind the bridge
    // until the *other* process happened to die.
    const { deps } = harness({ powershell: "", netstat: "", probe: ["not-our-bridge"] });

    const result = await releasePort({ port: PORT }, deps);

    expect(result.ok).toBe(false);
    expect(result.killed).toEqual([]);
    expect(result.detail).toMatch(/owner is unknown/i);
    expect(result.detail).toMatch(/not-our-bridge/);
    expect(result.detail).toMatch(/close whatever is using it/i);
  });

  it("waits out a port that frees while it looks", async () => {
    // Our own host may still be exiting when the reclaimer runs; a moment of
    // socket teardown must not fail an otherwise good takeover.
    const { deps } = harness({ netstat: netstatRow(4242), probe: ["ok", "unreachable"] });

    const result = await releasePort({ port: PORT, ownPids: [4242] }, deps);

    expect(result.ok).toBe(true);
    expect(result.killed).toEqual([]);
  });

  it("never signals a kernel or System PID", async () => {
    const { deps, killed } = harness({ netstat: netstatRow(4), probe: ["ok", "unreachable"] });

    const result = await releasePort({ port: PORT }, deps);

    expect(killed).toEqual([]);
    expect(result.killed).toEqual([]);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const { deps, killed } = harness({
      netstat: netstatRow(4242),
      // Still answering after the grace period, then gone.
      probe: ["ok", "ok", "unreachable"],
    });

    const result = await releasePort({ port: PORT }, deps);

    expect(result.ok).toBe(true);
    expect(killed.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("re-reads the owner before killing, so a recycled PID is left alone", async () => {
    // First lookup names 4242; by the time the kill is attempted, 4242 is gone
    // and an unrelated 9999 holds the port. Killing 4242 would hit a stranger.
    let lookup = 0;
    const { deps, killed } = harness({
      netstat: () => {
        lookup += 1;
        return lookup === 1 ? netstatRow(4242) : netstatRow(9999);
      },
      probe: ["ok", "unreachable"],
    });

    await releasePort({ port: PORT }, deps);

    expect(killed).toEqual([]);
  });

  it("reports what holds the port when force is off", async () => {
    const { deps, killed } = harness({ netstat: netstatRow(4242), probe: ["ok"] });

    const result = await releasePort({ port: PORT, force: false }, deps);

    expect(result.ok).toBe(false);
    expect(killed).toEqual([]);
    expect(result.detail).toMatch(/38617/);
    expect(result.detail).toMatch(/pi\.exe \(pid 4242\)/);
  });

  it("fails with the owner named when the port never comes free", async () => {
    // The probe keeps answering: something is restarting, or the kill was
    // refused. The caller gets a message it can show verbatim.
    const { deps } = harness({ netstat: netstatRow(4242), probe: ["ok"] });

    const result = await releasePort({ port: PORT }, deps);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/still in use/);
    expect(result.detail).toMatch(/4242/);
  });

  it("says its owner is unknown when the probe answers but no tool finds one", async () => {
    const { deps } = harness({ powershell: "", netstat: "", probe: ["not-our-bridge"] });

    const result = await releasePort({ port: PORT, force: false }, deps);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/owner is unknown/);
    // A read-only inspection does not wait out the probe.
    expect(result.killed).toEqual([]);
  });
});

describe("describeOwner", () => {
  it("names the image on Windows", async () => {
    const { deps } = harness({});
    expect(await describeOwner(4242, deps)).toMatch(/pi\.exe \(pid 4242\)/);
  });

  it("names the command on POSIX", async () => {
    const { deps } = harness({ platform: "linux" });
    expect(await describeOwner(4242, deps)).toMatch(/pi \(pid 4242\)/);
  });
});
