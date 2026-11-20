import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDemoApp } from "./demo-app";

/**
 * Marketing screenshot capture. Not part of `npm run test:e2e`; run
 * `npm run site:screenshots` from the repository root. Raw PNGs land in the
 * ignored `test-results/site-screenshots/`; `site/scripts/optimize-screenshots.mjs`
 * turns them into committed WebP assets.
 */
test("capture the six public screenshots", async () => {
  test.setTimeout(180_000);
  const app = await launchDemoApp();
  const window = app.window;
  const output = join(process.cwd(), "test-results", "site-screenshots");
  mkdirSync(output, { recursive: true });

  try {
    // The status bar carries the isolated profile's temp path, which is not
    // useful in a product screenshot. Everything else is the real UI.
    await window.addStyleTag({
      content: 'footer:has(> [data-testid="status-project"]) { display: none !important; }',
    });

    const shot = async (name: string) => {
      await window.waitForTimeout(250);
      await window.screenshot({
        path: join(output, `${name}.png`),
        animations: "disabled",
      });
    };

    await expect(window.getByText("Pi Desktop").first()).toBeVisible({ timeout: 30_000 });
    await shot("welcome");

    await window
      .getByTestId("session-tab-strip")
      .getByRole("button", { name: "New session" })
      .click();
    const composer = window.getByLabel("Prompt");
    await expect(composer).toBeVisible({ timeout: 30_000 });

    app.provider.enqueue({
      kind: "thinking",
      thinking: "I should inspect the existing theme tokens before changing the shell.",
      text: "Let me look at the theme and the app shell first.",
    });
    await composer.fill("Review the theme and get this demo ready to present.");
    await composer.press("Enter");
    await expect(window.getByText("Let me look at the theme and the app shell first.")).toBeVisible(
      {
        timeout: 30_000,
      },
    );

    app.provider.enqueue(
      {
        kind: "toolCall",
        name: "read",
        arguments: { path: "src/theme.ts" },
        text: "Reading src/theme.ts.",
      },
      {
        kind: "text",
        text: "The theme is consistent. The next step is to verify the tab strip in the two-pane layout.",
      },
    );
    await composer.fill("Read the theme file and tell me what to verify next.");
    await composer.press("Enter");
    await expect(
      window.getByText(
        "The theme is consistent. The next step is to verify the tab strip in the two-pane layout.",
      ),
    ).toBeVisible({ timeout: 30_000 });
    await shot("session");

    await window.getByTestId("rail-menu-explorer").click();
    await expect(window.getByTestId("explorer-section")).toBeVisible({ timeout: 15_000 });
    await window.getByRole("button", { name: "Expand src" }).click();
    const appFile = window.getByTestId("explorer-row").filter({ hasText: "app.ts" });
    await expect(appFile).toBeVisible();
    await appFile.getByRole("button", { name: "app.ts" }).click();
    await expect(window.getByTestId("editor-tab-view")).toBeVisible({ timeout: 15_000 });
    await expect(window.locator(".cm-editor")).toBeVisible();
    await shot("editor");

    await window
      .getByRole("button", { name: /^Settings/ })
      .first()
      .click();
    await expect(window.getByRole("heading", { name: "Settings", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await shot("settings");

    await window
      .getByTestId("editor-tab-strip")
      .getByRole("tab", { name: /app\.ts/ })
      .click();
    await expect(window.locator(".cm-editor")).toBeVisible();
    writeFileSync(
      join(app.projectDir, "README.md"),
      "# Pi Desktop Demo\n\nA tiny project used for the public screenshots.\n\nA demo edit for the source-control view.\n",
      "utf8",
    );
    await window.getByTestId("rail-menu-source-control").click();
    await expect(window.getByTestId("source-control-block")).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("change-row-README.md")).toBeVisible({ timeout: 20_000 });
    await shot("source-control");

    await app.menuCommand("grid-two");
    await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "two");
    await window.getByTestId("pane-picker-0").click();
    await window.getByRole("menu").getByRole("menuitem").first().click();
    await expect(window.getByTestId("pane-0").getByLabel("Prompt")).toBeVisible({
      timeout: 30_000,
    });
    await window.getByTestId("pane-picker-1").click();
    await window.getByRole("menuitem", { name: /app\.ts/ }).click();
    await expect(window.getByTestId("pane-1").locator(".cm-editor")).toBeVisible();
    await shot("grid");
  } finally {
    await app.shutdown();
  }
});
