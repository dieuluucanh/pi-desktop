import { describe, expect, it, vi } from "vitest";
import { createExtensionUiBridge } from "../../src/host/extension-ui";

/**
 * The extension-UI bridge (plan step 4 plumbing; step 16 renders the dialogs).
 *
 * The contract that matters: a request blocks until its id comes back, a
 * cancelled dialog resolves `undefined` (never a rejection the extension would
 * have to catch), and nothing can hang forever.
 */

function harness(timeoutMs = 1_000) {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  let counter = 0;
  const bridge = createExtensionUiBridge({
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    newId: () => `ui-${++counter}`,
    timeoutMs,
  });
  const respond = bridge.handlers()["oi.respond"]!;
  return { bridge, emitted, respond };
}

describe("extension UI bridge", () => {
  it("emits oi.request and resolves with the answer value", async () => {
    const { bridge, emitted, respond } = harness();
    const answer = bridge.request("select", { title: "Pick", options: ["a", "b"] });

    expect(emitted[0]).toMatchObject({ event: "oi.request" });
    expect(emitted[0]?.payload).toMatchObject({
      id: "ui-1",
      method: "select",
      params: { title: "Pick" },
    });

    await respond({ id: "ui-1", value: "a" }, {} as never);
    await expect(answer).resolves.toBe("a");
    expect(bridge.pendingIds()).toEqual([]);
  });

  it("resolves a confirmation and reports an unknown id", async () => {
    const { bridge, respond } = harness();
    const confirm = bridge.request("confirm", { message: "Delete?" });
    await respond({ id: "ui-1", confirmed: true }, {} as never);
    await expect(confirm).resolves.toBe(true);

    // `oi.respond` is synchronous: it either delivers or reports a miss.
    expect(respond({ id: "nope", value: 1 }, {} as never)).toEqual({ delivered: false });
  });

  it("resolves a cancelled dialog as undefined, not as an error", async () => {
    const { bridge, respond } = harness();
    const answer = bridge.request("input", { title: "Name" });
    await respond({ id: "ui-1", cancelled: true }, {} as never);
    await expect(answer).resolves.toBeUndefined();
  });

  it("rejects a malformed response envelope", () => {
    const { respond } = harness();
    expect(() => respond({ value: "no id" }, {} as never)).toThrow(/requires an \{ id \}/);
  });

  it("unblocks a request that expires instead of hanging the extension", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = harness(50);
      const answer = bridge.request("editor", { title: "Write" });
      const assertion = expect(answer).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects every pending request when the session goes away", async () => {
    const { bridge } = harness();
    const first = bridge.request("select", {});
    const second = bridge.request("input", {});
    expect(bridge.pendingIds()).toHaveLength(2);

    bridge.dispose("the session closed");
    await expect(first).rejects.toThrow(/session closed/);
    await expect(second).rejects.toThrow(/session closed/);
    expect(bridge.pendingIds()).toEqual([]);
  });
});
