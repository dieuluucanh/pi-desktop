import { describe, expect, it } from "vitest";
import { parseEditorCommand, resolveEditorCommand } from "../../src/main/editor-command";
import { openInExternalEditor } from "../../src/main/editor";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createFakeCommandRunner } from "../../src/main/office/exec";
import { normalize } from "node:path";

/**
 * The OS editor round trip (2026-10-26 session-parity plan step 21).
 *
 * The command string is parsed without a shell, the spawn is awaited (so a GUI
 * editor that exits immediately is still honest), and the scratch file never
 * outlives the edit.
 */

describe("parseEditorCommand", () => {
  it("splits a command with quoted arguments", () => {
    expect(parseEditorCommand('code --wait "/path with spaces/file.md"')).toEqual({
      editor: { command: "code", args: ["--wait", "/path with spaces/file.md"] },
      error: null,
    });
  });

  it("accepts a bare executable", () => {
    expect(parseEditorCommand("notepad").editor).toEqual({ command: "notepad", args: [] });
  });

  it("rejects shell metacharacters instead of handing them to a shell", () => {
    for (const raw of ["cat x | tee y", "code && rm -rf /", "code $(evil)", "code > out"]) {
      const result = parseEditorCommand(raw);
      expect(result.editor).toBeNull();
      expect(result.error).toMatch(/shell syntax/i);
    }
  });

  it("rejects an unbalanced quote", () => {
    expect(parseEditorCommand('code --wait "file.md').error).toMatch(/unbalanced/i);
  });

  it("treats an empty string as 'not configured'", () => {
    expect(parseEditorCommand("   ")).toEqual({ editor: null, error: null });
  });
});

describe("resolveEditorCommand", () => {
  it("prefers the setting, then $VISUAL, then $EDITOR", () => {
    expect(
      resolveEditorCommand({
        setting: "code --wait",
        env: { VISUAL: "vim", EDITOR: "nano" },
      }),
    ).toMatchObject({ editor: { command: "code" }, source: "externalEditor" });
    expect(resolveEditorCommand({ setting: null, env: { VISUAL: "vim" } })).toMatchObject({
      source: "VISUAL",
    });
    expect(resolveEditorCommand({ setting: null, env: { EDITOR: "nano" } })).toMatchObject({
      source: "EDITOR",
    });
    expect(resolveEditorCommand({})).toEqual({ editor: null, error: null, source: null });
  });
});

describe("openInExternalEditor", () => {
  function deps(runner = createFakeCommandRunner([{ command: "code", args: ["--wait"] }])) {
    const fs = createMemoryFsPort({ dirs: ["/scratch"] });
    return { fs, runner, scratchDir: "/scratch", setting: "code --wait", env: {} };
  }

  it("writes the draft, awaits the editor and returns the edited text", async () => {
    const context = deps(
      createFakeCommandRunner([{ command: "code", args: ["--wait"], stdout: "" }]),
    );
    // The fake runner does not touch the file; simulate the editor's write by
    // reading the same path after the call starts.
    const original = context.fs.writeTextFile.bind(context.fs);
    context.fs.writeTextFile = async (path, text) => {
      await original(path, text);
      // Pretend the editor appended a line before exiting.
      if (path.endsWith(".md")) await original(path, `${text}\nedited`);
    };

    const result = await openInExternalEditor(context, "original");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("edited");
    expect(result.source).toBe("externalEditor");
    // The scratch file is gone afterwards.
    expect([...context.fs.files.keys()].some((path) => path.includes("pi-editor-"))).toBe(false);
  });

  it("reports a missing executable and cleans the file", async () => {
    const context = deps(createFakeCommandRunner([{ command: "code", missing: true, code: 127 }]));
    const result = await openInExternalEditor(context, "draft");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect([...context.fs.files.keys()].some((path) => path.includes("pi-editor-"))).toBe(false);
  });

  it("keeps the draft untouched on a non-zero exit", async () => {
    const context = deps(createFakeCommandRunner([{ command: "code", code: 2 }]));
    const result = await openInExternalEditor(context, "draft");
    expect(result.ok).toBe(false);
    expect(result.text).toBeUndefined();
    expect(result.error).toMatch(/exit/i);
  });

  it("explains when nothing is configured", async () => {
    const context = { ...deps(), setting: null, env: {} };
    const result = await openInExternalEditor(context, "draft");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No external editor/i);
  });

  it("refuses a shell-syntax command before spawning", async () => {
    const context = { ...deps(), setting: "code --wait && rm -rf /" };
    const result = await openInExternalEditor(context, "draft");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/shell syntax/i);
    expect([...context.fs.files.keys()].some((path) => path === normalize("/scratch/x"))).toBe(
      false,
    );
  });
});
