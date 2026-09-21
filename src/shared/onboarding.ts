/**
 * The first-run onboarding flow (plan step 26).
 *
 * A fresh install walks through: what the app is → which Pi profile to use →
 * sign in to a provider → open or create a project → optionally install the
 * recommended extensions → optionally set up Pi for Office → first session.
 *
 * The steps are a pure list so the wizard's navigation, the skip rules and the
 * "is this install set up already" answer can be unit-tested without a DOM.
 * Completion is an app preference (`prefs.onboardingCompletedAt`); nothing here
 * touches Pi state.
 */

export const ONBOARDING_STEPS = [
  "welcome",
  "profile",
  "provider",
  "project",
  "extensions",
  "office",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The steps a user may skip: both optional integrations, and anything already done. */
export const OPTIONAL_ONBOARDING_STEPS: readonly OnboardingStep[] = ["extensions", "office"];

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

export function nextOnboardingStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  if (index < 0 || index >= ONBOARDING_STEPS.length - 1) return null;
  return ONBOARDING_STEPS[index + 1] ?? null;
}

export function previousOnboardingStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  if (index <= 0) return null;
  return ONBOARDING_STEPS[index - 1] ?? null;
}

export interface OnboardingContext {
  /** At least one provider has a credential or an env var available. */
  providersConfigured: boolean;
  /** The app already remembers a project. */
  hasProjects: boolean;
  /** The complete/incomplete flag, from `prefs.onboardingCompletedAt`. */
  completedAt: number | null;
}

/** Whether the whole flow is already done (or was skipped). */
export function isOnboardingComplete(context: Pick<OnboardingContext, "completedAt">): boolean {
  return context.completedAt !== null;
}

/**
 * Skip a step whose goal is already met: signing in is pointless when a provider
 * works, and opening a project is pointless when one is already remembered.
 * Deliberately never skips `profile` — the choice is explicit.
 */
export function shouldSkipOnboardingStep(
  step: OnboardingStep,
  context: OnboardingContext,
): boolean {
  if (step === "provider") return context.providersConfigured;
  if (step === "project") return context.hasProjects;
  return false;
}

/**
 * The step the wizard should show when it opens, considering what is already
 * true: a returning user who signed in but never finished onboarding resumes at
 * the project step rather than the welcome screen.
 */
export function firstOnboardingStep(context: OnboardingContext): OnboardingStep {
  for (const step of ONBOARDING_STEPS) {
    if (!shouldSkipOnboardingStep(step, context)) return step;
  }
  return ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1] as OnboardingStep;
}

/** 1-based position and total, for the wizard's "Step n of m" label. */
export function onboardingProgress(step: OnboardingStep): { index: number; total: number } {
  return { index: ONBOARDING_STEPS.indexOf(step) + 1, total: ONBOARDING_STEPS.length };
}

/** Human-readable title for each step (the wizard's heading). */
export function onboardingStepTitle(step: OnboardingStep): string {
  switch (step) {
    case "welcome":
      return "Welcome to Pi Desktop";
    case "profile":
      return "Choose a Pi profile";
    case "provider":
      return "Connect a provider";
    case "project":
      return "Open a project";
    case "extensions":
      return "Recommended extensions";
    case "office":
      return "Pi for Office (optional)";
  }
}
