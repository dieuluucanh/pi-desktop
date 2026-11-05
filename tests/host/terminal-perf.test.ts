import { describe, expect, it } from "vitest";
import { TerminalCore } from "../../src/host/terminal-core";
import type { TerminalDataEvent, TerminalSpawnSpec } from "../../src/shared/terminal-protocol";
import { createFakePtyPort, createFakeTreeKill } from "./fakes/pty";

/**
 * Throughput/flow-control contract (2026-11-05 terminal plan, step 13).
 *
 * 50 MB through the host must not grow an unbounded buffer: the credit window
 * pauses the PTY, the ring keeps only the replay tail, and every byte is
 * delivered exactly once before the shell is allowed to continue.
 */

const SPEC: TerminalSpawnSpec = {
  cwd: "/work/app",
  shell: "/bin/bash",
  args: [],
  env: { TERM: "xterm-256color" },
  cols: 80,
  rows: 24,
  name: "xterm-256color",
};

const TOTAL = 50 * 1024 * 1024;
const CHUNK = 64 * 1024;
const REPLAY = 256 * 1024;
const HIGH_WATER = 1024 * 1024;

describe("TerminalCore throughput", () => {
  it("streams 50 MB within the credit window and keeps only the replay tail", () => {
    const pty = createFakePtyPort();
    const treeKill = createFakeTreeKill();
    let received = 0;
    let ackAutomatically = false;
    const core = new TerminalCore({
      pty,
      treeKill,
      emit: (frame) => {
        if (frame.event !== "terminal.data") return;
        const payload = frame.payload as TerminalDataEvent;
        received += payload.bytes;
        if (ackAutomatically) core.ack(payload.terminalId, payload.bytes);
      },
      batchBytes: 32 * 1024,
      batchMs: 0,
      highWaterBytes: HIGH_WATER,
      lowWaterBytes: REPLAY,
      replayBytes: REPLAY,
    });

    const id = core.open(SPEC).id;
    const process = pty.processes[0]!;

    // Phase 1: 2 MB with no acks. The host must pause rather than buffer.
    const firstPhase = 2 * 1024 * 1024;
    for (let offset = 0; offset < firstPhase; offset += CHUNK) {
      process.emitData(new Uint8Array(CHUNK));
    }
    expect(process.pauseCount).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(HIGH_WATER + CHUNK);

    // Drain the credit until phase 1 is fully delivered.
    while (received < firstPhase) core.ack(id, REPLAY);
    // One more credit drop crosses the low-water mark and resumes the PTY.
    core.ack(id, HIGH_WATER);
    expect(process.resumeCount).toBeGreaterThan(0);

    // Phase 2: the remaining 48 MB with the renderer acking every frame.
    ackAutomatically = true;
    for (let offset = firstPhase; offset < TOTAL; offset += CHUNK) {
      process.emitData(new Uint8Array(CHUNK));
    }

    // The replay ring is bounded, not proportional to the stream. `attach`
    // flushes the final sub-batch first, so it is also the last delivery.
    const snapshot = core.attach(id);
    expect(received).toBe(TOTAL);
    expect(snapshot?.bytes).toBe(REPLAY);
    expect(core.list()).toHaveLength(1);
    core.dispose();
    expect(pty.processes[0]?.kills).toContain("SIGKILL");
  });
});
