import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ProjectTrustStatus } from "../../src/shared/projects";
import { TrustDialog } from "../../src/renderer/src/projects/TrustDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

const PATH = "C:\\work\\pi-desktop";

function status(overrides: Partial<ProjectTrustStatus> = {}): ProjectTrustStatus {
  return {
    cwd: PATH,
    requiresTrust: true,
    decision: null,
    trusted: false,
    needsPrompt: true,
    ...overrides,
  };
}

function resetStore(): void {
  useAppStore.setState({
    view: "welcome",
    project: null,
    projects: [],
    projectsLoaded: true,
    projectInspections: {},
    projectInspectionErrors: {},
    trustPrompt: null,
    trustBusy: false,
    sessionTrust: [],
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    tabs: [],
    activeTabId: null,
    transcripts: {},
    sessionStates: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("TrustDialog", () => {
  it("renders nothing without a pending question", () => {
    installBridge();
    const { container } = render(<TrustDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains the project and offers all four answers", () => {
    installBridge();
    useAppStore.setState({ trustPrompt: { cwd: PATH, tabId: "tab-1", status: status() } });

    render(<TrustDialog />);

    expect(screen.getByText("Trust this project?")).toBeInTheDocument();
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /trust once/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /trust & remember/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /never/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ignore/i })).toBeInTheDocument();
  });

  it("answers 'trust' by retrying session.create and closing", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({ sessionId: "session-1" }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ trustPrompt: { cwd: PATH, tabId: "tab-1", status: status() } });

    render(<TrustDialog />);
    await userEvent.click(screen.getByRole("button", { name: /trust & remember/i }));

    expect(request).toHaveBeenCalledWith({
      tabId: "tab-1",
      method: "session.create",
      params: { cwd: PATH, trust: "trust" },
    });
    expect(useAppStore.getState().trustPrompt).toBeNull();
  });

  it("records a 'never' answer and leaves the project untrusted", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({ sessionId: "session-1" }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ trustPrompt: { cwd: PATH, tabId: "tab-1", status: status() } });

    render(<TrustDialog />);
    await userEvent.click(screen.getByRole("button", { name: /never/i }));

    expect(request).toHaveBeenCalledWith({
      tabId: "tab-1",
      method: "session.create",
      params: { cwd: PATH, trust: "never" },
    });
  });

  it("ignores without deciding", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({}));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ trustPrompt: { cwd: PATH, tabId: "tab-1", status: status() } });

    render(<TrustDialog />);
    await userEvent.click(screen.getByRole("button", { name: /ignore/i }));

    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().trustPrompt).toBeNull();
    expect(useAppStore.getState().sessionTrust).toEqual([]);
  });
});
