import { describe, expect, it } from "vitest";
import {
  APP_PROFILE_DIR_NAME,
  DEFAULT_PROFILE_MODE,
  profileModeFromDocument,
  profileModeLabel,
  sanitizeProfileMode,
} from "../../src/shared/profile";

describe("profile mode (plan step 26)", () => {
  it("defaults to the shared profile", () => {
    expect(DEFAULT_PROFILE_MODE).toBe("shared");
    expect(sanitizeProfileMode(undefined)).toBe("shared");
    expect(sanitizeProfileMode("nonsense")).toBe("shared");
    expect(sanitizeProfileMode("shared")).toBe("shared");
    expect(sanitizeProfileMode("app")).toBe("app");
  });

  it("reads the persisted choice out of an app-state document", () => {
    expect(profileModeFromDocument({ prefs: { profileMode: "app" } })).toBe("app");
    expect(profileModeFromDocument({ prefs: { profileMode: "shared" } })).toBe("shared");
  });

  it("falls back to shared for a missing or malformed document", () => {
    expect(profileModeFromDocument(null)).toBe("shared");
    expect(profileModeFromDocument("nope")).toBe("shared");
    expect(profileModeFromDocument({})).toBe("shared");
    expect(profileModeFromDocument({ prefs: null })).toBe("shared");
    expect(profileModeFromDocument({ prefs: { profileMode: 7 } })).toBe("shared");
  });

  it("names the app-private directory and labels both choices", () => {
    expect(APP_PROFILE_DIR_NAME).toBe("profile");
    expect(profileModeLabel("app")).toContain("Separate");
    expect(profileModeLabel("shared")).toContain("Shared");
  });
});
