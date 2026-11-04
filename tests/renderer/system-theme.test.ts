import { afterEach, describe, expect, it, vi } from "vitest";
import { systemThemeName, watchSystemTheme } from "../../src/renderer/src/themes/system-theme";

/**
 * OS light/dark resolution (2026-10-30 theme pass). The renderer reads
 * `prefers-color-scheme`; these tests pin the fallback and the listener
 * add/remove contract without an Electron runtime.
 */

const originalMatchMedia = window.matchMedia;

function stubMatchMedia(matches: boolean): {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
} {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return { addEventListener, removeEventListener };
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
});

describe("systemThemeName", () => {
  it("maps the OS preference to a built-in Pi theme name", () => {
    stubMatchMedia(true);
    expect(systemThemeName()).toBe("dark");
    stubMatchMedia(false);
    expect(systemThemeName()).toBe("light");
  });

  it("falls back to dark when matchMedia is unavailable", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    expect(systemThemeName()).toBe("dark");
  });
});

describe("watchSystemTheme", () => {
  it("subscribes and unsubscribes the same listener", () => {
    const { addEventListener, removeEventListener } = stubMatchMedia(true);
    const listener = vi.fn();

    const stop = watchSystemTheme(listener);
    expect(addEventListener).toHaveBeenCalledWith("change", listener);
    stop();
    expect(removeEventListener).toHaveBeenCalledWith("change", listener);
  });

  it("is a no-op without matchMedia", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    expect(() => watchSystemTheme(() => undefined)()).not.toThrow();
  });
});
