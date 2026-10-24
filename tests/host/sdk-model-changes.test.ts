import { describe, expect, it, vi } from "vitest";

import { observeSdkModelChanges } from "../../src/host/sdk/model-changes";

/**
 * The host-side bridge for Pi's extension-only selection events.
 *
 * `AgentSession.setModel` announces a change to extensions through
 * `ExtensionRunner.emit`, not through the session's subscriber stream, so the
 * adapter wraps `emit`. These tests pin the two events it must observe, the
 * result/`this` it must preserve for every other event, and the dispose path.
 */

function runner(result: unknown = "handled") {
  const emit = vi.fn(async (event: { type: string }) => {
    void event;
    return result;
  });
  return { emit };
}

describe("observeSdkModelChanges", () => {
  it("notifies after a model selection resolves", async () => {
    const target = runner("handled");
    const onChange = vi.fn();
    observeSdkModelChanges({ extensionRunner: target }, onChange);

    await expect(target.emit({ type: "model_select" })).resolves.toBe("handled");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("notifies after a thinking-level selection resolves", async () => {
    const target = runner();
    const onChange = vi.fn();
    observeSdkModelChanges({ extensionRunner: target }, onChange);

    await target.emit({ type: "thinking_level_select" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("leaves every other event untouched", async () => {
    const target = runner("result");
    const onChange = vi.fn();
    observeSdkModelChanges({ extensionRunner: target }, onChange);

    await expect(target.emit({ type: "message_end" })).resolves.toBe("result");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("notifies on a rejected selection and preserves the rejection", async () => {
    const target = {
      emit: vi.fn(async (_event: { type: string }) => {
        throw new Error("handler failed");
      }),
    };
    const onChange = vi.fn();
    observeSdkModelChanges({ extensionRunner: target }, onChange);

    await expect(target.emit({ type: "model_select" })).rejects.toThrow("handler failed");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("swallows a callback failure instead of changing the SDK result", async () => {
    const target = runner("handled");
    observeSdkModelChanges({ extensionRunner: target }, () => {
      throw new Error("state push failed");
    });

    await expect(target.emit({ type: "model_select" })).resolves.toBe("handled");
  });

  it("restores the original method on dispose and stops notifying", async () => {
    const target = runner();
    const original = target.emit;
    const onChange = vi.fn();
    const dispose = observeSdkModelChanges({ extensionRunner: target }, onChange);

    expect(target.emit).not.toBe(original);
    dispose();
    expect(target.emit).toBe(original);

    await target.emit({ type: "model_select" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is a no-op when the session has no extension runner", () => {
    const onChange = vi.fn();
    const dispose = observeSdkModelChanges({}, onChange);
    expect(() => dispose()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
