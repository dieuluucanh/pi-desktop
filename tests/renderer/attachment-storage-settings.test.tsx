import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentStorageReport } from "../../src/shared/attachment-storage";
import { AttachmentStorageSettingsCard } from "../../src/renderer/src/settings/AttachmentStorageSettings";

const report: AttachmentStorageReport = {
  measuredAt: 1,
  assets: 4,
  originals: 2,
  representations: 2,
  assetBytes: 3_000,
  staging: 1,
  stagingBytes: 100,
  tombstones: 1,
  tombstonedAssets: 2,
  tombstonedBytes: 1_000,
  unowned: 2,
  unownedBytes: 1_000,
  pendingRemovals: 0,
  removable: 2,
  removableBytes: 1_000,
  referenced: 2,
  quotaBytes: 5 * 1024 * 1024 * 1024,
  usedBytes: 3_100,
  freeBytes: 9_000_000,
};

function stubBridge(overrides: {
  storage?: () => Promise<AttachmentStorageReport | null>;
  clearStorage?: () => Promise<{
    clearedAt: number;
    paused: "manifest" | "journal" | null;
    assetsRemoved: number;
    staleStagingRemoved: number;
    bytesFreed: number;
    errors: number;
  }>;
}) {
  Object.defineProperty(window, "pi", {
    configurable: true,
    value: {
      attachments: {
        storage: overrides.storage ?? (async () => report),
        clearStorage:
          overrides.clearStorage ??
          (async () => ({
            clearedAt: 2,
            paused: null,
            assetsRemoved: 2,
            staleStagingRemoved: 0,
            bytesFreed: 1_000,
            errors: 0,
          })),
      },
    },
  });
}

afterEach(() => {
  delete (window as { pi?: unknown }).pi;
});

describe("attachment storage settings", () => {
  it("reports bounded usage, recoverable and removable copies", async () => {
    stubBridge({});
    render(<AttachmentStorageSettingsCard />);
    await waitFor(() =>
      expect(screen.getByTestId("attachment-storage-report")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("attachment-storage-report")).toHaveTextContent("2 originals");
    expect(screen.getByTestId("attachment-storage-removable")).toHaveTextContent(
      "2 copies can be reclaimed now",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.queryByTestId("attachment-storage-error")).not.toBeInTheDocument();
  });

  it("requires an explicit confirmation and explains what is not removed", async () => {
    const clearStorage = vi.fn(async () => ({
      clearedAt: 2,
      paused: null,
      assetsRemoved: 2,
      staleStagingRemoved: 0,
      bytesFreed: 1_000,
      errors: 0,
    }));
    stubBridge({ clearStorage });
    render(<AttachmentStorageSettingsCard />);
    await waitFor(() =>
      expect(screen.getByTestId("attachment-storage-report")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("attachment-storage-clear"));
    expect(clearStorage).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Pi conversation history");
    expect(dialog).toHaveTextContent("30-day recovery window");

    fireEvent.click(screen.getByRole("button", { name: "Remove unreferenced copies" }));
    await waitFor(() => expect(clearStorage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("attachment-storage-cleared")).toHaveTextContent(
        "Removed 2 copies",
      ),
    );
  });

  it("explains an unreadable store instead of showing zero", async () => {
    stubBridge({ storage: async () => null });
    render(<AttachmentStorageSettingsCard />);
    await waitFor(() =>
      expect(screen.getByTestId("attachment-storage-error")).toHaveTextContent(
        "unavailable or unreadable",
      ),
    );
    expect(screen.queryByTestId("attachment-storage-report")).not.toBeInTheDocument();
  });

  it("surfaces a paused clear without pretending bytes were freed", async () => {
    stubBridge({
      clearStorage: async () => ({
        clearedAt: 2,
        paused: "journal",
        assetsRemoved: 0,
        staleStagingRemoved: 0,
        bytesFreed: 0,
        errors: 0,
      }),
    });
    render(<AttachmentStorageSettingsCard />);
    await waitFor(() => expect(screen.getByTestId("attachment-storage-clear")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("attachment-storage-clear"));
    fireEvent.click(screen.getByRole("button", { name: "Remove unreferenced copies" }));
    await waitFor(() =>
      expect(screen.getByTestId("attachment-storage-cleared")).toHaveTextContent(
        "the journal could not be read",
      ),
    );
  });
});
