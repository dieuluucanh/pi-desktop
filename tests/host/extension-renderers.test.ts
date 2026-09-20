import { describe, expect, it, vi } from "vitest";
import {
  createExtensionRendererRegistry,
  type RendererComponent,
  type RendererRunner,
} from "../../src/host/extension-renderers";
import { EXTENSION_RENDER_INVALIDATE_EVENT } from "../../src/shared/extension-render";

/**
 * The extension renderer registry (plan step 18).
 *
 * These tests use fake components and a fake runner, so they pin the contract
 * the SDK adapter relies on: which renderer runs for which target, that a
 * renderer's state survives across a tool call's renders, and that a throwing
 * renderer degrades to the native card instead of killing the session.
 */

function linesComponent(...lines: string[]): RendererComponent {
  return { render: (width: number) => lines.map((line) => `${line}@${width}`) };
}

function harness(runner: RendererRunner | null = null) {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const registry = createExtensionRendererRegistry({
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
  });
  registry.bind({ runner, theme: () => ({ name: "test-theme" }), cwd: "C:/work/app" });
  return { registry, emitted };
}

describe("message and entry renderers", () => {
  it("runs a message renderer with the expand state and output pad", () => {
    const renderer = vi.fn((_message, _options, theme) => linesComponent(String(theme)));
    const { registry } = harness({ getMessageRenderer: () => renderer });

    const frame = registry.render({
      target: "message",
      type: "todo",
      width: 80,
      expanded: true,
      outputPad: 2,
      message: { customType: "todo", content: "3 left" },
    });

    expect(frame).toEqual({ rendered: true, width: 80, lines: ["[object Object]@80"] });
    expect(renderer).toHaveBeenCalledWith(
      { customType: "todo", content: "3 left" },
      { expanded: true, outputPad: 2 },
      { name: "test-theme" },
    );
  });

  it("runs an entry renderer with the entry payload", () => {
    const renderer = vi.fn(() => linesComponent("entry"));
    const { registry } = harness({ getEntryRenderer: () => renderer });

    const frame = registry.render({
      target: "entry",
      type: "note",
      width: 40,
      expanded: false,
      entry: { type: "custom", customType: "note", data: { body: "hi" } },
    });

    expect(frame.rendered).toBe(true);
    expect(renderer).toHaveBeenCalledWith(
      { type: "custom", customType: "note", data: { body: "hi" } },
      { expanded: false },
      { name: "test-theme" },
    );
  });

  it("falls back when the custom type has no renderer", () => {
    const { registry } = harness({ getMessageRenderer: () => undefined });
    expect(
      registry.render({ target: "message", type: "plain", width: 40, expanded: false }),
    ).toEqual({ rendered: false, width: 40, lines: [] });
  });

  it("falls back when the renderer returns undefined", () => {
    const { registry } = harness({ getMessageRenderer: () => () => undefined });
    expect(
      registry.render({ target: "message", type: "todo", width: 40, expanded: false }).rendered,
    ).toBe(false);
  });
});

describe("tool renderers", () => {
  it("renders the call and then the result, sharing the renderer state", () => {
    const states: unknown[] = [];
    const runner: RendererRunner = {
      getToolDefinition: () => ({
        name: "bash",
        renderCall: (args, _theme, context) => {
          states.push(context.state);
          const seen = typeof context.state.seen === "number" ? context.state.seen : 0;
          context.state.seen = seen + 1;
          return linesComponent(`call ${JSON.stringify(args)}`);
        },
        renderResult: (_result, options, _theme, context) => {
          states.push(context.state);
          return linesComponent(`result partial=${options.isPartial}`);
        },
      }),
    };
    const { registry } = harness(runner);

    const call = registry.render({
      target: "tool",
      type: "bash",
      toolCallId: "t1",
      width: 60,
      expanded: false,
      args: { command: "ls" },
      argsComplete: true,
    });
    expect(call.lines).toEqual(['call {"command":"ls"}@60']);

    const result = registry.render({
      target: "tool",
      type: "bash",
      toolCallId: "t1",
      width: 60,
      expanded: true,
      args: { command: "ls" },
      result: { content: [{ type: "text", text: "ok" }] },
      isPartial: true,
    });
    expect(result.lines).toEqual(['call {"command":"ls"}@60', "result partial=true@60"]);
    // The same state object reached both renders, and the call renderer ran
    // again for the result request (Pi re-renders the call each time).
    expect(states[0]).toBe(states[1]);
    expect(states[1]).toMatchObject({ seen: 2 });
  });

  it("passes the previous component back as lastComponent", () => {
    const last: Array<RendererComponent | undefined> = [];
    const runner: RendererRunner = {
      getToolDefinition: () => ({
        renderCall: (_args, _theme, context) => {
          last.push(context.lastComponent);
          return linesComponent("first");
        },
      }),
    };
    const { registry } = harness(runner);
    registry.render({ target: "tool", type: "x", toolCallId: "t1", width: 40, expanded: false });
    registry.render({ target: "tool", type: "x", toolCallId: "t1", width: 40, expanded: false });
    expect(last[0]).toBeUndefined();
    expect(last[1]).toBeDefined();
  });

  it("uses the native card when the tool has no renderers", () => {
    const { registry } = harness({ getToolDefinition: () => ({ name: "read" }) });
    expect(
      registry.render({
        target: "tool",
        type: "read",
        toolCallId: "t1",
        width: 40,
        expanded: false,
      }).rendered,
    ).toBe(false);
  });

  it("emits render.invalidate from the context's invalidate()", () => {
    const runner: RendererRunner = {
      getToolDefinition: () => ({
        renderCall: (_args, _theme, context) => {
          context.invalidate();
          return linesComponent("x");
        },
      }),
    };
    const { registry, emitted } = harness(runner);
    registry.render({ target: "tool", type: "x", toolCallId: "t9", width: 40, expanded: false });
    expect(emitted).toContainEqual({
      event: EXTENSION_RENDER_INVALIDATE_EVENT,
      payload: { toolCallId: "t9" },
    });
  });

  it("forgets per-tool state when the session is rebound", () => {
    const seen: unknown[] = [];
    const runner: RendererRunner = {
      getToolDefinition: () => ({
        renderCall: (_args, _theme, context) => {
          seen.push(context.state);
          return linesComponent("x");
        },
      }),
    };
    const { registry } = harness(runner);
    registry.render({ target: "tool", type: "x", toolCallId: "t1", width: 40, expanded: false });
    registry.bind({ runner, theme: () => null, cwd: "C:/other" });
    registry.render({ target: "tool", type: "x", toolCallId: "t1", width: 40, expanded: false });
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("renderer failures", () => {
  it("falls back with the error instead of throwing", () => {
    const { registry } = harness({
      getMessageRenderer: () => () => {
        throw new Error("boom");
      },
    });
    const frame = registry.render({
      target: "message",
      type: "todo",
      width: 40,
      expanded: false,
    });
    expect(frame).toEqual({ rendered: false, width: 40, lines: [], error: "boom" });
  });

  it("falls back when the component's render() throws", () => {
    const { registry } = harness({
      getEntryRenderer: () => () => ({
        render: () => {
          throw new Error("render boom");
        },
      }),
    });
    expect(
      registry.render({ target: "entry", type: "note", width: 40, expanded: false }).error,
    ).toBe("render boom");
  });

  it("treats a throwing runner lookup as no renderer", () => {
    const { registry } = harness({
      getMessageRenderer: () => {
        throw new Error("runner broke");
      },
    });
    expect(
      registry.render({ target: "message", type: "todo", width: 40, expanded: false }).rendered,
    ).toBe(false);
  });

  it("renders nothing before a session is bound", () => {
    const registry = createExtensionRendererRegistry({ emit: () => undefined });
    expect(
      registry.render({ target: "message", type: "todo", width: 40, expanded: false }).rendered,
    ).toBe(false);
  });
});

describe("markdown transformers", () => {
  it("chains transformers in registration order", () => {
    const { registry } = harness({
      getMarkdownTransformers: () => [
        (markdown) => markdown.replace("a", "b"),
        (markdown) => `${markdown}!`,
      ],
    });
    expect(
      registry.transformMarkdown({
        text: "a",
        messageType: "assistant",
        isStreaming: false,
        width: 80,
      }),
    ).toEqual({ text: "b!", transformed: true });
  });

  it("reports unchanged text and survives a throwing transformer", () => {
    const { registry } = harness({
      getMarkdownTransformers: () => [
        () => {
          throw new Error("nope");
        },
        (markdown) => markdown,
      ],
    });
    expect(
      registry.transformMarkdown({
        text: "same",
        messageType: "user",
        isStreaming: false,
        width: 80,
      }),
    ).toEqual({ text: "same", transformed: false });
  });
});

describe("handlers", () => {
  it("validates render.request and render.markdown params", () => {
    const { registry } = harness({ getMessageRenderer: () => () => linesComponent("x") });
    const handlers = registry.handlers();
    expect(() => handlers["render.request"]!({ target: "nope" }, {} as never)).toThrow(
      /render\.request requires/,
    );
    expect(() => handlers["render.markdown"]!({}, {} as never)).toThrow(
      /render\.markdown requires/,
    );
    expect(
      handlers["render.markdown"]!(
        { text: "hi", messageType: "assistant", isStreaming: false, width: 80 },
        {} as never,
      ),
    ).toEqual({ text: "hi", transformed: false });
  });
});
