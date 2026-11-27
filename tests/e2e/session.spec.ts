import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * Prompt history must follow **displayed** rows (2026-11-15 composer-soft-wrap
 * plan). jsdom has no layout, so this is the only proof that a soft-wrapped
 * draft keeps its native caret movement: the old logical-line gate recalled
 * history from every wrapped row.
 */
test("walks a soft-wrapped draft with Up and recalls history only at the top", async () => {
  const current = (app = await launchFakeApp());
  const composer = await startSession(current);

  // One sent prompt becomes the newest history entry.
  current.provider.enqueue({ kind: "text", text: "seed reply" });
  await composer.fill("seed prompt");
  await composer.press("Enter");
  await expect(current.window.getByText("seed reply")).toBeVisible({ timeout: 30_000 });

  // No `\n`: the composer must wrap this into several displayed rows.
  const wrapped = "lorem ipsum ".repeat(60).trim();
  await composer.fill(wrapped);
  const caretAtEnd = await composer.evaluate(
    (node) => (node as HTMLTextAreaElement).selectionStart,
  );
  expect(caretAtEnd).toBeGreaterThan(0);

  // The end of the value is the last displayed row. Count the rows from the
  // textarea's own layout (not the mirror under test), then walk to the top.
  const displayedRows = async (): Promise<number> =>
    composer.evaluate((node) => {
      const ta = node as HTMLTextAreaElement;
      const styles = getComputedStyle(ta);
      const lineHeight = Number.parseFloat(styles.getPropertyValue("line-height"));
      const paddingTop = Number.parseFloat(styles.getPropertyValue("padding-top") || "0");
      const paddingBottom = Number.parseFloat(styles.getPropertyValue("padding-bottom") || "0");
      return Math.max(1, Math.round((ta.scrollHeight - paddingTop - paddingBottom) / lineHeight));
    });

  const rows = await displayedRows();
  expect(rows).toBeGreaterThan(1);

  // Up on the last row moves the caret; it does not recall history.
  await composer.press("ArrowUp");
  const afterFirstUp = await composer.evaluate(
    (node) => (node as HTMLTextAreaElement).selectionStart,
  );
  await expect(composer).toHaveValue(wrapped);
  expect(afterFirstUp).toBeLessThan(caretAtEnd);

  // `rows - 1` presses reach the first displayed row; the draft survives all of
  // them, including the nonzero column the browser keeps at the top.
  for (let press = 1; press < rows - 1; press += 1) {
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(wrapped);
  }
  const topCaret = await composer.evaluate((node) => (node as HTMLTextAreaElement).selectionStart);
  // The top row is reached at a nonzero offset: recall is not "offset 0".
  expect(topCaret).toBeGreaterThan(0);
  await expect(composer).toHaveValue(wrapped);

  // Only the press from the first displayed row leaves the draft.
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("seed prompt");

  // Hard newlines and an empty line use the same displayed-row gate.
  const hard = "first line\nsecond line\n\nfourth line";
  await composer.fill(hard);
  await expect(composer).toHaveValue(hard);
  const hardRows = await displayedRows();
  expect(hardRows).toBe(4);

  await composer.press("ArrowUp");
  await expect(composer).toHaveValue(hard);
  for (let press = 1; press < hardRows - 1; press += 1) {
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(hard);
  }
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("seed prompt");
});

/**
 * The transcript column must be the pane width, not a fixed measure
 * (2026-11-15 transcript-width).
 *
 * Display zoom scales CSS px (`webContents.setZoomFactor`), so zooming out
 * grows the CSS-px pane. The old `--transcript-measure: 110ch` cap was absolute
 * in CSS px (≈980 px at the 16 px root font), so the column stayed put while
 * the pane grew: at 50 % zoom it filled ~50 % of the pane with empty gutters on
 * both sides. jsdom has no layout engine, so this is the only real guard.
 */
async function transcriptWidths(current: FakeApp): Promise<{ pane: number; content: number }> {
  return current.window.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    const content = document.querySelector<HTMLElement>('[data-testid="transcript-content"]');
    if (!scroll || !content) throw new Error("transcript is not mounted");
    return { pane: scroll.clientWidth, content: content.getBoundingClientRect().width };
  });
}

test("fills the pane with the transcript at every zoom level", async () => {
  const current = (app = await launchFakeApp());
  const composer = await startSession(current);
  current.provider.enqueue({ kind: "text", text: "a line of prose in the transcript" });
  await composer.fill("Fill the pane");
  await composer.press("Enter");
  await expect(current.window.getByText("a line of prose in the transcript")).toBeVisible({
    timeout: 30_000,
  });

  // The scroll area's `px-4` is the only inset: 16 px on each side.
  const fill = async (): Promise<number> => {
    const { pane, content } = await transcriptWidths(current);
    return Math.round((content / (pane - 32)) * 100) / 100;
  };
  const contentWidth = async (): Promise<number> => (await transcriptWidths(current)).content;

  await expect.poll(fill, { timeout: 10_000 }).toBeGreaterThanOrEqual(0.99);
  const width100 = await contentWidth();

  // 100 % → 50 % is five levels of `ZOOM_LEVELS`.
  for (const percent of [90, 80, 75, 67, 50]) {
    await current.menuCommand("zoom-out");
    await expect.poll(() => current.zoomPercent(), { timeout: 15_000 }).toBe(percent);
    await expect.poll(fill, { timeout: 10_000 }).toBeGreaterThanOrEqual(0.99);
  }

  // Growing, not parked at the retired ~980 px cap.
  await expect.poll(contentWidth, { timeout: 10_000 }).toBeGreaterThan(width100 + 200);

  await current.menuCommand("zoom-reset");
});

test("prints multi-line info command output in the transcript with default prefs", async () => {
  const current = (app = await launchFakeApp({
    launch: {
      extensions: {
        "audit-output.js": `export default function (pi) {
  pi.registerCommand("audit", {
    description: "Print multi-line command output",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Folder policy: cwd\\n  outside: ask\\n  base: C:/repo", "info");
    },
  });
}`,
      },
    },
  }));
  const composer = await startSession(current);
  const requestsBefore = current.provider.requests.length;
  await composer.fill("/audit");
  await composer.press("Enter");

  // Info notifications are off for the bell by default; the transcript must
  // still print extension command output, exactly like terminal Pi.
  const notice = current.window
    .getByTestId("transcript-notice-text")
    .filter({ hasText: "Folder policy: cwd" });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("outside: ask");
  expect(current.provider.requests).toHaveLength(requestsBefore);
});

test("closes a starting session once without startup errors or resurrection", async () => {
  test.setTimeout(180_000);
  const held: Array<{ release(): void }> = [];
  const queued: Array<() => void> = [];
  const waiting: Array<(release: () => void) => void> = [];
  let gateServer: Server | undefined;
  const rendererFailures: string[] = [];
  const base = await new Promise<string>((resolve, reject) => {
    gateServer = createServer((_request, response) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (!response.destroyed) response.writeHead(204).end();
      };
      held.push({ release });
      const waiter = waiting.shift();
      if (waiter) waiter(release);
      else queued.push(release);
    });
    gateServer.once("error", reject);
    gateServer.listen(0, "127.0.0.1", () => {
      const address = gateServer?.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/hold`);
    });
  });
  const nextGate = (): Promise<() => void> => {
    const ready = queued.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => waiting.push(resolve));
  };
  const releaseAll = (): void => {
    for (const gate of held) gate.release();
    for (const release of waiting.splice(0)) release(() => undefined);
  };
  const extension = `export default function (pi) {
  pi.on("session_start", async () => {
    await fetch(${JSON.stringify(base)});
  });
}`;

  try {
    const current = (app = await launchFakeApp({
      launch: { extensions: { "startup-gate.js": extension } },
    }));
    current.window.on("pageerror", (error) => rendererFailures.push(`pageerror: ${error.message}`));
    current.window.on("console", (message) => {
      if (message.type() === "error") rendererFailures.push(`console: ${message.text()}`);
    });
    await expect(
      current.window.getByRole("button", { name: /new session/i }).first(),
    ).toBeVisible();
    await expect(current.window.getByRole("heading", { name: "Pi Desktop" })).toBeVisible();

    // Keep the bridge calls explicit in page context; no production test hooks are exposed.
    const list = async (): Promise<{
      tabs: Array<{ id: string; kind: string; status: string }>;
      activeTabId: string | null;
    }> =>
      current.window.evaluate(async () =>
        (
          window as unknown as { pi: { sessions: { list(): Promise<unknown> } } }
        ).pi.sessions.list(),
      ) as Promise<{
        tabs: Array<{ id: string; kind: string; status: string }>;
        activeTabId: string | null;
      }>;
    const diagnostics = async (): Promise<{
      hosts: Array<{ tabId: string; pid: number | null; logLines: string[] }>;
    }> =>
      current.window.evaluate(async () =>
        (
          window as unknown as { pi: { diagnostics: { get(): Promise<unknown> } } }
        ).pi.diagnostics.get(),
      ) as Promise<{ hosts: Array<{ tabId: string; pid: number | null; logLines: string[] }> }>;
    const ensure = async (tabId: string): Promise<void> => {
      await current.window.evaluate(async (id) => {
        const pi = (
          window as unknown as { pi: { sessions: { ensure(id: string): Promise<unknown> } } }
        ).pi;
        await pi.sessions.ensure(id);
      }, tabId);
    };
    const openStarting = async (): Promise<{ id: string; release: () => void }> => {
      const gate = nextGate();
      await current.window
        .getByRole("button", { name: /new session/i })
        .first()
        .click();
      const release = await gate;
      const startingDot = current.window.locator('[data-status="starting"]').last();
      await expect(startingDot).toBeVisible({ timeout: 30_000 });
      const tab = startingDot.locator("xpath=ancestor::*[@data-tab-id]");
      const id = await tab.getAttribute("data-tab-id");
      expect(id, "starting tab must expose its real main-process tab id").toBeTruthy();
      return { id: id!, release };
    };
    const closeByX = async (id: string): Promise<void> => {
      await current.window
        .locator(`[data-testid="tab-${id}"] button[aria-label^="Close "]`)
        .click();
    };
    const getMainOutput = (): string => current.stderr.join("");
    const closedHostPid = async (id: string): Promise<number | null> =>
      (await diagnostics()).hosts.find((host) => host.tabId === id)?.pid ?? null;
    const closedIds: string[] = [];
    const requestDiagnostics: string[] = [];

    // A real ready tab is the survivor; closing another starting tab must select it.
    const previous = await openStarting();
    previous.release();
    await expect(current.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });
    await ensure(previous.id); // settles the actual create/activate lifecycle, not merely the green dot
    await expect(
      current.window.locator(`[data-testid="tab-${previous.id}"] [data-status="idle"]`),
    ).toBeVisible();

    for (let iteration = 0; iteration < 2; iteration += 1) {
      const starting = await openStarting();
      // Capture identities and diagnostics before the single close gesture.
      const pid = await closedHostPid(starting.id);
      const hostBeforeClose = (await diagnostics()).hosts.find(
        (host) => host.tabId === starting.id,
      );
      requestDiagnostics.push(...(hostBeforeClose?.logLines ?? []));
      closedIds.push(starting.id);
      await closeByX(starting.id);
      await expect(current.window.locator(`[data-testid="tab-${starting.id}"]`)).toHaveCount(0);
      await expect(
        current.window.locator(`[data-testid="tab-${previous.id}"] [role="tab"]`),
      ).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      starting.release();
      const now = await list();
      expect(now.tabs.some((tab) => tab.id === starting.id)).toBe(false);
      expect(now.activeTabId).toBe(previous.id);
      expect(pid, `host pid unavailable for ${starting.id}`).not.toBeNull();
      expect((await diagnostics()).hosts.some((host) => host.tabId === starting.id)).toBe(false);
      if (pid !== null) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive, `closed host process ${pid} for ${starting.id} remains alive`).toBe(false);
      }
    }

    // The ready-tab close control works too. With no remaining tab, an early close
    // returns to Welcome; this is repeated in the same launch, not only at restore.
    await closeByX(previous.id);
    await expect(
      current.window.getByRole("button", { name: /new session/i }).first(),
    ).toBeVisible();
    const finalStarting = await openStarting();
    const finalPid = await closedHostPid(finalStarting.id);
    const finalHostBeforeClose = (await diagnostics()).hosts.find(
      (host) => host.tabId === finalStarting.id,
    );
    requestDiagnostics.push(...(finalHostBeforeClose?.logLines ?? []));
    closedIds.push(finalStarting.id);
    await closeByX(finalStarting.id);
    await expect(current.window.locator(`[data-testid="tab-${finalStarting.id}"]`)).toHaveCount(0);
    await expect(current.window.getByRole("heading", { name: "Pi Desktop" })).toBeVisible({
      timeout: 30_000,
    });
    finalStarting.release();

    const finalTabs = await list();
    expect(finalTabs.tabs.some((tab) => tab.id === finalStarting.id)).toBe(false);
    expect(finalTabs.activeTabId).toBeNull();
    expect(finalPid).not.toBeNull();
    expect((await diagnostics()).hosts.some((host) => host.tabId === finalStarting.id)).toBe(false);
    if (finalPid !== null) {
      let alive = true;
      try {
        process.kill(finalPid, 0);
      } catch {
        alive = false;
      }
      expect(alive, `closed host process ${finalPid} for ${finalStarting.id} remains alive`).toBe(
        false,
      );
    }
    const expectedCloseErrors = /host_stopped|tab-closed|unknown tab/i;
    const mainOutput = getMainOutput();
    expect(
      mainOutput,
      `tab=${finalStarting.id}; renderer=${rendererFailures.join("\n")}`,
    ).not.toMatch(expectedCloseErrors);
    expect(rendererFailures.join("\n"), `main stderr:\n${mainOutput}`).not.toMatch(
      expectedCloseErrors,
    );

    // Diagnostics identifies any session request method in host log lines without
    // assuming the unlabelled request in the original report was messages.get.
    test.info().annotations.push({
      type: "close-diagnostics",
      description: JSON.stringify({
        closedTabIds: closedIds,
        identifiableRequestMethodsOrHostLogs: requestDiagnostics,
        rendererFailures,
        stderr: mainOutput,
      }),
    });
  } finally {
    releaseAll();
    gateServer?.closeAllConnections();
    if (gateServer?.listening)
      await new Promise<void>((resolve) => gateServer!.close(() => resolve()));
    if (app) {
      const paths = app.paths;
      try {
        await app.shutdown();
      } finally {
        removeTempDirs(paths);
        app = undefined;
      }
    }
  }
});
