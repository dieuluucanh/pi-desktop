import {
  Theme,
  type AgentSession,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionUiPort } from "../../src/host/extension-ui";
import {
  THEME_GLOBAL_SYMBOL,
  createSdkCommandContextActions,
  createSdkExtensionBinder,
  createSdkExtensionUiContext,
  createSdkThemeAccess,
} from "../../src/host/sdk/extension-ui";
import {
  EXTENSION_UI_THEME_EVENT,
  SESSION_SHUTDOWN_REQUEST_EVENT,
} from "../../src/shared/extension-ui";

/**
 * The SDK side of the extension-UI host (plan step 16).
 *
 * The theme symbol is the one fragile assumption: the SDK exports `initTheme`
 * and `Theme` but not the `theme` proxy, so reading the well-known global is the
 * only way to hand an extension the current `Theme`. If upstream renames the
 * symbol these tests fail loudly instead of extensions getting a fallback.
 */

function fakeSession(overrides: Record<string, unknown> = {}): AgentSession {
  return {
    resourceLoader: { getThemes: () => ({ themes: [] }) },
    settingsManager: { getTheme: () => "dark", setTheme: () => undefined },
    waitForIdle: async () => undefined,
    navigateTree: async () => ({ cancelled: false }),
    reload: async () => undefined,
    bindExtensions: async () => undefined,
    ...overrides,
  } as unknown as AgentSession;
}

function portHarness() {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const port = createExtensionUiPort({
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    newId: () => "ui-1",
  });
  return { port, emitted };
}

describe("theme access", () => {
  it("pins the global theme symbol the SDK installs", () => {
    expect(THEME_GLOBAL_SYMBOL).toBe(Symbol.for("@earendil-works/pi-coding-agent:theme"));
  });

  it("returns a real Theme for the active theme and lists built-ins", () => {
    const access = createSdkThemeAccess({ session: fakeSession() });
    const current = access.current();
    expect(current).toBeInstanceOf(Theme);
    expect(current.fg("accent", "x")).toContain("x");
    expect(access.all().map((info) => info.name)).toEqual(
      expect.arrayContaining(["dark", "light"]),
    );
  });

  it("loads a named theme without changing the active one", () => {
    const access = createSdkThemeAccess({ session: fakeSession() });
    const before = access.current();
    const light = access.get("light");
    expect(light).toBeInstanceOf(Theme);
    expect(access.current().name).toBe(before.name);
    expect(access.get("missing")).toBeUndefined();
  });

  it("switches, persists and reports an unknown theme", () => {
    const setTheme = vi.fn();
    const access = createSdkThemeAccess({
      session: fakeSession(),
      settings: { getTheme: () => "dark", setTheme },
    });
    expect(access.set("light")).toEqual({ success: true });
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(access.current().name).toBe("light");
    expect(access.set("nope").success).toBe(false);
  });

  it("accepts a Theme instance", () => {
    const access = createSdkThemeAccess({ session: fakeSession() });
    const theme = access.current();
    expect(access.set(theme)).toEqual({ success: true });
    expect(access.current()).toBe(theme);
  });
});

describe("createSdkExtensionUiContext", () => {
  it("delegates the interactive members and leaves the TUI surface inert", async () => {
    const { port, emitted } = portHarness();
    const access = createSdkThemeAccess({ session: fakeSession() });
    const context = createSdkExtensionUiContext(port, access);

    const answer = context.select("Pick", ["a", "b"], { timeout: 1000 });
    const request = emitted.find((entry) => entry.event === "oi.request");
    expect(request?.payload).toMatchObject({ id: "ui-1", method: "select" });
    port.handlers()["oi.respond"]!({ id: "ui-1", value: "b" }, {} as never);
    await expect(answer).resolves.toBe("b");

    context.notify("hi", "warning");
    context.setStatus("k", "v");
    context.setWidget("w", ["line"]);
    context.setTitle("title");
    context.setToolsExpanded(true);
    expect(port.snapshot()).toMatchObject({
      statuses: { k: "v" },
      widgets: [{ key: "w", lines: ["line"], placement: "aboveEditor" }],
      title: "title",
      toolsExpanded: true,
    });

    // Step 17 renders these; until then they must not throw or hang.
    await expect(
      context.custom(async () => ({ render: () => [] }) as never),
    ).resolves.toBeUndefined();
    expect(context.getEditorComponent()).toBeUndefined();
    expect(context.getToolsExpanded()).toBe(true);
    expect(context.theme).toBeInstanceOf(Theme);
  });

  it("ignores a component widget factory and keeps string widgets", () => {
    const { port } = portHarness();
    const context = createSdkExtensionUiContext(
      port,
      createSdkThemeAccess({ session: fakeSession() }),
    );
    context.setWidget("factory", (() => ({ render: () => [] })) as never);
    context.setWidget("lines", ["a"]);
    expect(port.snapshot().widgets.map((widget) => widget.key)).toEqual(["lines"]);
  });

  it("emits the theme event when an extension switches theme", () => {
    const { port, emitted } = portHarness();
    const context = createSdkExtensionUiContext(
      port,
      createSdkThemeAccess({ session: fakeSession() }),
    );
    expect(context.setTheme("light")).toEqual({ success: true });
    expect(emitted.at(-1)).toEqual({ event: EXTENSION_UI_THEME_EVENT, payload: { name: "light" } });
  });
});

describe("createSdkCommandContextActions", () => {
  it("maps the command context onto the session and runtime", async () => {
    const waitForIdle = vi.fn(async () => undefined);
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    const reload = vi.fn(async () => undefined);
    const session = fakeSession({ waitForIdle, navigateTree, reload });
    const newSession = vi.fn(async () => ({ cancelled: false }));
    const fork = vi.fn(async () => ({ cancelled: false }));
    const switchSession = vi.fn(async () => ({ cancelled: false }));
    const runtime = { newSession, fork, switchSession } as unknown as AgentSessionRuntime;

    const actions = createSdkCommandContextActions(session, runtime);
    await actions.waitForIdle();
    await actions.newSession();
    await actions.fork("entry-1");
    await actions.navigateTree("entry-1");
    await actions.switchSession("file.jsonl");
    await actions.reload();

    expect(waitForIdle).toHaveBeenCalled();
    expect(newSession).toHaveBeenCalled();
    expect(fork).toHaveBeenCalledWith("entry-1", undefined);
    expect(navigateTree).toHaveBeenCalledWith("entry-1", undefined);
    expect(switchSession).toHaveBeenCalledWith("file.jsonl", undefined);
    expect(reload).toHaveBeenCalled();
  });
});

describe("createSdkExtensionBinder", () => {
  it("binds a tui-mode UI context and forwards errors and shutdown", async () => {
    const { port, emitted } = portHarness();
    const bindExtensions = vi.fn(async (_bindings: unknown) => undefined);
    const session = fakeSession({ bindExtensions });
    const binder = createSdkExtensionBinder({
      port,
      emit: (event, payload) =>
        emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    });

    await binder(session, {} as AgentSessionRuntime);

    expect(bindExtensions).toHaveBeenCalledTimes(1);
    const bindings = bindExtensions.mock.calls[0]![0] as {
      mode: string;
      uiContext: unknown;
      commandContextActions: unknown;
      shutdownHandler: () => void;
      onError: (error: unknown) => void;
    };
    expect(bindings.mode).toBe("tui");
    expect(bindings.uiContext).toBeTruthy();
    expect(bindings.commandContextActions).toBeTruthy();

    bindings.shutdownHandler();
    expect(emitted.some((entry) => entry.event === SESSION_SHUTDOWN_REQUEST_EVENT)).toBe(true);

    bindings.onError({ extensionPath: "/x.ts", event: "tool_call", error: "boom", stack: "s" });
    expect(emitted.find((entry) => entry.event === "extension_error")?.payload).toEqual({
      extensionPath: "/x.ts",
      event: "tool_call",
      error: "boom",
      stack: "s",
    });
  });

  it("points the renderer registry at the session's runner and cwd (plan step 18)", async () => {
    const { port } = portHarness();
    const extensionRunner = { getMessageRenderer: () => undefined };
    const session = fakeSession({ extensionRunner, bindExtensions: async () => undefined });
    const bind = vi.fn();
    const binder = createSdkExtensionBinder({
      port,
      emit: () => undefined,
      renderers: { bind } as never,
    });

    await binder(session, { cwd: "C:/work/app" } as unknown as AgentSessionRuntime);

    expect(bind).toHaveBeenCalledTimes(1);
    const binding = bind.mock.calls[0]![0] as {
      runner: unknown;
      cwd: string;
      theme: () => unknown;
    };
    expect(binding.runner).toBe(extensionRunner);
    expect(binding.cwd).toBe("C:/work/app");
    // The theme is resolved lazily, so a later switch is reflected on re-render.
    expect(binding.theme()).toBeInstanceOf(Theme);
  });
});
