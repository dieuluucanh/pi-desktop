import { describe, expect, it, vi } from "vitest";
import {
  notifyAttachmentTabClosed,
  onAttachmentTabClosed,
} from "../../src/renderer/src/attachments/lifecycle";

describe("attachment tab lifecycle", () => {
  it("notifies each subscriber once per closed tab", () => {
    const listener = vi.fn();
    const unsubscribe = onAttachmentTabClosed(listener);
    notifyAttachmentTabClosed(["tab-1", "tab-1", "tab-2", "", "tab-1"]);
    expect(listener.mock.calls.map(([id]) => id)).toEqual(["tab-1", "tab-2"]);
    unsubscribe();
    notifyAttachmentTabClosed(["tab-3"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps one failing subscriber from stranding the others", () => {
    const failing = vi.fn(() => {
      throw new Error("teardown failed");
    });
    const healthy = vi.fn();
    const offFailing = onAttachmentTabClosed(failing);
    const offHealthy = onAttachmentTabClosed(healthy);
    notifyAttachmentTabClosed(["tab-1"]);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    offFailing();
    offHealthy();
  });
});

describe("managed draft presence", () => {
  it("publishes and clears the selected-file predicate", async () => {
    const { hasAttachmentDraft, setAttachmentDraftPresence } =
      await import("../../src/renderer/src/attachments/lifecycle");
    setAttachmentDraftPresence((tabId) => tabId === "tab-1");
    expect(hasAttachmentDraft("tab-1")).toBe(true);
    expect(hasAttachmentDraft("tab-2")).toBe(false);
    setAttachmentDraftPresence(() => {
      throw new Error("presence failed");
    });
    expect(hasAttachmentDraft("tab-1")).toBe(false);
    setAttachmentDraftPresence(null);
    expect(hasAttachmentDraft("tab-1")).toBe(false);
  });
});
