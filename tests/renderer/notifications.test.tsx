import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { MuteNotificationDialog } from "../../src/renderer/src/notifications/MuteNotificationDialog";
import { NotificationCenter } from "../../src/renderer/src/notifications/NotificationCenter";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { updateNotification, type AppNotification } from "../../src/shared/notifications";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The notification bell, popover and mute dialog (2026-11-08 plan).
 *
 * The bell counts only unsuppressed rows; a class-disabled or rule-matched row
 * stays in the archive behind Show hidden, and every row can be dismissed
 * individually. The update offer is an app-owned row with an action.
 */

const TAB = "tab-1";

function entry(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "n1",
    message: "Installed workflow",
    type: "warning",
    class: "warning",
    tabId: TAB,
    at: 1,
    action: null,
    ...overrides,
  };
}

function reset(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    info: null,
    hint: null,
    view: "welcome",
    settingsFocus: null,
    notifications: [],
    muteTarget: null,
    notificationCooldowns: {},
  });
}

beforeEach(reset);

describe("NotificationCenter", () => {
  it("renders a bell with the unsuppressed count", () => {
    useAppStore.setState({
      notifications: [
        entry(),
        entry({
          id: "n-info",
          message: "Server logs ready (local)",
          type: "info",
          class: "info",
        }),
      ],
    });
    render(<NotificationCenter />);

    expect(screen.getByRole("button", { name: "Notifications (1)" })).toBeInTheDocument();
    expect(screen.getByTestId("notification-count")).toHaveTextContent("1");
  });

  it("renders an empty bell and a closeable popover", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(screen.queryByTestId("notification-count")).toBeNull();

    await user.click(bell);
    expect(screen.getByTestId("notification-center")).toBeInTheDocument();
    expect(screen.getByText("No notifications.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.queryByTestId("notification-center")).toBeNull();
  });

  it("clears the archive", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ notifications: [entry()] });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  it("dismisses only the chosen row", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      notifications: [entry(), entry({ id: "n2", message: "two" })],
    });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (2)" }));
    await user.click(
      screen.getByRole("button", { name: "Dismiss notification: Installed workflow" }),
    );
    expect(useAppStore.getState().notifications.map((notification) => notification.id)).toEqual([
      "n2",
    ]);
  });

  it("hides an info class by default and reveals it from the hidden bin", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      notifications: [
        entry({
          id: "n-info",
          message: "Server logs ready (local)",
          type: "info",
          class: "info",
        }),
      ],
    });
    render(<NotificationCenter />);
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.queryByText("Server logs ready (local)")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show hidden (1)" }));
    expect(screen.getByText("Server logs ready (local)")).toBeInTheDocument();
    expect(screen.getByTestId("notification-hidden")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show info notifications" }));
    expect(useAppStore.getState().prefs.notifications.classes.info).toBe(true);
    expect(screen.getByTestId("notification-count")).toHaveTextContent("1");
  });

  it("opens the update view from the offer row", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ notifications: [updateNotification("0.4.0", 1)] });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(screen.getByRole("button", { name: "Pi Desktop v0.4.0 is available." }));
    expect(useAppStore.getState().view).toBe("updates");
  });

  it("marks a muted row behind Show hidden and unmutes it", async () => {
    const user = userEvent.setup();
    const muted = entry({ id: "n-muted" });
    useAppStore.getState().muteNotification(muted, "exact");
    useAppStore.setState({ notifications: [muted], muteTarget: null });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show hidden (1)" }));
    expect(screen.getByTestId("notification-muted")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /notification settings for installed workflow/i }),
    );
    expect(useAppStore.getState().muteTarget).toEqual(muted);

    await user.click(screen.getByRole("button", { name: /unmute notification/i }));
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(0);
    expect(screen.queryByTestId("notification-muted")).toBeNull();
  });

  it("links to the class settings", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Notification settings" }));
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("notifications");
  });
});

describe("MuteNotificationDialog", () => {
  const target: AppNotification = entry({
    id: "n-mute",
    message:
      "Workflow plan: thinking xhigh → high (opencode-go/deepseek-v4.1-flash does not support xhigh).",
  });

  it("defaults to the template rule and saves it", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    expect(screen.getByRole("dialog", { name: "Notification settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(useAppStore.getState().prefs.notifications.muted[0]).toMatchObject({
      scope: "template",
      type: "warning",
    });
    expect(useAppStore.getState().muteTarget).toBeNull();
  });

  it("can save the exact text", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    await user.click(screen.getByRole("radio", { name: /just this notification/i }));
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(useAppStore.getState().prefs.notifications.muted[0]?.scope).toBe("exact");
  });

  it("keeps the template scope selectable for a message without variables", async () => {
    const user = userEvent.setup();
    const staticMessage = entry({
      id: "n-static",
      message: "Server logs ready (local)",
    });
    useAppStore.setState({ muteTarget: staticMessage });
    render(<MuteNotificationDialog />);

    expect(screen.getByText(/no variable parts/i)).toBeInTheDocument();
    const template = screen.getByRole("radio", { name: /all warnings like this/i });
    expect(template).not.toBeDisabled();
    await user.click(template);
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(useAppStore.getState().prefs.notifications.muted[0]).toMatchObject({
      scope: "template",
      value: "server logs ready (local)",
    });
  });

  it("can save the whole type", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    await user.click(screen.getByRole("radio", { name: /all warning notifications/i }));
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(useAppStore.getState().prefs.notifications.muted[0]).toMatchObject({
      scope: "type",
      value: "warning",
    });
  });

  it("shows muted state and unmutes", async () => {
    const user = userEvent.setup();
    useAppStore.getState().muteNotification(target, "exact");
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    expect(screen.getByText("muted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unmute" }));
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(0);
  });
});
