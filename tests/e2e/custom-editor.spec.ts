import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Regression: an extension that installs a custom editor on `session_start`
 * must not replace the desktop composer (2026-10-26 plan).
 *
 * Before the fix, `ctx.ui.setEditorComponent()` mounted the component in the
 * TUI surface, the composer disappeared behind the “Extension UI — keys are
 * forwarded…” panel, and Enter discarded the text (no `onSubmit` was wired).
 * The extension is seeded into the isolated profile, so this runs the real
 * host/SDK extension path, not a renderer mock.
 */

const CUSTOM_EDITOR_EXTENSION = `
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    // A visible status proves the extension really ran, so a test that cannot
    // load it fails instead of passing vacuously.
    ctx.ui.setStatus("editor-probe", "on");
    ctx.ui.setEditorComponent(() => ({
      render: () => ["EXTENSION EDITOR"],
      handleInput: () => {},
      invalidate: () => {},
      dispose: () => {},
    }));
  });
}
`;

let app: FakeApp | undefined;

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

test("keeps the native composer when an extension installs a custom editor", async () => {
  app = await launchFakeApp({
    launch: { extensions: { "editor.js": CUSTOM_EDITOR_EXTENSION } },
  });

  await app.window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();

  const composer = app.window.getByLabel("Prompt");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  // The extension loaded and ran session_start…
  await expect(app.window.getByTestId("extension-status-editor-probe")).toHaveText("on", {
    timeout: 30_000,
  });
  // …but its editor was recorded, not mounted.
  await expect(app.window.getByText("Extension UI")).toHaveCount(0);
  await expect(app.window.getByText("EXTENSION EDITOR")).toHaveCount(0);

  // Enter reaches the real composer/session path, not a dead TUI component.
  app.provider.enqueue({ kind: "text", text: "composer works" });
  await composer.fill("hello from the composer");
  await composer.press("Enter");
  await expect(app.window.getByText("composer works")).toBeVisible({ timeout: 30_000 });
});
