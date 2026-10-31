import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Session E2E (plan step 25): create → send → stream → abort, against the
 * deterministic fake provider. Every step runs the real app: Electron main, the
 * spawned Pi host process and the SDK's agent loop.
 */

let app: FakeApp | undefined;

// The host runs `!` through the same Bash Pi uses. A Windows CI machine without
// Git Bash cannot exercise the path, so the test says so instead of failing.
const hasBash = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

/** Creates a session from the welcome shell and returns the composer. */
async function startSession(
  current: FakeApp,
): Promise<ReturnType<typeof current.window.getByLabel>> {
  await current.window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  const composer = current.window.getByLabel("Prompt");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return composer;
}

test("@smoke creates a session and streams a reply from the model", async () => {
  app = await launchFakeApp();
  const composer = await startSession(app);

  app.provider.enqueue({ kind: "text", text: "Hello from the fake model" });
  await composer.fill("Say hello");
  await composer.press("Enter");

  // The reply is streamed through the real host and rendered in the transcript.
  await expect(app.window.getByText("Hello from the fake model")).toBeVisible({ timeout: 30_000 });

  // The user message is in the transcript too.
  await expect(app.window.getByText("Say hello")).toBeVisible();
});

test("runs ! and !! shell commands without losing the composer", async () => {
  test.skip(!hasBash, "bash is not on PATH");
  app = await launchFakeApp();
  const composer = await startSession(app);

  await composer.fill("!echo shell-e2e-ok");
  await composer.press("Enter");
  await expect(app.window.getByText("shell-e2e-ok")).toBeVisible({ timeout: 30_000 });

  await composer.fill("!!echo excluded-e2e-ok");
  await composer.press("Enter");
  await expect(app.window.getByText("excluded-e2e-ok")).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveValue("");
});

test("@smoke aborts a running reply and returns the session to idle", async () => {
  app = await launchFakeApp();
  const composer = await startSession(app);

  app.provider.enqueue({
    kind: "slowText",
    text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
    delayMs: 40,
  });
  await composer.fill("Count for me");
  await composer.press("Enter");

  // The composer's Stop button is the one with the Esc hint (the shell has a
  // second, unrelated Stop in the status bar).
  const stop = app.window.locator('button[title="Esc"]');
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();

  // The session leaves the streaming state: the Stop button disappears.
  await expect(stop).toBeHidden({ timeout: 30_000 });
});

test("uses one Send button and queues a follow-up with Alt+Enter", async () => {
  app = await launchFakeApp();
  const composer = await startSession(app);

  app.provider.enqueue({
    kind: "slowText",
    text: Array.from({ length: 60 }, (_, index) => `word${index}`).join(" "),
    delayMs: 200,
  });
  await composer.fill("start a long answer");
  await composer.press("Enter");

  // One Send button in every state; the delivery choice is the chord, exactly
  // like terminal Pi (Enter steers, Alt+Enter queues a follow-up).
  const send = app.window.getByRole("button", { name: /^send$/i });
  await expect(send).toBeVisible({ timeout: 30_000 });
  await expect(send).toHaveAttribute("title", /Alt\+Enter/);
  await expect(app.window.getByRole("button", { name: "steer mode" })).toHaveCount(0);
  await expect(app.window.getByRole("button", { name: "follow-up mode" })).toHaveCount(0);

  await composer.fill("after this");
  await composer.press("Alt+Enter");
  await expect(app.window.getByTestId("pending-queue").getByText("Follow-up")).toBeVisible({
    timeout: 15_000,
  });

  // Stop the long run so the app can shut down promptly.
  await app.window.locator('button[title="Esc"]').click();
});

test("@smoke keeps two session tabs independent", async () => {
  app = await launchFakeApp();
  const composer = await startSession(app);
  app.provider.enqueue({ kind: "text", text: "first tab reply" });
  await composer.fill("First tab");
  await composer.press("Enter");
  await expect(app.window.getByText("first tab reply")).toBeVisible({ timeout: 30_000 });

  // A second tab runs its own host; its reply must not leak into the first.
  await app.window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  const second = app.window.getByLabel("Prompt");
  await expect(second).toBeVisible({ timeout: 30_000 });
  app.provider.enqueue({ kind: "text", text: "second tab reply" });
  await second.fill("Second tab");
  await second.press("Enter");
  await expect(app.window.getByText("second tab reply")).toBeVisible({ timeout: 30_000 });

  // Two tabs exist in the strip.
  await expect(app.window.getByRole("tab")).toHaveCount(2);
});
