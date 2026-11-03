import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";

/**
 * Explorer + editor smoke (2026-11-01 plan step 13).
 *
 * Real Electron, real main/preload/renderer: the rail opens Explorer, the tree
 * lists a project file, the file opens in an editor tab with CodeMirror, an
 * edit saves to disk, and the tab carries the editor identity.
 */

let app: FakeApp | undefined;
let projectDir: string | undefined;

test.afterEach(async () => {
  if (app) {
    await app.shutdown();
    app = undefined;
  }
  if (projectDir) {
    rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  }
});

test("@smoke explorer opens a file in an editor tab and saves it", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-editor-e2e-"));
  writeFileSync(join(projectDir, "app.ts"), "const answer = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  // Start a session so the rail has both a project scope and an active tab.
  await window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  await expect(window.getByTestId("right-rail")).toBeVisible({ timeout: 30_000 });
  await window.getByTestId("rail-menu-explorer").click();
  await expect(window.getByTestId("explorer-section")).toBeVisible();
  const row = window.getByTestId("explorer-row").filter({ hasText: "app.ts" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "app.ts" }).click();

  await expect(window.getByTestId("editor-tab-view")).toBeVisible();
  await expect(window.locator(".cm-editor")).toBeVisible();

  // Editor tabs have their own row under the session row (2026-11-02 plan);
  // the file must not appear in the session strip.
  const editorStrip = window.getByTestId("editor-tab-strip");
  await expect(editorStrip).toBeVisible();
  await expect(editorStrip.getByRole("tab", { name: /app\.ts/ })).toBeVisible();
  await expect(window.getByTestId("session-tab-strip")).toBeVisible();
  await expect(
    window.getByTestId("session-tab-strip").getByRole("tab", { name: /app\.ts/ }),
  ).toHaveCount(0);

  await window.locator(".cm-content").click();
  await window.keyboard.press("Control+End");
  await window.keyboard.type("// edited in the app");
  await expect(window.getByText("Unsaved")).toBeVisible();

  // Switching away and back (the reported Alt+Tab shape) must not blank the
  // editor or lose unsaved work (2026-11-03 plan step 11).
  await window.getByTestId("session-tab-strip").getByRole("tab").first().click();
  await editorStrip.getByRole("tab", { name: /app\.ts/ }).click();
  await expect(window.getByText("Loading file…")).toHaveCount(0);
  await expect(window.locator(".cm-content")).toContainText("// edited in the app");
  await expect(window.getByText("Unsaved")).toBeVisible();

  // A real window focus burst runs one reconcile; it must not re-read the file.
  // (`globalThis` because the test's `window` variable is the Playwright Page.)
  await window.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
    return true;
  }, undefined);
  await window.waitForTimeout(600);
  await expect(window.getByText("Loading file…")).toHaveCount(0);
  await expect(window.locator(".cm-content")).toContainText("// edited in the app");
  await expect(window.getByText("Unsaved")).toBeVisible();

  // Ctrl/Cmd+S is owned by the editor surface (CodeMirror + the view
  // container), not by an Electron accelerator.
  const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
  await window.locator(".cm-content").press(saveKey);
  await expect(window.getByText("Unsaved")).toHaveCount(0);
  await expect
    .poll(() => readFileSync(join(app!.projectDir, "app.ts"), "utf8"), { timeout: 15_000 })
    .toContain("// edited in the app");

  // The no-accelerator File menu path works too.
  await window.locator(".cm-content").press("Control+End");
  await window.keyboard.press("Enter");
  await window.keyboard.type("// saved from the menu");
  await expect(window.getByText("Unsaved")).toBeVisible();
  await app.menuCommand("save-editor");
  await expect(window.getByText("Unsaved")).toHaveCount(0);
  await expect
    .poll(() => readFileSync(join(app!.projectDir, "app.ts"), "utf8"), { timeout: 15_000 })
    .toContain("// saved from the menu");
});

test("quick open finds a file and opens an editor tab", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-editor-e2e-"));
  writeFileSync(join(projectDir, "README.md"), "# project\n", "utf8");
  writeFileSync(join(projectDir, "app.ts"), "const x = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  await window.getByRole("button", { name: "E2E project", exact: true }).click();
  await app.menuCommand("open-file");
  await expect(window.getByTestId("quick-open")).toBeVisible();
  await window.getByPlaceholder("Search files by name…").fill("app.ts");
  await window.getByText("app.ts").last().click();
  await expect(window.getByTestId("editor-tab-view")).toBeVisible();
  await expect(window.locator(".cm-editor")).toBeVisible();
  await expect(window.getByTestId("editor-tab-strip")).toBeVisible();
});

test("@smoke explorer search finds deep and ignored files; drag inserts a mention", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-search-e2e-"));
  mkdirSync(join(projectDir, "src/deep/nested"), { recursive: true });
  mkdirSync(join(projectDir, ".pi/plans"), { recursive: true });
  writeFileSync(join(projectDir, "src/deep/nested/2026-11-01-release.md"), "# release\n");
  writeFileSync(join(projectDir, ".pi/plans/2026-11-01-note.md"), "# note\n");
  writeFileSync(join(projectDir, ".gitignore"), ".pi/\n");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  await window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  await expect(window.getByTestId("right-rail")).toBeVisible({ timeout: 30_000 });
  await window.getByTestId("rail-menu-explorer").click();
  await expect(window.getByTestId("explorer-section")).toBeVisible();

  const filter = window.getByTestId("explorer-filter");
  await filter.fill("2026-11-01");
  const release = window
    .getByTestId("explorer-result")
    .filter({ hasText: "2026-11-01-release.md" });
  const ignoredNote = window
    .getByTestId("explorer-result")
    .filter({ hasText: "2026-11-01-note.md" });
  await expect(release).toBeVisible();
  await expect(ignoredNote).toBeVisible();

  // The ignored plan file follows the Show ignored toggle, not the tree state.
  await window.getByTestId("explorer-show-ignored").click();
  await expect(ignoredNote).toHaveCount(0);
  await expect(release).toBeVisible();
  await window.getByTestId("explorer-show-ignored").click();
  await expect(ignoredNote).toBeVisible();

  // The x clears the query and restores the lazy tree.
  await window.getByTestId("explorer-clear").click();
  await expect(filter).toHaveValue("");
  await expect(window.getByTestId("explorer-row").filter({ hasText: "src" })).toBeVisible();

  // Search again, then drag the result into the chat composer.
  await filter.fill("2026-11-01-release");
  await expect(release).toBeVisible();
  await release.dragTo(window.getByTestId("composer-drop"));
  await expect(window.getByLabel("Prompt")).toHaveValue(
    /@src\/deep\/nested\/2026-11-01-release\.md/,
  );
});
