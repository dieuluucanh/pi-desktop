/**
 * Which Pi profile the app uses (plan D‑A8, step 26 onboarding).
 *
 * The default is the **shared** profile (`~/.pi/agent`), so the desktop app and
 * terminal Pi are interchangeable. Onboarding also offers an **app-private**
 * profile for users who want the GUI's sessions and configuration kept apart;
 * it lives under the app's own `userData`, never inside the shared profile.
 *
 * The choice is resolved by the main process before any host spawns, because a
 * host's cwd/profile is fixed at spawn. Changing it therefore needs a restart,
 * which the onboarding wizard offers.
 */

export type ProfileMode = "shared" | "app";

export const DEFAULT_PROFILE_MODE: ProfileMode = "shared";

/** Directory name of the app-private profile, under Electron's `userData`. */
export const APP_PROFILE_DIR_NAME = "profile";

export function sanitizeProfileMode(value: unknown): ProfileMode {
  return value === "app" ? "app" : "shared";
}

/** Reads the persisted choice out of an app-state document (bootstrap read). */
export function profileModeFromDocument(doc: unknown): ProfileMode {
  if (!doc || typeof doc !== "object") return DEFAULT_PROFILE_MODE;
  const prefs = (doc as { prefs?: unknown }).prefs;
  if (!prefs || typeof prefs !== "object") return DEFAULT_PROFILE_MODE;
  return sanitizeProfileMode((prefs as { profileMode?: unknown }).profileMode);
}

/** A short label for the choice, used by onboarding and Diagnostics. */
export function profileModeLabel(mode: ProfileMode): string {
  return mode === "app" ? "Separate profile for Pi Desktop" : "Shared profile with terminal Pi";
}
