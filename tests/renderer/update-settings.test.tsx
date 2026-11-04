import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateSettingsCard } from "../../src/renderer/src/settings/UpdateSettingsCard";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import {
  PI_DESKTOP_RELEASES_URL,
  initialUpdateState,
  type UpdateState,
} from "../../src/shared/updates";
import { appInfoFixture, installBridge } from "./fixtures";

/**
 * Settings → About & updates (2026-11-01 update plan): build provenance, the
 * updater's full state, and every action. This card is where errors and no-feed
 * notices live now that the full-width banner is gone.
 */

beforeEach(() => {
  installBridge({ update: initialUpdateState(true) });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    info: appInfoFixture({
      version: "0.3.0",
      isDev: false,
      buildChannel: "release",
      buildVersion: "0.3.0",
      buildCommit: "abc123",
      builtAt: "2026-11-01T10:00:00.000Z",
    }),
    update: initialUpdateState(true, { currentVersion: "0.3.0" }),
    settingsFocus: null,
    hint: null,
  });
});

function setUpdate(partial: Partial<UpdateState>) {
  useAppStore.setState({
    update: { ...initialUpdateState(true, { currentVersion: "0.3.0" }), ...partial },
  });
}

describe("UpdateSettingsCard", () => {
  it("shows the version, build provenance and a check action", () => {
    render(<UpdateSettingsCard />);

    expect(screen.getByTestId("settings-updates")).toHaveTextContent("v0.3.0");
    expect(screen.getByText("Release build")).toBeInTheDocument();
    expect(screen.getByText(/commit abc123/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check now/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /automatically/i })).toBeChecked();
  });

  it("turns automatic checks off for a local build and explains why", () => {
    useAppStore.setState({
      info: appInfoFixture({
        version: "0.3.0",
        isDev: false,
        buildChannel: "local",
        buildVersion: "0.3.0",
      }),
    });
    render(<UpdateSettingsCard />);

    expect(screen.getByText("Local build")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /automatically/i })).toBeDisabled();
    expect(screen.getByText(/Automatic update checks are off/i)).toBeInTheDocument();
    // A manual check is still allowed.
    expect(screen.getByRole("button", { name: /check now/i })).toBeInTheDocument();
  });

  it("downloads and installs through the store actions", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const api = window.pi as unknown as {
      updates: { download: () => Promise<unknown>; install: () => Promise<boolean> };
    };
    api.updates.download = async () => {
      calls.push("download");
      return { ...initialUpdateState(true), phase: "downloading" as const, percent: 10 };
    };
    api.updates.install = async () => {
      calls.push("install");
      return true;
    };

    setUpdate({ phase: "available", version: "0.4.0" });
    render(<UpdateSettingsCard />);
    await user.click(screen.getByRole("button", { name: /download v0\.4\.0/i }));
    await vi.waitFor(() => expect(useAppStore.getState().update?.phase).toBe("downloading"));
    expect(calls).toEqual(["download"]);

    setUpdate({ phase: "downloaded", version: "0.4.0", percent: 100 });
    await user.click(await screen.findByRole("button", { name: /restart & install/i }));
    expect(calls).toEqual(["download", "install"]);
  });

  it("keeps a missing published feed neutral and allows a retry", async () => {
    const user = userEvent.setup();
    const check = vi.fn(async () => initialUpdateState(true, { currentVersion: "0.3.0" }));
    (window.pi as unknown as { updates: { check: unknown } }).updates.check = check;
    setUpdate({
      phase: "no-feed",
      problemKind: "no-feed",
      error: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
    });
    render(<UpdateSettingsCard />);

    expect(screen.getByTestId("settings-updates")).toHaveTextContent(
      "No published release was found for this build.",
    );
    await user.click(screen.getByRole("button", { name: /check again/i }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("shows a friendly error, technical details and dismisses the message", async () => {
    const user = userEvent.setup();
    const clearProblem = vi.fn(async () => initialUpdateState(true, { currentVersion: "0.3.0" }));
    (window.pi as unknown as { updates: { clearProblem: unknown } }).updates.clearProblem =
      clearProblem;
    setUpdate({
      phase: "error",
      problemKind: "network",
      error: "getaddrinfo ENOTFOUND github.com",
    });
    render(<UpdateSettingsCard />);

    expect(screen.getByTestId("settings-updates")).toHaveTextContent(
      /Couldn't reach the update server/,
    );
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByText(/ENOTFOUND/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /dismiss message/i }));
    expect(clearProblem).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().update?.phase).toBe("idle");
  });

  it("hides and restores the status-bar notification for an offered version", async () => {
    const user = userEvent.setup();
    setUpdate({ phase: "available", version: "0.4.0" });
    render(<UpdateSettingsCard />);

    await user.click(screen.getByRole("button", { name: /hide notification/i }));
    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBe("0.4.0");

    await user.click(screen.getByRole("button", { name: /show notification/i }));
    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBeNull();
  });

  it("opens the public releases page", async () => {
    const user = userEvent.setup();
    const openExternal = vi.fn(async () => true);
    (window.pi as unknown as { openExternal: typeof openExternal }).openExternal = openExternal;
    render(<UpdateSettingsCard />);

    await user.click(screen.getByRole("button", { name: /open releases page/i }));
    expect(openExternal).toHaveBeenCalledWith(PI_DESKTOP_RELEASES_URL);
  });
});
