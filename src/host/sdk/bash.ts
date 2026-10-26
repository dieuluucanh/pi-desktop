/**
 * The `BashPort` over a live session's `ExtensionRunner` (plan step 7).
 *
 * Terminal Pi emits Pi's `user_bash` event **before** it runs a `!`/`!!`
 * command, so an extension can rewrite the executor (`operations`) or replace
 * the execution entirely (`result`). The host must do the same; otherwise an
 * extension that intercepts bash (a sandbox, a remote runner) would be bypassed
 * by the desktop and the two clients would disagree about the same profile.
 *
 * Only root-exported SDK types are used (`BashOperations`); the runner itself
 * arrives as the session core's injected `extensionRunner`.
 */

import type { BashOperations, UserBashEventResult } from "@earendil-works/pi-coding-agent";
import type { BashPort, BashRunOutcome } from "../session-core";

/** The narrow runner surface the adapter drives (mirrors the SDK's runner). */
export interface SdkUserBashRunner {
  emitUserBash?(event: {
    type: "user_bash";
    command: string;
    excludeFromContext: boolean;
    cwd: string;
  }): Promise<UserBashEventResult | undefined>;
}

export function createSdkBashPort(runner: unknown): BashPort | null {
  if (!runner || typeof runner !== "object") return null;
  const emit = (runner as SdkUserBashRunner).emitUserBash;
  if (typeof emit !== "function") return null;
  return {
    async run(command, options): Promise<BashRunOutcome> {
      const outcome = await emit.call(runner, {
        type: "user_bash",
        command,
        excludeFromContext: options.excludeFromContext,
        cwd: options.cwd,
      });
      if (!outcome) return {};
      // A full replacement wins: the extension already ran the command and the
      // host must not run it a second time.
      if (outcome.result) return { result: outcome.result };
      if (outcome.operations) return { operations: outcome.operations as BashOperations };
      return {};
    },
  };
}
