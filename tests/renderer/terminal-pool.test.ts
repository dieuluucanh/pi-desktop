import { describe, expect, it } from "vitest";
import {
  TerminalPool,
  type PoolTerminal,
  type TerminalFactory,
  type TerminalOptionsPatch,
  type TerminalPoolOptions,
} from "../../src/renderer/src/terminal/terminal-pool";
import { terminalThemeFromCssVariables } from "../../src/shared/terminal-theme";

function options(overrides: Partial<TerminalPoolOptions> = {}): TerminalPoolOptions {
  return {
    cols: 80,
    rows: 24,
    fontSize: 13,
    fontFamily: null,
    scrollback: 10_000,
    cursorStyle: "block",
    cursorBlink: true,
    macOptionIsMeta: false,
    theme: terminalThemeFromCssVariables(() => ""),
    ...overrides,
  };
}

class FakeTerm implements PoolTerminal {
  readonly element = document.createElement("div");
  readonly writes: Uint8Array[] = [];
  readonly themes: unknown[] = [];
  readonly optionPatches: TerminalOptionsPatch[] = [];
  disposed = 0;
  focused = 0;

  write(bytes: Uint8Array, callback?: () => void): void {
    this.writes.push(bytes);
    callback?.();
  }

  focus(): void {
    this.focused += 1;
  }

  dispose(): void {
    this.disposed += 1;
  }

  fit(): { cols: number; rows: number } {
    return { cols: 100, rows: 40 };
  }

  getSelection(): string {
    return "";
  }

  clearSelection(): void {}

  selectAll(): void {}

  clear(): void {}

  findNext(): boolean {
    return true;
  }

  findPrevious(): boolean {
    return false;
  }

  setTheme(theme: unknown): void {
    this.themes.push(theme);
  }

  setOptions(options: TerminalOptionsPatch): void {
    this.optionPatches.push(options);
  }

  onData(): () => void {
    return () => undefined;
  }

  attachKeyHandler(): void {}

  paste(): void {}

  onTitleChange(): () => void {
    return () => undefined;
  }

  onSelectionChange(): () => void {
    return () => undefined;
  }

  onBell(): () => void {
    return () => undefined;
  }
}

function createPool() {
  const terms: FakeTerm[] = [];
  const creations: TerminalPoolOptions[] = [];
  const factory: TerminalFactory = {
    create(input) {
      creations.push(input);
      const term = new FakeTerm();
      terms.push(term);
      return term;
    },
  };
  return { pool: new TerminalPool(factory), terms, creations };
}

describe("TerminalPool", () => {
  it("creates a terminal once and keeps its element inside the container", () => {
    const { pool, terms, creations } = createPool();
    const first = pool.create("t-1", options());
    const second = pool.create("t-1", options({ fontSize: 20 }));
    expect(second).toBe(first);
    expect(terms).toHaveLength(1);
    expect(creations).toHaveLength(1);
    expect(first.container.dataset.terminalId).toBe("t-1");
    expect(first.container.contains(terms[0]!.element)).toBe(true);
    expect(pool.has("t-1")).toBe(true);
  });

  it("moves the container between hosts instead of recreating the terminal", () => {
    const { pool, terms } = createPool();
    pool.create("t-1", options());
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    document.body.append(firstHost, secondHost);

    expect(pool.mount("t-1", firstHost)).toBe(true);
    expect(firstHost.contains(terms[0]!.element)).toBe(true);

    pool.detach("t-1");
    expect(terms[0]!.element.isConnected).toBe(false);
    expect(pool.has("t-1")).toBe(true);

    pool.mount("t-1", secondHost);
    expect(secondHost.contains(terms[0]!.element)).toBe(true);
    expect(terms).toHaveLength(1);
    expect(terms[0]!.disposed).toBe(0);
  });

  it("routes writes, focus and fit to the pooled terminal", () => {
    const { pool, terms } = createPool();
    pool.create("t-1", options());
    let written = 0;
    expect(pool.write("t-1", new Uint8Array([1, 2, 3]), () => (written += 1))).toBe(true);
    expect(terms[0]!.writes).toHaveLength(1);
    expect(written).toBe(1);
    expect(pool.focus("t-1")).toBe(true);
    expect(terms[0]!.focused).toBe(1);
    expect(pool.fit("t-1")).toEqual({ cols: 100, rows: 40 });
  });

  it("returns false/null for an unknown terminal", () => {
    const { pool } = createPool();
    expect(pool.write("nope", new Uint8Array())).toBe(false);
    expect(pool.focus("nope")).toBe(false);
    expect(pool.fit("nope")).toBeNull();
  });

  it("fans theme and appearance changes out to every terminal", () => {
    const { pool, terms } = createPool();
    pool.create("t-1", options());
    pool.create("t-2", options());
    const theme = terminalThemeFromCssVariables(() => "");
    pool.setTheme(theme);
    pool.setOptions({ fontSize: 16, fontFamily: "Consolas, monospace" });
    for (const term of terms) {
      expect(term.themes).toEqual([theme]);
      expect(term.optionPatches).toEqual([{ fontSize: 16, fontFamily: "Consolas, monospace" }]);
    }
  });

  it("disposes one terminal and all of them", () => {
    const { pool, terms } = createPool();
    pool.create("t-1", options());
    pool.create("t-2", options());
    pool.dispose("t-1");
    expect(terms[0]!.disposed).toBe(1);
    expect(pool.has("t-1")).toBe(false);
    expect(pool.has("t-2")).toBe(true);
    pool.disposeAll();
    expect(terms[1]!.disposed).toBe(1);
    expect(pool.has("t-2")).toBe(false);
  });
});
