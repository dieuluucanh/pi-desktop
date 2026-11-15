import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PackageConsentDialog } from "../../src/renderer/src/extensions/PackageConsentDialog";
import { PackagesSection } from "../../src/renderer/src/extensions/PackagesSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { PackageSummary, PackageUpdateSummary } from "../../src/shared/packages";
import type { TabRecord } from "../../src/shared/session-ipc";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The packages UI (plan step 14). The dialog is the only way to install, it shows
 * the source verbatim, and nothing reaches the host until it is confirmed.
 */

const PROJECT = "C:/work/app";

function summary(overrides: Partial<PackageSummary> = {}): PackageSummary {
  return {
    source: "npm:@dieulc/workflow",
    name: "@dieulc/workflow",
    kind: "npm",
    scope: "user",
    filtered: false,
    version: "0.3.2",
    pinned: false,
    installedPath: "C:/profile/agent/npm/node_modules/@dieulc/workflow",
    installed: true,
    ...overrides,
  };
}

function stubRequest(impl: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function resetStore(packages: PackageSummary[] = [summary()]): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    prefsLoaded: true,
    project: { path: PROJECT, name: "app" },
    tabs: [],
    activeTabId: null,
    packages,
    packagesLoaded: true,
    packagesBusy: false,
    packagesError: null,
    packagesCwd: PROJECT,
    packageProgress: null,
    packageConsent: null,
    packageUpdates: [],
    packageUpdatesCheckedAt: null,
    packageUpdatesBusy: false,
    packageUpdatesError: null,
    packageUpdatesOffline: false,
    packageUpdatesUnavailable: false,
    packageUpdatesCwd: null,
    packagesMutatedAt: null,
  });
}

beforeEach(() => resetStore());

describe("PackagesSection", () => {
  it("lists configured packages with scope, version and pin state", () => {
    resetStore([
      summary(),
      summary({
        source: "npm:lodash@4.17.21",
        name: "lodash",
        version: "4.17.21",
        pinned: true,
        scope: "project",
        installed: false,
        installedPath: null,
      }),
    ]);
    stubRequest(async () => ({ packages: [], loadedAt: 1 }));
    render(<PackagesSection />);

    expect(screen.getByTestId("package-npm:@dieulc/workflow")).toHaveTextContent(
      "@dieulc/workflow",
    );
    expect(screen.getByTestId("package-npm:@dieulc/workflow")).toHaveTextContent("installed 0.3.2");
    const pinned = screen.getByTestId("package-npm:lodash@4.17.21");
    expect(pinned).toHaveTextContent("pinned");
    expect(pinned).toHaveTextContent("not installed");
    expect(pinned).toHaveTextContent("project");
  });

  it("shows an empty state when nothing is configured", () => {
    resetStore([]);
    stubRequest(async () => ({ packages: [], loadedAt: 1 }));
    render(<PackagesSection />);
    expect(screen.getByTestId("packages-empty")).toBeInTheDocument();
  });

  it("surfaces a host error verbatim", () => {
    resetStore([]);
    stubRequest(async () => ({ packages: [], loadedAt: 1 }));
    useAppStore.setState({ packagesError: "npm ERR! code E404\n\nHint: check the name" });
    render(<PackagesSection />);
    expect(screen.getByRole("alert")).toHaveTextContent("npm ERR! code E404");
  });

  it("removes a package without a consent dialog", async () => {
    const request = stubRequest(async (method) => {
      if (method === "packages.list") return { packages: [summary()], loadedAt: 1 };
      return {};
    });
    render(<PackagesSection />);

    await userEvent.click(screen.getByRole("button", { name: /Remove @dieulc\/workflow/i }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "packages.remove",
        params: { source: "npm:@dieulc/workflow", scope: "user", cwd: PROJECT },
      }),
    );
    expect(useAppStore.getState().packageConsent).toBeNull();
  });

  it("opens the consent dialog for an install from the source field", async () => {
    const request = stubRequest(async (method) => {
      if (method === "packages.list") return { packages: [summary()], loadedAt: 1 };
      return {};
    });
    render(
      <>
        <PackagesSection />
        <PackageConsentDialog />
      </>,
    );

    await userEvent.type(screen.getByLabelText("Package source"), "@dieulc/autocompact");
    await userEvent.click(screen.getByRole("button", { name: /Install$/i }));

    expect(screen.getByTestId("package-consent")).toBeInTheDocument();
    expect(screen.getByTestId("consent-source")).toHaveTextContent("npm:@dieulc/autocompact");
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "packages.install" }),
    );
  });

  it("pins a package to its installed version through the dialog", async () => {
    stubRequest(async (method) => {
      if (method === "packages.list") return { packages: [summary()], loadedAt: 1 };
      return {};
    });
    render(
      <>
        <PackagesSection />
        <PackageConsentDialog />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Pin to 0.3.2" }));
    expect(screen.getByTestId("consent-source")).toHaveTextContent("npm:@dieulc/workflow@0.3.2");
  });
});

describe("available updates", () => {
  function updateEntry(overrides: Partial<PackageUpdateSummary> = {}): PackageUpdateSummary {
    return {
      source: "npm:@dieulc/workflow",
      name: "@dieulc/workflow",
      kind: "npm",
      scope: "user",
      latestVersion: "0.4.0",
      ...overrides,
    };
  }

  function stubCheck(updates: PackageUpdateSummary[] = [updateEntry()]) {
    return stubRequest(async (method) => {
      if (method === "packages.checkUpdates") {
        return { updates, checkedAt: Date.now(), offline: false };
      }
      if (method === "packages.list") return { packages: [summary()], loadedAt: 1 };
      return {};
    });
  }

  it("badges the version an update would install and counts it", () => {
    useAppStore.setState({ packageUpdates: [updateEntry()] });
    stubCheck();
    render(<PackagesSection />);

    expect(screen.getByTestId("package-update-badge-npm:@dieulc/workflow")).toHaveTextContent(
      "0.4.0 available",
    );
    expect(screen.getByTestId("package-update-npm:@dieulc/workflow")).toHaveAttribute(
      "title",
      "Update to 0.4.0",
    );
    expect(screen.getByTestId("package-check-status")).toHaveTextContent("1 update available");
    expect(screen.getByRole("button", { name: "Update all (1)" })).toBeInTheDocument();
  });

  it("says only 'available' when the target is not knowable (git or a range)", () => {
    resetStore([
      summary({ source: "git:github.com/owner/repo", name: "repo", kind: "git", version: "main" }),
    ]);
    useAppStore.setState({
      packageUpdates: [
        updateEntry({
          source: "git:github.com/owner/repo",
          name: "repo",
          kind: "git",
          latestVersion: null,
        }),
      ],
    });
    stubCheck();
    render(<PackagesSection />);

    const badge = screen.getByTestId("package-update-badge-git:github.com/owner/repo");
    expect(badge).toHaveTextContent("available");
    expect(badge).not.toHaveTextContent("0.4.0");
  });

  it("keeps a pinned row disabled and explains why", () => {
    resetStore([summary({ pinned: true, version: "0.3.2" })]);
    useAppStore.setState({ packageUpdates: [updateEntry()] });
    stubCheck();
    render(<PackagesSection />);

    const action = screen.getByTestId("package-update-npm:@dieulc/workflow");
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("title", "Pinned to 0.3.2 — unpin to follow latest");
    // The sweep skips a pin, so the row must not claim an update either.
    expect(screen.queryByTestId("package-update-badge-npm:@dieulc/workflow")).toBeNull();
  });

  it("labels a configured-but-missing package Install", () => {
    resetStore([summary({ installed: false, installedPath: null, version: null })]);
    stubCheck();
    render(<PackagesSection />);
    expect(screen.getByTestId("package-update-npm:@dieulc/workflow")).toHaveTextContent("Install");
  });

  it("reports up to date, offline, unavailable and failure states", () => {
    stubCheck();
    useAppStore.setState({ packageUpdatesCheckedAt: Date.now() });
    const { unmount } = render(<PackagesSection />);
    expect(screen.getByTestId("package-check-status")).toHaveTextContent(
      "Up to date · checked just now",
    );
    unmount();

    useAppStore.setState({ packageUpdatesOffline: true });
    const offline = render(<PackagesSection />);
    expect(screen.getByTestId("package-check-status")).toHaveTextContent("Offline");
    offline.unmount();

    useAppStore.setState({ packageUpdatesOffline: false, packageUpdatesUnavailable: true });
    const unavailable = render(<PackagesSection />);
    expect(screen.getByTestId("package-check-status")).toHaveTextContent(
      "unavailable in this build",
    );
    unavailable.unmount();

    useAppStore.setState({
      packageUpdatesUnavailable: false,
      packageUpdatesError: "registry unreachable\n\nHint: retry later",
    });
    render(<PackagesSection />);
    // The hint body stays out of the status row.
    expect(screen.getByTestId("package-check-status")).toHaveTextContent(
      "Could not check for updates: registry unreachable",
    );
  });

  it("checks on demand with force", async () => {
    const request = stubCheck([]);
    render(<PackagesSection />);

    await userEvent.click(screen.getByRole("button", { name: "Check now" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "packages.checkUpdates",
        params: { cwd: PROJECT, force: true },
      }),
    );
  });

  it("persists the automatic-check switch", async () => {
    stubCheck([]);
    render(<PackagesSection />);

    await userEvent.click(screen.getByRole("switch", { name: /Check for updates automatically/i }));

    expect(useAppStore.getState().prefs.packages.autoCheck).toBe(false);
  });

  it("spins the row whose operation is running", () => {
    useAppStore.setState({
      packageProgress: {
        operationId: "op-1",
        action: "update",
        phase: "start",
        source: "npm:@dieulc/workflow",
        percent: 0,
      },
    });
    stubCheck([]);
    render(<PackagesSection />);
    expect(screen.getByTestId("package-row-spinner")).toBeInTheDocument();
  });

  it("offers a reload only while a session is open, and dismisses it", async () => {
    useAppStore.setState({
      tabs: [{ id: "t1", kind: "session", cwd: PROJECT } as TabRecord],
      packagesMutatedAt: Date.now(),
    });
    stubCheck([]);
    render(<PackagesSection />);

    expect(screen.getByTestId("package-reload-hint")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("package-reload-hint")).toBeNull();
    expect(useAppStore.getState().packagesMutatedAt).toBeNull();
  });

  it("hides the reload hint when no session is open", () => {
    useAppStore.setState({ tabs: [], packagesMutatedAt: Date.now() });
    stubCheck([]);
    render(<PackagesSection />);
    expect(screen.queryByTestId("package-reload-hint")).toBeNull();
  });
});

describe("PackageConsentDialog", () => {
  it("renders nothing without a pending consent", () => {
    installBridge();
    const { container } = render(<PackageConsentDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states the system-access risk and confirms with the exact source", async () => {
    const request = stubRequest(async (method) => {
      if (method === "packages.list") return { packages: [summary()], loadedAt: 1 };
      if (method === "settings.get") {
        return {
          settings: { global: {}, project: {} },
          errors: [],
          files: {
            global: { path: "/s.json", exists: true, mtimeMs: 1 },
            project: { path: `${PROJECT}/.pi/settings.json`, exists: false, mtimeMs: 0 },
          },
          projectTrusted: true,
        };
      }
      return {};
    });
    useAppStore.getState().requestPackageInstall("npm:@dieulc/workflow", "user");
    render(<PackageConsentDialog />);

    expect(screen.getByText(/full system access/i)).toBeInTheDocument();
    expect(screen.getByTestId("consent-source")).toHaveTextContent("npm:@dieulc/workflow");

    await userEvent.click(screen.getByTestId("consent-confirm"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "packages.install",
        params: {
          source: "npm:@dieulc/workflow",
          scope: "user",
          cwd: PROJECT,
          consent: { source: "npm:@dieulc/workflow", systemAccess: true },
        },
      }),
    );
  });

  it("cancel closes the dialog and installs nothing", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.getState().requestPackageInstall("npm:@dieulc/workflow", "user");
    render(<PackageConsentDialog />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().packageConsent).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
