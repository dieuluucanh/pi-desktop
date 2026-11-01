import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Source control and folder checkpoints E2E (git-checkpoint plan step 30).
 *
 * This is the only test that exercises the whole chain — renderer → IPC →
 * service → real `git` → a real folder — so it asserts outcomes a unit test
 * cannot: that a file edited *outside* the app shows up under Changes, that a
 * commit reaches the real log, and that a restore round-trips through the rail's
 * own buttons and then Undo puts the second edit back.
 *
 * A second test removes `git` from `PATH` and asserts the *explicit* disabled
 * states. The supervisor prepends its own `binDir` shims, which cover
 * `node`/`npm`/`npx`/`pi` only — git really is absent, which is the R1 case.
 */

/** True when a `git` answers; the whole file skips without one. */
function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = hasGit();

let app: FakeApp | undefined;

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

/** Runs git in the project with the env a CI box needs (no prompts, no hooks). */
function git(projectDir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "E2E",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "E2E",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });
}

/** Turns the seeded project into a repository with one commit. */
function initRepo(projectDir: string): void {
  git(projectDir, ["init", "-b", "main"]);
  git(projectDir, ["config", "user.name", "E2E"]);
  git(projectDir, ["config", "user.email", "e2e@example.com"]);
  git(projectDir, ["config", "commit.gpgsign", "false"]);
  // The fixture writes LF; a Windows git default would otherwise rewrite it and
  // make the "unchanged" assertions lie.
  git(projectDir, ["config", "core.autocrlf", "false"]);
  git(projectDir, ["add", "-A"]);
  git(projectDir, ["commit", "-m", "chore: seed"]);
}

/**
 * Grants the one-time git write consent if the dialog appears.
 *
 * Every mutating git command (stage, commit, discard, stash…) asks once per
 * session whether the app may write to the repository. The dialog is modal over
 * the panel, so any test that stages a file must answer it or the click lands on
 * a disabled surface and times out.
 */
async function grantGitConsent(current: FakeApp): Promise<void> {
  const allow = current.window.getByRole("button", { name: /allow and continue/i });
  if (await allow.isVisible().catch(() => false)) await allow.click();
}

/**
 * Opens the panel on one menu.
 *
 * The strip is always mounted now, so there is no "Panel" button to click and no
 * section header to expand — but clicking the *active* entry collapses the panel,
 * so the helper reads `aria-expanded` first and only clicks when it must.
 */
async function openRail(current: FakeApp, menu: "source-control" | "checkpoints"): Promise<void> {
  const entry = current.window.getByTestId(`rail-menu-${menu}`);
  await expect(entry).toBeVisible({ timeout: 15_000 });
  if ((await entry.getAttribute("aria-expanded")) !== "true") await entry.click();
  await expect(current.window.getByTestId("rail-panel")).toBeVisible({ timeout: 15_000 });
}

test.describe("source control", () => {
  test.skip(!gitAvailable, "git is not on PATH; the source-control E2E skips");

  test("@smoke stages, commits and shows a file edited outside the app", async () => {
    app = await launchFakeApp();
    initRepo(app.projectDir);

    await app.window
      .getByRole("button", { name: /new session/i })
      .first()
      .click();
    await expect(app.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });

    // The header no longer carries a Panel button (it used to be gated on the
    // Office bridge, so it came and went); the strip is the entry point.
    await expect(app.window.getByRole("button", { name: /^panel$/i })).toHaveCount(0);
    await expect(app.window.getByTestId("rail-strip")).toBeVisible({ timeout: 15_000 });
    // The two unconditional menus are always offered, whatever Office is doing.
    // (Whether Documents appears depends on a real bridge answering on this
    // machine's port, so that rule is pinned by `right-rail.test.tsx` instead.)
    await expect(app.window.getByTestId("rail-menu-source-control")).toBeVisible();
    await expect(app.window.getByTestId("rail-menu-checkpoints")).toBeVisible();

    await openRail(app, "source-control");

    // The body is three blocks with their own scrollers, not one column.
    for (const id of ["source-control-block", "changes-block", "history-block"]) {
      await expect(app.window.getByTestId(id)).toBeVisible({ timeout: 15_000 });
    }

    // Edit a file *outside* the app: the poll must notice it, not a UI event.
    writeFileSync(join(app.projectDir, "README.md"), "# E2E project\n\nan outside edit\n", "utf8");
    const row = app.window.getByTestId("change-row-README.md");
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Stage it, then commit through the rail's own box.
    await row.getByRole("button", { name: /^stage /i }).click();
    // The first mutating command asks once whether the app may write here.
    await grantGitConsent(app);
    // The file moved from the Changes group into Staged Changes.
    await expect(
      app.window.getByTestId("changes-group-staged").getByTestId("change-row-README.md"),
    ).toBeVisible({ timeout: 15_000 });

    const message = app.window.getByLabel(/commit message/i);
    await message.fill("feat: an outside edit");
    await app.window
      .getByRole("button", { name: /commit (all|staged)|^commit$/i })
      .first()
      .click();

    // The real repository has the commit, with the message byte-exact.
    await expect
      .poll(() => git(app!.projectDir, ["log", "-1", "--format=%B"]).trim(), { timeout: 20_000 })
      .toBe("feat: an outside edit");

    // And it is in History, which reads the log rather than the earlier snapshot.
    // History is the bottom block of the already-open Source Control panel, with
    // its own scroller — so it is visible without re-opening the rail.
    await expect(
      app.window
        .getByTestId("history-block")
        .getByText(/an outside edit/)
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("collapses a change group and drags a block splitter", async () => {
    app = await launchFakeApp();
    initRepo(app.projectDir);
    writeFileSync(join(app.projectDir, "README.md"), "# E2E project\n\nchanged\n", "utf8");

    await app.window
      .getByRole("button", { name: /new session/i })
      .first()
      .click();
    await expect(app.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });
    await openRail(app, "source-control");

    await expect(app.window.getByTestId("change-row-README.md")).toBeVisible({ timeout: 20_000 });

    // Collapsing `Changes` hides its rows but keeps the header and the count.
    await app.window.getByTestId("changes-group-toggle-changed").click();
    await expect(app.window.getByTestId("change-row-README.md")).toHaveCount(0);
    await expect(app.window.getByTestId("changes-group-changed")).toBeVisible();

    // Re-expanding restores them (the fold is a preference, not a one-way trip).
    await app.window.getByTestId("changes-group-toggle-changed").click();
    await expect(app.window.getByTestId("change-row-README.md")).toBeVisible();

    // Dragging the top splitter changes the block heights. jsdom cannot do this
    // and a unit test cannot either, so it is asserted here via geometry.
    const top = app.window.getByTestId("source-control-block");
    const before = await top.boundingBox();
    const splitter = app.window.getByTestId("rail-splitter-top");
    const handle = await splitter.boundingBox();
    expect(before).not.toBeNull();
    expect(handle).not.toBeNull();
    await app.window.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await app.window.mouse.down();
    await app.window.mouse.move(handle!.x + handle!.width / 2, handle!.y + 80, { steps: 8 });
    // The blocks follow the pointer *before* release (2026-10-31 UI plan).
    const during = await top.boundingBox();
    expect(during).not.toBeNull();
    expect(during!.height).toBeGreaterThan(before!.height);
    await app.window.mouse.up();

    const after = await top.boundingBox();
    expect(after).not.toBeNull();
    // Grow only (the drag is downward), and never past the panel.
    expect(after!.height).toBeGreaterThan(before!.height);
  });

  test("refuses to enable a discarded untracked file's return (trash, not delete)", async () => {
    app = await launchFakeApp();
    initRepo(app.projectDir);
    const target = join(app.projectDir, "scratch.txt");
    writeFileSync(target, "temporary\n", "utf8");

    await app.window
      .getByRole("button", { name: /new session/i })
      .first()
      .click();
    await expect(app.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });
    await openRail(app, "source-control");

    const row = app.window.getByTestId("change-row-scratch.txt");
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button", { name: /discard|move to trash/i }).click();

    // The confirmation names the file and the trash, then the file is gone from
    // the working tree (it is in the OS trash, which a test cannot inspect).
    const dialog = app.window.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("scratch.txt");
    // The untracked case is worded as the trash, never as a delete.
    await expect(dialog).toContainText(/trash/i);
    await dialog.getByRole("button", { name: /move to trash/i }).click();
    // Confirming the discard is the first mutating command here, so *now* the
    // one-time write consent asks — after the app's own confirmation, not before.
    await grantGitConsent(app);

    // Two honest outcomes, and neither one is a silent delete:
    //  - the OS trash accepted the file, so it is gone from the work tree;
    //  - the trash is unavailable on this volume (a sandboxed temp dir can refuse
    //    it), so the file is still there *and* the panel says exactly that.
    await expect
      .poll(
        async () => {
          if (!existsSync(target)) return "moved";
          const error = app!.window.getByTestId("git-error");
          return (await error.isVisible().catch(() => false)) &&
            (await error.innerText()).match(/trash/i)
            ? "refused"
            : "pending";
        },
        { timeout: 15_000 },
      )
      .not.toBe("pending");

    if (existsSync(target)) {
      // Refused: the app must say so and must not have deleted the file itself.
      await expect(app.window.getByTestId("git-error")).toContainText(/trash/i);
    } else {
      // Moved: `git checkout`-style revert never applies to an untracked file, so
      // the only way it disappears is the trash.
      expect(existsSync(target)).toBe(false);
    }
  });
});

test.describe("folder checkpoints", () => {
  test.skip(!gitAvailable, "checkpoints need git; the E2E skips without it");

  test("@smoke snapshots, previews, restores and undoes", async () => {
    app = await launchFakeApp();
    const notes = join(app.projectDir, "notes.txt");
    writeFileSync(notes, "first version\n", "utf8");

    await app.window
      .getByRole("button", { name: /new session/i })
      .first()
      .click();
    await expect(app.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });
    await openRail(app, "checkpoints");

    await app.window.getByTestId("checkpoint-create").click();
    await expect(app.window.getByTestId("checkpoint-detail").first()).toBeVisible({
      timeout: 20_000,
    });

    // Mutate the folder, then restore the checkpoint.
    writeFileSync(notes, "second version\n", "utf8");
    await app.window
      .getByTestId(/checkpoint-restore-/)
      .first()
      .click();
    const dialog = app.window.getByTestId("restore-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("notes.txt");
    await app.window.getByTestId("restore-confirm").click();

    await expect
      .poll(() => readFileSync(notes, "utf8"), { timeout: 20_000 })
      .toBe("first version\n");

    // Undo restores the pre-restore snapshot, so the second edit is back.
    await app.window.getByTestId("checkpoint-undo").click();
    await expect
      .poll(() => readFileSync(notes, "utf8"), { timeout: 20_000 })
      .toBe("second version\n");
  });

  test("works in a folder with no repository at all", async () => {
    // Deliberately *not* `initRepo`: this is the Office-folder case.
    app = await launchFakeApp();
    const doc = join(app.projectDir, "Report.docx");
    writeFileSync(doc, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x01]));

    await app.window
      .getByRole("button", { name: /new session/i })
      .first()
      .click();
    await expect(app.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });
    await openRail(app, "checkpoints");

    await app.window.getByTestId("checkpoint-create").click();
    await expect(app.window.getByTestId("checkpoint-detail").first()).toBeVisible({
      timeout: 20_000,
    });

    // The project's own folder stays untouched: checkpoints never create a `.git`.
    expect(existsSync(join(app.projectDir, ".git"))).toBe(false);
    expect(readFileSync(doc).length).toBe(7);
  });
});

test.describe("git missing (R1)", () => {
  test("states the disabled surfaces explicitly, never a silent failure", async () => {
    // A PATH with only the bare system directory: the supervisor's own shims
    // cover node/npm/npx/pi, so git really is absent here.
    const emptyPath = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin";
    app = await launchFakeApp({ launch: { env: { PATH: emptyPath } } });

    await app.window
      .getByRole("button", { name: /new session/i })
      .first()
      .click();
    await expect(app.window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });
    await openRail(app, "checkpoints");

    // The explicit state, with its instruction — not an empty timeline.
    const unavailable = app.window.getByTestId("checkpoints-unavailable");
    await expect(unavailable).toBeVisible({ timeout: 30_000 });
    await expect(unavailable).toContainText(/git/i);
    await expect(app.window.getByText(/not bundled/i)).toBeVisible();
  });
});
