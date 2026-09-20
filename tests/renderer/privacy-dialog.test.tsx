import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { PrivacyDialog } from "../../src/renderer/src/privacy/PrivacyDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The first-run privacy screen (plan step 23). The dialog must appear only until
 * it has been answered, must default telemetry **off**, and turning it on must
 * be an explicit action that is persisted as an app preference.
 */

function reset(prefs: Partial<typeof DEFAULT_PREFS> = {}) {
  const handles = installBridge({ prefs });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, ...prefs },
    prefsLoaded: true,
  });
  return handles;
}

beforeEach(() => reset());

describe("privacy dialog", () => {
  it("shows once the prefs are loaded and not yet acknowledged", () => {
    render(<PrivacyDialog />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/your data stays on this machine/i)).toBeInTheDocument();
    expect(screen.getByText(/sends no usage data of its own/i)).toBeInTheDocument();
  });

  it("defaults the telemetry switch to off", () => {
    render(<PrivacyDialog />);
    expect(
      screen.getByRole("switch", { name: /share anonymous install telemetry/i }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("keeps telemetry off when the user declines", async () => {
    const handles = reset();
    render(<PrivacyDialog />);

    await userEvent.click(screen.getByRole("button", { name: /keep telemetry off/i }));

    await waitFor(() => {
      expect(useAppStore.getState().prefs.privacyAcknowledged).toBe(true);
    });
    expect(useAppStore.getState().prefs.telemetryEnabled).toBe(false);
    await waitFor(() => {
      expect(handles.prefs.privacyAcknowledged).toBe(true);
      expect(handles.prefs.telemetryEnabled).toBe(false);
    });
    // Acknowledged: the dialog does not render again.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("enables telemetry only through an explicit opt-in", async () => {
    const handles = reset();
    render(<PrivacyDialog />);

    await userEvent.click(
      screen.getByRole("switch", { name: /share anonymous install telemetry/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /allow and continue/i }));

    await waitFor(() => {
      expect(handles.prefs.telemetryEnabled).toBe(true);
      expect(handles.prefs.privacyAcknowledged).toBe(true);
    });
  });

  it("stays hidden when the app has already recorded an answer", () => {
    reset({ privacyAcknowledged: true, telemetryEnabled: true });
    render(<PrivacyDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
