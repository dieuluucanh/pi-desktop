import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useExplorerStore } from "../../src/renderer/src/files/explorer-store";
import { ExplorerSection } from "../../src/renderer/src/rail/ExplorerSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { WorkspaceEntry } from "../../src/shared/workspace";
import { installBridge } from "./fixtures";

/**
 * Delete confirmation regression (2026-11-03 plan step 4).
 *
 * The reported freeze was a modal context menu handing `pointer-events: none`
 * to a modal dialog from a different copy of Radix's DismissableLayer: the
 * dialog restored `"none"` when it closed and the whole renderer went inert.
 * This walks the real flow and asserts the body lock is released.
 */

const PROJECT = "C:/work/app";

function entry(path: string, kind: WorkspaceEntry["kind"] = "file"): WorkspaceEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    kind,
    size: kind === "file" ? 12 : null,
    mtimeMs: kind === "file" ? 1 : null,
    hidden: false,
    ignored: false,
    symlink: false,
    outside: false,
  };
}

const ROOT_ENTRIES = [entry("README.md"), entry("src", "directory")];

beforeEach(() => {
  installBridge();
  useExplorerStore.setState({ trees: {}, searches: {}, busy: {}, lastError: {} });
  useAppStore.setState({
    project: { path: PROJECT, name: "app" },
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    hint: null,
    tabs: [],
    activeTabId: null,
  });
  window.pi.workspace.listDirectory = vi.fn(async ({ path }) => ({
    ok: true as const,
    value: {
      root: PROJECT,
      path,
      entries: path === "" ? ROOT_ENTRIES : [],
      truncated: false,
    },
  }));
});

describe("explorer delete confirmation", () => {
  it("releases the modal body lock after the confirm dialog closes", async () => {
    const user = userEvent.setup();
    const deleteEntry = vi.fn(async () => ({
      ok: true as const,
      value: { path: "README.md", absolutePath: `${PROJECT}/README.md`, kind: "file" as const },
    }));
    (window.pi.workspace as unknown as { delete: unknown }).delete = deleteEntry;

    render(<ExplorerSection projectPath={PROJECT} />);
    const name = await screen.findByText("README.md");
    const row = name.closest('[data-testid="explorer-row"]');
    expect(row).not.toBeNull();

    fireEvent.contextMenu(row!);
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByTestId("confirm-dialog")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Move to Recycle Bin" }));
    await waitFor(() =>
      expect(deleteEntry).toHaveBeenCalledWith({ projectPath: PROJECT, path: "README.md" }),
    );
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());

    // Both Radix's own cleanup and the recovery scheduled by `DialogContent`
    // must leave the body interactive; `"none"` here is the reported freeze.
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  });
});
