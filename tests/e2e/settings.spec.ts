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

test("@smoke round-trips a theme preference across a restart", async () => {
  app = await launchFakeApp();
  await openSettings(app);

  const light = app.window.getByRole("button", { name: "light", exact: true });
  await light.click();
  await expect(light).toHaveAttribute("aria-pressed", "true");

  await app.relaunch();
  await openSettings(app);

  // The value came from disk, not from a fresh default.
  await expect(app.window.getByRole("button", { name: "light", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
