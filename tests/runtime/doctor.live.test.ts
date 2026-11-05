/**
 * `npm run doctor` — the honest environment check.
 *
 * Runs the real resolution and detection code against this machine and prints a
 * report (runtime source and versions, Pi profile, git, Office, bridge health).
 * It asserts only invariants that hold on every platform, so it is safe in CI.
 *
 *   npx vitest run tests/runtime/doctor.live.test.ts --disable-console-intercept
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectOfficeEnvironment } from "../../src/main/office/detect";
import { checkBridgeHealth, createDefaultVerifyDeps } from "../../src/main/office/verify";
import { resolveAppPaths } from "../../src/main/paths";
import {
  isCommonProjectDevPort,
  rendererDevServer,
  rendererDevUrl,
} from "../../src/main/runtime/dev-server";
import { resolveAppRuntime } from "../../src/main/runtime/environment";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtimeRoot = join(repoRoot, "resources", "runtime");

/**
 * True when nothing listens on `host:port`. A bind failure is the signal; the
 * server is closed again on success. The doctor only reports this — a CI run may
 * legitimately have a dev server up.
 */
async function isPortFree(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

describe("doctor", () => {
  it("prints the environment report and holds its invariants", async () => {
    const resolution = resolveAppRuntime({
      isPackaged: false,
      resourcesPath: runtimeRoot,
      appRoot: repoRoot,
    });
    const paths = resolveAppPaths({
      userDataDir: join(homedir(), "AppData", "Roaming", "pi-desktop"),
      env: {},
    });
    const office = await detectOfficeEnvironment();
    const health = await checkBridgeHealth(createDefaultVerifyDeps(), { timeoutMs: 2_000 });
    const git = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000 });
    const dev = (() => {
      try {
        return { ok: true as const, value: rendererDevServer(process.env) };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    const devFree = dev.ok ? await isPortFree(dev.value.host, dev.value.port) : false;
    const devState = !dev.ok
      ? `invalid — ${dev.message}`
      : [
          devFree ? "free" : "in use — stop the other dev server or set PI_DESKTOP_RENDERER_PORT",
          ...(isCommonProjectDevPort(dev.value.port)
            ? ["common project port — expect collisions"]
            : []),
        ].join("; ");

    const lines = [
      "",
      "pi-desktop doctor",
      "─────────────────",
      `os               ${process.platform}/${process.arch} (node ${process.version})`,
      `runtime source   ${resolution.source ?? "unavailable"}`,
      `runtime target   ${resolution.target}`,
      `node             ${resolution.nodeVersion ?? "—"}  ${resolution.nodePath ?? ""}`,
      `npm command      ${resolution.npmCommand?.join(" ") ?? "—"}`,
      `host bundle      ${resolution.piHostPath}${existsSync(resolution.piHostPath) ? "" : "  (missing — run npm run build:host)"}`,
      `shim dir         ${resolution.binDir}${existsSync(resolution.binDir) ? "" : "  (missing — run npm run runtime:fetch)"}`,
      `renderer dev     ${dev.ok ? rendererDevUrl(process.env) : "—"}  (${devState})`,
      `pi profile       ${paths.profileDir}${existsSync(paths.profileDir) ? "" : "  (not created yet)"}`,
      `  settings.json  ${existsSync(join(paths.profileDir, "settings.json")) ? "present" : "absent"}`,
      `  auth.json      ${existsSync(join(paths.profileDir, "auth.json")) ? "present" : "absent"}`,
      `git              ${git.status === 0 ? (git.stdout ?? "").trim() : "not found (commit/checkpoint features degrade)"}`,
      `office           ${office.os}${office.office.version ? `, Office ${office.office.version}` : ", no Office install"} (supported: ${office.supported})`,
      `bridge           ${health.status} on ${health.url}${health.portConflict ? " (port conflict)" : ""}${
        health.health
          ? ` — ${health.health.serverName} v${health.health.serverVersion}, ${health.health.panes.length} pane(s)`
          : ""
      }`,
    ];

    for (const problem of resolution.problems) lines.push(`note             ${problem}`);
    if (resolution.hint) lines.push(`hint             ${resolution.hint}`);
    lines.push("");
    console.log(lines.join("\n"));

    // Invariants that must hold on any machine.
    expect(paths.profileDir.endsWith(join(".pi", "agent"))).toBe(true);
    expect(["ok", "unreachable", "not-our-bridge", "invalid-response"]).toContain(health.status);
    expect(office.apps).toHaveLength(3);
    if (!resolution.ok) {
      expect(resolution.hint).toContain("runtime:fetch");
    }
  }, 60_000);
});
