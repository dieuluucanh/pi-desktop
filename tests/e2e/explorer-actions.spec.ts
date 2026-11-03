import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";

/**
 * Explorer context menu + project removal smoke (2026-11-02 plan step 13).
 *
 * Real Electron, real main/preload/renderer: the blank tree area opens the root
 * menu, New File creates through the workspace IPC and opens an editor tab, and
 * removing the project closes its tabs while leaving the folder on disk.
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

test("@smoke explorer creates a file from the context menu and project removal closes tabs", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-explorer-actions-"));
  writeFileSync(join(projectDir, "app.ts"), "const answer = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  await window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  await expect(window.getByTestId("right-rail")).toBeVisible({ timeout: 30_000 });
  await window.getByTestId("rail-menu-explorer").click();
  await expect(window.getByTestId("explorer-section")).toBeVisible();

  // Right-click the blank tree area below the rows, then create a file inline.
  await window.getByTestId("explorer-tree").click({ button: "right", position: { x: 20, y: 240 } });
  await window.getByText("New File…").click();
  const name = window.getByRole("textbox", { name: "New file name" });
  await expect(name).toBeVisible();
  await name.fill("created.ts");
  await name.press("Enter");

  await expect(window.getByTestId("explorer-row").filter({ hasText: "created.ts" })).toBeVisible();
  await expect(window.getByTestId("editor-tab-strip")).toBeVisible();
  await expect(
    window.getByTestId("editor-tab-strip").getByRole("tab", { name: /created\.ts/ }),
  ).toBeVisible();
  expect(existsSync(join(projectDir, "created.ts"))).toBe(true);

  // Removing the project closes every tab in it but keeps the folder.
  await window.getByRole("button", { name: /Remove E2E project and close its tabs/i }).click();
  await expect(window.getByTestId("editor-tab-strip")).toHaveCount(0);
  await expect(
    window.getByTestId("session-tab-strip").getByRole("tab", { name: /E2E project/ }),
  ).toHaveCount(0);
  expect(existsSync(projectDir)).toBe(true);
});
