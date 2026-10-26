import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionInfoDialog } from "../../src/renderer/src/sessions/SessionInfoDialog";
import { useAppStore, type SessionInfoView } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * `/session` (2026-10-26 session-parity plan step 12): the terminal prints file,
 * id, tokens incl. cache and cost; the dialog must show the same numbers.
 */

const DATA: SessionInfoView = {
  tabId: "tab-1",
  sessionId: "s1",
  sessionFile: "/profile/sessions/s1.jsonl",
  sessionName: "Fix the bug",
  cwd: "C:/work/app",
  model: { provider: "anthropic", id: "claude-sonnet-4", name: "Sonnet" },
  thinkingLevel: "high",
  messageCount: 12,
  toolCount: 3,
  streaming: false,
  pendingMessages: 0,
  contextUsage: { tokens: 1_200, contextWindow: 200_000, percent: 42 },
  tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126, cost: 0.03 },
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  autoCompaction: true,
  autoRetry: false,
};

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    sessionInfoOpen: true,
    sessionInfoData: DATA,
  });
});

describe("SessionInfoDialog", () => {
  it("shows the file, id, model and token breakdown", () => {
    render(<SessionInfoDialog />);
    expect(screen.getByText("/profile/sessions/s1.jsonl")).toBeInTheDocument();
    expect(screen.getByText("s1")).toBeInTheDocument();
    expect(screen.getByText("anthropic/claude-sonnet-4")).toBeInTheDocument();
    expect(screen.getByText("Cache read")).toBeInTheDocument();
    expect(screen.getByText("$0.0300")).toBeInTheDocument();
    expect(screen.getByText(/42% of 200\.0k/)).toBeInTheDocument();
  });

  it("shows the queue modes and automation state", () => {
    render(<SessionInfoDialog />);
    expect(screen.getByText("all")).toBeInTheDocument();
    expect(screen.getByText("one-at-a-time")).toBeInTheDocument();
    expect(screen.getByText("on")).toBeInTheDocument();
  });

  it("shows a loading line before stats arrive and an error when the host fails", () => {
    useAppStore.setState({ sessionInfoData: null, sessionInfoError: null });
    const { rerender } = render(<SessionInfoDialog />);
    expect(screen.getByText(/Loading session stats/)).toBeInTheDocument();

    useAppStore.setState({ sessionInfoError: "host gone" });
    rerender(<SessionInfoDialog />);
    expect(screen.getByRole("alert")).toHaveTextContent("host gone");
  });
});
