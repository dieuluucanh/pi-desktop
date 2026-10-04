import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_COPYRIGHT,
  APP_NAME,
  APP_USER_MODEL_ID,
  resolveBranding,
} from "../../src/main/branding";

/**
 * Branding resolution (plan step 28).
 *
 * Two things can break silently here: the packaged directory drifting away from
 * what `extraResources` copies in `electron-builder.yml` (the app then launches
 * with no icon and no error), and the identity constants drifting from the
 * metadata the packaged build actually carries.
 *
 * The constants are checked *against* that config rather than against repeated
 * literals, so the test fails when the two disagree instead of when someone
 * changes both.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const builderYaml = readFileSync(join(repoRoot, "electron-builder.yml"), "utf8");

describe("resolveBranding", () => {
  it("reads the repository's assets in development", () => {
    // Dev has no resources directory: the icons are the ones checked into the
    // repo, which is why `npm run dev` shows a branded window without a build.
    const branding = resolveBranding({
      isPackaged: false,
      resourcesPath: "/unused/resources",
      appRoot: "/repo",
    });

    // Built with `join` so the expectation is the same shape the module uses on
    // every platform (`/repo/assets` on CI's macOS and Linux runners).
    expect(branding.dir).toBe(join("/repo", "assets"));
    expect(branding.ico).toBe(join("/repo", "assets", "icon.ico"));
    expect(branding.png512).toBe(join("/repo", "assets", "icon-512.png"));
  });

  it("reads resources/branding once packaged", () => {
    // "branding" is not decoration: it is the `to:` of the extraResources entry
    // that copies these two files outside the asar.
    const branding = resolveBranding({
      isPackaged: true,
      resourcesPath: "/app/resources",
      appRoot: "/unused/repo",
    });

    expect(branding.dir).toBe(join("/app/resources", "branding"));
    expect(branding.ico).toBe(join("/app/resources", "branding", "icon.ico"));
    expect(branding.png512).toBe(join("/app/resources", "branding", "icon-512.png"));
  });

  it("ignores the app root when packaged, so a stray checkout cannot win", () => {
    const packaged = resolveBranding({
      isPackaged: true,
      resourcesPath: join("/app", "resources"),
      appRoot: join("/somewhere", "checkout"),
    });
    expect(packaged.dir).not.toContain("checkout");
    expect(packaged.dir).toContain("resources");
  });
});

describe("app identity constants", () => {
  it("agrees with electron-builder's productName", () => {
    // The packaged build reports `productName`; dev would otherwise report
    // `pi-desktop` from package.json. `APP_NAME` is what makes the two agree.
    expect(builderYaml).toContain(`productName: ${APP_NAME}`);
  });

  it("agrees with electron-builder's appId, which owns the taskbar identity", () => {
    // Changing this in one place only splits the app's Windows identity in two.
    expect(builderYaml).toContain(`appId: ${APP_USER_MODEL_ID}`);
  });

  it("agrees with electron-builder's copyright, shown in the file properties", () => {
    expect(builderYaml).toContain(`copyright: ${APP_COPYRIGHT}`);
  });

  it("names the app the way the window title does", () => {
    // `rendererWindowOptions` hard-codes this title; the two must not drift.
    const security = readFileSync(join(repoRoot, "src", "main", "security.ts"), "utf8");
    expect(security).toContain(`title: "${APP_NAME}"`);
  });
});
