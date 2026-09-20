/**
 * The `KeybindingPort` over the profile's `keybindings.json` (plan step 15).
 *
 * The path is the same one Pi itself uses (`<agentDir>/keybindings.json` —
 * see the SDK's migration that reads `join(getAgentDir(), "keybindings.json")`).
 * Reads and writes go through the injected atomic file io, so a crashed write
 * can never truncate the shared profile's bindings.
 */

import { join } from "node:path";
import type { ModelsFileIo } from "../custom-providers";
import type { KeybindingPort } from "../keybindings";

export interface SdkKeybindingPortOptions {
  /** `~/.pi/agent`, resolved by the composition root. */
  agentDir: string;
  /** Atomic file access (temp file + rename, shared with `models.json`). */
  io: ModelsFileIo;
}

export function createSdkKeybindingPort(options: SdkKeybindingPortOptions): KeybindingPort {
  const path = join(options.agentDir, "keybindings.json");
  return {
    path: () => path,
    read: () => options.io.read(path),
    write: (content: string) => options.io.write(path, content),
    remove: () => options.io.delete(path),
  };
}
