import { describe, expect, it, vi } from "vitest";
import { createExtensionUiBridge, createExtensionUiPort } from "../../src/host/extension-ui";
import {
  EXTENSION_UI_NOTIFY_EVENT,
  EXTENSION_UI_STATE_EVENT,
  type ExtensionUiSnapshot,
} from "../../src/shared/extension-ui";

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

/* ------------------------------------------------------------------------- *
 * The UI port (plan step 16)
 * ------------------------------------------------------------------------- */

function portHarness(timeoutMs = 1_000) {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  let counter = 0;
  let bindingCounter = 0;
  const port = createExtensionUiPort({
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    newId: () => `ui-${++counter}`,
    // Deterministic bindings so an assertion can name the fencing generation.
    newBindingId: () => `binding-${++bindingCounter}`,
    timeoutMs,
    now: () => 1000,
  });
  const states = (): ExtensionUiSnapshot[] =>
    emitted
      .filter((entry) => entry.event === EXTENSION_UI_STATE_EVENT)
      .map((entry) => entry.payload as ExtensionUiSnapshot);
  const lastState = (): ExtensionUiSnapshot | undefined => states().at(-1);
  const respond = port.handlers()["oi.respond"]!;
  return { port, emitted, states, lastState, respond };
}

describe("extension UI port state", () => {
  it("sets and clears a status, pushing a snapshot each time", () => {
    const { port, lastState } = portHarness();
    port.setStatus("build", "passing");
    expect(lastState()?.statuses).toEqual({ build: "passing" });
    port.setStatus("build", undefined);
    expect(lastState()?.statuses).toEqual({});
    expect(port.snapshot().statuses).toEqual({});
  });

  it("sets widgets with a placement and clears them with undefined", () => {
    const { port, lastState } = portHarness();
    port.setWidget("one", ["a", "b"]);
    port.setWidget("two", ["c"], { placement: "belowEditor" });
    expect(lastState()?.widgets).toEqual([
      { key: "one", lines: ["a", "b"], placement: "aboveEditor" },
      { key: "two", lines: ["c"], placement: "belowEditor" },
    ]);
    port.setWidget("one", undefined);
    expect(lastState()?.widgets.map((widget) => widget.key)).toEqual(["two"]);
  });

  it("tracks working message, visibility and indicator", () => {
    const { port, lastState } = portHarness();
    port.setWorkingMessage("Thinking hard");
    port.setWorkingVisible(false);
    port.setWorkingIndicator({ frames: ["·"], intervalMs: 80 });
    expect(lastState()?.working).toEqual({
      message: "Thinking hard",
      visible: false,
      frames: ["·"],
      intervalMs: 80,
    });
    port.setWorkingMessage();
    port.setWorkingIndicator();
    expect(lastState()?.working).toEqual({
      message: null,
      visible: false,
      frames: null,
      intervalMs: null,
    });
  });

  it("tracks the hidden thinking label, title and tools-expanded state", () => {
    const { port, lastState } = portHarness();
    port.setHiddenThinkingLabel("…");
    port.setTitle("Reviewing");
    port.setToolsExpanded(true);
    expect(lastState()).toMatchObject({
      hiddenThinkingLabel: "…",
      title: "Reviewing",
      toolsExpanded: true,
    });
    expect(port.getToolsExpanded()).toBe(true);
    port.setHiddenThinkingLabel();
    expect(lastState()?.hiddenThinkingLabel).toBeNull();
  });

  it("emits notify with a type", () => {
    const { port, emitted } = portHarness();
    port.notify("done", "warning");
    expect(emitted.at(-1)).toEqual({
      event: EXTENSION_UI_NOTIFY_EVENT,
      payload: { id: "ui-1", message: "done", type: "warning", at: 1000 },
    });
  });

  it("mirrors the composer: set, paste, report back", () => {
    const { port, lastState, emitted } = portHarness();
    port.setEditorText("hello");
    expect(port.getEditorText()).toBe("hello");
    expect(lastState()?.editor).toEqual({ seq: 1, text: "hello", binding: "binding-1" });
    port.pasteToEditor(" world");
    expect(port.getEditorText()).toBe("hello world");
    expect(lastState()?.editor).toEqual({ seq: 2, text: "hello world", binding: "binding-1" });

    const before = emitted.length;
    expect(port.handlers()["oi.editorText"]!({ text: "typed" }, {} as never)).toEqual({ ok: true });
    expect(port.getEditorText()).toBe("typed");
    // Reporting the renderer's own text must not bounce back as an edit.
    expect(emitted.length).toBe(before);
  });

  it("answers oi.state with the snapshot", () => {
    const { port } = portHarness();
    port.setStatus("k", "v");
    expect(port.handlers()["oi.state"]!(undefined, {} as never)).toEqual(port.snapshot());
  });

  it("resets session-scoped registrations but keeps app-owned state", () => {
    const { port, states } = portHarness();
    const factory = (() => ({ render: () => [] })) as never;
    port.setStatus("k", "v");
    port.setWidget("w", ["line"]);
    port.setWorkingMessage("working");
    port.setWorkingVisible(true);
    port.setWorkingIndicator({ frames: ["."], intervalMs: 50 });
    port.setHiddenThinkingLabel("…");
    port.setTitle("title");
    port.setToolsExpanded(true);
    port.setFooter(factory);
    port.setHeader(factory);
    port.setEditorComponent(factory);
    port.onTerminalInput(() => undefined);
    port.addAutocompleteProvider(factory);
    port.setEditorText("draft");

    const before = states().length;
    port.resetSessionUi();

    expect(port.snapshot()).toMatchObject({
      statuses: {},
      widgets: [],
      working: { message: null, visible: null, frames: null, intervalMs: null },
      hiddenThinkingLabel: null,
      title: null,
      toolsExpanded: true,
      autocompleteProviders: 0,
    });
    expect(port.getFooter()).toBeUndefined();
    expect(port.getHeader()).toBeUndefined();
    expect(port.getEditorComponent()).toBeUndefined();
    expect(port.terminalInputHandlers()).toHaveLength(0);
    expect(port.providerCount()).toBe(0);
    // The renderer owns the draft mirror; a rebind must not erase it.
    expect(port.getEditorText()).toBe("draft");
    // The pending host edit, however, is superseded by the rebind.
    expect(port.snapshot().editor).toBeNull();
    expect(states()).toHaveLength(before + 1);

    // Idempotent: a second reset pushes the same empty state and changes nothing.
    port.resetSessionUi();
    expect(states()).toHaveLength(before + 2);
    expect(port.getToolsExpanded()).toBe(true);
  });
});

describe("composer edit fencing (plan step 17)", () => {
  it("mints a new binding and restarts the sequence on rebind", () => {
    const { port, lastState } = portHarness();
    port.setEditorText("old session");
    port.setEditorText("old session 2");
    expect(lastState()?.editor).toMatchObject({ seq: 2, binding: "binding-1" });

    port.resetSessionUi();
    // The pending edit belongs to the outgoing runner: replaying it into the
    // replacement session would overwrite a newer draft.
    expect(lastState()?.editor).toBeNull();
    // ...but the renderer's draft mirror survives the rebind.
    expect(port.getEditorText()).toBe("old session 2");

    // A fresh host can legitimately start again at a low sequence.
    port.setEditorText("new session");
    expect(lastState()?.editor).toEqual({ seq: 1, text: "new session", binding: "binding-2" });
  });

  it("keeps unconditional set/paste semantics for unrelated extensions", () => {
    const { port } = portHarness();
    port.setEditorText("a");
    port.setEditorText("a");
    port.pasteToEditor("b");
    // No compare-and-swap here: every write goes through, as Pi documents.
    expect(port.getEditorText()).toBe("ab");
    expect(port.snapshot().editor).toMatchObject({ seq: 3, text: "ab" });
  });

  it("drops a pending command the renderer's newer draft has superseded", () => {
    const { port, lastState } = portHarness();
    port.setEditorText("extension text");
    const before = lastState();

    // The user typed over it: the mirror no longer matches the command, so the
    // next state frame must not replay it.
    port.handlers()["oi.editorText"]!({ text: "user typed more" }, {} as never);
    expect(port.getEditorText()).toBe("user typed more");
    expect(port.snapshot().editor).toBeNull();
    // The superseded snapshot is not re-pushed: the mirror is not an edit.
    expect(lastState()).toEqual(before);
  });

  it("keeps the pending command while the mirror still matches it", () => {
    const { port } = portHarness();
    port.setEditorText("same");
    port.handlers()["oi.editorText"]!({ text: "same" }, {} as never);
    expect(port.snapshot().editor).toMatchObject({ seq: 1, text: "same" });
  });

  it("clears a consumed command once and only for the matching binding/seq", () => {
    const { port } = portHarness();
    const consume = port.handlers()["oi.editorConsumed"]!;
    port.setEditorText("one");

    // A stale ack (wrong seq or binding) must not drop a live command.
    expect(consume({ seq: 0, binding: "binding-1" }, {} as never)).toEqual({
      ok: true,
      cleared: false,
    });
    expect(consume({ seq: 1, binding: "binding-other" }, {} as never)).toEqual({
      ok: true,
      cleared: false,
    });
    expect(port.snapshot().editor).not.toBeNull();

    expect(consume({ seq: 1, binding: "binding-1" }, {} as never)).toEqual({
      ok: true,
      cleared: true,
    });
    // One-shot delivery: a reconnected renderer is never handed it again.
    expect(port.snapshot().editor).toBeNull();
    expect(port.getEditorText()).toBe("one");
    expect(consume({ seq: 1, binding: "binding-1" }, {} as never)).toEqual({
      ok: true,
      cleared: false,
    });
  });
});

describe("extension UI port dialogs", () => {
  it("select resolves through oi.respond and cancel resolves undefined", async () => {
    const { port, respond } = portHarness();
    const answer = port.select("Pick", ["a", "b"], { timeout: 5000 });
    await respond({ id: "ui-1", value: "b" }, {} as never);
    await expect(answer).resolves.toBe("b");

    const cancelled = port.confirm("Delete?", "Sure?");
    await respond({ id: "ui-2", cancelled: true }, {} as never);
    await expect(cancelled).resolves.toBe(false);
  });

  it("resolves an aborted dialog to its default without waiting", async () => {
    const { port } = portHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      port.input("Name", undefined, { signal: controller.signal }),
    ).resolves.toBeUndefined();
  });

  it("unblocks a dialog that expires", async () => {
    vi.useFakeTimers();
    try {
      const { port } = portHarness(50);
      const answer = port.editor("Write", "pre");
      const assertion = expect(answer).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("extension UI port autocomplete", () => {
  it("runs provider factories in registration order over the renderer's base", async () => {
    const { port } = portHarness();
    port.addAutocompleteProvider((current) => ({
      triggerCharacters: ["#"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const token = (lines[cursorLine] ?? "").slice(0, cursorCol);
        if (!token.startsWith("#"))
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        return { prefix: token, items: [{ value: "#doc", label: "#doc" }] };
      },
      applyCompletion: (_l, _cl, _cc, item, prefix) => ({
        lines: [item.value],
        cursorLine: 0,
        cursorCol: prefix.length + item.value.length,
      }),
    }));
    expect(port.providerCount()).toBe(1);

    const suggest = port.handlers()["completion.suggest"]!;
    await expect(
      suggest(
        {
          lines: ["#do"],
          cursorLine: 0,
          cursorCol: 3,
          base: { prefix: "@", items: [{ value: "@x", label: "@x" }] },
        },
        {} as never,
      ),
    ).resolves.toEqual({ prefix: "#do", items: [{ value: "#doc", label: "#doc" }] });

    // A token the provider does not own falls through to the renderer's base.
    await expect(
      suggest(
        {
          lines: ["@x"],
          cursorLine: 0,
          cursorCol: 2,
          base: { prefix: "@", items: [{ value: "@x", label: "@x" }] },
        },
        {} as never,
      ),
    ).resolves.toEqual({ prefix: "@", items: [{ value: "@x", label: "@x" }] });

    expect(
      port.handlers()["completion.apply"]!(
        {
          lines: ["#do"],
          cursorLine: 0,
          cursorCol: 3,
          item: { value: "#doc", label: "#doc" },
          prefix: "#do",
        },
        {} as never,
      ),
    ).toEqual({ lines: ["#doc"], cursorLine: 0, cursorCol: 7 });
  });

  it("answers null when no provider is registered", async () => {
    const { port } = portHarness();
    await expect(
      port.handlers()["completion.suggest"]!(
        { lines: ["a"], cursorLine: 0, cursorCol: 1 },
        {} as never,
      ),
    ).resolves.toBeNull();
  });
});

describe("dialog retraction on abort (row 28)", () => {
  it("retracts an already-visible dialog when its signal aborts", async () => {
    const { port, emitted } = portHarness();
    const controller = new AbortController();
    const answer = port.input("Name", "typed", { signal: controller.signal });
    const request = emitted.find((entry) => entry.event === "oi.request");
    expect(request).toBeTruthy();

    controller.abort();
    await expect(answer).resolves.toBeUndefined();
    const cancel = emitted.find((entry) => entry.event === "oi.cancel");
    expect(cancel?.payload).toEqual({ id: (request?.payload as { id: string }).id });
  });

  it("retracts every pending dialog when the session is torn down", () => {
    const { port, emitted } = portHarness();
    // The teardown rejects the host promises by design; the test only asserts
    // the renderer-side retraction, so the rejections are handled here.
    void port.select("Pick", ["a"]).catch(() => undefined);
    void port.confirm("Sure?", "Really?").catch(() => undefined);
    const ids = emitted
      .filter((entry) => entry.event === "oi.request")
      .map((entry) => (entry.payload as { id: string }).id);
    port.dispose("session replaced");
    const cancelled = emitted
      .filter((entry) => entry.event === "oi.cancel")
      .map((entry) => (entry.payload as { id: string }).id);
    expect(cancelled).toEqual(ids);
  });

  it("does not emit a cancel for a dialog that already settled", async () => {
    const { port, emitted, respond } = portHarness();
    const controller = new AbortController();
    const answer = port.input("Name", undefined, { signal: controller.signal });
    const id = (emitted.find((entry) => entry.event === "oi.request")?.payload as { id: string })
      .id;
    await respond({ id, value: "done" }, {} as never);
    await expect(answer).resolves.toBe("done");
    controller.abort();
    expect(emitted.some((entry) => entry.event === "oi.cancel")).toBe(false);
  });
});
