import { describe, expect, it } from "vitest";

import {
  CSP_PLACEHOLDER,
  DEV_RENDERER_CSP,
  EXTERNAL_PROTOCOLS,
  RENDERER_CSP,
  SECURE_WEB_PREFERENCES,
  WEB_TAB_PARTITION,
  isAllowedExternalUrl,
  rendererCspFor,
  rendererWebPreferences,
  rendererWindowOptions,
  sanitizeExternalUrl,
  webTabWebPreferences,
} from "../../src/main/security";

/**
 * The renderer's security posture (plan step 23).
 *
 * These assertions read the values the Electron call sites actually use, so
 * dropping `sandbox`, adding `nodeIntegration`, loosening the CSP or giving a
 * web tab a preload is a failing test rather than a code-review note.
 */

describe("renderer CSP", () => {
  it("denies by default and closes the plugin/framing families", () => {
    expect(RENDERER_CSP).toContain("default-src 'none'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).toContain("base-uri 'none'");
    expect(RENDERER_CSP).toContain("form-action 'none'");
    expect(RENDERER_CSP).toContain("frame-ancestors 'none'");
  });

  it("never allows inline or eval script in production", () => {
    const scriptSrc = RENDERER_CSP.split("; ").find((part) => part.startsWith("script-src"));
    expect(scriptSrc).toBe("script-src 'self'");
    expect(RENDERER_CSP).not.toContain("'unsafe-eval'");
    // `style-src` may allow inline (Radix/Tailwind set style attributes); script
    // may not, which is the one that would make an XSS reachable.
    const styleSrc = RENDERER_CSP.split("; ").find((part) => part.startsWith("style-src"));
    expect(styleSrc).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("is a strict subset of the development policy", () => {
    expect(DEV_RENDERER_CSP).toContain("'unsafe-inline'");
    expect(DEV_RENDERER_CSP).toContain("connect-src 'self' ws: wss:");
    expect(rendererCspFor(false)).toBe(RENDERER_CSP);
    expect(rendererCspFor(true)).toBe(DEV_RENDERER_CSP);
    // Every production directive survives into dev; dev only adds capabilities.
    for (const directive of RENDERER_CSP.split("; ")) {
      if (directive.startsWith("script-src") || directive.startsWith("connect-src")) continue;
      expect(DEV_RENDERER_CSP).toContain(directive);
    }
  });

  it("exposes the placeholder the build plugin replaces", () => {
    expect(CSP_PLACEHOLDER.length).toBeGreaterThan(0);
    expect(RENDERER_CSP).not.toContain(CSP_PLACEHOLDER);
  });
});

describe("app window preferences", () => {
  it("is isolated, sandboxed and free of Node integration", () => {
    const options = rendererWindowOptions("/app/preload/index.cjs");
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    });
    expect(options.webPreferences.preload).toBe("/app/preload/index.cjs");
  });

  it("does not mutate the shared secure base", () => {
    rendererWebPreferences("/somewhere/preload.cjs");
    expect(SECURE_WEB_PREFERENCES).not.toHaveProperty("preload");
    expect(SECURE_WEB_PREFERENCES).not.toHaveProperty("partition");
  });

  it("keeps the window chrome options stable", () => {
    const options = rendererWindowOptions("/p.cjs");
    expect(options).toMatchObject({
      width: 1280,
      height: 860,
      show: false,
      autoHideMenuBar: true,
    });
  });
});

describe("web tab preferences", () => {
  it("shares one partition and carries no preload", () => {
    const prefs = webTabWebPreferences();
    expect(prefs.partition).toBe(WEB_TAB_PARTITION);
    expect(prefs).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    });
    // The absence of a preload is what keeps `window.pi` out of a web tab.
    expect(prefs.preload).toBeUndefined();
  });
});

describe("external URL policy", () => {
  it("allows only http, https and mailto", () => {
    expect([...EXTERNAL_PROTOCOLS].sort()).toEqual(["http:", "https:", "mailto:"]);
    expect(sanitizeExternalUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(sanitizeExternalUrl("mailto:hi@example.com")).toContain("mailto:");
  });

  it("refuses script-bearing, local and malformed schemes", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///C:/Windows/System32/calc.exe",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "",
      null,
      42,
      "not a url",
    ]) {
      expect(isAllowedExternalUrl(value)).toBe(false);
      expect(sanitizeExternalUrl(value)).toBeNull();
    }
  });
});
