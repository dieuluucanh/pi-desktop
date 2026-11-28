import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCROLL_MEMORY_LIMIT,
  forgetScroll,
  recallScroll,
  rememberScroll,
  resetScrollMemory,
} from "../../src/renderer/src/rail/scroll-memory";
import { useScrollMemory } from "../../src/renderer/src/rail/use-scroll-memory";

/**
 * The rail scroll memory (2026-11-25 rail scroll plan step 5).
 *
 * jsdom has no layout and no `ResizeObserver`, so these tests prime the
 * scroller's geometry by hand (the same technique as
 * `transcript-scroll.test.tsx`) and drive the fallback rAF loop. The geometry's
 * `scrollTop` setter clamps like a browser, so a restore that cannot be held
 * yet must keep retrying rather than pretend it landed.
 */

function Harness({ memoryKey, ready = true }: { memoryKey: string; ready?: boolean }) {
  const ref = useScrollMemory({ key: memoryKey, ready });
  return (
    <div ref={ref} data-testid="scroller">
      <div data-testid="content">rows</div>
    </div>
  );
}

interface Geometry {
  read(): number;
  write(value: number): void;
  setContentHeight(value: number): void;
}

/** jsdom reports zero metrics; give the scroller a fixed, clamping geometry. */
function primeGeometry(element: HTMLElement, content = 1_000): Geometry {
  const viewport = 400;
  let scrollHeight = content;
  const max = (): number => Math.max(0, scrollHeight - viewport);
  // Keep whatever the restore already wrote (clamped like a browser would), so
  // priming the geometry does not erase the effect's first assignment.
  let top = Math.max(0, Math.min(element.scrollTop, max()));
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: viewport });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, max()));
    },
  });
  return {
    read: () => top,
    write: (value) => {
      top = Math.max(0, Math.min(value, max()));
    },
    setContentHeight: (value) => {
      scrollHeight = value;
    },
  };
}

function scroller(): HTMLElement {
  return screen.getByTestId("scroller");
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Let rAF-throttled save/restore work run, inside `act` for safety. */
async function settle(frames = 2): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await act(async () => {
      await nextFrame();
    });
  }
}

/** Mount a block, scroll it, let the save land, then unmount. */
async function mountAndSave(key: string, top: number): Promise<void> {
  const view = render(<Harness memoryKey={key} />);
  const geometry = primeGeometry(scroller());
  geometry.write(top);
  fireEvent.scroll(scroller());
  await settle();
  view.unmount();
}

/** Mount a block, read what the restore produced, then unmount. */
async function mountAndRead(key: string): Promise<number> {
  const view = render(<Harness memoryKey={key} />);
  const geometry = primeGeometry(scroller());
  await settle(2);
  const top = geometry.read();
  view.unmount();
  return top;
}

beforeEach(() => {
  resetScrollMemory();
});

describe("scroll-memory", () => {
  it("evicts the least-recently-used entry once past the cap", () => {
    for (let index = 0; index < SCROLL_MEMORY_LIMIT; index += 1) {
      rememberScroll(`key-${index}`, index);
    }

    // Reading is a touch, so key-0 must outlive key-1 when the cap overflows.
    expect(recallScroll("key-0")).toBe(0);
    rememberScroll("new", 99);

    expect(recallScroll("key-1")).toBeUndefined();
    expect(recallScroll("key-0")).toBe(0);
    expect(recallScroll("new")).toBe(99);
  });

  it("forgets one key without disturbing the others", () => {
    rememberScroll("a", 10);
    rememberScroll("b", 20);

    forgetScroll("a");

    expect(recallScroll("a")).toBeUndefined();
    expect(recallScroll("b")).toBe(20);
  });
});

describe("useScrollMemory", () => {
  it("saves an offset and restores it after a remount", async () => {
    const first = render(<Harness memoryKey="changes:/project-a" />);
    const geometry = primeGeometry(scroller());
    geometry.write(500);
    fireEvent.scroll(scroller());
    await settle();
    expect(recallScroll("changes:/project-a")).toBe(500);
    first.unmount();

    render(<Harness memoryKey="changes:/project-a" />);
    const restored = primeGeometry(scroller());
    await settle(2);

    expect(restored.read()).toBe(500);
  });

  it("keeps two keys isolated", async () => {
    await mountAndSave("changes:/project-a", 400);
    await mountAndSave("changes:/project-b", 120);

    expect(await mountAndRead("changes:/project-a")).toBe(400);
    expect(await mountAndRead("changes:/project-b")).toBe(120);
  });

  it("does not save anything while the block is not ready", async () => {
    render(<Harness memoryKey="changes:/project-a" ready={false} />);
    const geometry = primeGeometry(scroller());
    geometry.write(500);
    fireEvent.scroll(scroller());
    await settle(2);

    expect(recallScroll("changes:/project-a")).toBeUndefined();
  });

  it("lets a wheel gesture win and stops the pending restore", async () => {
    rememberScroll("changes:/project-a", 500);
    render(<Harness memoryKey="changes:/project-a" />);
    // 800 - 400 = 400 px, so the 500 px offset cannot be held yet.
    const geometry = primeGeometry(scroller(), 800);
    await settle(1);

    fireEvent.wheel(scroller(), { deltaY: -120 });
    geometry.write(80);
    fireEvent.scroll(scroller());
    await settle(1);

    // The list finally has room, but the reader already took the viewport.
    geometry.setContentHeight(2_000);
    await settle(3);

    expect(geometry.read()).toBe(80);
  });

  it("restores a late content growth within the deadline", async () => {
    rememberScroll("changes:/project-a", 500);
    render(<Harness memoryKey="changes:/project-a" />);
    // The loading block is shorter than the viewport: nothing to hold 500 px.
    const geometry = primeGeometry(scroller(), 300);
    await settle(1);
    expect(geometry.read()).toBe(0);

    geometry.setContentHeight(1_500);
    await settle(3);

    expect(geometry.read()).toBe(500);
  });
});
