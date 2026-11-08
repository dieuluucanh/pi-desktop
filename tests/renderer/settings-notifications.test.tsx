import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { NotificationsSettingsCard } from "../../src/renderer/src/settings/NotificationsSettings";
import { SettingsView } from "../../src/renderer/src/views/SettingsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { DEFAULT_NOTIFICATION_PREFS, muteRuleFor } from "../../src/shared/notifications";
import { installBridge } from "./fixtures";

function reset(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, notifications: { ...DEFAULT_NOTIFICATION_PREFS } },
    settingsCwd: null,
    settings: null,
    settingsLoaded: false,
    settingsBusy: false,
    settingsError: null,
    settingsErrors: [],
    settingsFiles: null,
    settingsProjectTrusted: true,
    settingsMtimes: { global: null, project: null },
    settingsExternalEdit: false,
  });
}

beforeEach(reset);

describe("NotificationsSettingsCard", () => {
  it("shows the empty state", () => {
    render(<NotificationsSettingsCard />);
    expect(screen.getByTestId("settings-notifications")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-empty")).toHaveTextContent("No muted notifications");
  });

  it("toggles a class without dropping the mute rules", async () => {
    const rule = muteRuleFor({ message: "Installed workflow", type: "info" }, "exact", 1);
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        notifications: { ...DEFAULT_NOTIFICATION_PREFS, muted: [rule] },
      },
    });
    render(<NotificationsSettingsCard />);

    const info = screen.getByRole("switch", { name: /show informational messages/i });
    expect(info).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /show warnings/i })).toBeChecked();

    await userEvent.click(info);
    expect(useAppStore.getState().prefs.notifications.classes.info).toBe(true);
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(1);
  });

  it("lists exact, template and type rules", () => {
    const exact = muteRuleFor({ message: "Installed workflow", type: "info" }, "exact");
    const template = muteRuleFor(
      { message: "thinking xhigh → high (model does not support xhigh)", type: "warning" },
      "template",
    );
    const type = muteRuleFor({ message: "anything", type: "warning" }, "type");
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        notifications: { ...DEFAULT_NOTIFICATION_PREFS, muted: [exact, template, type] },
      },
    });
    render(<NotificationsSettingsCard />);
    expect(screen.getByText("exact")).toBeInTheDocument();
    expect(screen.getByText("template")).toBeInTheDocument();
    expect(screen.getByText("type")).toBeInTheDocument();
    expect(screen.getByText(/Installed workflow/)).toBeInTheDocument();
    expect(screen.getByText(/All warning notifications/)).toBeInTheDocument();
  });

  it("unmutes one rule and all rules", async () => {
    const first = muteRuleFor({ message: "one", type: "warning" }, "exact");
    const second = muteRuleFor({ message: "two", type: "warning" }, "exact");
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        notifications: { ...DEFAULT_NOTIFICATION_PREFS, muted: [first, second] },
      },
    });
    render(<NotificationsSettingsCard />);

    await userEvent.click(screen.getByRole("button", { name: /unmute .*one/i }));
    expect(useAppStore.getState().prefs.notifications.muted.map((rule) => rule.id)).toEqual([
      second.id,
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Unmute all" }));
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(0);
  });
});

describe("SettingsView", () => {
  it("mounts the notifications card", async () => {
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId("settings-notifications")).toBeTruthy());
  });
});
