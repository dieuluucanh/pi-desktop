import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COPY_FEEDBACK_MS, CopyIconButton } from "../../src/renderer/src/ui/copy-button";

/**
 * Copy feedback (2026-11-06): the button reports its own result, because the
 * global hint lives in the status bar and is easy to miss.
 */

const originalClipboard = navigator.clipboard;

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
});

describe("CopyIconButton", () => {
  it("shows a check and announces success, then resets", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    render(<CopyIconButton value="/work/s.jsonl" label="Copy session path" testId="copy" />);
    const button = screen.getByTestId("copy");

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(writeText).toHaveBeenCalledWith("/work/s.jsonl");
    expect(button).toHaveAttribute("title", "Copied");
    expect(button).toHaveTextContent("Copy session path: copied");
    expect(button.className).toContain("text-ok");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS);
    });
    expect(button).toHaveAttribute("title", "Copy session path");
    expect(button).not.toHaveTextContent("copied");
  });

  it("shows a failure when the clipboard refuses", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    render(<CopyIconButton value="x" label="Copy session path" testId="copy" />);
    const button = screen.getByTestId("copy");

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute("title", "Copy failed"));
    expect(button).toHaveTextContent("Copy session path: copy failed");
    expect(button.className).toContain("text-danger");
  });

  it("is disabled when there is nothing to copy", () => {
    render(<CopyIconButton value="" label="Copy session path" testId="copy" />);
    expect(screen.getByTestId("copy")).toBeDisabled();
  });
});
