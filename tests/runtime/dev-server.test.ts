import { describe, expect, it } from "vitest";
import {
  COMMON_PROJECT_DEV_PORTS,
  DEFAULT_RENDERER_DEV_PORT,
  RENDERER_DEV_HOST,
  RENDERER_DEV_PORT_ENV,
  isCommonProjectDevPort,
  rendererDevServer,
  rendererDevUrl,
  resolveRendererDevPort,
} from "../../src/main/runtime/dev-server";

/**
 * The renderer dev-server policy (2026-11-05 port-collision plan).
 *
 * The regression this pins: Pi Desktop served its renderer on Vite's default
 * `localhost:5173`, so a project Vite that also defaults to 5173 either fell
 * back to 5174 or bound the other loopback family — and opening 5173 showed
 * Pi Desktop in a browser, without a preload bridge.
 */

describe("renderer dev port default", () => {
  it("uses a dedicated port, never Vite's 5173", () => {
    expect(DEFAULT_RENDERER_DEV_PORT).toBe(5273);
    expect(DEFAULT_RENDERER_DEV_PORT).not.toBe(5173);
    expect(resolveRendererDevPort({})).toBe(5273);
  });

  it("keeps the default outside the ports project dev servers take", () => {
    expect(COMMON_PROJECT_DEV_PORTS).toContain(5173);
    expect(isCommonProjectDevPort(DEFAULT_RENDERER_DEV_PORT)).toBe(false);
  });

  it("treats an unset or blank override as the default", () => {
    expect(resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: "" })).toBe(DEFAULT_RENDERER_DEV_PORT);
    expect(resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: "   " })).toBe(
      DEFAULT_RENDERER_DEV_PORT,
    );
  });
});

describe("renderer dev port override", () => {
  it("accepts an integer in range and trims it", () => {
    expect(resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: "6000" })).toBe(6000);
    expect(resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: " 6000 " })).toBe(6000);
    expect(resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: "1024" })).toBe(1024);
    expect(resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: "65535" })).toBe(65535);
  });

  it("rejects anything that is not a usable TCP port", () => {
    for (const value of ["abc", "0", "1023", "65536", "5173.5", "-1", "0x1499"]) {
      expect(() => resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: value }), value).toThrow(
        RENDERER_DEV_PORT_ENV,
      );
    }
  });

  it("names the override in the error so a typo is actionable", () => {
    expect(() => resolveRendererDevPort({ [RENDERER_DEV_PORT_ENV]: "nope" })).toThrow(
      /PI_DESKTOP_RENDERER_PORT must be an integer between 1024 and 65535 \(got "nope"\)/,
    );
  });
});

describe("renderer dev server options", () => {
  it("binds one explicit loopback family", () => {
    expect(RENDERER_DEV_HOST).toBe("127.0.0.1");
  });

  it("never lets Vite fall back to another port", () => {
    // electron-vite derives ELECTRON_RENDERER_URL from the configured port, so a
    // fallback would load whichever server owns that port instead of this one.
    expect(rendererDevServer({})).toEqual({
      host: "127.0.0.1",
      port: 5273,
      strictPort: true,
    });
  });

  it("carries the override into the server options and the URL", () => {
    const env = { [RENDERER_DEV_PORT_ENV]: "6000" };
    expect(rendererDevServer(env)).toEqual({ host: "127.0.0.1", port: 6000, strictPort: true });
    expect(rendererDevUrl(env)).toBe("http://127.0.0.1:6000");
    expect(rendererDevUrl({})).toBe("http://127.0.0.1:5273");
  });
});

describe("common project dev ports", () => {
  it("recognises the Vite default and its fallback family", () => {
    for (const port of [5173, 5174, 5178, 3000, 4321, 4173]) {
      expect(isCommonProjectDevPort(port), String(port)).toBe(true);
    }
    expect(isCommonProjectDevPort(5273)).toBe(false);
  });
});
