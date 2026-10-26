/**
 * The extension TUI surface (plan step 17, half B).
 *
 * Pi's `ctx.ui.custom(factory, options)` hands an extension a `TUI` and a
 * component factory; the component owns the keyboard and renders to ANSI lines.
 * The desktop has no terminal, so this module **emulates the TUI** for that one
 * component: it coalesces `requestRender()`, tracks focus, resolves overlay
 * geometry (anchor, width, margins, `visible()`), routes terminal input and
 * renders each slot to ANSI lines which the app displays.
 *
 * The emulation is deliberately SDK-free and structural. The real `Theme`,
 * `KeybindingsManager` and pi-tui helpers are injected by
 * `src/host/sdk/tui-surface.ts`, so this module is unit-tested with fake
 * components and stays inside AGENTS.md rule 4 (SDK contact lives in
 * `src/host/sdk/*`).
 *
 * Wire shape: `src/shared/tui-surface.ts`.
 */

import {
  EMPTY_TUI_SURFACE,
  TUI_STATE_EVENT,
  sanitizeTuiInput,
  sanitizeTuiResize,
  type TuiBounds,
  type TuiCursor,
  type TuiFrame,
  type TuiSlot,
  type TuiSurfaceSnapshot,
} from "../shared/tui-surface";
import type { HostMethod } from "../shared/host-protocol";
import type { ExtensionTerminalInputHandler } from "./extension-ui";
import type { HostHandler } from "./service";

/** The component surface Pi's components implement (a structural `Component`). */
export interface SurfaceComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
  dispose?(): void;
  /** Set by the surface when the component owns the keyboard (`Focusable`). */
  focused?: boolean;
}

export type SurfaceInputResult = { consume?: boolean; data?: string } | undefined;

export interface SurfaceOverlayMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** A structural mirror of pi-tui's `OverlayOptions`. */
export interface SurfaceOverlayOptions {
  width?: number | `${number}%`;
  minWidth?: number;
  maxHeight?: number | `${number}%`;
  anchor?:
    | "center"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "top-center"
    | "bottom-center"
    | "left-center"
    | "right-center";
  offsetX?: number;
  offsetY?: number;
  row?: number | `${number}%`;
  col?: number | `${number}%`;
  margin?: SurfaceOverlayMargin | number;
  visible?: (termWidth: number, termHeight: number) => boolean;
  nonCapturing?: boolean;
}

export interface SurfaceOverlayHandle {
  /** Permanently remove the overlay. */
  hide(): void;
  /** Temporarily hide or show the overlay. */
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  /** Focus the overlay and bring it to the front. */
  focus(): void;
  /** Release focus to an explicit target, or to the overlay's pre-focus component. */
  unfocus(options?: { target: SurfaceComponent | null }): void;
  isFocused(): boolean;
  /** Last resolved bounds, or undefined while hidden/unrendered. */
  getBounds(): TuiBounds | undefined;
}

export interface SurfaceCustomOptions {
  overlay?: boolean;
  overlayOptions?: SurfaceOverlayOptions | (() => SurfaceOverlayOptions);
  onHandle?: (handle: SurfaceOverlayHandle) => void;
}

/**
 * The emulated `TUI` passed to extension factories. Structural: the SDK adapter
 * casts it to pi-tui's `TUI`.
 */
export interface SurfaceTui {
  readonly mode: "regular";
  readonly terminal: {
    readonly columns: number;
    readonly rows: number;
    readonly kittyProtocolActive: boolean;
    setTitle(title: string): void;
    write(data: string): void;
    hideCursor(): void;
    showCursor(): void;
    setProgress(active: boolean): void;
  };
  readonly children: SurfaceComponent[];
  readonly fullRedraws: number;
  requestRender(force?: boolean): void;
  renderNow(force?: boolean): void;
  invalidate(): void;
  addChild(component: SurfaceComponent): void;
  removeChild(component: SurfaceComponent): void;
  clear(): void;
  setFocus(component: SurfaceComponent | null): void;
  getFocusedComponent(): SurfaceComponent | null;
  showOverlay(component: SurfaceComponent, options?: SurfaceOverlayOptions): SurfaceOverlayHandle;
  hideOverlay(): void;
  hasOverlay(): boolean;
  getShowHardwareCursor(): boolean;
  setShowHardwareCursor(enabled: boolean): void;
  getClearOnShrink(): boolean;
  setClearOnShrink(enabled: boolean): void;
  addInputListener(listener: (data: string) => SurfaceInputResult): () => void;
  removeInputListener(listener: (data: string) => SurfaceInputResult): void;
  onTerminalColorSchemeChange(listener: (scheme: unknown) => void): () => void;
  setTerminalColorSchemeNotifications(enabled: boolean): void;
  queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<undefined>;
  queryTerminalColorScheme(options: { timeoutMs: number }): Promise<undefined>;
  start(): void;
  stop(): void;
  onDebug?: () => void;
}

/** The pi-tui helpers the renderer needs, injected so this module stays pure. */
export interface TuiRenderKit {
  visibleWidth(text: string): number;
  sliceByColumn(line: string, start: number, length: number, strict?: boolean): string;
  stripTerminalSequences(text: string): string;
  cursorMarker: string;
}

export interface TuiSurfaceOptions {
  emit(event: string, payload?: unknown): void;
  /** Extension `onTerminalInput` handlers, consulted before the component. */
  terminalInput?: () => readonly ExtensionTerminalInputHandler[];
  kit: TuiRenderKit;
  /** Used until the renderer reports its measured grid. */
  defaultRows?: number;
  defaultCols?: number;
}

export type SurfaceWidgetPlacement = "aboveEditor" | "belowEditor";

export interface TuiSurfacePort {
  /**
   * Runs a `ctx.ui.custom()` factory. The port supplies the emulated TUI and a
   * `done` callback; the returned promise resolves with the factory's result
   * (undefined when the component is disposed or never produced).
   */
  custom<T>(
    invoke: (
      tui: SurfaceTui,
      done: (result: T) => void,
    ) => SurfaceComponent | Promise<SurfaceComponent>,
    options?: SurfaceCustomOptions,
  ): Promise<T>;
  setFooter(invoke: ((tui: SurfaceTui) => SurfaceComponent) | undefined): void;
  setHeader(invoke: ((tui: SurfaceTui) => SurfaceComponent) | undefined): void;
  /**
   * A component-factory widget (Pi's `ctx.ui.setWidget(key, factory)`), rendered
   * above or below the editor/dock. `undefined` removes it from both placements.
   */
  setWidget(
    key: string,
    factory: ((tui: SurfaceTui) => SurfaceComponent) | undefined,
    placement: SurfaceWidgetPlacement,
  ): void;
  /** Renderer-reported grid; overlays re-resolve and `visible()` re-evaluates. */
  setSize(rows: number, cols: number): void;
  /** Raw terminal bytes from the renderer. */
  input(data: string): void;
  /** Invalidates every mounted component (a theme switch re-renders them). */
  invalidate(): void;
  /** Clears every slot without disposing the port (a session rebind). */
  reset(): void;
  snapshot(): TuiSurfaceSnapshot;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  dispose(reason: string): void;
}

interface OverlayEntry {
  component: SurfaceComponent;
  options: SurfaceOverlayOptions;
  hidden: boolean;
  focusOrder: number;
  preFocus: SurfaceComponent | null;
  bounds: TuiBounds | undefined;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

function parseSizeValue(
  value: number | `${number}%` | undefined,
  total: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const match = value.match(/^(\d+(?:\.\d+)?)%$/);
  if (!match) return undefined;
  return Math.floor((total * Number.parseFloat(match[1] ?? "0")) / 100);
}

function resolveAnchorRow(
  anchor: SurfaceOverlayOptions["anchor"],
  height: number,
  availHeight: number,
  marginTop: number,
): number {
  switch (anchor) {
    case "top-left":
    case "top-center":
    case "top-right":
      return marginTop;
    case "bottom-left":
    case "bottom-center":
    case "bottom-right":
      return marginTop + availHeight - height;
    default:
      return marginTop + Math.floor((availHeight - height) / 2);
  }
}

function resolveAnchorCol(
  anchor: SurfaceOverlayOptions["anchor"],
  width: number,
  availWidth: number,
  marginLeft: number,
): number {
  switch (anchor) {
    case "top-left":
    case "left-center":
    case "bottom-left":
      return marginLeft;
    case "top-right":
    case "right-center":
    case "bottom-right":
      return marginLeft + availWidth - width;
    default:
      return marginLeft + Math.floor((availWidth - width) / 2);
  }
}

/**
 * Resolves an overlay's width/row/col/maxHeight, mirroring pi-tui's
 * `resolveOverlayLayout` so an extension's overlay lands where it would in a
 * terminal.
 */
export function resolveOverlayLayout(
  options: SurfaceOverlayOptions | undefined,
  overlayHeight: number,
  termWidth: number,
  termHeight: number,
): { width: number; row: number; col: number; maxHeight: number | undefined } {
  const opt = options ?? {};
  const margin =
    typeof opt.margin === "number"
      ? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
      : (opt.margin ?? {});
  const marginTop = Math.max(0, margin.top ?? 0);
  const marginRight = Math.max(0, margin.right ?? 0);
  const marginBottom = Math.max(0, margin.bottom ?? 0);
  const marginLeft = Math.max(0, margin.left ?? 0);
  const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
  const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

  let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
  if (opt.minWidth !== undefined) width = Math.max(width, opt.minWidth);
  width = Math.max(1, Math.min(width, availWidth));

  let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
  if (maxHeight !== undefined) maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
  const effectiveHeight =
    maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

  let row: number;
  if (opt.row !== undefined) {
    if (typeof opt.row === "string") {
      const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
      row = match
        ? marginTop +
          Math.floor(
            Math.max(0, availHeight - effectiveHeight) * (Number.parseFloat(match[1] ?? "0") / 100),
          )
        : resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
    } else {
      row = opt.row;
    }
  } else {
    row = resolveAnchorRow(opt.anchor ?? "center", effectiveHeight, availHeight, marginTop);
  }

  let col: number;
  if (opt.col !== undefined) {
    if (typeof opt.col === "string") {
      const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
      col = match
        ? marginLeft +
          Math.floor(Math.max(0, availWidth - width) * (Number.parseFloat(match[1] ?? "0") / 100))
        : resolveAnchorCol("center", width, availWidth, marginLeft);
    } else {
      col = opt.col;
    }
  } else {
    col = resolveAnchorCol(opt.anchor ?? "center", width, availWidth, marginLeft);
  }

  row += opt.offsetY ?? 0;
  col += opt.offsetX ?? 0;
  row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
  col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));
  return { width, row, col, maxHeight };
}

export function createTuiSurface(options: TuiSurfaceOptions): TuiSurfacePort {
  const kit = options.kit;
  let rows = options.defaultRows ?? DEFAULT_ROWS;
  let cols = options.defaultCols ?? DEFAULT_COLS;

  let headerComponent: SurfaceComponent | null = null;
  let footerComponent: SurfaceComponent | null = null;
  let customComponent: SurfaceComponent | null = null;
  let focusedComponent: SurfaceComponent | null = null;
  const overlays: OverlayEntry[] = [];
  const widgetsAbove = new Map<string, SurfaceComponent>();
  const widgetsBelow = new Map<string, SurfaceComponent>();
  let focusCounter = 0;
  let showHardwareCursor = false;
  let clearOnShrink = false;
  let frameSeq = 0;
  let dirty = false;
  let renderScheduled = false;
  let disposed = false;
  const inputListeners = new Set<(data: string) => SurfaceInputResult>();
  const pendingCustom = new Set<(result: unknown) => void>();

  const isOverlayVisible = (entry: OverlayEntry): boolean => {
    if (entry.hidden) return false;
    const visible = entry.options.visible;
    if (visible && !visible(cols, rows)) return false;
    return true;
  };

  const visibleOverlays = (): OverlayEntry[] =>
    overlays.filter((entry) => isOverlayVisible(entry)).sort((a, b) => a.focusOrder - b.focusOrder);

  const setComponentFocus = (component: SurfaceComponent | null): void => {
    if (focusedComponent === component) return;
    if (focusedComponent && "focused" in focusedComponent) focusedComponent.focused = false;
    focusedComponent = component;
    if (component && "focused" in component) component.focused = true;
  };

  const scheduleRender = (): void => {
    if (disposed) return;
    dirty = true;
    if (renderScheduled) return;
    renderScheduled = true;
    const timer = setTimeout(() => {
      renderScheduled = false;
      flush();
    }, 0);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  };

  const renderComponent = (component: SurfaceComponent | null, width: number): string[] => {
    if (!component) return [];
    try {
      const lines = component.render(Math.max(1, width));
      return Array.isArray(lines)
        ? lines.filter((line): line is string => typeof line === "string")
        : [];
    } catch {
      // A throwing renderer must never take the session down (Pi's own fallback
      // is to surface the error elsewhere); render nothing for this frame.
      return [];
    }
  };

  const extractCursor = (lines: string[]): TuiCursor | null => {
    const marker = kit.cursorMarker;
    for (let row = lines.length - 1; row >= 0; row--) {
      const line = lines[row] ?? "";
      const index = line.indexOf(marker);
      if (index === -1) continue;
      const col = kit.visibleWidth(line.slice(0, index));
      lines[row] = line.slice(0, index) + line.slice(index + marker.length);
      return { row, col };
    }
    return null;
  };

  const makeFrame = (component: SurfaceComponent | null, width: number): TuiFrame | null => {
    if (!component) return null;
    const lines = renderComponent(component, width);
    const cursor = component === focusedComponent ? extractCursor(lines) : null;
    return { seq: ++frameSeq, width: Math.max(1, width), height: lines.length, cursor, lines };
  };

  const buildSnapshot = (): TuiSurfaceSnapshot => {
    const widgetFrames = (widgets: Map<string, SurfaceComponent>): TuiFrame[] =>
      [...widgets.values()]
        .map((component) => makeFrame(component, cols))
        .filter((frame): frame is TuiFrame => frame !== null);
    const widgetsAboveFrames = widgetFrames(widgetsAbove);
    const widgetsBelowFrames = widgetFrames(widgetsBelow);
    const topOverlay = visibleOverlays().at(-1);
    if (topOverlay) {
      const { width, maxHeight } = resolveOverlayLayout(topOverlay.options, 0, cols, rows);
      const lines = renderComponent(topOverlay.component, width);
      const clipped = maxHeight !== undefined ? lines.slice(0, maxHeight) : lines;
      const layout = resolveOverlayLayout(topOverlay.options, clipped.length, cols, rows);
      topOverlay.bounds = {
        row: layout.row,
        col: layout.col,
        width: layout.width,
        height: clipped.length,
      };
      const cursor = topOverlay.component === focusedComponent ? extractCursor(clipped) : null;
      return {
        active: true,
        overlay: true,
        bounds: topOverlay.bounds,
        focus: "custom",
        custom: {
          seq: ++frameSeq,
          width: layout.width,
          height: clipped.length,
          lines: clipped,
          cursor,
        },
        footer: makeFrame(footerComponent, cols),
        header: makeFrame(headerComponent, cols),
        widgetsAbove: widgetsAboveFrames,
        widgetsBelow: widgetsBelowFrames,
      };
    }
    for (const entry of overlays) entry.bounds = undefined;
    const custom = makeFrame(customComponent, cols);
    const footer = makeFrame(footerComponent, cols);
    const header = makeFrame(headerComponent, cols);
    const focus: TuiSlot | null =
      focusedComponent === null ? null : focusedComponent === customComponent ? "custom" : null;
    return {
      active: Boolean(
        custom ||
        footer ||
        header ||
        widgetsAboveFrames.length > 0 ||
        widgetsBelowFrames.length > 0,
      ),
      overlay: false,
      bounds: null,
      focus,
      custom,
      footer,
      header,
      widgetsAbove: widgetsAboveFrames,
      widgetsBelow: widgetsBelowFrames,
    };
  };

  const flush = (): void => {
    if (!dirty || disposed) return;
    dirty = false;
    options.emit(TUI_STATE_EVENT, buildSnapshot());
  };

  const makeHandle = (entry: OverlayEntry): SurfaceOverlayHandle => ({
    hide: () => {
      const index = overlays.indexOf(entry);
      if (index === -1) return;
      overlays.splice(index, 1);
      if (focusedComponent === entry.component) setComponentFocus(entry.preFocus);
      entry.component.dispose?.();
      scheduleRender();
    },
    setHidden: (hidden: boolean) => {
      if (entry.hidden === hidden) return;
      entry.hidden = hidden;
      if (hidden && focusedComponent === entry.component) setComponentFocus(entry.preFocus);
      scheduleRender();
    },
    isHidden: () => entry.hidden,
    focus: () => {
      entry.focusOrder = ++focusCounter;
      setComponentFocus(entry.component);
      scheduleRender();
    },
    unfocus: (unfocusOptions) => {
      if (focusedComponent !== entry.component) return;
      setComponentFocus(unfocusOptions ? unfocusOptions.target : entry.preFocus);
      scheduleRender();
    },
    isFocused: () => focusedComponent === entry.component,
    getBounds: () => entry.bounds,
  });

  const tui: SurfaceTui = {
    mode: "regular",
    terminal: {
      get columns(): number {
        return cols;
      },
      get rows(): number {
        return rows;
      },
      kittyProtocolActive: false,
      setTitle: () => undefined,
      write: () => undefined,
      hideCursor: () => undefined,
      showCursor: () => undefined,
      setProgress: () => undefined,
    },
    get children(): SurfaceComponent[] {
      return [headerComponent, customComponent, footerComponent].filter(
        (component): component is SurfaceComponent => component !== null,
      );
    },
    get fullRedraws(): number {
      return frameSeq;
    },
    requestRender: () => scheduleRender(),
    renderNow: () => {
      dirty = true;
      flush();
    },
    invalidate: () => {
      for (const component of [headerComponent, footerComponent, customComponent]) {
        component?.invalidate?.();
      }
      for (const component of widgetsAbove.values()) component.invalidate?.();
      for (const component of widgetsBelow.values()) component.invalidate?.();
      for (const entry of overlays) entry.component.invalidate?.();
      scheduleRender();
    },
    addChild: () => undefined,
    removeChild: () => undefined,
    clear: () => undefined,
    setFocus: (component) => {
      setComponentFocus(component);
      scheduleRender();
    },
    getFocusedComponent: () => focusedComponent,
    showOverlay: (component, overlayOptions) => {
      const entry: OverlayEntry = {
        component,
        options: overlayOptions ?? {},
        hidden: false,
        focusOrder: ++focusCounter,
        preFocus: focusedComponent,
        bounds: undefined,
      };
      overlays.push(entry);
      if (!entry.options.nonCapturing && isOverlayVisible(entry)) setComponentFocus(component);
      scheduleRender();
      return makeHandle(entry);
    },
    hideOverlay: () => {
      const entry = overlays.pop();
      if (!entry) return;
      if (focusedComponent === entry.component) setComponentFocus(entry.preFocus);
      entry.component.dispose?.();
      scheduleRender();
    },
    hasOverlay: () => visibleOverlays().length > 0,
    getShowHardwareCursor: () => showHardwareCursor,
    setShowHardwareCursor: (enabled) => {
      showHardwareCursor = enabled;
      scheduleRender();
    },
    getClearOnShrink: () => clearOnShrink,
    setClearOnShrink: (enabled) => {
      clearOnShrink = enabled;
    },
    addInputListener: (listener) => {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    },
    removeInputListener: (listener) => {
      inputListeners.delete(listener);
    },
    onTerminalColorSchemeChange: () => () => undefined,
    setTerminalColorSchemeNotifications: () => undefined,
    queryTerminalBackgroundColor: () => Promise.resolve(undefined),
    queryTerminalColorScheme: () => Promise.resolve(undefined),
    start: () => undefined,
    stop: () => undefined,
  };

  const disposeComponent = (component: SurfaceComponent | null): void => {
    if (!component) return;
    try {
      component.dispose?.();
    } catch {
      // Disposal must never throw back into the session.
    }
  };

  /** Extension input filters → TUI listeners → the focused component. */
  const routeInput = (data: string): void => {
    if (disposed || data.length === 0) return;
    let current = data;
    for (const handler of options.terminalInput?.() ?? []) {
      const result = handler(current);
      if (result?.consume) return;
      if (result?.data !== undefined) current = result.data;
    }
    if (current.length === 0) return;
    for (const listener of inputListeners) {
      const result = listener(current);
      if (result?.consume) return;
      if (result?.data !== undefined) current = result.data;
    }
    if (current.length === 0) return;
    const target = focusedComponent;
    if (target?.handleInput) {
      try {
        target.handleInput(current);
      } catch {
        // A throwing handler must not crash the host; the next render recovers.
      }
    }
    scheduleRender();
  };

  const clearSlots = (): void => {
    disposeComponent(headerComponent);
    disposeComponent(footerComponent);
    disposeComponent(customComponent);
    headerComponent = null;
    footerComponent = null;
    customComponent = null;
    for (const component of widgetsAbove.values()) disposeComponent(component);
    for (const component of widgetsBelow.values()) disposeComponent(component);
    widgetsAbove.clear();
    widgetsBelow.clear();
    for (const entry of overlays) disposeComponent(entry.component);
    overlays.length = 0;
    setComponentFocus(null);
  };

  return {
    async custom<T>(
      invoke: (
        tui: SurfaceTui,
        done: (result: T) => void,
      ) => SurfaceComponent | Promise<SurfaceComponent>,
      customOptions?: SurfaceCustomOptions,
    ): Promise<T> {
      if (disposed) return undefined as T;
      let settled = false;
      let component: SurfaceComponent | null = null;
      let overlayHandle: SurfaceOverlayHandle | null = null;
      return new Promise<T>((resolve) => {
        const finish = (result: T): void => {
          if (settled) return;
          settled = true;
          pendingCustom.delete(finish as (result: unknown) => void);
          if (overlayHandle) {
            // `hide()` disposes the overlay component exactly once.
            overlayHandle.hide();
          } else if (component) {
            const wasFocused = focusedComponent === component;
            if (customComponent === component) customComponent = null;
            if (wasFocused) setComponentFocus(null);
            disposeComponent(component);
          }
          scheduleRender();
          resolve(result);
        };
        pendingCustom.add(finish as (result: unknown) => void);
        Promise.resolve()
          .then(() => invoke(tui, finish))
          .then((created) => {
            if (settled || disposed) {
              disposeComponent(created ?? null);
              return;
            }
            if (!created || typeof created.render !== "function") {
              finish(undefined as T);
              return;
            }
            component = created;
            if (customOptions?.overlay) {
              const overlayOptions =
                typeof customOptions.overlayOptions === "function"
                  ? customOptions.overlayOptions()
                  : (customOptions.overlayOptions ?? {});
              overlayHandle = tui.showOverlay(created, overlayOptions);
              customOptions.onHandle?.(overlayHandle);
            } else {
              disposeComponent(customComponent);
              customComponent = created;
              setComponentFocus(created);
            }
            scheduleRender();
          })
          .catch(() => {
            finish(undefined as T);
          });
      });
    },

    setFooter(invoke) {
      disposeComponent(footerComponent);
      footerComponent = invoke ? safeCreate(invoke, tui) : null;
      scheduleRender();
    },
    setHeader(invoke) {
      disposeComponent(headerComponent);
      headerComponent = invoke ? safeCreate(invoke, tui) : null;
      scheduleRender();
    },

    setWidget(key, factory, placement) {
      for (const widgets of [widgetsAbove, widgetsBelow]) {
        const existing = widgets.get(key);
        if (!existing) continue;
        disposeComponent(existing);
        widgets.delete(key);
      }
      if (factory) {
        const component = safeCreate(factory, tui);
        if (component) {
          (placement === "belowEditor" ? widgetsBelow : widgetsAbove).set(key, component);
        }
      }
      scheduleRender();
    },

    setSize(nextRows, nextCols) {
      rows = Math.max(1, nextRows);
      cols = Math.max(1, nextCols);
      scheduleRender();
    },

    input(data) {
      routeInput(data);
    },

    invalidate() {
      tui.invalidate();
    },

    reset() {
      clearSlots();
      scheduleRender();
    },

    snapshot: () => (disposed ? EMPTY_TUI_SURFACE : buildSnapshot()),

    handlers: () => ({
      "tui.state": () => (disposed ? EMPTY_TUI_SURFACE : buildSnapshot()),
      "tui.resize": (params) => {
        const request = sanitizeTuiResize(params);
        if (!request) throw new Error("tui.resize requires { rows, cols }");
        rows = request.rows;
        cols = request.cols;
        scheduleRender();
        return { ok: true, rows, cols };
      },
      "tui.input": (params) => {
        const request = sanitizeTuiInput(params);
        if (!request) throw new Error("tui.input requires { data }");
        // Route through the same path as a host-side key so listeners run too.
        routeInput(request.data);
        return { ok: true };
      },
    }),

    dispose(reason) {
      if (disposed) return;
      disposed = true;
      for (const finish of [...pendingCustom]) finish(undefined);
      pendingCustom.clear();
      clearSlots();
      void reason;
    },
  };
}

function safeCreate(
  invoke: (tui: SurfaceTui) => SurfaceComponent,
  tui: SurfaceTui,
): SurfaceComponent | null {
  try {
    const component = invoke(tui);
    return component && typeof component.render === "function" ? component : null;
  } catch {
    return null;
  }
}
