/**
 * The SDK side of the TUI surface (plan step 17).
 *
 * `src/host/tui-surface.ts` emulates the TUI with structural types; this adapter
 * supplies the three things only the SDK knows: pi-tui's width/compositing
 * helpers, the profile's effective keybindings (installed globally so Pi's
 * components honour a remap), and the `ReadonlyFooterDataProvider` an extension
 * footer expects. It also builds the `EditorTheme` an `EditorFactory` needs.
 *
 * Keeping this split means the emulation is unit-tested with fake components and
 * every `@earendil-works/*` import stays inside `src/host/sdk/*` (AGENTS.md
 * rule 4).
 */

import {
  CURSOR_MARKER,
  KeybindingsManager,
  setKeybindings,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  getSelectListTheme,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { KEYBINDING_DEFINITIONS, resolveKeybindings } from "../../shared/keybindings";
import { createTuiSurface, type TuiRenderKit, type TuiSurfacePort } from "../tui-surface";
import type { ExtensionTerminalInputHandler, ExtensionUiPort } from "../extension-ui";

/** pi-tui's real helpers, injected into the pure emulation. */
export const SDK_TUI_KIT: TuiRenderKit = {
  visibleWidth,
  sliceByColumn,
  stripTerminalSequences,
  cursorMarker: CURSOR_MARKER,
};

/**
 * Builds the profile's effective keybindings and installs them globally, so
 * Pi's `Editor`/`SelectList` (which call `getKeybindings()`) honour the app's
 * remaps — the step-15 deferral ("a remapped key is reflected inside extension
 * renderers") lands here.
 */
export function createSdkTuiKeybindings(user: Record<string, unknown> = {}): KeybindingsManager {
  const definitions: Record<string, { defaultKeys: string[]; description: string }> = {};
  for (const definition of KEYBINDING_DEFINITIONS) {
    definitions[definition.id] = {
      defaultKeys: definition.defaults,
      description: definition.description,
    };
  }
  const resolved = resolveKeybindings(user);
  const manager = new KeybindingsManager(definitions as never, resolved as never);
  setKeybindings(manager);
  return manager;
}

/**
 * A `ReadonlyFooterDataProvider` for an extension footer: the app has no git
 * branch watcher, so the branch is null, while the statuses are the live
 * `ctx.ui.setStatus()` map (plan step 16).
 */
export function createSdkFooterData(
  port: Pick<ExtensionUiPort, "snapshot">,
): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map(Object.entries(port.snapshot().statuses)),
    getAvailableProviderCount: () => 0,
    onBranchChange: () => () => undefined,
  };
}

/** The `EditorTheme` an `EditorFactory` receives (the SDK does not export it). */
export function sdkEditorTheme(theme: Theme): {
  borderColor: (s: string) => string;
  selectList: ReturnType<typeof getSelectListTheme>;
} {
  return {
    borderColor: (text: string) => theme.fg("borderMuted", text),
    selectList: getSelectListTheme(),
  };
}

export interface SdkTuiSurfaceOptions {
  emit(event: string, payload?: unknown): void;
  terminalInput?: () => readonly ExtensionTerminalInputHandler[];
  defaultRows?: number;
  defaultCols?: number;
}

export function createSdkTuiSurface(options: SdkTuiSurfaceOptions): TuiSurfacePort {
  return createTuiSurface({ ...options, kit: SDK_TUI_KIT });
}
