import { expect, test } from "@playwright/test";

import { removeTempDirs } from "./fixtures/app";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";

/**
 * Extension dialog parity (2026-11-18 dialog parity plan, step 8).
 *
 * The reported prompt is `ctx.ui.select`: the workflow read/write gate puts the
 * header, `Outside:` and one `  • command` per line into the title. Terminal Pi
 * preserves those lines and lets the selector navigate with arrows/j/k even
 * when focus is not inside its list. This runs the real Electron app (not
 * jsdom) and deliberately clicks the title to move focus back to `body` before
 * pressing the keys, which is the case that used to fail.
 */

let app: FakeApp | undefined;

// The first Electron launch on a cold `out/` can take most of a minute; the
// dialog interaction itself is fast, so the budget covers startup, not waiting.
test.setTimeout(120_000);

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

/**
 * A command that asks the same shape of question as the folder-policy read
 * gate, then prints the answer so the test can assert what was selected.
 */
const PERMISSION_EXTENSION = `
export default function (pi) {
  pi.registerCommand("ask", {
    description: "Multi-line permission question",
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.select(
        "Read policy: allow 2 reads?\\nOutside: C:/repo\\n  • read → ../secret/a.txt\\n  • read → ../secret/b.txt",
        ["Allow once (this turn)", "Always allow this folder", "Deny"],
      );
      ctx.ui.notify("answer: " + (answer ?? "cancelled"), "info");
    },
  });
}
`;

/**
 * Starts a session and runs the fixture command. The caller assigns `app`
 * before this so a failure still reaches `afterEach` and shuts the app down.
 */
async function launchWithPrompt(current: FakeApp): Promise<void> {
  const newSession = current.window.getByRole("button", { name: /new session/i }).first();
  await expect(newSession).toBeVisible({ timeout: 60_000 });
  await newSession.click({ timeout: 60_000 });
  const composer = current.window.getByLabel("Prompt");
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.fill("/ask");
  await composer.press("Enter");
}

/** Clicks the title and drops focus to `body`, the case that used to fail. */
async function leaveFocusOnThePage(current: FakeApp): Promise<void> {
  const title = current.window.getByTestId("extension-dialog-title");
  await expect(title).toBeVisible({ timeout: 30_000 });
  await title.click();
  await current.window.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  expect(await current.window.evaluate(() => document.activeElement === document.body)).toBe(true);
}

test("keeps the permission title's lines and navigates from the page", async () => {
  app = await launchFakeApp({
    launch: { extensions: { "permission-dialog.js": PERMISSION_EXTENSION } },
  });
  await launchWithPrompt(app);
  const title = app.window.getByTestId("extension-dialog-title");
  await expect(title).toBeVisible({ timeout: 30_000 });

  // `innerText` reflects real layout: with pre-wrap each source line is its own
  // rendered line. `textContent` alone would pass even when CSS collapsed them.
  const lines = await title.evaluate((element) =>
    (element as HTMLElement).innerText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  expect(lines).toEqual([
    "Read policy: allow 2 reads?",
    "Outside: C:/repo",
    "• read → ../secret/a.txt",
    "• read → ../secret/b.txt",
  ]);

  await leaveFocusOnThePage(app);
  await app.window.keyboard.press("ArrowDown");
  await app.window.keyboard.press("Enter");

  await expect(app.window.getByText("answer: Always allow this folder")).toBeVisible({
    timeout: 30_000,
  });
});

test("cancels the permission prompt from the page with Escape", async () => {
  app = await launchFakeApp({
    launch: { extensions: { "permission-dialog.js": PERMISSION_EXTENSION } },
  });
  await launchWithPrompt(app);
  await leaveFocusOnThePage(app);

  await app.window.keyboard.press("Escape");

  await expect(app.window.getByText("answer: cancelled")).toBeVisible({ timeout: 30_000 });
});
