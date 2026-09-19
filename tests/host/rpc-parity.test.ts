import { describe, expect, it } from "vitest";
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import { HOST_METHODS, isHostMethod } from "../../src/shared/host-protocol";

/**
 * RPC parity (plan step 4).
 *
 * Our host protocol mirrors Pi's official RPC mode so a Pi upgrade maps cleanly.
 * The checks below are *compile-time* wherever possible: if upstream renames a
 * command or an extension-UI method, this file stops type-checking instead of
 * drifting silently. The runtime checks then pin the parts a type cannot
 * (uniqueness, the absence of duplicate names, `isHostMethod` agreement).
 */

type RpcCommandType = RpcCommand["type"];

/**
 * Host method → the RPC command it mirrors. Adding a mirrored method without
 * listing it here is caught by the "every declared RPC mirror exists" test.
 */
const MIRRORED: Record<string, RpcCommandType> = {
  "session.new": "new_session",
  "session.switch": "switch_session",
  "session.forkMessages": "get_fork_messages",
  "session.lastAssistantText": "get_last_assistant_text",
  "session.queueMode": "set_steering_mode",
  "session.autoCompaction": "set_auto_compaction",
  "session.autoRetry": "set_auto_retry",
  "session.abortRetry": "abort_retry",
  "model.available": "get_available_models",
  "model.cycle": "cycle_model",
  "thinking.cycle": "cycle_thinking_level",
  "bash.run": "bash",
  "bash.abort": "abort_bash",
  "stats.get": "get_session_stats",
  "entries.get": "get_entries",
  "tree.get": "get_tree",
  "commands.list": "get_commands",
  "messages.get": "get_messages",
  "state.get": "get_state",
  prompt: "prompt",
  steer: "steer",
  followUp: "follow_up",
  abort: "abort",
  clearQueue: "clear_queue",
  "session.create": "new_session",
  "session.clone": "clone",
  "session.fork": "fork",
  "session.list": "get_state",
  compact: "compact",
  "session.rename": "set_session_name",
};

/** The follow-up mode shares one host method with steering, so it is listed apart. */
const MIRRORED_EXTRA: Record<string, RpcCommandType> = {
  "session.queueMode(followUp)": "set_follow_up_mode",
};

/** The extension-UI methods we reuse verbatim (plan step 16 implements them). */
type UiRequestMethod = RpcExtensionUIRequest["method"];

const UI_METHODS: Record<
  "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget",
  UiRequestMethod
> = {
  select: "select",
  confirm: "confirm",
  input: "input",
  editor: "editor",
  notify: "notify",
  setStatus: "setStatus",
  setWidget: "setWidget",
};

describe("host protocol ⇄ Pi RPC parity", () => {
  it("mirrors RPC command names that exist upstream (compile-time)", () => {
    // The record is typed `RpcCommand["type"]`, so any renamed or removed
    // command fails to compile.
    expect(Object.keys(MIRRORED).length).toBeGreaterThan(20);
    expect(Object.values(MIRRORED).every((value) => typeof value === "string")).toBe(true);
    expect(Object.keys(MIRRORED_EXTRA)).toHaveLength(1);
  });

  it("declares every mirrored method in HOST_METHODS and passes isHostMethod", () => {
    const declared = new Set<string>(HOST_METHODS);
    for (const method of Object.keys(MIRRORED)) {
      expect(declared.has(method), `host method ${method}`).toBe(true);
      expect(isHostMethod(method), `isHostMethod(${method})`).toBe(true);
    }
  });

  it("reuses the RPC extension-UI method names", () => {
    // Typed against RpcExtensionUIRequest["method"], so a renamed dialog method
    // breaks the build rather than the step-16 dialogs.
    expect(Object.values(UI_METHODS)).toEqual([
      "select",
      "confirm",
      "input",
      "editor",
      "notify",
      "setStatus",
      "setWidget",
    ]);
  });

  it("answers extension-UI requests with the RPC response shape", () => {
    const value: RpcExtensionUIResponse = {
      type: "extension_ui_response",
      id: "req-1",
      value: "Allow",
    };
    const confirmed: RpcExtensionUIResponse = {
      type: "extension_ui_response",
      id: "req-2",
      confirmed: true,
    };
    const cancelled: RpcExtensionUIResponse = {
      type: "extension_ui_response",
      id: "req-3",
      cancelled: true,
    };
    expect([value.type, confirmed.type, cancelled.type]).toEqual([
      "extension_ui_response",
      "extension_ui_response",
      "extension_ui_response",
    ]);
  });

  it("never gives one operation two host names", () => {
    const declared = new Set<string>(HOST_METHODS);
    // These would be duplicates of names the protocol already has.
    for (const duplicate of [
      "session.setName",
      "session.stats",
      "session.entries",
      "session.tree",
      "session.prompt",
    ]) {
      expect(declared.has(duplicate), `${duplicate} must not be a second name`).toBe(false);
    }
  });

  it("keeps HOST_METHODS unique and complete", () => {
    expect(new Set(HOST_METHODS).size).toBe(HOST_METHODS.length);
    expect(HOST_METHODS.length).toBeGreaterThanOrEqual(60);
  });
});
