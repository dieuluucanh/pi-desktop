import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OfficeIntegrationCard } from "../../src/renderer/src/office/OfficeIntegrationCard";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyIntegrationsState } from "../../src/shared/integrations";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { documentsViewFixture, installBridge, officeViewFixture } from "./fixtures";

/**
 * The Pi for Office integration card (plan step 19). The installed/connected
 * facts come from the wizard view and the package manager's list; the bridge
 * install always goes through the consent dialog, never straight to npm.
 */

function resetStore() {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    project: { path: "C:/work/app", name: "app" },
    tabs: [],
    activeTabId: null,
    packages: [],
    packagesLoaded: false,
    packagesBusy: false,
    packagesError: null,
    packagesCwd: null,
    packageProgress: null,
    packageConsent: null,
    integrations: emptyIntegrationsState(),
    integrationsLoaded: false,
    view: "extensions",
    hint: null,
  });
}

beforeEach(resetStore);

describe("office integration card", () => {
  it("says not-installed and offers the consented install first", async () => {
    render(<OfficeIntegrationCard />);

    const card = await screen.findByTestId("office-integration-card");
    expect(card).toHaveAttribute("data-status", "not-installed");
    expect(screen.getByText("not installed")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /install bridge package/i }));

    const consent = useAppStore.getState().packageConsent;
    expect(consent?.source).toBe("npm:@dieulc/pi-office-bridge@^0.6.0");
    expect(consent?.integration).toBe("office");
    // The Office session needs a bridge, so it stays disabled until then.
    expect(screen.getByRole("button", { name: /open office session/i })).toBeDisabled();
  });

  it("offers Connect when a 0.6 bridge is installed but off", async () => {
    const connect = vi.fn(async () => true);
    useAppStore.setState({
      packages: [
        {
          source: "npm:@dieulc/pi-office-bridge@^0.6.0",
          name: "@dieulc/pi-office-bridge",
          kind: "npm",
          scope: "user",
          filtered: false,
          version: "0.6.0",
          pinned: true,
          installedPath: "C:/profile/agent/npm/node_modules/@dieulc/pi-office-bridge",
          installed: true,
        },
      ],
      packagesLoaded: true,
      packagesCwd: "C:/work/app",
      tabs: [
        {
          id: "tab-1",
          kind: "session",
          cwd: "C:/work/app",
          title: "app",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
      activeTabId: "tab-1",
      officeDocuments: documentsViewFixture({
        available: true,
        status: "ok",
        manualLifecycle: true,
        owner: null,
        panes: [],
      }),
      connectOfficeBridge: connect,
    });
    render(<OfficeIntegrationCard />);

    await screen.findByTestId("office-integration-card");
    expect(screen.getByText("on demand (0.6+)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect bridge" }));
    expect(connect).toHaveBeenCalledWith("tab-1");
  });

  it("offers Update bridge for an automatic 0.5 bridge", async () => {
    useAppStore.setState({
      packages: [
        {
          source: "npm:@dieulc/pi-office-bridge@^0.5.0",
          name: "@dieulc/pi-office-bridge",
          kind: "npm",
          scope: "user",
          filtered: false,
          version: "0.5.2",
          pinned: true,
          installedPath: "C:/profile/agent/npm/node_modules/@dieulc/pi-office-bridge",
          installed: true,
        },
      ],
      packagesLoaded: true,
      packagesCwd: "C:/work/app",
    });
    render(<OfficeIntegrationCard />);

    await screen.findByTestId("office-integration-card");
    expect(screen.getByText("automatic (legacy)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update bridge" }));
    expect(useAppStore.getState().packageConsent?.source).toBe(
      "npm:@dieulc/pi-office-bridge@^0.6.0",
    );
  });

  it("reports an installed bridge from the package manager before the wizard runs", async () => {
    useAppStore.setState({
      packages: [
        {
          source: "npm:@dieulc/pi-office-bridge@^0.5.0",
          name: "@dieulc/pi-office-bridge",
          kind: "npm",
          scope: "user",
          filtered: false,
          version: "0.5.2",
          pinned: true,
          installedPath: "C:/profile/agent/npm/node_modules/@dieulc/pi-office-bridge",
          installed: true,
        },
      ],
      packagesLoaded: true,
      packagesCwd: "C:/work/app",
    });
    render(<OfficeIntegrationCard />);

    const card = await screen.findByTestId("office-integration-card");
    expect(card).toHaveAttribute("data-status", "installed");
    expect(screen.getByText(/v0\.5\.2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open office session/i })).toBeEnabled();
    // The wizard panel is reachable once the package exists.
    expect(screen.getByTestId("office-setup-details")).toBeInTheDocument();
  });

  it("shows connected when the bridge answers /health", async () => {
    installBridge({
      office: officeViewFixture({
        status: "done",
        finishedAt: "2026-09-20T10:00:00.000Z",
        bridge: { status: "already-installed", version: "0.5.0", error: null, installLog: "" },
        health: {
          status: "ok",
          url: "http://127.0.0.1:38617/health",
          portConflict: false,
          error: null,
          serverName: "pi-office-bridge",
          serverVersion: "0.5.0",
          protocolVersion: 3,
          catalogVersion: 3,
          capabilities: [],
        },
      }),
    });
    render(<OfficeIntegrationCard />);

    const card = await screen.findByTestId("office-integration-card");
    expect(card).toHaveAttribute("data-status", "connected");
    expect(screen.getByText(/^v3 \/ v3$/)).toBeInTheDocument();
  });

  it("records the completed setup in app state once", async () => {
    const record = vi.fn(async (_patch: unknown) => emptyIntegrationsState());
    installBridge({
      office: officeViewFixture({
        status: "done",
        finishedAt: "2026-09-20T10:00:00.000Z",
        bridge: { status: "already-installed", version: "0.5.0", error: null, installLog: "" },
      }),
    });
    (
      window.pi as unknown as { integrations: { recordOffice: unknown } }
    ).integrations.recordOffice = record;

    render(<OfficeIntegrationCard />);

    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0]?.[0]).toEqual({ lastSetupAt: "2026-09-20T10:00:00.000Z" });
  });

  it("copies the redacted diagnostics bundle to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    installBridge({
      office: officeViewFixture({
        bridge: { status: "installed", version: "0.5.0", error: null, installLog: "" },
      }),
    });
    (window.pi as unknown as { office: { diagnostics: unknown } }).office.diagnostics = async () =>
      "bundle: no credentials";
    render(<OfficeIntegrationCard />);

    await userEvent.click(await screen.findByRole("button", { name: /copy diagnostics/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("bundle: no credentials"));
    expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("disables Reset add-in until something is sideloaded", async () => {
    render(<OfficeIntegrationCard />);

    await screen.findByTestId("office-integration-card");
    expect(screen.getByRole("button", { name: /reset add-in/i })).toBeDisabled();
  });
});
