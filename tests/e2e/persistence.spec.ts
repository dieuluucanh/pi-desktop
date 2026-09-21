import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Restart/restore E2E (plan step 25).
 *
 * The session JSONL lives in the shared Pi profile and the tab table in
 * `app-state.json`; a relaunch must bring both back, resume the session and show
 * the prior conversation. The fake provider is still running, so the resumed
 * session can also take a new prompt.
 */

let app: FakeApp | undefined;

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

test("@smoke restores a session tab and its transcript after a restart", async () => {
  app = await launchFakeApp();
  await app.window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  const composer = app.window.getByLabel("Prompt");
  await expect(composer).toBeVisible({ timeout: 30_000 });

  app.provider.enqueue({ kind: "text", text: "before the restart" });
  await composer.fill("remember this conversation");
  await composer.press("Enter");
  await expect(app.window.getByText("before the restart")).toBeVisible({ timeout: 30_000 });

  await app.relaunch();

  // The tab is restored from the table. If it comes back stopped, the user
  // starts it; either way the JSONL is re-read and the transcript returns.
  const start = app.window.getByRole("button", { name: /start session/i });
  if ((await start.count()) > 0) await start.first().click();

  await expect(app.window.getByText("remember this conversation")).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByText("before the restart")).toBeVisible({ timeout: 30_000 });

  // The resumed session is usable: a new prompt streams a reply.
  app.provider.enqueue({ kind: "text", text: "after the restart" });
  const resumed = app.window.getByLabel("Prompt");
  await expect(resumed).toBeVisible({ timeout: 30_000 });
  await resumed.fill("are you still there?");
  await resumed.press("Enter");
  await expect(app.window.getByText("after the restart")).toBeVisible({ timeout: 30_000 });
});
