import { describe, expect, it, vi } from "vitest";

import { createFooterFacts, type FooterFactsIo } from "../../src/host/footer-facts";

/**
 * Live footer facts for an extension `ctx.ui.setFooter()` component (row 28).
 *
 * What matters: the branch is read through the injected git port, a footer
 * subscription starts the poll and the last unsubscribe stops it, a repaint of
 * the same branch is silent, and the provider count is read at call time so it
 * never goes stale.
 */

function harness(branch: string | null = "main") {
  const runGit = vi.fn(async () => (branch === null ? null : `${branch}\n`));
  const io: FooterFactsIo = { runGit };
  let providerCount = 2;
  const timers: Array<{ callback: () => void; ms: number; stopped: boolean }> = [];
  const facts = createFooterFacts({
    cwd: "C:/work/app",
    io,
    availableProviderCount: () => providerCount,
    pollMs: 1_000,
    startTimer: (callback, ms) => {
      const timer = { callback, ms, stopped: false };
      timers.push(timer);
      return timer;
    },
    stopTimer: (handle) => {
      (handle as { stopped: boolean }).stopped = true;
    },
  });
  return {
    facts,
    runGit,
    timers,
    setProviderCount: (value: number) => {
      providerCount = value;
    },
    setBranch: (value: string | null) => {
      branch = value;
      runGit.mockImplementation(async () => (value === null ? null : `${value}\n`));
    },
  };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("createFooterFacts", () => {
  it("reads the branch through the git port on the first subscription", async () => {
    const { facts, runGit } = harness("feat/parity");
    expect(facts.gitBranch()).toBeNull();
    const unsubscribe = facts.onBranchChange(() => undefined);
    await tick();
    expect(runGit).toHaveBeenCalledWith("C:/work/app", ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(facts.gitBranch()).toBe("feat/parity");
    unsubscribe();
    facts.dispose();
  });

  it("polls only while a footer is subscribed and notifies on a real change", async () => {
    const { facts, timers, setBranch } = harness("main");
    const listener = vi.fn();
    const unsubscribe = facts.onBranchChange(listener);
    await tick();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(1_000);

    const callsAfterFirst = listener.mock.calls.length;
    timers[0]?.callback();
    await tick();
    // Same branch: a poll is not a change.
    expect(listener.mock.calls.length).toBe(callsAfterFirst);

    setBranch("feat/next");
    timers[0]?.callback();
    await tick();
    expect(facts.gitBranch()).toBe("feat/next");
    expect(listener.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    unsubscribe();
    expect(timers[0]?.stopped).toBe(true);
    facts.dispose();
  });

  it("degrades to no branch when git fails or the directory is not a repo", async () => {
    const { facts } = harness(null);
    const unsubscribe = facts.onBranchChange(() => undefined);
    await tick();
    expect(facts.gitBranch()).toBeNull();
    unsubscribe();
    facts.dispose();
  });

  it("reads the provider count at call time and stops after dispose", async () => {
    const { facts, setProviderCount, runGit, timers } = harness();
    const unsubscribe = facts.onBranchChange(() => undefined);
    await tick();
    expect(facts.availableProviderCount()).toBe(2);
    setProviderCount(5);
    expect(facts.availableProviderCount()).toBe(5);

    unsubscribe();
    facts.dispose();
    const calls = runGit.mock.calls.length;
    await facts.refresh();
    expect(runGit.mock.calls.length).toBe(calls);
    expect(timers[0]?.stopped).toBe(true);
  });

  it("keeps one poll timer for two subscribers", async () => {
    const { facts, timers } = harness();
    const first = facts.onBranchChange(() => undefined);
    const second = facts.onBranchChange(() => undefined);
    await tick();
    expect(timers).toHaveLength(1);
    first();
    expect(timers[0]?.stopped).toBe(false);
    second();
    expect(timers[0]?.stopped).toBe(true);
    facts.dispose();
  });
});
