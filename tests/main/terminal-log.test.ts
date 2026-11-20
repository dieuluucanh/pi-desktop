import { normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createTerminalLog } from "../../src/main/terminal-log";

const FILE = "/logs/terminal.log";
/** The in-memory port normalizes keys per platform (Windows uses `\`). */
const KEY = normalize(FILE);
const FIXED = Date.UTC(2026, 10, 8, 12, 0, 0);

function setup(maxChars = 1_000_000) {
  const fs = createMemoryFsPort();
  const log = createTerminalLog({ file: FILE, fs, maxChars, now: () => FIXED });
  return { fs, log };
}

/** The logger serializes writes; one microtask turn flushes the chain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createTerminalLog", () => {
  it("appends timestamped lines in order", async () => {
    const { fs, log } = setup();
    log.write("spawned terminal host");
    log.write("terminal host stderr: boom\n");
    await flush();

    expect(fs.files.get(KEY)).toBe(
      `2026-11-08T12:00:00.000Z  spawned terminal host\n` +
        `2026-11-08T12:00:00.000Z  terminal host stderr: boom\n`,
    );
  });

  it("keeps one previous segment when the cap is reached", async () => {
    const previous = `${"a".repeat(1100)}\n`;
    const fs = createMemoryFsPort({ files: { [FILE]: previous } });
    const log = createTerminalLog({ file: FILE, fs, maxChars: 1024, now: () => FIXED });
    log.write("the next line");
    await flush();

    expect(fs.files.get(normalize(`${FILE}.1`))).toBe(previous);
    expect(fs.files.get(KEY)).toBe(`2026-11-08T12:00:00.000Z  the next line\n`);
  });

  it("never throws when the filesystem fails", async () => {
    const fs = createMemoryFsPort();
    const failing = {
      readTextFile: async () => null,
      writeTextFile: async () => {
        throw new Error("EACCES");
      },
      appendTextFile: async () => {
        throw new Error("EACCES");
      },
    };
    const log = createTerminalLog({ file: FILE, fs: failing, now: () => FIXED });
    expect(() => log.write("still fine")).not.toThrow();
    await flush();
    expect(fs.files.size).toBe(0);
  });

  it("exposes the file path for Diagnostics", () => {
    const { log } = setup();
    expect(log.file).toBe(FILE);
  });
});
