import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PREFS,
  DEFAULT_TERMINAL_FONT_SIZE,
  isAbsoluteTerminalPath,
  isTerminalFontFamily,
  isTerminalProfileId,
  mergeTerminalPrefs,
  sanitizeTerminalPrefs,
} from "../../src/shared/terminal-prefs";
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs } from "../../src/shared/prefs";

describe("terminal prefs defaults", () => {
  it("supplies a complete block when the preference is missing", () => {
    expect(sanitizeTerminalPrefs(undefined)).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(sanitizeTerminalPrefs("nope")).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("is wired into the app prefs with a fresh object", () => {
    expect(DEFAULT_PREFS.terminal).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(DEFAULT_PREFS.terminal).not.toBe(DEFAULT_TERMINAL_PREFS);
    expect(sanitizePrefs({}).terminal).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("starts new profiles at 14 px but leaves a stored 13 untouched", () => {
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBe(14);
    expect(sanitizeTerminalPrefs(undefined).fontSize).toBe(14);
    expect(sanitizeTerminalPrefs({ fontSize: 13 }).fontSize).toBe(13);
  });
});

describe("sanitizeTerminalPrefs", () => {
  it("clamps font size and scrollback to their supported ranges", () => {
    expect(sanitizeTerminalPrefs({ fontSize: 400 }).fontSize).toBe(24);
    expect(sanitizeTerminalPrefs({ fontSize: 1 }).fontSize).toBe(11);
    expect(sanitizeTerminalPrefs({ fontSize: 15.6 }).fontSize).toBe(16);
    expect(sanitizeTerminalPrefs({ scrollback: 1 }).scrollback).toBe(1000);
    expect(sanitizeTerminalPrefs({ scrollback: 10_000_000 }).scrollback).toBe(50_000);
    expect(sanitizeTerminalPrefs({ scrollback: Number.NaN }).scrollback).toBe(10_000);
  });

  it("accepts only the three cursor styles", () => {
    expect(sanitizeTerminalPrefs({ cursorStyle: "bar" }).cursorStyle).toBe("bar");
    expect(sanitizeTerminalPrefs({ cursorStyle: "underline" }).cursorStyle).toBe("underline");
    expect(sanitizeTerminalPrefs({ cursorStyle: "beam" }).cursorStyle).toBe("block");
  });

  it("keeps an absolute shell path and drops a relative or malformed one", () => {
    expect(
      sanitizeTerminalPrefs({ shellPath: "C:\\Program Files\\Git\\bin\\bash.exe" }).shellPath,
    ).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(sanitizeTerminalPrefs({ shellPath: "/bin/zsh" }).shellPath).toBe("/bin/zsh");
    expect(sanitizeTerminalPrefs({ shellPath: "bash.exe" }).shellPath).toBeNull();
    expect(sanitizeTerminalPrefs({ shellPath: "" }).shellPath).toBeNull();
    expect(sanitizeTerminalPrefs({ shellPath: 3 }).shellPath).toBeNull();
  });

  it("keeps a one-line font family and drops control or CSS structural characters", () => {
    expect(sanitizeTerminalPrefs({ fontFamily: "  JetBrains Mono, monospace  " }).fontFamily).toBe(
      "JetBrains Mono, monospace",
    );
    expect(sanitizeTerminalPrefs({ fontFamily: "var(--font-mono)" }).fontFamily).toBe(
      "var(--font-mono)",
    );
    expect(sanitizeTerminalPrefs({ fontFamily: "Mono\nMalicious" }).fontFamily).toBeNull();
    expect(
      sanitizeTerminalPrefs({ fontFamily: "Mono; } body { color: red" }).fontFamily,
    ).toBeNull();
    expect(sanitizeTerminalPrefs({ fontFamily: "Mono</style>" }).fontFamily).toBeNull();
    expect(sanitizeTerminalPrefs({ fontFamily: "   " }).fontFamily).toBeNull();
    expect(sanitizeTerminalPrefs({ fontFamily: "x".repeat(201) }).fontFamily).toBeNull();
  });

  it("validates profile ids with one shared predicate", () => {
    for (const id of ["auto", "git-bash", "wsl-ubuntu", "posix-zsh", "custom"]) {
      expect(isTerminalProfileId(id), id).toBe(true);
    }
    for (const id of ["", "../x", "x y", "x".repeat(65), 3, null]) {
      expect(isTerminalProfileId(id), String(id)).toBe(false);
    }
    expect(isTerminalFontFamily("JetBrains Mono, monospace")).toBe(true);
    expect(isTerminalFontFamily("Mono; } body {}")).toBe(false);
  });

  it("falls back to auto for an unsafe profile id", () => {
    expect(sanitizeTerminalPrefs({ defaultProfile: "git-bash" }).defaultProfile).toBe("git-bash");
    expect(sanitizeTerminalPrefs({ defaultProfile: "../../etc/passwd" }).defaultProfile).toBe(
      "auto",
    );
    expect(sanitizeTerminalPrefs({ defaultProfile: "" }).defaultProfile).toBe("auto");
    expect(sanitizeTerminalPrefs({ defaultProfile: "x".repeat(65) }).defaultProfile).toBe("auto");
  });

  it("defaults every boolean explicitly", () => {
    const prefs = sanitizeTerminalPrefs({
      cursorBlink: "yes",
      copyOnSelection: 1,
      enableBell: "on",
      macOptionIsMeta: null,
    });
    expect(prefs.cursorBlink).toBe(true);
    expect(prefs.copyOnSelection).toBe(false);
    expect(prefs.enableBell).toBe(false);
    expect(prefs.macOptionIsMeta).toBe(false);

    const enabled = sanitizeTerminalPrefs({
      cursorBlink: false,
      copyOnSelection: true,
      enableBell: true,
      macOptionIsMeta: true,
    });
    expect(enabled).toEqual({
      ...DEFAULT_TERMINAL_PREFS,
      cursorBlink: false,
      copyOnSelection: true,
      enableBell: true,
      macOptionIsMeta: true,
    });
  });
});

describe("mergeTerminalPrefs", () => {
  it("keeps unspecified values when a patch names one key", () => {
    const current = {
      ...DEFAULT_TERMINAL_PREFS,
      defaultProfile: "git-bash",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      scrollback: 20_000,
    };
    const next = mergeTerminalPrefs(current, { fontSize: 16 });
    expect(next.fontSize).toBe(16);
    expect(next.defaultProfile).toBe("git-bash");
    expect(next.shellPath).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(next.scrollback).toBe(20_000);
  });

  it("merges through the app prefs without dropping the other blocks", () => {
    const next = mergePrefs(DEFAULT_PREFS, { terminal: { fontSize: 18 } });
    expect(next.terminal.fontSize).toBe(18);
    expect(next.terminal.defaultProfile).toBe(DEFAULT_TERMINAL_PREFS.defaultProfile);
    expect(next.editor).toEqual(DEFAULT_PREFS.editor);
    expect(next.rail).toEqual(DEFAULT_PREFS.rail);
  });

  it("never mutates the shared default object", () => {
    mergeTerminalPrefs(DEFAULT_TERMINAL_PREFS, { fontSize: 20, enableBell: true });
    expect(DEFAULT_TERMINAL_PREFS.fontSize).toBe(14);
    expect(DEFAULT_TERMINAL_PREFS.enableBell).toBe(false);
  });
});

describe("isAbsoluteTerminalPath", () => {
  it("recognises drive, UNC and POSIX paths", () => {
    expect(isAbsoluteTerminalPath("C:\\Windows")).toBe(true);
    expect(isAbsoluteTerminalPath("C:/Windows")).toBe(true);
    expect(isAbsoluteTerminalPath("\\\\server\\share\\x")).toBe(true);
    expect(isAbsoluteTerminalPath("/usr/bin/zsh")).toBe(true);
    expect(isAbsoluteTerminalPath("bin/zsh")).toBe(false);
    expect(isAbsoluteTerminalPath("~/.bashrc")).toBe(false);
  });
});
