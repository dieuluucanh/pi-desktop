import { expect, test } from "@playwright/test";
import { launchApp, removeTempDirs, type LaunchedApp } from "./fixtures/app";

/**
 * Shell smoke test (plan step 2, `npm run e2e:smoke`).
 *
 * This is the first test that runs the *real* built app end to end: main process,
 * preload, renderer, application menu and IPC. It pins the user-visible
 * regression that started the re-baseline — "New session" must open a real shell
 * with a welcome state, not build scaffolding.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  if (!launched) return;
  await launched.close();
  removeTempDirs(launched.paths);
  launched = undefined;
});

test("@smoke the app opens on the welcome view of the new shell", async () => {
  launched = await launchApp({ settings: { theme: "dark" } });
  const { window } = launched;

  await expect(window.getByText("Pi Desktop").first()).toBeVisible();
  // Several surfaces own the action (title bar, sidebar, tab strip, palette), so
  // the assertion is "the command exists in the shell", not an exact count.
  const newSession = window.getByRole("button", { name: /new session/i });
  expect(await newSession.count()).toBeGreaterThanOrEqual(2);
  await expect(window.getByText(/the desktop ui for the pi coding agent/i)).toBeVisible();
  await expect(window.getByRole("button", { name: /open project folder/i })).toBeVisible();

  // Navigation exists up front: the sidebar carries the product views.
  for (const label of ["Settings", "Extensions", "Connections", "Diagnostics"]) {
    await expect(
      window.getByRole("button", { name: new RegExp(label, "i") }).first(),
    ).toBeVisible();
  }
});

test("@smoke the old scaffold placeholder is gone", async () => {
  launched = await launchApp();
  const body = launched.window.locator("body");
  await expect(body).not.toContainText("Scaffold is running");
  await expect(body).not.toContainText("Next up");
});

test("@smoke runs against the isolated profile and exits cleanly", async () => {
  const app = await launchApp();
  launched = app;

  // The status bar proves `PI_CODING_AGENT_DIR` reached the app: the E2E profile
  // is a temp directory, never the developer's real ~/.pi/agent.
  await expect(app.window.locator("footer")).toContainText(app.paths.profileDir);

  const exitCode = await app.close();
  expect(exitCode).toBe(0);
  // Closed explicitly, so the afterEach must not close it twice.
  removeTempDirs(app.paths);
  launched = undefined;
});
