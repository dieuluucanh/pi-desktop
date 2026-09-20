import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeView } from "../../src/renderer/src/views/WelcomeView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";
import type { ProviderSummary } from "../../src/shared/providers";

/**
 * The first-run sign-in prompt (plan step 9, slice 4): the welcome view is where
 * a user with no project lands, so it also says when no provider is connected
 * and routes to Connections.
 */

function provider(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: "anthropic",
    label: "Anthropic",
    authTypes: ["api_key"],
    subscription: false,
    configured: false,
    modelCount: 3,
    envVars: [],
    envAvailable: false,
    ...overrides,
  };
}

function stubRequest(providers: ProviderSummary[]) {
  const request = vi.fn(async () => ({ providers }));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    providers: [],
    providersLoaded: false,
    providersError: null,
    view: "welcome",
    hint: null,
  });
});

describe("WelcomeView sign-in prompt", () => {
  it("shows the prompt when no provider is configured", async () => {
    stubRequest([provider()]);
    render(<WelcomeView />);
    await waitFor(() => expect(screen.getByTestId("welcome-signin")).toBeInTheDocument());
  });

  it("hides the prompt once a provider is configured", async () => {
    stubRequest([provider({ configured: true, source: "stored" })]);
    render(<WelcomeView />);
    await waitFor(() => expect(useAppStore.getState().providersLoaded).toBe(true));
    expect(screen.queryByTestId("welcome-signin")).not.toBeInTheDocument();
  });

  it("routes to Connections", async () => {
    stubRequest([provider()]);
    render(<WelcomeView />);
    await waitFor(() => expect(screen.getByTestId("welcome-signin")).toBeInTheDocument());
    screen.getByRole("button", { name: /Open Connections/ }).click();
    expect(useAppStore.getState().view).toBe("connections");
  });
});
