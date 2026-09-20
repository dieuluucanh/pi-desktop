import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionsView } from "../../src/renderer/src/views/ExtensionsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { PACKAGE_GALLERY_URL, RECOMMENDED_PACKAGES } from "../../src/shared/recommended-packages";
import type { ResourcesSnapshot } from "../../src/shared/resources";
import type { SettingsSnapshot } from "../../src/shared/settings";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { emptyIntegrationsState } from "../../src/shared/integrations";
import { appInfoFixture, installBridge, officeViewFixture } from "./fixtures";

/**
 * The Extensions hub (plan step 13). The Office wizard must stay reachable from
 * day one (plan D-A10), and everything the step promises — provenance,
 * contributions, load errors, live errors, enable/disable and the recommended
 * set — is asserted here.
 */

function settingsSnapshot(global: Record<string, unknown> = {}): SettingsSnapshot {
  return {
    settings: { global, project: {} },
    errors: [],
    files: {
      global: { path: "/profile/agent/settings.json", exists: true, mtimeMs: 1 },
      project: { path: "/p/.pi/settings.json", exists: false, mtimeMs: 0 },
    },
    projectTrusted: true,
  };
}

function resourcesSnapshot(overrides: Partial<ResourcesSnapshot> = {}): ResourcesSnapshot {
  return {
    cwd: null,
    scope: "control",
    resources: [],
    overrides: [],
    diagnostics: [],
    runtimeErrors: [],
    loadedAt: 1,
    ...overrides,
  };
}

function extensionResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "extensions:C:/res/foo/index.ts",
    kind: "extensions" as const,
    name: "index.ts",
    path: "C:/res/foo/index.ts",
    overridePath: "C:/res/foo/index.ts",
    source: "user",
    scope: "user" as const,
    origin: "top-level" as const,
    settingsKey: "extensions" as const,
    enabled: true,
    contributed: [
      { kind: "tool" as const, name: "do_thing", description: "does" },
      { kind: "command" as const, name: "foo" },
    ],
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

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    info: appInfoFixture(),
    project: null,
    tabs: [],
    activeTabId: null,
    settings: settingsSnapshot().settings,
    settingsLoaded: true,
    settingsCwd: null,
    settingsBusy: false,
    settingsError: null,
    resources: resourcesSnapshot(),
    resourcesLoaded: true,
    resourcesBusy: false,
    resourcesError: null,
    resourcesTabId: "control",
    resourcesCwd: null,
    resourcesChange: null,
    packages: [],
    packagesLoaded: false,
    packagesBusy: false,
    packagesError: null,
    packagesCwd: null,
    packageProgress: null,
    packageConsent: null,
    integrations: emptyIntegrationsState(),
    integrationsLoaded: false,
  });
});

describe("extensions view", () => {
  it("mounts the Pi for Office card under Integrations (plan step 19)", async () => {
    stubRequest(async (method) =>
      method === "settings.get" ? settingsSnapshot() : resourcesSnapshot(),
    );
    render(<ExtensionsView />);
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Pi for Office" })).toBeInTheDocument();
    const card = screen.getByTestId("office-integration-card");
    expect(card).toBeInTheDocument();
    // Nothing is installed yet, so the card offers the consented install instead
    // of a wizard that would install the bridge without asking.
    expect(card).toHaveAttribute("data-status", "not-installed");
    expect(screen.getByRole("button", { name: /install bridge package/i })).toBeInTheDocument();
    expect(useAppStore.getState().integrationsLoaded).toBe(true);
  });

  it("reveals the wizard panel once the bridge package is installed", async () => {
    installBridge({
      office: officeViewFixture({
        status: "done",
        finishedAt: "2026-09-20T10:00:00.000Z",
        bridge: { status: "already-installed", version: "0.5.0", error: null, installLog: "" },
      }),
    });
    stubRequest(async (method) => {
      if (method === "packages.list") {
        return {
          packages: [
            {
              source: "npm:@dieulc/pi-office-bridge@^0.5.0",
              name: "@dieulc/pi-office-bridge",
              kind: "npm",
              scope: "user",
              filtered: false,
              version: "0.5.0",
              pinned: true,
              installedPath: "C:/profile/agent/npm/node_modules/@dieulc/pi-office-bridge",
              installed: true,
            },
          ],
          loadedAt: 1,
        };
      }
      return method === "settings.get" ? settingsSnapshot() : resourcesSnapshot();
    });
    const { container } = render(<ExtensionsView />);

    expect(await screen.findByTestId("office-setup-details")).toBeInTheDocument();
    // The unchanged wizard panel is still reachable inside the card.
    expect(container.querySelector(".panel")).not.toBeNull();
    expect(container.querySelector(".steps")).not.toBeNull();
  });

  it("lists loaded resources with provenance and contributions", () => {
    useAppStore.setState({
      resources: resourcesSnapshot({
        resources: [
          extensionResource(),
          {
            id: "skills:C:/res/skills/review/SKILL.md",
            kind: "skills",
            name: "review",
            path: "C:/res/skills/review/SKILL.md",
            overridePath: "C:/res/skills/review/SKILL.md",
            source: "local",
            scope: "project",
            origin: "top-level",
            settingsKey: "skills",
            enabled: true,
            description: "reviews code",
          },
        ],
      }),
    });
    render(<ExtensionsView />);

    expect(screen.getByTestId("kind-extensions")).toBeInTheDocument();
    expect(screen.getByTestId("kind-skills")).toBeInTheDocument();
    expect(screen.getByText("index.ts")).toBeInTheDocument();
    expect(screen.getByText("tool: do_thing")).toBeInTheDocument();
    expect(screen.getByText("command: foo")).toBeInTheDocument();
    expect(within(screen.getByTestId("kind-skills")).getByText("project")).toBeInTheDocument();
  });

  it("never hides a load error or a live extension error", () => {
    useAppStore.setState({
      resources: resourcesSnapshot({
        resources: [extensionResource({ error: "cannot parse extension" })],
        diagnostics: [{ type: "error", message: "broken.ts failed", path: "C:/res/broken.ts" }],
        runtimeErrors: [
          {
            extensionPath: "C:/res/foo/index.ts",
            event: "agent_end",
            error: "kaboom",
            at: 1,
          },
        ],
      }),
    });
    render(<ExtensionsView />);
    expect(screen.getByText("cannot parse extension")).toBeInTheDocument();
    expect(screen.getByText("broken.ts failed")).toBeInTheDocument();
    expect(screen.getByText("kaboom")).toBeInTheDocument();
  });

  it("disables a loaded resource through the settings array", async () => {
    const request = stubRequest(async (method, params) => {
      if (method === "settings.set") {
        const input = params as { value: string[] };
        return settingsSnapshot({ extensions: [...input.value] });
      }
      if (method === "settings.get") return settingsSnapshot();
      return resourcesSnapshot({ resources: [extensionResource()] });
    });
    useAppStore.setState({ resources: resourcesSnapshot({ resources: [extensionResource()] }) });
    render(<ExtensionsView />);

    fireEvent.click(screen.getByRole("switch", { name: /Disable index\.ts/i }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "settings.set",
          params: expect.objectContaining({
            key: "extensions",
            value: ["-C:/res/foo/index.ts"],
          }),
        }),
      ),
    );
  });

  it("shows the recommended set and detects an existing install", () => {
    useAppStore.setState({
      settings: { global: { packages: [`npm:${RECOMMENDED_PACKAGES[1]?.name}`] }, project: {} },
    });
    render(<ExtensionsView />);
    expect(screen.getByTestId("recommended-pi-office-bridge")).toBeInTheDocument();
    expect(screen.getByText("@dieulc/pi-office-bridge")).toBeInTheDocument();
    expect(screen.getByText("pinned in repo")).toBeInTheDocument();
    // The second entry is reported as installed from the packages setting.
    expect(screen.getByTestId(`recommended-${RECOMMENDED_PACKAGES[1]?.id}`)).toHaveTextContent(
      "Installed",
    );
  });

  it("links to the package gallery without installing anything", () => {
    const openExternal = vi.fn(async () => true);
    (window.pi as unknown as { openExternal: unknown }).openExternal = openExternal;
    render(<ExtensionsView />);
    fireEvent.click(screen.getByRole("button", { name: /pi\.dev\/packages/i }));
    expect(openExternal).toHaveBeenCalledWith(PACKAGE_GALLERY_URL);
  });
});
