import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingWizard } from "../../src/renderer/src/onboarding/OnboardingWizard";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ProviderSummary } from "../../src/shared/providers";
import { installBridge } from "./fixtures";

/**
 * The onboarding wizard (plan step 26): each step is reachable, the profile
 * choice persists and offers a restart, and skipping or finishing records the
 * completion flag so the wizard does not return.
 */

function provider(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: "anthropic",
    label: "Anthropic",
    authTypes: ["api_key"],
    configured: false,
    subscription: false,
    modelCount: 3,
    envVars: [],
    envAvailable: false,
    ...overrides,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    onboardingStep: "welcome",
    providers: [],
    providersLoaded: true,
    projects: [],
    project: null,
    hint: null,
  });
});

describe("OnboardingWizard (plan step 26)", () => {
  it("renders nothing when closed", () => {
    useAppStore.setState({ onboardingStep: null });
    const { container } = render(<OnboardingWizard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts at welcome and advances to the profile step", async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(screen.getByText("Welcome to Pi Desktop")).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 6")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Choose a Pi profile")).toBeInTheDocument();
    expect(useAppStore.getState().onboardingStep).toBe("profile");
  });

  it("persists the app-private profile choice and offers a restart", async () => {
    useAppStore.setState({ onboardingStep: "profile" });
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByTestId("profile-choice-app"));

    expect(useAppStore.getState().prefs.profileMode).toBe("app");
    expect(screen.getByTestId("onboarding-restart")).toBeInTheDocument();
  });

  it("marks the flow done when the user skips setup", async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByRole("button", { name: "Skip setup" }));

    expect(useAppStore.getState().onboardingStep).toBeNull();
    expect(useAppStore.getState().prefs.onboardingCompletedAt).toBeGreaterThan(0);
  });

  it("lists providers with an actionable sign-in at the provider step", () => {
    useAppStore.setState({
      onboardingStep: "provider",
      providers: [provider({ authTypes: ["oauth"] })],
    });
    render(<OnboardingWizard />);

    expect(screen.getByTestId("onboarding-providers")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows what is already connected", () => {
    useAppStore.setState({
      onboardingStep: "provider",
      providers: [provider({ configured: true })],
    });
    render(<OnboardingWizard />);
    // A configured provider no longer offers a sign-in button.
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("completes and starts a session from the last step", async () => {
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (window.pi as unknown as { sessions: { create: unknown } }).sessions.create = create;
    useAppStore.setState({ onboardingStep: "office", project: { path: "C:/work", name: "work" } });
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    await user.click(screen.getByTestId("onboarding-start-session"));

    expect(useAppStore.getState().prefs.onboardingCompletedAt).toBeGreaterThan(0);
    expect(useAppStore.getState().onboardingStep).toBeNull();
  });
});
