import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionBrowserDialog } from "../../src/renderer/src/sessions/SessionBrowser";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SessionSummary } from "../../src/shared/session-browser";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Session browser controls (2026-10-26 session-parity plan step 16): the scope
 * tabs, sort cycle and named/path toggles must exist, and the delete
 * confirmation must name the session's open tabs instead of silently closing them.
 */

const SESSION: SessionSummary = {
  path: "C:/work/pi-desktop/sessions/s1.jsonl",
  id: "s1",
  cwd: "C:/work/pi-desktop",
  name: "Fix host protocol",
  created: 1,
  modified: 2,
  messageCount: 4,
  firstMessage: "Fix host protocol",
  allMessagesText: "Fix host protocol",
  parentSessionPath: null,
};

function tab(): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "C:/work/pi-desktop",
    title: "Fix host protocol",
    sessionFile: SESSION.path,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    sessionBrowserOpen: true,
    sessionBrowserQuery: "",
    projectSessions: [SESSION],
    projectSessionsLoaded: true,
    projectSessionsError: null,
    projectSessionsErrorKind: null,
    projectSessionsSearching: false,
    projectSessionsTotal: 1,
    projectSessionsMatched: 1,
    projectSessionsTruncated: false,
    project: { path: "C:/work/pi-desktop", name: "pi-desktop" },
    tabs: [tab()],
    activeTabId: "tab-1",
  });
});

describe("session browser controls", () => {
  it("offers scope tabs, a sort cycle and named/path toggles", () => {
    render(<SessionBrowserDialog />);
    expect(screen.getByRole("tablist", { name: "Scope" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All sessions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("session-sort")).toHaveTextContent("recent");
    expect(screen.getByRole("button", { name: "named only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "show path" })).toBeInTheDocument();
  });

  it("explains that deleting will close the tab that has this session open", () => {
    render(<SessionBrowserDialog />);
    fireEvent.click(screen.getByLabelText("Delete session"));
    expect(screen.getByText(/Closes "Fix host protocol"/)).toBeInTheDocument();
  });

  it("says when the host capped the page", () => {
    useAppStore.setState({
      projectSessionsTotal: 10,
      projectSessionsMatched: 8,
      projectSessionsTruncated: true,
    });
    render(<SessionBrowserDialog />);
    expect(screen.getByTestId("session-truncated")).toHaveTextContent("Showing 1 of 8 matches");
  });
});
