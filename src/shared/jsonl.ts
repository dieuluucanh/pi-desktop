/**
 * Generic newline-delimited JSON framing (2026-11-05 terminal plan, step 5).
 *
 * Extracted from `host-protocol.ts` so the Pi host and the terminal host share
 * one overflow/resync implementation. A decoder is stateful and belongs to one
 * stream: `push` returns the frames completed by a chunk and reports whether a
 * frame was dropped (either because it exceeded the cap or because a partial
 * line did before a newline arrived).
 */

export interface JsonlPushResult<T> {
  frames: T[];
  /** True when at least one frame was discarded by the size guard. */
  overflow: boolean;
}

export class JsonlDecoder<T> {
  private buffer = "";
  private dropping = false;

  constructor(
    private readonly decode: (line: string) => T | null,
    private readonly maxBytes: number,
  ) {}

  push(chunk: string): JsonlPushResult<T> {
    this.buffer += chunk;
    const frames: T[] = [];
    let overflow = false;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.dropping) {
        // The tail of an oversized frame; resynchronise on this newline.
        this.dropping = false;
        overflow = true;
        continue;
      }
      if (line.length > this.maxBytes) {
        overflow = true;
        continue;
      }
      const frame = this.decode(line);
      if (frame !== null) frames.push(frame);
    }

    if (this.buffer.length > this.maxBytes) {
      this.buffer = "";
      this.dropping = true;
      overflow = true;
    }

    return { frames, overflow };
  }

  reset(): void {
    this.buffer = "";
    this.dropping = false;
  }
}
