import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Milestone-A attachment E2E (plan step 16).
 *
 * These run the real app + host + fake provider. Files arrive through a
 * synthetic external drop, so no native picker has to be scripted. The
 * development gate is enabled explicitly; a packaged build keeps its own gate.
 */

let app: FakeApp | undefined;

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

async function startSession(current: FakeApp) {
  await current.window
    .getByRole("button", { name: /new session/i })
    .first()
    .click();
  const composer = current.window.getByLabel("Prompt");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return composer;
}

async function dropFile(
  current: FakeApp,
  file: { name: string; text?: string; base64?: string; mime: string },
): Promise<void> {
  await current.window.evaluate((payload) => {
    const bytes = payload.base64
      ? Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(payload.text ?? "");
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: payload.mime }));
    const target = document.querySelector('[data-testid="composer-drop"]');
    if (!target) throw new Error("composer drop target is missing");
    target.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }, file);
}

// A 1×1 transparent PNG: enough to exercise the real image preparation path.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("@smoke sends a dropped text file through the managed path", async () => {
  app = await launchFakeApp({ launch: { env: { PI_DESKTOP_ATTACHMENTS: "1" } } });
  const composer = await startSession(app);

  await dropFile(app, { name: "notes.txt", text: "attachment body", mime: "text/plain" });
  await expect(app.window.getByText("notes.txt")).toBeVisible({ timeout: 30_000 });

  app.provider.enqueue({ kind: "text", text: "Attachment received" });
  await composer.fill("Review this file");
  const send = app.window.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();

  await expect(app.window.getByText("Attachment received")).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByTestId("attachment-transcript-card")).toBeVisible();
  await expect(app.window.getByText("Review this file")).toBeVisible();
});

test("@smoke prepares and sends a dropped raster image", async () => {
  app = await launchFakeApp({ launch: { env: { PI_DESKTOP_ATTACHMENTS: "1" } } });
  const composer = await startSession(app);

  await dropFile(app, { name: "pixel.png", base64: PNG_1X1, mime: "image/png" });
  await expect(app.window.getByText("pixel.png")).toBeVisible({ timeout: 30_000 });

  app.provider.enqueue({ kind: "text", text: "Image received" });
  await composer.fill("What is this?");
  const send = app.window.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();
  await expect(app.window.getByText("Image received")).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByTestId("attachment-transcript-card")).toBeVisible();
});

test("blocks an unsupported document instead of sending text only", async () => {
  app = await launchFakeApp({ launch: { env: { PI_DESKTOP_ATTACHMENTS: "1" } } });
  const composer = await startSession(app);

  await dropFile(app, { name: "report.pdf", text: "%PDF-1.7", mime: "application/pdf" });
  await expect(app.window.getByText("This file format cannot be sent directly.")).toBeVisible({
    timeout: 30_000,
  });
  app.provider.enqueue({ kind: "text", text: "must not arrive" });
  await composer.fill("Summarize the report");
  await expect(app.window.getByRole("button", { name: "Send", exact: true })).toBeDisabled({
    timeout: 5_000,
  });
  await expect(app.window.getByText("must not arrive")).toBeHidden({ timeout: 2_000 });
});

test("does not consume selected files for a slash command", async () => {
  app = await launchFakeApp({ launch: { env: { PI_DESKTOP_ATTACHMENTS: "1" } } });
  const composer = await startSession(app);

  await dropFile(app, { name: "notes.txt", text: "keep me", mime: "text/plain" });
  await expect(app.window.getByText("notes.txt")).toBeVisible({ timeout: 30_000 });
  await composer.fill("/help");
  await composer.press("Enter");
  // The tray keeps the file; a command must not silently send or drop it.
  await expect(app.window.getByText("notes.txt")).toBeVisible();
});
