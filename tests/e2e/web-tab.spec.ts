import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Web-tab E2E (plan step 25 + 2026-11-18 close/return plan).
 *
 * A loopback URL becomes an in-app tab whose page is a native
 * `WebContentsView`; the assertions are the chrome around it (address bar, tab
 * strip) plus the tab table main publishes. The close cases cover both paths:
 * the injected `window.close` bridge and the native-close/destroyed fallback.
 */

test.describe.configure({ timeout: 120_000 });

interface TabSummary {
  id: string;
  kind: string;
  url?: string | null;
  sessionTabId?: string | null;
}

interface Envelope {
  tabs: TabSummary[];
  activeTabId: string | null;
}

interface PiBridge {
  sessions: {
    list(): Promise<Envelope>;
    activate(tabId: string): Promise<Envelope>;
    close(tabId: string): Promise<Envelope>;
  };
  web: {
    open(input: {
      url: string;
      sessionTabId?: string;
      activate?: boolean;
      reload?: boolean;
    }): Promise<Envelope>;
  };
}

let server: Server;
let origin: string;
let pageUrl: string;
let app: FakeApp | undefined;

function pageHtml(path: string): string {
  const title =
    path === "/native-close"
      ? "Native Close"
      : path === "/close"
        ? "Close Page"
        : path === "/manual"
          ? "Manual Page"
          : "Fake Review";
  const script =
    path === "/native-close"
      ? "<script>window.__nativeClose = window.close; window.closeSoon = () => window.__nativeClose();</script>"
      : "";
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${script}</body></html>`;
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(pageHtml((request.url ?? "/").split("?")[0] ?? "/"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pageUrl = `${origin}/review`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

async function listTabs(target: FakeApp): Promise<Envelope> {
  return target.window.evaluate(async () => {
    const bridge = (window as unknown as { pi: PiBridge }).pi;
    return bridge.sessions.list();
  });
}

async function newSession(target: FakeApp, expectedSessions: number): Promise<string> {
  await target.window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  await expect(target.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => (await listTabs(target)).tabs.filter((tab) => tab.kind === "session").length,
      {
        timeout: 30_000,
      },
    )
    .toBe(expectedSessions);
  const envelope = await listTabs(target);
  const active = envelope.tabs.find((tab) => tab.id === envelope.activeTabId);
  expect(active?.kind).toBe("session");
  return envelope.activeTabId!;
}

async function clickTab(target: FakeApp, tabId: string): Promise<void> {
  await target.window.locator(`[data-testid="tab-${tabId}"] [role="tab"]`).click();
}

async function openWeb(
  target: FakeApp,
  url: string,
  sessionTabId?: string,
  focus = true,
): Promise<Envelope> {
  return target.window.evaluate(
    async ({ url, sessionTabId, focus }) => {
      const bridge = (window as unknown as { pi: PiBridge }).pi;
      return bridge.web.open({
        url,
        ...(sessionTabId ? { sessionTabId } : {}),
        ...(focus ? {} : { activate: false }),
      });
    },
    { url, sessionTabId, focus },
  );
}

async function closeSession(target: FakeApp, tabId: string): Promise<Envelope> {
  return target.window.evaluate(async (id) => {
    const bridge = (window as unknown as { pi: PiBridge }).pi;
    return bridge.sessions.close(id);
  }, tabId);
}

function webTabId(envelope: Envelope, url: string): string {
  const tab = envelope.tabs.find((entry) => entry.kind === "web" && entry.url === url);
  expect(tab).toBeTruthy();
  return tab!.id;
}

async function expectSelected(target: FakeApp, tabId: string): Promise<void> {
  await expect(target.window.locator(`[data-testid="tab-${tabId}"] [role="tab"]`)).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 30_000 },
  );
}

async function markerFor(target: FakeApp, url: string): Promise<unknown> {
  return target.app.evaluate(({ webContents }, page) => {
    const contents = webContents
      .getAllWebContents()
      .find((entry) => !entry.isDestroyed() && entry.getURL() === page);
    return contents ? contents.executeJavaScript("window.__piDesktopCloseBridge") : null;
  }, url);
}

/** Runs an expression in the tab's page and tolerates the page dying mid-script. */
async function callPageClose(target: FakeApp, url: string, expression: string): Promise<string> {
  return target.app.evaluate(
    ({ webContents }, input) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => !entry.isDestroyed() && entry.getURL() === input.url);
      if (!contents) return "missing";
      return contents.executeJavaScript(input.expression).then(
        () => "ok",
        () => "destroyed",
      );
    },
    { url, expression },
  );
}

test("@smoke opens a loopback URL in an in-app tab", async () => {
  const launched = await launchFakeApp();
  app = launched;
  const { window } = launched;

  // The Electron menu owns the action; clicking the real menu item exercises the
  // same `MenuCommand` path the accelerator would (a synthetic key press does not
  // trigger a native menu accelerator).
  await launched.menuCommand("open-web-url");

  const urlInput = window.getByRole("textbox", { name: "URL" });
  await expect(urlInput).toBeVisible({ timeout: 15_000 });
  await urlInput.fill(pageUrl);
  await window.getByRole("button", { name: /^open$/i }).click();

  // The web tab chrome is up and the address is the loopback URL.
  await expect(window.getByLabel("Web address")).toHaveValue(pageUrl, { timeout: 30_000 });
  await expect(window.getByTestId("web-tab-host")).toBeVisible();
  await expect(window.getByRole("tab")).toHaveCount(1);

  // The page loaded in the isolated native view and reported its title back.
  await expect(window.getByText("Fake Review")).toBeVisible({ timeout: 30_000 });
});

test("closes a page-requested web tab and returns to its opener", async () => {
  const launched = await launchFakeApp();
  app = launched;
  const opener = await newSession(launched, 1);
  const newer = await newSession(launched, 2);
  const url = `${origin}/close`;

  await clickTab(launched, opener);
  const opened = await openWeb(launched, url, opener);
  const webId = webTabId(opened, url);
  await clickTab(launched, webId);
  await expect(launched.window.getByLabel("Web address")).toHaveValue(url, { timeout: 30_000 });

  // `newer` is the most recently activated session. Bring the review tab back
  // in front; the explicit opener link must still win on close.
  await clickTab(launched, newer);
  await clickTab(launched, webId);
  await expect.poll(async () => markerFor(launched, url), { timeout: 15_000 }).toBe("installed");

  await callPageClose(launched, url, "window.close(); 'called'");

  await expect(launched.window.locator('[data-tab-kind="web"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expectSelected(launched, opener);
});

test("closes a web tab through the native window.close fallback", async () => {
  const launched = await launchFakeApp();
  app = launched;
  const opener = await newSession(launched, 1);
  const url = `${origin}/native-close`;

  const opened = await openWeb(launched, url, opener);
  await clickTab(launched, webTabId(opened, url));
  await expect(launched.window.getByLabel("Web address")).toHaveValue(url, { timeout: 30_000 });

  // The page saved the native close reference before the bridge ran; Electron
  // destroys the webContents, so only the `destroyed` fallback can close the tab.
  const result = await callPageClose(launched, url, "window.closeSoon(); 'called'");
  expect(["ok", "destroyed"]).toContain(result);

  await expect(launched.window.locator('[data-tab-kind="web"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expectSelected(launched, opener);
});

test("re-points a reused review tab and returns to the latest opener", async () => {
  const launched = await launchFakeApp();
  app = launched;
  const first = await newSession(launched, 1);
  const second = await newSession(launched, 2);
  const url = `${origin}/review`;

  const opened = await openWeb(launched, url, first);
  const webId = webTabId(opened, url);
  await clickTab(launched, webId);
  await expect(launched.window.getByLabel("Web address")).toHaveValue(url, { timeout: 30_000 });

  // A background notification for the same URL re-points the link without
  // moving the user off the session they are reading.
  await clickTab(launched, first);
  const relinked = await openWeb(launched, url, second, false);
  expect(relinked.activeTabId).toBe(first);
  expect(relinked.tabs.find((entry) => entry.id === webId)?.sessionTabId).toBe(second);

  // `first` is now the MRU session; the link must still decide the close target.
  await clickTab(launched, webId);
  await callPageClose(launched, url, "window.close(); 'called'");

  await expect(launched.window.locator('[data-tab-kind="web"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expectSelected(launched, second);
});

test("closing a session removes its review tab and keeps an unrelated web tab", async () => {
  const launched = await launchFakeApp();
  app = launched;
  const owner = await newSession(launched, 1);
  const other = await newSession(launched, 2);
  const manualUrl = `${origin}/manual`;
  const reviewUrl = `${origin}/review`;

  const manual = await openWeb(launched, manualUrl);
  const manualWebId = webTabId(manual, manualUrl);
  await clickTab(launched, manualWebId);
  await clickTab(launched, other);
  const review = await openWeb(launched, reviewUrl, owner);
  await clickTab(launched, webTabId(review, reviewUrl));

  const before = await listTabs(launched);
  expect(before.tabs.filter((tab) => tab.kind === "web")).toHaveLength(2);

  const closed = await closeSession(launched, owner);

  expect(closed.tabs.some((tab) => tab.id === owner)).toBe(false);
  expect(closed.tabs.some((tab) => tab.kind === "web" && tab.sessionTabId === owner)).toBe(false);
  expect(closed.tabs.some((tab) => tab.kind === "web" && tab.url === manualUrl)).toBe(true);
  await expect(launched.window.locator('[data-tab-kind="web"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expectSelected(launched, other);
});
