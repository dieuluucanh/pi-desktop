import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Settings E2E (plan step 25): a preference changed in the UI survives a restart.
 * App preferences are written through `prefs.set` to `app-state.json`, so a
 * relaunch against the same app-state directory is the round trip.
 */

let app: FakeApp | undefined;

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

async function openSettings(current: FakeApp): Promise<void> {
  // The sidebar item's accessible name includes its accelerator ("Settings Ctrl+,").
  await current.window
    .getByRole("button", { name: /^settings/i })
    .first()
    .click();
  await expect(current.window.getByTestId("app-preferences")).toBeVisible({ timeout: 15_000 });
}

async function openSkills(current: FakeApp): Promise<void> {
  await current.window
    .getByRole("button", { name: /^skills/i })
    .first()
    .click();
  await expect(current.window.getByTestId("themes")).toBeVisible({ timeout: 15_000 });
}

test("@smoke round-trips the active theme across a restart", async () => {
  app = await launchFakeApp();
  await openSkills(app);

  const light = app.window.getByTestId("theme-builtin-light");
  await expect(light).toHaveAttribute("aria-checked", "false");
  await light.click();
  await expect(light).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  await expect(app.window.locator("html")).toHaveAttribute("data-theme", "light");

  await app.relaunch();
  await openSkills(app);

  // The value came from Pi's settings, not from a fresh default.
  await expect(app.window.getByTestId("theme-builtin-light")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("Settings no longer renders a theme control", async () => {
  app = await launchFakeApp();
  await openSettings(app);

  await expect(app.window.getByTestId("setting-theme")).toHaveCount(0);
  await expect(app.window.getByRole("button", { name: "Open theme settings" })).toBeVisible();
});

async function zoomPercent(current: FakeApp): Promise<number> {
  return current.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return Math.round((window?.webContents.getZoomFactor() ?? 1) * 100);
  });
}

test("@smoke round-trips the display zoom across a restart", async () => {
  const current = (app = await launchFakeApp());

  await current.menuCommand("zoom-in");
  await expect.poll(() => zoomPercent(current), { timeout: 15_000 }).toBe(110);

  await current.relaunch();
  await expect.poll(() => zoomPercent(current), { timeout: 15_000 }).toBe(110);

  await current.menuCommand("zoom-reset");
  await expect.poll(() => zoomPercent(current), { timeout: 15_000 }).toBe(100);
});

test("round-trips the telemetry opt-in and defaults it off", async () => {
  app = await launchFakeApp();
  await openSettings(app);

  const telemetry = app.window.getByRole("switch", {
    name: /share anonymous install telemetry/i,
  });
  await expect(telemetry).toHaveAttribute("aria-checked", "false");

  await telemetry.click();
  await expect(telemetry).toHaveAttribute("aria-checked", "true");

  await app.relaunch();
  await openSettings(app);
  await expect(
    app.window.getByRole("switch", { name: /share anonymous install telemetry/i }),
  ).toHaveAttribute("aria-checked", "true");
});
