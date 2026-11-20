/**
 * Renderer terminal event pump (2026-11-05 native-terminal plan, step 8).
 *
 * One subscription per window routes the host's frames to the store: PTY output
 * is decoded to bytes (xterm owns the UTF-8 decoder), exit reports update the
 * tab, and host-level errors fail the terminal. Sequence filtering happens in
 * the store, which owns the replay boundary.
 */

import type { TerminalBridge } from "../../../shared/terminal-ipc";
import {
  base64ToBytes,
  type TerminalDataEvent,
  type TerminalErrorEvent,
  type TerminalExitEvent,
  type TerminalEventFrame,
} from "../../../shared/terminal-protocol";

export interface TerminalEventSink {
  data(terminalId: string, bytes: Uint8Array, seq: number): void;
  exit(terminalId: string, exitCode: number, signal?: number): void;
  error(terminalId: string | null, message: string): void;
}

export interface TerminalEventPumpOptions {
  log?: (line: string) => void;
}

export interface TerminalEventPump {
  dispose(): void;
}

export function createTerminalEventPump(
  bridge: TerminalBridge,
  sink: TerminalEventSink,
  options: TerminalEventPumpOptions = {},
): TerminalEventPump {
  const unsubscribe = bridge.onEvent((frame: TerminalEventFrame) => {
    try {
      if (frame.event === "terminal.data") {
        const payload = frame.payload as TerminalDataEvent;
        sink.data(payload.terminalId, base64ToBytes(payload.data), payload.seq);
        return;
      }
      if (frame.event === "terminal.exit") {
        const payload = frame.payload as TerminalExitEvent;
        sink.exit(payload.terminalId, payload.exitCode, payload.signal);
        return;
      }
      const payload = frame.payload as TerminalErrorEvent;
      sink.error(payload.terminalId, payload.message);
    } catch (error) {
      // A malformed frame must not tear down the subscription.
      options.log?.(`terminal event failed: ${String(error)}`);
    }
  });
  return { dispose: unsubscribe };
}
