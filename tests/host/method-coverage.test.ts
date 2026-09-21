import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_METHODS, isHostMethod, type HostMethod } from "../../src/shared/host-protocol";
import { createControlCore } from "../../src/host/control-core";
import { createExtensionUiBridge, createExtensionUiPort } from "../../src/host/extension-ui";
import { createExtensionRendererRegistry } from "../../src/host/extension-renderers";
import { createProviderLoginHandlers } from "../../src/host/provider-login";
import { createSessionCore } from "../../src/host/session-core";
import { createFakeSettings } from "./fake-settings";

/**
 * Method coverage (plan step 25).
 *
 * `HOST_METHODS` is the single allowlist: `src/main/ipc.ts` refuses a
 * `session.request` whose method is not in it, and `src/host/service.ts` refuses
 * to dispatch one. That makes it easy for a method to drift — declared but never
 * handled, handled but never declared (and therefore unreachable), or handled but
 * never exercised by a test.
 *
 * This test pins all three directions:
 *
 *  1. every declared method is handled by exactly one of the host's handler
 *     factories (nothing dead in the protocol);
 *  2. every handled method is declared (nothing unreachable behind
 *     `isHostMethod`);
 *  3. every declared method is named in at least one other test file, so adding
 *     a method cannot ship without a test that exercises it.
 *
 * When this fails, the fix is to add the handler *and* a test that names the
 * method — not to edit the expected set here.
 */

/**
 * Methods served by the service's own transport layer (`src/host/service.ts`)
 * rather than by a core.
 */
const TRANSPORT_METHODS: readonly HostMethod[] = [
  "host.hello",
  "host.ping",
  "host.shutdown",
  "host.blobs.read",
  "host.metrics",
];

/**
 * Methods served by the SDK-backed TUI surface (plan step 17). Its factory
 * imports `pi-tui`, so this test does not instantiate it; the list is the
 * surface's `handlers()` keys, and a new `tui.*` method forces an edit here *and*
 * a test.
 */
const TUI_METHODS: readonly HostMethod[] = ["tui.state", "tui.resize", "tui.input"];

/** A session core built only to read its handler map; nothing calls the runtime. */
function sessionCore() {
  return createSessionCore({
    cwd: "/work/app",
    agentDir: "/profile",
    emit: () => undefined,
    createRuntime: async () => {
      throw new Error("this core is only inspected for its handler map");
    },
  });
}

function handledMethods(): Set<string> {
  const core = sessionCore();
  const control = createControlCore({
    settings: createFakeSettings(),
    listSessions: async () => [],
  });
  const bridge = createExtensionUiBridge({ emit: () => undefined });
  const uiPort = createExtensionUiPort({ emit: () => undefined });
  const renderers = createExtensionRendererRegistry({ emit: () => undefined });
  const providerLogin = createProviderLoginHandlers({
    resolvePort: () => null,
    emit: () => undefined,
    request: async () => undefined,
  });

  return new Set<string>([
    ...Object.keys(core.handlers()),
    ...Object.keys(control.handlers()),
    ...Object.keys(bridge.handlers()),
    ...Object.keys(uiPort.handlers()),
    ...Object.keys(renderers.handlers()),
    ...Object.keys(providerLogin.handlers()),
    ...TUI_METHODS,
    ...TRANSPORT_METHODS,
  ]);
}

const here = fileURLToPath(new URL(".", import.meta.url));

/** Every `*.test.ts(x)` under `tests/`, except this file. */
function testFiles(dir: string = join(here, "..")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry) && path !== fileURLToPath(import.meta.url)) out.push(path);
  }
  return out;
}

describe("host method coverage (plan step 25)", () => {
  it("handles exactly the declared methods — no dead, no unreachable", () => {
    const handled = handledMethods();
    const declared = new Set<string>(HOST_METHODS);

    const declaredButUnhandled = HOST_METHODS.filter((method) => !handled.has(method));
    const handledButUndeclared = [...handled].filter((method) => !declared.has(method));

    expect(declaredButUnhandled, "declared in HOST_METHODS but no handler exists").toEqual([]);
    expect(handledButUndeclared, "a handler exists but isHostMethod rejects the name").toEqual([]);
  });

  it("keeps every declared method reachable through isHostMethod", () => {
    for (const method of HOST_METHODS) {
      expect(isHostMethod(method), `${method} must pass isHostMethod`).toBe(true);
    }
  });

  it("names every declared method in another test file", () => {
    const corpus = testFiles()
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    const untested = HOST_METHODS.filter((method) => !corpus.includes(method));
    expect(untested, "add a test that exercises these methods").toEqual([]);
  });
});
