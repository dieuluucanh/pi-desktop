/**
 * Fixture entry point for the Workflow bundle staging tests.
 *
 * It deliberately mirrors the shapes the real artifact uses: a relative static
 * import, a relative dynamic import, a host-peer type import, and a relative
 * non-code asset. The default export is the registration factory the loader
 * contract requires.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { helperValue } from "./helper.ts";

const policyUrl = new URL("./assets/policy.json", import.meta.url);

export default function workflowFixture(api: Pick<ExtensionAPI, "on">): void {
  api.on("session_start", () => undefined);
}

export async function loadDynamic(): Promise<string> {
  const module = await import("./dynamic.ts");
  return `${helperValue()}:${module.dynamicValue()}:${policyUrl.pathname.length}`;
}
