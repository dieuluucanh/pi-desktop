import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { appInfoFixture, installBridge } from "./fixtures";

/**
 * Onboarding store actions (plan step 26): navigation, completion persistence,
 * the profile choice and the restart contract. Completion lives in
 * `prefs.onboardingCompletedAt`, so a dismissed wizard returns next launch.
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    info: appInfoFixture(),
    onboardingStep: null,
    providers: [],
    projects: [],
    project: null,
    hint: null,
  });
});

describe("onboarding store (plan step 26)", () => {
  it("starts at the welcome step for a fresh install", () => {
    useAppStore.getState().startOnboarding();
    expect(useAppStore.getState().onboardingStep).toBe("welcome");
  });

  it("moves forward and backward through the steps", () => {
    useAppStore.getState().setOnboardingStep("profile");
    useAppStore.getState().nextOnboarding();
    expect(useAppStore.getState().onboardingStep).toBe("provider");
    useAppStore.getState().previousOnboarding();
    expect(useAppStore.getState().onboardingStep).toBe("profile");
    // The first step has no previous.
    useAppStore.getState().setOnboardingStep("welcome");
    useAppStore.getState().previousOnboarding();
    expect(useAppStore.getState().onboardingStep).toBe("welcome");
  });

  it("dismisses without completing, so the wizard returns", () => {
    useAppStore.getState().setOnboardingStep("provider");
    useAppStore.getState().dismissOnboarding();
    expect(useAppStore.getState().onboardingStep).toBeNull();
    expect(useAppStore.getState().prefs.onboardingCompletedAt).toBeNull();
  });

  it("persists completion and closes", async () => {
    useAppStore.getState().setOnboardingStep("office");
    await useAppStore.getState().completeOnboarding();
    expect(useAppStore.getState().onboardingStep).toBeNull();
    expect(useAppStore.getState().prefs.onboardingCompletedAt).toBeGreaterThan(0);
  });

  it("persists the profile choice and reports whether a restart is needed", async () => {
    const info = useAppStore.getState().info;
    await useAppStore.getState().chooseProfileMode("app");
    expect(useAppStore.getState().prefs.profileMode).toBe("app");
    // The fixture's running app reports "shared", so the change needs a restart.
    expect(info?.profileMode).toBe("shared");
    const needed = await useAppStore.getState().chooseProfileMode("shared");
    expect(needed).toBe(false);
    expect(useAppStore.getState().prefs.profileMode).toBe("shared");
  });

  it("rolls the choice back when persisting fails", async () => {
    const api = window.pi as unknown as {
      prefs: { set: (patch: Partial<typeof DEFAULT_PREFS>) => Promise<unknown> };
    };
    api.prefs.set = async () => {
      throw new Error("disk full");
    };
    await useAppStore.getState().chooseProfileMode("app");
    expect(useAppStore.getState().prefs.profileMode).toBe("shared");
    expect(useAppStore.getState().hint).toBe("disk full");
  });

  it("asks main to relaunch", async () => {
    const relaunch = vi.fn(async () => true);
    (window.pi as unknown as { relaunch: unknown }).relaunch = relaunch;
    await useAppStore.getState().relaunchApp();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
