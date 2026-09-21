import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Web-tab E2E (plan step 25): a loopback URL opened from the command palette
 * becomes an in-app tab. The page itself is a native `WebContentsView`, so the
 * assertions are the chrome around it (address bar, tab strip) plus the title the
 * page reports back.
 */

let server: Server;
let pageUrl: string;
let app: FakeApp | undefined;

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><html><head><title>Fake Review</title></head><body><h1>review</h1></body></html>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/review`;
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

test("@smoke opens a loopback URL in an in-app tab", async () => {
  app = await launchFakeApp();
  const { window } = app;

  // The Electron menu owns the action; clicking the real menu item exercises the
  // same `MenuCommand` path the accelerator would (a synthetic key press does not
  // trigger a native menu accelerator).
  await app.menuCommand("open-web-url");

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
