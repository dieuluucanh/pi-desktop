import { describe, expect, it } from "vitest";
import {
  PACKAGE_GALLERY_URL,
  RECOMMENDED_PACKAGES,
  isRecommendedInstalled,
  officeRecommendedPackage,
  packageNameOf,
} from "../../src/shared/recommended-packages";
import { PI_OFFICE_BRIDGE } from "../../src/shared/office";

/**
 * The recommended set. The list is checked in, so the exact ordered id list and
 * the one name this repo can prove — the Office bridge — are pinned here;
 * everything else is an npm source that the package manager must resolve at
 * install time.
 */

describe("recommended packages", () => {
  it("pins the Office entry to the in-repo bridge package name", () => {
    const office = officeRecommendedPackage();
    expect(office.name).toBe(PI_OFFICE_BRIDGE.packageName);
    expect(office.source).toBe(`npm:${PI_OFFICE_BRIDGE.packageName}`);
    expect(office.integration).toBe(true);
    expect(office.verifiableInRepo).toBe(true);
  });

  it("keeps every source npm-prefixed and every id unique", () => {
    const ids = RECOMMENDED_PACKAGES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of RECOMMENDED_PACKAGES) {
      expect(entry.source.startsWith("npm:")).toBe(true);
      expect(packageNameOf(entry.source)).toBe(entry.name);
    }
  });

  it("pins the exact set, in the order the UI renders", () => {
    expect(RECOMMENDED_PACKAGES.map((entry) => entry.id)).toEqual([
      "dieulc-autocompact",
      "pi-office-bridge",
      "plannotator",
      "pi-lens",
      "pi-memory",
      "pi-web-access",
    ]);
  });

  it("does not offer Workflow, which the app already ships as builtin:workflow", () => {
    // Plan step 27: a recommended npm install of the extension the app bundles
    // would be a duplicate default. The package manager below the cards still
    // installs an explicit npm/git/profile override for anyone who wants it.
    expect(RECOMMENDED_PACKAGES.map((entry) => entry.name)).not.toContain("@dieulc/workflow");
    expect(RECOMMENDED_PACKAGES.map((entry) => entry.source)).not.toContain("npm:@dieulc/workflow");
  });

  it("does not recommend packages that were dropped from the set", () => {
    const names = RECOMMENDED_PACKAGES.map((entry) => entry.name);
    expect(names).not.toContain("@dieulc/server-logs");
    expect(names).not.toContain("pi-commandcode-provider");
  });

  it("keeps every card renderable: a chip label and a description", () => {
    for (const entry of RECOMMENDED_PACKAGES) {
      expect(entry.provides.trim()).not.toBe("");
      expect(entry.provides.length).toBeLessThanOrEqual(24);
      expect(entry.description.trim()).not.toBe("");
    }
  });

  it("points gallery discovery at pi.dev without pretending to install", () => {
    expect(PACKAGE_GALLERY_URL).toBe("https://pi.dev/packages");
  });
});

describe("packageNameOf", () => {
  it("strips the npm prefix and a trailing version, keeping the scope", () => {
    expect(packageNameOf("npm:@dieulc/workflow")).toBe("@dieulc/workflow");
    expect(packageNameOf("@dieulc/workflow@0.3.0")).toBe("@dieulc/workflow");
    expect(packageNameOf("npm:foo@1.2.3")).toBe("foo");
    expect(packageNameOf("foo")).toBe("foo");
  });
});

describe("isRecommendedInstalled", () => {
  it("matches a configured package regardless of prefix or version", () => {
    const lens = RECOMMENDED_PACKAGES.find((entry) => entry.id === "pi-lens");
    if (!lens) throw new Error("fixture drift");
    expect(isRecommendedInstalled(lens, [])).toBe(false);
    expect(isRecommendedInstalled(lens, ["npm:pi-lens@0.3.0"])).toBe(true);
    expect(isRecommendedInstalled(lens, ["some-other-package"])).toBe(false);
  });
});
