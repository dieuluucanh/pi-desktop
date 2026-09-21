import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PROFILE_ENV,
  SAFE_MODE_ENV,
  SAFE_MODE_FLAG,
  appPaths,
  isSafeMode,
  resolveAppPaths,
  resolveAppRoots,
} from "../../src/main/paths";

vi.mock("electron", () => ({
  app: { getPath: (): string => join("C:", "user-data") },
}));

describe("resolveAppPaths", () => {
  it("puts app state under userData and the profile under the home directory", () => {
    const paths = resolveAppPaths({
      userDataDir: join("C:", "user-data"),
      homeDir: join("C:", "Users", "tester"),
      env: {},
    });

    expect(paths.userData).toBe(join("C:", "user-data"));
    expect(paths.appStateFile).toBe(join("C:", "user-data", "app-state.json"));
    expect(paths.logs).toBe(join("C:", "user-data", "logs"));
    expect(paths.blobCache).toBe(join("C:", "user-data", "blob-cache"));
    expect(paths.profileDir).toBe(join("C:", "Users", "tester", ".pi", "agent"));
  });

  it(`honours ${PROFILE_ENV} so a separate profile can be used`, () => {
    const paths = resolveAppPaths({
      userDataDir: join("C:", "user-data"),
      homeDir: join("C:", "Users", "tester"),
      env: { [PROFILE_ENV]: join("D:", "profiles", "work") },
    });

    expect(paths.profileDir).toBe(join("D:", "profiles", "work"));
  });

  it("ignores a blank or whitespace-only override", () => {
    const paths = resolveAppPaths({
      userDataDir: join("C:", "user-data"),
      homeDir: join("C:", "Users", "tester"),
      env: { [PROFILE_ENV]: "   " },
    });

    expect(paths.profileDir).toBe(join("C:", "Users", "tester", ".pi", "agent"));
  });

  it("defaults to the shared profile mode", () => {
    const paths = resolveAppPaths({
      userDataDir: join("C:", "user-data"),
      homeDir: join("C:", "Users", "tester"),
      env: {},
    });
    expect(paths.profileMode).toBe("shared");
  });

  it("uses an app-private profile under userData when the mode says so (plan step 26)", () => {
    const paths = resolveAppPaths({
      userDataDir: join("C:", "user-data"),
      homeDir: join("C:", "Users", "tester"),
      env: {},
      profileMode: "app",
    });
    expect(paths.profileDir).toBe(join("C:", "user-data", "profile"));
    expect(paths.profileMode).toBe("app");
  });

  it(`still lets ${PROFILE_ENV} pin the directory over the mode`, () => {
    const paths = resolveAppPaths({
      userDataDir: join("C:", "user-data"),
      homeDir: join("C:", "Users", "tester"),
      env: { [PROFILE_ENV]: join("D:", "profiles", "work") },
      profileMode: "app",
    });
    expect(paths.profileDir).toBe(join("D:", "profiles", "work"));
    // The stored choice is still reported, so Diagnostics can explain it.
    expect(paths.profileMode).toBe("app");
  });

  it("resolves the Electron-bound wrapper through app.getPath", () => {
    expect(appPaths().userData).toBe(join("C:", "user-data"));
  });
});

describe("resolveAppRoots", () => {
  it("resolves the repository root in development", () => {
    const roots = resolveAppRoots({
      isPackaged: false,
      resourcesPath: join("D:", "unused"),
      mainDir: join("C:", "repo", "out", "main"),
    });

    expect(roots.appRoot).toBe(join("C:", "repo"));
    expect(roots.resourcesDir).toBe(join("C:", "repo", "resources"));
    expect(roots.runtimeDir).toBe(join("C:", "repo", "resources", "runtime"));
    expect(roots.manifestPath).toBe(join("C:", "repo", "resources", "office", "manifest.prod.xml"));
  });

  it("resolves the resources directory when packaged", () => {
    const resources = join("C:", "Program Files", "Pi Desktop", "resources");
    const roots = resolveAppRoots({
      isPackaged: true,
      resourcesPath: resources,
      mainDir: "ignored",
    });

    expect(roots.appRoot).toBe(resources);
    expect(roots.runtimeDir).toBe(join(resources, "runtime"));
    expect(roots.manifestPath).toBe(join(resources, "office", "manifest.prod.xml"));
  });
});

describe("isSafeMode", () => {
  it("is off by default", () => {
    expect(isSafeMode([], {})).toBe(false);
  });

  it(`turns on with ${SAFE_MODE_FLAG}`, () => {
    expect(isSafeMode(["pi-desktop", SAFE_MODE_FLAG], {})).toBe(true);
  });

  it(`turns on with ${SAFE_MODE_ENV}=1`, () => {
    expect(isSafeMode([], { [SAFE_MODE_ENV]: "1" })).toBe(true);
    expect(isSafeMode([], { [SAFE_MODE_ENV]: "0" })).toBe(false);
  });
});
