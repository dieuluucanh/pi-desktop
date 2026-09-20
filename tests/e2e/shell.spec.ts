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

test("@smoke the built renderer carries the strict CSP and no Node globals", async () => {
  launched = await launchApp();
  const { window } = launched;

  // The policy is a `<meta>` tag (Electron's webRequest does not see file://),
  // injected by the build plugin. A missing/loose policy is the regression this
  // guards: `script-src 'self'` with no `unsafe-inline`.
  const csp = await window.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? "",
  );
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toContain("__PI_RENDERER_CSP__");

  // The app window is the one place `window.pi` exists (it must, or nothing
  // works), and Node is not reachable from it.
  const globals = await window.evaluate(() => ({
    pi: typeof (window as unknown as { pi?: unknown }).pi,
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(globals.pi).toBe("object");
  expect(globals.require).toBe("undefined");
  expect(globals.process).toBe("undefined");
});

test("@smoke the first run asks about telemetry and defaults it off", async () => {
  // No seeded acknowledgement: this is the real first launch.
  launched = await launchApp({ prefs: { privacyAcknowledged: false } });
  const { window } = launched;

  await expect(window.getByText(/your data stays on this machine/i)).toBeVisible();
  const telemetry = window.getByRole("switch", { name: /share anonymous install telemetry/i });
  await expect(telemetry).toHaveAttribute("aria-checked", "false");

  await window.getByRole("button", { name: /keep telemetry off/i }).click();

  // Acknowledged: the shell is reachable again and the choice was persisted.
  await expect(window.getByRole("button", { name: /open project folder/i })).toBeVisible();
  await expect(window.getByText(/your data stays on this machine/i)).toBeHidden();
});
