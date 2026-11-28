import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { PrivacyDialog } from "../../src/renderer/src/privacy/PrivacyDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The first-run privacy notice (plan step 23). Pi 1.7.0 removed install
 * telemetry, so the dialog is a one-time local-data notice with a Continue
 * acknowledgement; there is no telemetry switch or preference.
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
    expect(screen.getByText(/pi 1\.7\.0 removed its install telemetry/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("acknowledges the notice with Continue", async () => {
    const handles = reset();
    render(<PrivacyDialog />);

    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(useAppStore.getState().prefs.privacyAcknowledged).toBe(true);
    });
    await waitFor(() => {
      expect(handles.prefs.privacyAcknowledged).toBe(true);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays hidden when the app has already recorded an answer", () => {
    reset({ privacyAcknowledged: true });
    render(<PrivacyDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
