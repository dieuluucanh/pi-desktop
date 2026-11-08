import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesView } from "../../src/renderer/src/views/UpdatesView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import {
  PI_DESKTOP_RELEASES_URL,
  initialUpdateState,
  type UpdateState,
} from "../../src/shared/updates";
import { appInfoFixture, installBridge } from "./fixtures";

/**
 * About & updates (2026-11-01 update plan, moved out of Settings in 2026-11-08):
 * build provenance, the updater's full state, and every action. This view is
 * where errors and no-feed notices live now that the full-width banner is gone.
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
    prefsLoaded: true,
    notifications: [],
    settingsFocus: null,
    hint: null,
  });
});

function setUpdate(partial: Partial<UpdateState>) {
  useAppStore.setState({
    update: { ...initialUpdateState(true, { currentVersion: "0.3.0" }), ...partial },
  });
}

describe("UpdatesView", () => {
  it("shows the version, build provenance and a check action", () => {
    render(<UpdatesView />);

    expect(screen.getByTestId("updates-panel")).toHaveTextContent("v0.3.0");
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
    render(<UpdatesView />);

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
    render(<UpdatesView />);
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
    render(<UpdatesView />);

    expect(screen.getByTestId("updates-panel")).toHaveTextContent(
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
    render(<UpdatesView />);

    expect(screen.getByTestId("updates-panel")).toHaveTextContent(
      /Couldn't reach the update server/,
    );
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByText(/ENOTFOUND/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /dismiss message/i }));
    expect(clearProblem).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().update?.phase).toBe("idle");
  });

  it("offers Notify me again after the update notification is dismissed", async () => {
    const user = userEvent.setup();
    setUpdate({ phase: "available", version: "0.4.0" });
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        updates: { ...DEFAULT_PREFS.updates, notifiedVersion: "0.4.0" },
      },
      notifications: [],
    });
    render(<UpdatesView />);

    await user.click(screen.getByRole("button", { name: /notify me again/i }));
    expect(useAppStore.getState().notifications).toHaveLength(1);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBe("0.4.0");
  });

  it("opens the public releases page", async () => {
    const user = userEvent.setup();
    const openExternal = vi.fn(async () => true);
    (window.pi as unknown as { openExternal: typeof openExternal }).openExternal = openExternal;
    render(<UpdatesView />);

    await user.click(screen.getByRole("button", { name: /open releases page/i }));
    expect(openExternal).toHaveBeenCalledWith(PI_DESKTOP_RELEASES_URL);
  });

  it("presents the macOS signature policy as manual updates, not a failure", async () => {
    const user = userEvent.setup();
    const openExternal = vi.fn(async () => true);
    (window.pi as unknown as { openExternal: typeof openExternal }).openExternal = openExternal;
    useAppStore.setState({
      update: initialUpdateState(false, {
        currentVersion: "0.5.0",
        unsupportedReason: "unsigned-mac",
      }),
    });
    render(<UpdatesView />);

    // The badge names the policy, and the prose says where the update comes from
    // — an ad-hoc-signed mac build can never install one in place.
    expect(screen.getByText("Manual updates")).toBeInTheDocument();
    expect(screen.queryByText("Unsupported")).not.toBeInTheDocument();
    expect(screen.getByTestId("updates-panel")).toHaveTextContent(
      /installed by downloading the new release from GitHub/i,
    );
    expect(screen.getByRole("switch", { name: /check for updates automatically/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /open releases page/i }));
    expect(openExternal).toHaveBeenCalledWith(PI_DESKTOP_RELEASES_URL);
  });
});
