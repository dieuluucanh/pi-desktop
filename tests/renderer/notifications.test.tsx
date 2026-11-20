import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MuteNotificationDialog } from "../../src/renderer/src/notifications/MuteNotificationDialog";
import { NotificationCenter } from "../../src/renderer/src/notifications/NotificationCenter";
import { overlayOpenIn } from "../../src/renderer/src/web/overlay-detect";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  muteRuleFor,
  updateNotification,
  type AppNotification,
} from "../../src/shared/notifications";
import type { PackageUpdateSummary } from "../../src/shared/packages";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { initialUpdateState } from "../../src/shared/updates";
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

function packageUpdate(
  source: string,
  latestVersion: string | null = "2.0.0",
): PackageUpdateSummary {
  return { source, name: source.replace(/^npm:/, ""), kind: "npm", scope: "user", latestVersion };
}

/** A live app-update offer in the shape main pushes. */
function updateOffer(version = "0.4.0") {
  return {
    ...initialUpdateState(true),
    phase: "available" as const,
    version,
    checkedAt: 1,
  };
}

function reset(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    prefsLoaded: true,
    info: null,
    hint: null,
    view: "welcome",
    settingsFocus: null,
    notifications: [],
    muteTarget: null,
    notificationCooldowns: {},
    update: null,
    packageUpdates: [],
    packageUpdatesCheckedAt: null,
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

  it("opens an empty bell and closes it with Escape", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(screen.queryByTestId("notification-count")).toBeNull();

    await user.click(bell);
    expect(screen.getByTestId("notification-center")).toBeInTheDocument();
    expect(screen.getByText("No notifications.")).toBeInTheDocument();
    expect(screen.getByTestId("notification-center")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Close notifications" })).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());
    await waitFor(() => expect(bell).toHaveFocus());
  });

  it("closes on an outside click and still runs the outside control", async () => {
    const user = userEvent.setup();
    const outside = vi.fn();
    render(
      <>
        <button type="button" onClick={outside}>
          Outside
        </button>
        <NotificationCenter />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(outside).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());
  });

  it("stays open when a control inside is used", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ notifications: [entry()] });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(screen.getByTestId("notification-center")).toBeInTheDocument();
    expect(screen.getByText("No notifications.")).toBeInTheDocument();
  });

  it("toggles closed from the bell", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    const bell = screen.getByRole("button", { name: "Notifications" });

    await user.click(bell);
    expect(screen.getByTestId("notification-center")).toBeInTheDocument();

    await user.click(bell);
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());
  });

  it("resets Show hidden when the panel is dismissed", async () => {
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
    render(
      <>
        <button type="button">Outside</button>
        <NotificationCenter />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Show hidden (1)" }));
    expect(screen.getByText("Server logs ready (local)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.queryByText("Server logs ready (local)")).toBeNull();
  });

  it("closes the panel and focuses the mute dialog from a row gear", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ notifications: [entry()] });
    render(
      <>
        <NotificationCenter />
        <MuteNotificationDialog />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(
      screen.getByRole("button", { name: "Notification settings for Installed workflow" }),
    );

    expect(useAppStore.getState().muteTarget?.id).toBe("n1");
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());
    const dialog = await screen.findByTestId("mute-notification-dialog");
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  });

  it("registers as an overlay so a native web view steps aside", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    expect(overlayOpenIn(document)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(overlayOpenIn(document)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(overlayOpenIn(document)).toBe(false));
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

  it("keeps every line of an archived notification", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      notifications: [entry({ id: "n-lines", message: "line one\nline two" })],
    });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const message = screen.getByText(/line one\s+line two/);
    expect(message.className).toContain("whitespace-pre-wrap");
    expect(message.textContent).toBe("line one\nline two");
  });

  it("keeps every line of an actionable notification", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      notifications: [{ ...updateNotification("0.4.0", 1), message: "line one\nline two" }],
    });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const message = screen.getByText(/line one\s+line two/);
    expect(message.className).toContain("whitespace-pre-wrap");
  });

  it("opens the update view from the derived offer row", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ update: updateOffer() });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(screen.getByRole("button", { name: "Pi Desktop v0.4.0 is available." }));
    expect(useAppStore.getState().view).toBe("updates");
  });

  it("opens the Extensions hub from a derived extension-update row", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      packageUpdates: [packageUpdate("npm:alpha"), packageUpdate("npm:beta")],
      packageUpdatesCheckedAt: 1,
    });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(screen.getByRole("button", { name: "2 extension updates available." }));
    expect(useAppStore.getState().view).toBe("extensions");
  });

  it("derives offers from live state and drops them when the condition clears", () => {
    useAppStore.setState({ update: updateOffer() });
    const { rerender } = render(<NotificationCenter />);
    expect(screen.getByTestId("notification-count")).toHaveTextContent("1");

    // The app answered "up to date": the row must vanish with the condition.
    useAppStore.setState({ update: { ...initialUpdateState(true), phase: "up-to-date" } });
    rerender(<NotificationCenter />);
    expect(screen.queryByTestId("notification-count")).toBeNull();

    // The update set shrinks rather than stacking a second row.
    useAppStore.setState({
      packageUpdates: [packageUpdate("npm:alpha"), packageUpdate("npm:beta")],
      packageUpdatesCheckedAt: 1,
    });
    rerender(<NotificationCenter />);
    expect(screen.getByTestId("notification-count")).toHaveTextContent("1");

    useAppStore.setState({
      packageUpdates: [packageUpdate("npm:alpha")],
      packageUpdatesCheckedAt: 1,
    });
    rerender(<NotificationCenter />);
    expect(screen.getByTestId("notification-count")).toHaveTextContent("1");

    useAppStore.setState({ packageUpdates: [], packageUpdatesCheckedAt: 1 });
    rerender(<NotificationCenter />);
    expect(screen.queryByTestId("notification-count")).toBeNull();
  });

  it("dismisses a derived offer through its persisted marker", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ packageUpdates: [packageUpdate("npm:alpha")] });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(
      screen.getByRole("button", { name: "Dismiss notification: 1 extension update available." }),
    );

    const state = useAppStore.getState();
    expect(state.prefs.packages.dismissedSignature).not.toBeNull();
    expect(state.notifications).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId("notification-count")).toBeNull());
  });

  it("Clears a live offer by persisting its dismissal", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ update: updateOffer() });
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: "Notifications (1)" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBe("0.4.0");
    expect(screen.getByText("No notifications.")).toBeInTheDocument();
  });

  it("does not hide an offer behind a type:info mute rule", () => {
    const rule = muteRuleFor({ message: "Server logs ready (local)", type: "info" }, "type");
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        notifications: { ...DEFAULT_PREFS.notifications, muted: [rule] },
      },
      update: updateOffer(),
    });
    render(<NotificationCenter />);

    expect(screen.getByTestId("notification-count")).toHaveTextContent("1");
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
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());

    // The gear closed the panel; Show hidden starts collapsed on reopen.
    useAppStore.setState({ muteTarget: null });
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Show hidden (1)" }));
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
