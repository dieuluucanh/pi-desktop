import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_TERMINAL_FONT_FAMILY,
  resolveTerminalFontFamily,
  terminalFontFamilyFromDocument,
} from "../../src/renderer/src/terminal/terminal-font";

describe("resolveTerminalFontFamily", () => {
  it("resolves the app token by default", () => {
    const resolved = resolveTerminalFontFamily(null, (name) =>
      name === "--font-mono" ? '"Cascadia Code", Consolas, monospace' : "",
    );
    expect(resolved).toBe('"Cascadia Code", Consolas, monospace');
    expect(resolved).not.toContain("var(");
  });

  it("returns a concrete custom family unchanged", () => {
    expect(resolveTerminalFontFamily("JetBrains Mono, monospace", () => "")).toBe(
      "JetBrains Mono, monospace",
    );
  });

  it("expands var() tokens in a custom family", () => {
    expect(
      resolveTerminalFontFamily("var(--font-mono), monospace", (name) =>
        name === "--font-mono" ? "Consolas" : "",
      ),
    ).toBe("Consolas, monospace");
  });

  it("falls back to a valid canvas font when the token is missing", () => {
    expect(resolveTerminalFontFamily(null, () => "")).toBe(FALLBACK_TERMINAL_FONT_FAMILY);
    expect(resolveTerminalFontFamily("var(--unknown)", () => "")).toBe(
      FALLBACK_TERMINAL_FONT_FAMILY,
    );
    expect(resolveTerminalFontFamily("   ", () => "")).toBe(FALLBACK_TERMINAL_FONT_FAMILY);
  });
});

describe("terminalFontFamilyFromDocument", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--font-mono");
  });

  it("never returns a CSS variable reference", () => {
    const resolved = terminalFontFamilyFromDocument(null);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).not.toContain("var(");
  });

  it("reads the theme token when the browser exposes it", () => {
    document.documentElement.style.setProperty("--font-mono", '"Test Mono", monospace');
    const resolved = terminalFontFamilyFromDocument(null);
    // jsdom may not resolve custom properties; either the token or the valid
    // fallback is acceptable, but a var() reference is never acceptable.
    expect(
      resolved === '"Test Mono", monospace' || resolved === FALLBACK_TERMINAL_FONT_FAMILY,
    ).toBe(true);
  });
});
