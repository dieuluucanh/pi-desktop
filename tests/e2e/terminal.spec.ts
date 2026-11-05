import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Terminal E2E (2026-11-05 terminal plan, step 13).
 *
 * Runs the real app: Electron main, the per-window terminal host under the
 * bundled Node, `node-pty` and ConPTY/POSIX. xterm paints to a canvas, so the
 * assertions are about the surface (the live view, the xterm element, no error
 * notice) rather than reading glyphs back out of the renderer.
 */

let app: FakeApp | undefined;

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

test("@smoke opens a terminal tab, starts a real shell and accepts input", async () => {
  app = await launchFakeApp();

  await app.window.getByRole("button", { name: "New terminal" }).click();
  await expect(app.window.getByTestId("terminal-view")).toBeVisible({ timeout: 30_000 });

  const host = app.window.getByTestId("terminal-host");
  await expect(host.locator(".xterm")).toBeVisible({ timeout: 30_000 });

  // The xterm surface must fill the pane, not just the initial 24 rows. FitAddon
  // measures the mount div's parent, so this catches a broken height chain.
  await expect
    .poll(async () => {
      const hostBox = await host.boundingBox();
      const xtermBox = await host.locator(".xterm").boundingBox();
      if (!hostBox || !xtermBox || hostBox.height === 0) return 0;
      return xtermBox.height / hostBox.height;
    })
    .toBeGreaterThan(0.85);

  await host.click();
  await app.window.keyboard.type("echo terminal-e2e");
  await app.window.keyboard.press("Enter");

  // The shell accepted the input: no exit/error notice appeared.
  await expect(app.window.getByText(/Terminal exited/)).toHaveCount(0);
  await expect(app.window.getByText("This project is not trusted")).toHaveCount(0);
});

test("a terminal tab survives a grid layout switch", async () => {
  app = await launchFakeApp();
  await app.window.getByRole("button", { name: "New terminal" }).click();
  const view = app.window.getByTestId("terminal-view");
  await expect(view).toBeVisible({ timeout: 30_000 });

  // The strip's layout menu is the grid entry point; switching to a multi-pane
  // layout remounts the surface, and the pooled xterm must move with it.
  await app.window.getByRole("button", { name: /layout/i }).click();
  await app.window.getByRole("menuitemradio", { name: /two/i }).click();
  await expect(app.window.getByTestId("pane-grid")).toBeVisible();
  await app.window.getByRole("button", { name: "Grid layout" }).click();
  await app.window.getByRole("menuitemradio", { name: /single/i }).click();
  await expect(app.window.getByTestId("terminal-view")).toBeVisible({ timeout: 10_000 });
});
