import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { notifyToast } from "../../src/renderer/src/notifications/notify-toast";
import type { AppNotification } from "../../src/shared/notifications";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

/**
 * Extension notifications keep their source lines in a toast (2026-11-14
 * transcript-line-parity). Sonner accepts a React node as the message, so the
 * same `MultilineText` contract used by the transcript/archive applies here.
 */

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "n-toast",
    message: "line one\nline two",
    type: "warning",
    class: "warning",
    tabId: "tab-1",
    at: 1,
    action: null,
    ...overrides,
  };
}

function firstArgument(toastFn: unknown): ReactElement {
  const calls = (toastFn as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]?.[0] as ReactElement;
}

describe("notifyToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps every line in a warning toast", () => {
    notifyToast(notification(), {});

    const { container } = render(firstArgument(toast.warning));
    const message = container.querySelector("span");
    expect(message?.className).toContain("whitespace-pre-wrap");
    expect(message?.className).toContain("break-words");
    expect(message?.textContent).toBe("line one\nline two");
  });

  it("keeps every line in an update toast", () => {
    notifyToast(notification({ class: "update", type: "info" }), { onOpen: () => undefined });

    const { container } = render(firstArgument(toast.info));
    const message = container.querySelector("span");
    expect(message?.className).toContain("whitespace-pre-wrap");
    expect(message?.textContent).toBe("line one\nline two");
  });

  it("does not toast an info notification", () => {
    notifyToast(notification({ type: "info", class: "info" }), {});

    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
