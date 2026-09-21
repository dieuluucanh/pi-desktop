import { describe, expect, it } from "vitest";
import {
  firstOnboardingStep,
  isOnboardingComplete,
  isOnboardingStep,
  nextOnboardingStep,
  onboardingProgress,
  onboardingStepTitle,
  ONBOARDING_STEPS,
  OPTIONAL_ONBOARDING_STEPS,
  previousOnboardingStep,
  shouldSkipOnboardingStep,
  type OnboardingContext,
} from "../../src/shared/onboarding";

function context(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return { providersConfigured: false, hasProjects: false, completedAt: null, ...overrides };
}

describe("onboarding steps (plan step 26)", () => {
  it("walks the documented order", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "welcome",
      "profile",
      "provider",
      "project",
      "extensions",
      "office",
    ]);
  });

  it("validates step names", () => {
    expect(isOnboardingStep("profile")).toBe(true);
    expect(isOnboardingStep("teleport")).toBe(false);
    expect(isOnboardingStep(3)).toBe(false);
  });

  it("moves forward and backward", () => {
    expect(nextOnboardingStep("welcome")).toBe("profile");
    expect(nextOnboardingStep("office")).toBeNull();
    expect(previousOnboardingStep("welcome")).toBeNull();
    expect(previousOnboardingStep("profile")).toBe("welcome");
  });

  it("only skips steps whose goal is already met", () => {
    expect(shouldSkipOnboardingStep("provider", context({ providersConfigured: true }))).toBe(true);
    expect(shouldSkipOnboardingStep("provider", context())).toBe(false);
    expect(shouldSkipOnboardingStep("project", context({ hasProjects: true }))).toBe(true);
    // The profile choice is explicit: never skipped.
    expect(shouldSkipOnboardingStep("profile", context({ providersConfigured: true }))).toBe(false);
  });

  it("resumes at the first step that still matters", () => {
    expect(firstOnboardingStep(context())).toBe("welcome");
    expect(firstOnboardingStep(context({ providersConfigured: true }))).toBe("welcome");
    // welcome/profile are not skippable, so a returning user still sees them.
    expect(firstOnboardingStep(context({ providersConfigured: true, hasProjects: true }))).toBe(
      "welcome",
    );
  });

  it("reports a 1-based position", () => {
    expect(onboardingProgress("welcome")).toEqual({ index: 1, total: ONBOARDING_STEPS.length });
    expect(onboardingProgress("office")).toEqual({ index: 6, total: 6 });
  });

  it("gives every step a title", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(onboardingStepTitle(step).length).toBeGreaterThan(0);
    }
  });

  it("treats a completed flow as done", () => {
    expect(isOnboardingComplete({ completedAt: null })).toBe(false);
    expect(isOnboardingComplete({ completedAt: 1_700_000_000_000 })).toBe(true);
  });

  it("marks extensions and Office as the optional steps", () => {
    expect([...OPTIONAL_ONBOARDING_STEPS]).toEqual(["extensions", "office"]);
  });
});
