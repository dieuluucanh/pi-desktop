import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";

/**
 * Session view grid smoke (2026-11-03 plan step 15).
 *
 * Real Electron, real main/preload/renderer: a session and a file are on screen
 * in two panes at the same time, and the layout survives a relaunch through
 * `prefs.grid`. The drag/swap rules are pinned in `tests/renderer/pane-grid` and
 * `grid-store`; this covers the wiring that only a real window can show.
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

test("@smoke shows a session and a file in two panes at once", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-grid-e2e-"));
  writeFileSync(join(projectDir, "app.ts"), "const answer = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  // The session strip's `+` is the one always-mounted New session control: the
  // welcome CTA and the per-project row come and go with the shell's state, and a
  // loose role query can resolve to a hidden one.
  const strip = window.getByTestId("session-tab-strip");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await strip.getByRole("button", { name: "New session" }).click();
  await expect(window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });

  await expect(window.getByTestId("right-rail")).toBeVisible();
  await window.getByTestId("rail-menu-explorer").click();
  const row = window.getByTestId("explorer-row").filter({ hasText: "app.ts" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "app.ts" }).click();
  await expect(window.locator(".cm-editor")).toBeVisible();

  // Two panes. The preset seeds pane 1 with whatever is active (the file, since
  // it was just opened), so put the session in pane 1 explicitly and the file in
  // pane 2 — one tab per pane, and assigning a tab another pane holds swaps.
  await app.menuCommand("grid-two");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "two");
  await expect(window.getByTestId("pane-0")).toBeVisible();
  await expect(window.getByTestId("pane-1")).toBeVisible();

  await window.getByTestId("pane-picker-0").click();
  // The first menu item is the first session tab: sessions render before the
  // editor group, and the tab's title is the folder's basename (not the seeded
  // project label), so name matching would depend on the temp dir.
  await window.getByRole("menu").getByRole("menuitem").first().click();
  await expect(window.getByTestId("pane-0").getByLabel("Prompt")).toBeVisible({
    timeout: 30_000,
  });

  await window.getByTestId("pane-picker-1").click();
  await window.getByRole("menuitem", { name: /app\.ts/ }).click();

  // Both surfaces are live at the same time — the whole point of the grid.
  await expect(window.getByTestId("pane-1").locator(".cm-editor")).toBeVisible();
  await expect(window.getByTestId("pane-0").getByLabel("Prompt")).toBeVisible();
});

test("@smoke restores the layout and its panes after a relaunch", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-grid-e2e-"));
  writeFileSync(join(projectDir, "one.ts"), "export const one = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  const strip = window.getByTestId("session-tab-strip");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await strip.getByRole("button", { name: "New session" }).click();
  await expect(window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });

  await app.menuCommand("grid-four");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "four");

  await app.relaunch();

  // `prefs.grid` is persisted with the rest of the app state.
  await expect(app.window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "four");
  await expect(app.window.getByTestId("pane-3")).toBeVisible();
});
