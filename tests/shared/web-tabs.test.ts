import { describe, expect, it } from "vitest";
import {
  emptyWebTabState,
  firstLoopbackUrl,
  isLoopbackHost,
  isLoopbackUrl,
  loopbackUrlsIn,
  parseReviewDecision,
  parseWebCommand,
  parseWebUrl,
  sanitizeWebNavigationDecision,
  sanitizeWebTabBounds,
  sanitizeWebNavigationRequest,
  sanitizeWebTabState,
  sanitizeWebUrl,
  webTabTitle,
  WEB_TAB_MAX_ZOOM,
  WEB_TAB_MIN_ZOOM,
} from "../../src/shared/web-tabs";

/**
 * The web-tab wire model (plan step 21): the URL policy is the security
 * boundary (only http/https, and only loopback loads without a prompt), and the
 * sanitizers are what keep a malformed push from reaching the chrome.
 */

describe("web URL policy", () => {
  it("accepts only http(s) URLs", () => {
    expect(sanitizeWebUrl("http://127.0.0.1:19432/review")).toBe("http://127.0.0.1:19432/review");
    expect(sanitizeWebUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(sanitizeWebUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeWebUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeWebUrl("data:text/html,<h1>x")).toBeNull();
    expect(sanitizeWebUrl("not a url")).toBeNull();
    expect(sanitizeWebUrl(42)).toBeNull();
  });

  it("recognises loopback hosts in every spelling", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.10.20.30")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
  });

  it("classifies URLs by their host", () => {
    expect(isLoopbackUrl("http://localhost:3000/")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:19432")).toBe(true);
    expect(isLoopbackUrl("http://example.com:19432")).toBe(false);
    expect(isLoopbackUrl("file:///tmp/x")).toBe(false);
  });

  it("derives a host-based title", () => {
    expect(webTabTitle("http://127.0.0.1:19432/review/abc")).toBe("127.0.0.1:19432");
    expect(webTabTitle("https://example.com")).toBe("example.com");
    expect(webTabTitle("nonsense")).toBe("Web");
  });
});

describe("loopbackUrlsIn", () => {
  it("extracts Plannotator-style URLs from prose and tool output", () => {
    const text = [
      "Review ready at http://127.0.0.1:19432/review/abc-123 — approve when done.",
      "Also try http://localhost:5173/app?x=1).",
    ].join("\n");
    expect(loopbackUrlsIn(text)).toEqual([
      "http://127.0.0.1:19432/review/abc-123",
      "http://localhost:5173/app?x=1",
    ]);
  });

  it("ignores non-loopback and unsupported URLs", () => {
    expect(loopbackUrlsIn("see https://example.com/x and file:///tmp/y")).toEqual([]);
    expect(loopbackUrlsIn("")).toEqual([]);
    expect(loopbackUrlsIn(null)).toEqual([]);
  });

  it("dedupes and finds the first", () => {
    const text = "http://localhost:1/a http://localhost:1/a http://127.0.0.1:2/b";
    expect(loopbackUrlsIn(text)).toEqual(["http://localhost:1/a", "http://127.0.0.1:2/b"]);
    expect(firstLoopbackUrl(text)).toBe("http://localhost:1/a");
  });

  it("strips trailing punctuation a sentence attaches", () => {
    expect(loopbackUrlsIn("open http://localhost:19432/review.")).toEqual([
      "http://localhost:19432/review",
    ]);
  });
});

describe("sanitizeWebTabState", () => {
  it("creates an empty state from a URL", () => {
    expect(emptyWebTabState("tab-1", "http://localhost:19432/", "session-9")).toEqual({
      tabId: "tab-1",
      url: "http://localhost:19432/",
      title: "localhost:19432",
      favicon: null,
      status: "loading",
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
      error: null,
      sessionTabId: "session-9",
      loadedAt: null,
    });
  });

  it("rejects a snapshot without a tab id or a permitted URL", () => {
    expect(sanitizeWebTabState({ url: "http://localhost:1" })).toBeNull();
    expect(sanitizeWebTabState({ tabId: "t", url: "file:///x" })).toBeNull();
  });

  it("bounds zoom and defaults unknown fields", () => {
    const state = sanitizeWebTabState({
      tabId: "t",
      url: "http://localhost:1",
      zoom: 99,
      status: "nonsense",
      canGoBack: "yes",
    });
    expect(state?.zoom).toBe(WEB_TAB_MAX_ZOOM);
    expect(state?.status).toBe("loading");
    expect(state?.canGoBack).toBe(false);
    expect(sanitizeWebTabState({ tabId: "t", url: "http://localhost:1", zoom: 0.01 })?.zoom).toBe(
      WEB_TAB_MIN_ZOOM,
    );
  });
});

describe("parseWebCommand", () => {
  it("accepts the chrome commands", () => {
    expect(parseWebCommand({ command: "back" })).toEqual({ command: "back" });
    expect(parseWebCommand({ command: "reload" })).toEqual({ command: "reload" });
    expect(parseWebCommand({ command: "zoom", factor: 1.5 })).toEqual({
      command: "zoom",
      factor: 1.5,
    });
    expect(parseWebCommand({ command: "navigate", url: "http://localhost:2/" })).toEqual({
      command: "navigate",
      url: "http://localhost:2/",
    });
  });

  it("drops unknown commands and unsafe navigations", () => {
    expect(parseWebCommand({ command: "eval", script: "x" })).toBeNull();
    expect(parseWebCommand({ command: "navigate", url: "javascript:alert(1)" })).toBeNull();
    expect(parseWebCommand({ command: "zoom", factor: "big" })).toBeNull();
    expect(parseWebCommand(null)).toBeNull();
  });

  it("clamps zoom into range", () => {
    expect(parseWebCommand({ command: "zoom", factor: 100 })).toEqual({
      command: "zoom",
      factor: WEB_TAB_MAX_ZOOM,
    });
    expect(parseWebCommand({ command: "zoom", factor: 0 })).toEqual({
      command: "zoom",
      factor: WEB_TAB_MIN_ZOOM,
    });
  });
});

describe("sanitizeWebTabBounds", () => {
  it("rounds a rectangle and defaults visibility to true", () => {
    expect(sanitizeWebTabBounds({ x: 1.4, y: 2.6, width: 300.2, height: 400.9 })).toEqual({
      x: 1,
      y: 3,
      width: 300,
      height: 401,
      visible: true,
    });
    expect(sanitizeWebTabBounds({ x: 0, y: 0, width: 10, height: 10, visible: false })).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      visible: false,
    });
  });

  it("rejects a malformed rectangle", () => {
    expect(sanitizeWebTabBounds({ x: 0, y: 0, width: "10", height: 10 })).toBeNull();
    expect(sanitizeWebTabBounds(null)).toBeNull();
  });
});

describe("sanitizeWebNavigationRequest", () => {
  it("keeps the request and defaults its disposition", () => {
    expect(
      sanitizeWebNavigationRequest({
        tabId: "t",
        url: "https://example.com/x",
        disposition: "new-window",
        at: 5,
      }),
    ).toEqual({ tabId: "t", url: "https://example.com/x", disposition: "new-window", at: 5 });
    expect(
      sanitizeWebNavigationRequest({ tabId: "t", url: "https://example.com/x" })?.disposition,
    ).toBe("link");
  });

  it("refuses a request with no tab or an unsafe URL", () => {
    expect(sanitizeWebNavigationRequest({ url: "https://example.com" })).toBeNull();
    expect(sanitizeWebNavigationRequest({ tabId: "t", url: "file:///x" })).toBeNull();
  });
});

describe("sanitizeWebNavigationDecision", () => {
  it("keeps a permitted answer", () => {
    expect(
      sanitizeWebNavigationDecision({
        tabId: "w1",
        url: "https://example.com/x",
        action: "new-tab",
        sessionTabId: "s1",
      }),
    ).toEqual({
      tabId: "w1",
      url: "https://example.com/x",
      action: "new-tab",
      sessionTabId: "s1",
    });
    expect(
      sanitizeWebNavigationDecision({ tabId: "w1", url: "https://x.com", action: "dismiss" }),
    ).toMatchObject({ action: "dismiss", sessionTabId: null });
  });

  it("refuses an unknown action or an unsafe URL", () => {
    expect(
      sanitizeWebNavigationDecision({ tabId: "w1", url: "https://x.com", action: "run" }),
    ).toBeNull();
    expect(
      sanitizeWebNavigationDecision({ tabId: "w1", url: "file:///x", action: "external" }),
    ).toBeNull();
    expect(sanitizeWebNavigationDecision(null)).toBeNull();
  });
});

describe("parseReviewDecision", () => {
  it("reads the --json record", () => {
    expect(parseReviewDecision('{"decision":"approved"}')).toBe("approved");
    expect(parseReviewDecision('{"decision": "annotated", "feedback": "fix" }')).toBe("annotated");
    expect(parseReviewDecision('{"decision":"dismissed"}')).toBe("dismissed");
  });

  it("reads the plaintext approval and a bare decision line", () => {
    expect(parseReviewDecision("The user approved.")).toBe("approved");
    expect(parseReviewDecision("approved\n")).toBe("approved");
  });

  it("does not invent a decision from prose", () => {
    expect(parseReviewDecision("the plan was approved by the team yesterday")).toBeNull();
    expect(parseReviewDecision("")).toBeNull();
    expect(parseReviewDecision(undefined)).toBeNull();
  });
});

describe("parseWebUrl", () => {
  it("returns a URL object for allowed schemes", () => {
    expect(parseWebUrl("http://localhost:1/x")?.port).toBe("1");
    expect(parseWebUrl("ftp://example.com")).toBeNull();
  });
});
