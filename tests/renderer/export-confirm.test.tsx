import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportConfirmDialog } from "../../src/renderer/src/sessions/ExportConfirmDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";

/**
 * Native exports are truthful, not sanitized (plan step 15). The confirmation
 * must name the included conversation content before the file is written.
 */
afterEach(() => {
  useAppStore.setState({ pendingExport: null });
});

describe("native export confirmation", () => {
  it("names the included content and only exports after confirmation", async () => {
    const exportHtml = vi.fn(async () => {});
    useAppStore.setState({
      pendingExport: { tabId: "tab-1", format: "html" },
      exportSessionHtml: exportHtml,
    });
    render(<ExportConfirmDialog />);

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Pi's own HTML export");
    expect(dialog).toHaveTextContent("managed attachment text");
    expect(exportHtml).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Export HTML" }));
    await waitFor(() => expect(exportHtml).toHaveBeenCalledWith("tab-1"));
    expect(useAppStore.getState().pendingExport).toBeNull();
  });

  it("cancelling writes nothing and clears the pending export", () => {
    const exportJsonl = vi.fn(async () => {});
    useAppStore.setState({
      pendingExport: { tabId: "tab-2", format: "jsonl" },
      exportSessionJsonl: exportJsonl,
    });
    render(<ExportConfirmDialog />);
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent("JSONL export");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(exportJsonl).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingExport).toBeNull();
  });
});
