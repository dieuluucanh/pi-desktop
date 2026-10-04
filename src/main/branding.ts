/**
 * Where the brand icons live, and the app's own identity strings (plan step 28).
 *
 * Electron-free on purpose (AGENTS.md rule 1): the resolution is pure arithmetic
 * over injected facts, so it is unit tested without an Electron runtime and the
 * Electron call sites in `src/main/index.ts` stay the only place that touches
 * `app`, `nativeImage` or `dock`.
 *
 * The two consumers are the app window's icon and, off Windows, the about panel;
 * `docs/guide/branding.md` describes what each file is for.
 */

import { join } from "node:path";

/**
 * The app's own name — used for the diagnostics payload, the Office setup
 * app-info block and the application-menu label.
 *
 * It is passed explicitly rather than read from `app.getName()` because dev runs
 * report the package name (`pi-desktop`) while a packaged build reports
 * `productName` from `electron-builder.yml`, and the two should agree. `app.setName`
 * is deliberately *not* called: `app.getPath("userData")` is resolved at module
 * scope in `index.ts`, so renaming the app there would relocate every dev profile.
 */
export const APP_NAME = "Pi Desktop";

/**
 * The Windows AppUserModelID. Matches `appId` in `electron-builder.yml`, so
 * taskbar grouping and future toasts behave the same in dev and packaged builds.
 *
 * This is the one value in this module that is *not* free to change: it is
 * pinned by `tests/main/branding.test.ts` because changing it in one place only
 * silently splits the app's taskbar identity in two.
 */
export const APP_USER_MODEL_ID = "dev.pi.desktop";

/**
 * The about panel's copyright line. Kept here rather than inline at the call
 * site so it sits next to the other identity strings; it is deliberately the
 * same wording as `copyright` in `electron-builder.yml`, which is what the
 * packaged executable's file properties show.
 */
export const APP_COPYRIGHT = "Copyright (c) 2026 Pi Desktop contributors";

export interface BrandingFacts {
  isPackaged: boolean;
  /** `process.resourcesPath` (or `AppRoots.resourcesDir`, which equals it). */
  resourcesPath: string;
  /** The repository root in development; unused when packaged. */
  appRoot: string;
}

export interface BrandingPaths {
  /** The directory holding the icons, for diagnostics and tests. */
  dir: string;
  /** Windows window/installer icon. */
  ico: string;
  /** macOS dock icon, and the about-panel icon off macOS. */
  png512: string;
}

/**
 * Packaged builds read `resources/branding/` — what `extraResources` in
 * `electron-builder.yml` copies, deliberately outside the asar so a path works.
 * Development reads `assets/` straight from the repository, which is why the
 * icons appear in the dev window without a build step.
 */
export function resolveBranding(facts: BrandingFacts): BrandingPaths {
  const dir = facts.isPackaged
    ? join(facts.resourcesPath, "branding")
    : join(facts.appRoot, "assets");

  return { dir, ico: join(dir, "icon.ico"), png512: join(dir, "icon-512.png") };
}
