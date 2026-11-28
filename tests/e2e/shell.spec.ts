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
  // The welcome view, tab strip and palette own the action (the title bar and
  // sidebar CTAs were removed in the minimal-session-ui plan), so the assertion
  // is "the command exists in the shell", not an exact count.
  const newSession = window.getByRole("button", { name: /new session/i });
  expect(await newSession.count()).toBeGreaterThanOrEqual(2);
  await expect(window.getByText(/the desktop ui for the pi coding agent/i)).toBeVisible();
  await expect(window.getByRole("button", { name: "Open project folder…" })).toBeVisible();

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
  // is a temp directory, never the developer's real ~/.pi/agent. The chip is
  // compact, so the exact path is asserted through `data-profile`.
  await expect(app.window.getByTestId("status-profile")).toHaveAttribute(
    "data-profile",
    app.paths.profileDir,
  );

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

test("@smoke the first run shows the local-data notice", async () => {
  // No seeded acknowledgement or onboarding completion: the real first launch.
  launched = await launchApp({
    prefs: { privacyAcknowledged: false, onboardingCompletedAt: null },
  });
  const { window } = launched;

  await expect(window.getByText(/your data stays on this machine/i)).toBeVisible();
  await expect(window.getByText(/pi 1\.7\.0 removed its install telemetry/i)).toBeVisible();
  await expect(
    window.getByRole("switch", { name: /share anonymous install telemetry/i }),
  ).toHaveCount(0);

  await window.getByRole("button", { name: /continue/i }).click({ force: true });

  // The privacy screen is done and the first-run setup wizard follows it
  // (plan step 26); skipping it reaches the shell.
  await expect(window.getByText(/your data stays on this machine/i)).toBeHidden();
  await expect(window.getByTestId("onboarding-wizard")).toBeVisible();
  await window.getByRole("button", { name: /skip setup/i }).click();

  // Acknowledged and skipped: the shell is reachable again.
  await expect(window.getByRole("button", { name: "Open project folder…" })).toBeVisible();
  await expect(window.getByTestId("onboarding-wizard")).toBeHidden();
});

test("collapses and reopens the sidebar from the header and tab strip", async () => {
  launched = await launchApp({ settings: { theme: "dark" } });
  const { window } = launched;
  await expect(window.getByLabel("Navigation")).toBeVisible();

  await window.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(window.getByLabel("Navigation")).toHaveCount(0);
  const show = window.getByRole("button", { name: "Show sidebar" });
  await expect(show).toBeVisible();

  await show.click();
  await expect(window.getByLabel("Navigation")).toBeVisible();
});

test("keeps the Projects header pinned while the sidebar list scrolls", async () => {
  // `MAX_PROJECTS` is 30 (`shared/projects`) and 30 collapsed rows are taller
  // than the 860px window, so the sidebar's scroller really scrolls. The header
  // is pinned *outside* that scroller (2026-11-19 sidebar plan), which only a
  // real layout can verify: jsdom has no scroll geometry, so its renderer test
  // asserts the DOM structure instead.
  const projects = Array.from({ length: 30 }, (_, index) => {
    const name = `project-${String(index + 1).padStart(2, "0")}`;
    return {
      path: `C:\\work\\${name}`,
      name,
      addedAt: index + 1,
      lastOpenedAt: index + 1,
    };
  });
  launched = await launchApp({ settings: { theme: "dark" }, appState: { projects } });
  const { window } = launched;

  const header = window.getByTestId("projects-header");
  const viewport = window
    .getByTestId("sidebar-scroll")
    .locator("[data-radix-scroll-area-viewport]");

  // The list has rendered once its last project row is there. Assert on text,
  // not `toBeVisible()`: a row scrolled out of the viewport is still rendered,
  // and `getByRole` names match by substring (`project-30` would also match
  // "Expand project-30").
  await expect(window.getByTestId("projects-section")).toContainText("project-30");
  await expect(header).toBeVisible();
  const before = await header.boundingBox();
  expect(before).not.toBeNull();
  expect(await viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );

  const scrolledTo = await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrolledTo).toBeGreaterThan(0);

  const after = await header.boundingBox();
  expect(after).not.toBeNull();
  if (!before || !after) throw new Error("the Projects header has no box");
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  await expect(header).toBeVisible();
});
