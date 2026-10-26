import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareDialog } from "../../src/renderer/src/sessions/ShareDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * `/share` and `/bug` UI (2026-10-26 session-parity plan step 18).
 *
 * The dialog must show the upload result (and the secret-gist caveat), explain a
 * missing `gh` with an install hint plus the HTML escape hatch, and never
 * present an action that does nothing.
 */

const TAB = "tab-1";

function tab(): TabRecord {
  return {
    id: TAB,
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/sessions/s1.jsonl",
    status: "running",
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function stubShare(impl: { session?: () => Promise<unknown>; bugReport?: () => Promise<unknown> }) {
  const session = vi.fn(impl.session ?? (async () => ({ ok: true })));
  const bugReport = vi.fn(impl.bugReport ?? (async () => ({ ok: true })));
  (window.pi as unknown as { share: unknown }).share = { session, bugReport };
  return { session, bugReport };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: TAB,
    shareOpen: false,
    shareMode: "share",
    shareStatus: "idle",
    shareResult: null,
    shareError: null,
    shareErrorCode: null,
    shareIncludeTranscript: false,
    shareHint: null,
  });
});

describe("/share", () => {
  it("shows the viewer URL and the secret-gist caveat", async () => {
    stubShare({
      session: async () => ({
        ok: true,
        gistUrl: "https://gist.github.com/abc123",
        viewerUrl: "https://pi.dev/session/#abc123",
      }),
    });

    await useAppStore.getState().openShare(TAB);
    render(<ShareDialog />);

    expect(screen.getByText(/unlisted, not private/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("share-done")).toHaveTextContent("https://pi.dev/session/#abc123"),
    );
    expect(screen.getByRole("button", { name: "Copy URL" })).toBeInTheDocument();
  });

  it("explains a missing gh and offers the HTML export", async () => {
    stubShare({ session: async () => ({ ok: false, error: "gh_missing" }) });
    const exportHtml = vi.fn(async () => undefined);
    useAppStore.setState({ exportSessionHtml: exportHtml });

    await useAppStore.getState().openShare(TAB);
    render(<ShareDialog />);

    await waitFor(() => expect(screen.getByTestId("share-error")).toBeInTheDocument());
    expect(screen.getByText(/Install GitHub's CLI/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export HTML instead" }));
    expect(exportHtml).toHaveBeenCalledWith(TAB);
  });

  it("reports a session without a file instead of calling the bridge", async () => {
    const { session } = stubShare({});
    useAppStore.setState({ tabs: [{ ...tab(), sessionFile: null }] });

    await useAppStore.getState().openShare(TAB);
    render(<ShareDialog />);

    expect(session).not.toHaveBeenCalled();
    expect(screen.getByTestId("share-error")).toHaveTextContent(/no file on disk/i);
  });
});

describe("/bug", () => {
  it("defaults to excluding the transcript and builds a zip", async () => {
    const { bugReport } = stubShare({
      bugReport: async () => ({ ok: true, path: "/tmp/report.zip", bytes: 42 }),
    });
    const reveal = vi.fn(async () => true);
    (window.pi as unknown as { revealPath: unknown }).revealPath = reveal;

    await useAppStore.getState().openBugReport(TAB, "the queue lost a message");
    render(<ShareDialog />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Create zip" }));

    await waitFor(() =>
      expect(bugReport).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionFile: "/profile/sessions/s1.jsonl",
          includeTranscript: false,
          hint: "the queue lost a message",
        }),
      ),
    );
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("/tmp/report.zip"));
    expect(screen.getByTestId("share-done")).toHaveTextContent("/tmp/report.zip");
  });

  it("passes the transcript opt-in through", async () => {
    const { bugReport } = stubShare({
      bugReport: async () => ({ ok: true, path: "/tmp/report.zip" }),
    });
    await useAppStore.getState().openBugReport(TAB);
    render(<ShareDialog />);

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Create zip" }));

    await waitFor(() =>
      expect(bugReport).toHaveBeenCalledWith(expect.objectContaining({ includeTranscript: true })),
    );
  });
});
