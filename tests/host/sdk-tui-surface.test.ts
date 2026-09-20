import { Editor, SelectList, getKeybindings } from "@earendil-works/pi-tui";
import { getSelectListTheme, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createExtensionUiPort } from "../../src/host/extension-ui";
import { createSdkExtensionUiContext, createSdkThemeAccess } from "../../src/host/sdk/extension-ui";
import {
  createSdkFooterData,
  createSdkTuiKeybindings,
  createSdkTuiSurface,
  sdkEditorTheme,
} from "../../src/host/sdk/tui-surface";
import { TUI_STATE_EVENT, type TuiSurfaceSnapshot } from "../../src/shared/tui-surface";

/**
 * The SDK side of the TUI surface (plan step 17).
 *
 * The end-to-end case runs Pi's real `SelectList` through `ctx.ui.custom()` and
 * drives it with terminal bytes — the same shape the workflow extension's
 * questionnaire uses — so the emulation is proven against real components, not
 * just fakes. The keybinding case proves a profile remap reaches
 * `getKeybindings()`, which Pi's components consult.
 */

function fakeSession(): AgentSession {
  return {
    resourceLoader: { getThemes: () => ({ themes: [] }) },
    settingsManager: { getTheme: () => "dark", setTheme: () => undefined },
  } as unknown as AgentSession;
}

function harness() {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const uiPort = createExtensionUiPort({ emit: () => undefined });
  const surfacePort = createSdkTuiSurface({
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    terminalInput: () => [],
  });
  const surface = {
    port: surfacePort,
    keybindings: createSdkTuiKeybindings({}),
    footerData: createSdkFooterData(uiPort),
  };
  const context = createSdkExtensionUiContext(
    uiPort,
    createSdkThemeAccess({ session: fakeSession() }),
    surface,
  );
  const snapshots = (): TuiSurfaceSnapshot[] =>
    emitted
      .filter((entry) => entry.event === TUI_STATE_EVENT)
      .map((entry) => entry.payload as TuiSurfaceSnapshot);
  return { context, surfacePort, snapshots, uiPort };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("createSdkTuiKeybindings", () => {
  it("installs the effective bindings globally", () => {
    createSdkTuiKeybindings({});
    expect(getKeybindings().matches("\x1b[A", "tui.select.up" as never)).toBe(true);
    expect(getKeybindings().matches("\r", "tui.select.confirm" as never)).toBe(true);
  });

  it("honours a user remap", () => {
    createSdkTuiKeybindings({ "tui.select.up": ["k"] });
    expect(getKeybindings().matches("k", "tui.select.up" as never)).toBe(true);
    expect(getKeybindings().matches("\x1b[A", "tui.select.up" as never)).toBe(false);
    // Restore the defaults for the other tests in this file.
    createSdkTuiKeybindings({});
  });
});

describe("createSdkFooterData", () => {
  it("reports live extension statuses and no git branch", () => {
    const port = createExtensionUiPort({ emit: () => undefined });
    port.setStatus("build", "ok");
    const data = createSdkFooterData(port);
    expect(data.getGitBranch()).toBeNull();
    expect(data.getExtensionStatuses().get("build")).toBe("ok");
    expect(data.getAvailableProviderCount()).toBe(0);
    expect(typeof data.onBranchChange(() => undefined)).toBe("function");
  });
});

describe("sdkEditorTheme", () => {
  it("builds the editor theme the SDK does not export", () => {
    const access = createSdkThemeAccess({ session: fakeSession() });
    const theme = sdkEditorTheme(access.current());
    expect(theme.borderColor("x")).toContain("x");
    expect(theme.selectList).toBeTruthy();
  });
});

describe("ctx.ui.custom end-to-end", () => {
  it("renders a real SelectList and completes by keyboard", async () => {
    const { context, surfacePort, snapshots } = harness();
    const items = [
      { value: "build", label: "Build", description: "keep coding" },
      { value: "review", label: "Review", description: "check the diff" },
    ];
    const pending = context.custom<string>((tui, _theme, _kb, done) => {
      const list = new SelectList(items, 5, getSelectListTheme());
      (list as unknown as { onSelect: (item: { value: string }) => void }).onSelect = (item) =>
        done(item.value);
      (list as unknown as { onCancel: () => void }).onCancel = () => done(undefined as never);
      return {
        render: (width: number) => list.render(width),
        invalidate: () => list.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });

    await tick();
    const first = snapshots().at(-1);
    expect(first?.active).toBe(true);
    expect(first?.focus).toBe("custom");
    expect(first?.custom?.lines.join("\n")).toContain("Build");

    // Down, then Enter: the second item wins.
    surfacePort.input("\x1b[B");
    await tick();
    surfacePort.input("\r");
    await expect(pending).resolves.toBe("review");
    await tick();
    expect(snapshots().at(-1)?.active).toBe(false);
  });

  it("cancels a real SelectList with Escape and resolves undefined", async () => {
    const { context, surfacePort } = harness();
    const pending = context.custom<string | undefined>((tui, _theme, _kb, done) => {
      const list = new SelectList([{ value: "a", label: "A" }], 5, getSelectListTheme());
      (list as unknown as { onSelect: (item: { value: string }) => void }).onSelect = (item) =>
        done(item.value);
      (list as unknown as { onCancel: () => void }).onCancel = () => done(undefined);
      return {
        render: (width: number) => list.render(width),
        invalidate: () => list.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
    await tick();
    surfacePort.input("\x1b");
    await expect(pending).resolves.toBeUndefined();
  });

  it("keeps the TUI members inert without a surface", async () => {
    const uiPort = createExtensionUiPort({ emit: () => undefined });
    const context = createSdkExtensionUiContext(
      uiPort,
      createSdkThemeAccess({ session: fakeSession() }),
    );
    await expect(
      context.custom<string>(() => ({ render: () => [] }) as never),
    ).resolves.toBeUndefined();
  });

  it("delivers a bracketed paste to a real Editor", async () => {
    const { context, surfacePort } = harness();
    let editorText = "";
    const pending = context.custom<string>((tui, theme, _kb, done) => {
      const editor = new Editor(tui as never, sdkEditorTheme(theme));
      (editor as unknown as { onSubmit: (text: string) => void }).onSubmit = (text) => done(text);
      return {
        render: (width: number) => editor.render(width),
        invalidate: () => editor.invalidate(),
        handleInput: (data: string) => {
          editor.handleInput(data);
          editorText = editor.getText();
          tui.requestRender();
        },
      };
    });
    await tick();
    surfacePort.input("\x1b[200~pasted text\x1b[201~");
    expect(editorText).toContain("pasted text");
    // Enter submits the editor's contents.
    surfacePort.input("\r");
    await expect(pending).resolves.toContain("pasted text");
  });
});
