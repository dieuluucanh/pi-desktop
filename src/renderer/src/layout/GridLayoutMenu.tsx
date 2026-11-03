import { Check, Columns2, Columns3, Grid2x2, LayoutGrid, Square } from "lucide-react";

import {
  GRID_LAYOUTS,
  GRID_LAYOUT_LABELS,
  gridMode,
  type GridLayout,
} from "../../../shared/session-grid";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * The layout switcher, at the far right of the session strip (2026-11-03 plan).
 *
 * It lives here rather than in the editor row because that row disappears when no
 * file is open, which would make the control vanish with it. The `+` button sits
 * immediately to its left.
 *
 * The list is `gridLayoutChoices` + `gridViewToggle` — pure, so the tests pin the
 * labels, the checked state and the enablement without opening a Radix menu in
 * jsdom (the same split `tabMenuItems` and `panePickerModel` use).
 */
export function GridLayoutMenu(): React.JSX.Element {
  const layout = useAppStore((state) => state.prefs.grid.layout);
  const panes = useAppStore((state) => state.prefs.grid.panes);
  const solo = useAppStore((state) => state.gridSolo);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const setGridLayout = useAppStore((state) => state.setGridLayout);
  const showGrid = useAppStore((state) => state.showGrid);
  const showSolo = useAppStore((state) => state.showSolo);

  const mode = gridMode({ layout, panes, solo, activeTabId });
  const toggle = gridViewToggle(mode);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Grid layout"
          title={`Grid layout: ${GRID_LAYOUT_LABELS[layout]}`}
          data-testid="grid-layout-menu"
          data-layout={layout}
        >
          <LayoutGrid className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
        {gridLayoutChoices(layout).map((choice) => (
          <DropdownMenuItem
            key={choice.layout}
            onSelect={() => setGridLayout(choice.layout)}
            data-testid={`grid-layout-${choice.layout}`}
            data-checked={choice.checked ? "true" : undefined}
          >
            <span className="flex size-3 shrink-0 items-center justify-center">
              {choice.checked ? <Check className="size-3 text-accent" aria-hidden /> : null}
            </span>
            <LayoutIcon layout={choice.layout} />
            <span className="flex-1">{choice.label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => (toggle.id === "show-grid" ? showGrid() : showSolo())}
          disabled={toggle.disabled}
          data-testid={`grid-view-${toggle.id}`}
        >
          <span className="flex size-3 shrink-0" aria-hidden />
          <span className="flex-1">{toggle.label}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The five presets with their labels and which one is on screen. */
export interface GridLayoutChoice {
  layout: GridLayout;
  label: string;
  checked: boolean;
}

export function gridLayoutChoices(current: GridLayout): GridLayoutChoice[] {
  return GRID_LAYOUTS.map((layout) => ({
    layout,
    label: GRID_LAYOUT_LABELS[layout],
    checked: layout === current,
  }));
}

/**
 * The one grid/solo toggle.
 *
 * A `single` layout is already solo, so the item is disabled: there is no grid to
 * return to until the user picks a multi-pane preset.
 */
export interface GridViewToggle {
  id: "show-grid" | "show-solo";
  label: string;
  disabled: boolean;
}

export function gridViewToggle(
  mode: ReturnType<typeof gridMode>,
  layout: GridLayout = mode === "solo" ? "single" : "two",
): GridViewToggle {
  if (layout === "single") {
    return { id: "show-grid", label: "Show single tab", disabled: true };
  }
  return mode === "grid"
    ? { id: "show-solo", label: "Show single tab", disabled: false }
    : { id: "show-grid", label: "Show grid", disabled: false };
}

function LayoutIcon({ layout }: { layout: GridLayout }): React.JSX.Element {
  switch (layout) {
    case "single":
      return <Square className="size-3.5 shrink-0 text-ink-muted" aria-hidden />;
    case "two":
      return <Columns2 className="size-3.5 shrink-0 text-ink-muted" aria-hidden />;
    case "three-left":
    case "three-right":
      return <Columns3 className="size-3.5 shrink-0 text-ink-muted" aria-hidden />;
    case "four":
    default:
      return <Grid2x2 className="size-3.5 shrink-0 text-ink-muted" aria-hidden />;
  }
}
