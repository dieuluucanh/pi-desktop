import {
  Columns2,
  Grid2x2,
  PanelsLeftBottom,
  PanelsRightBottom,
  Square,
  type LucideIcon,
} from "lucide-react";

import { GRID_LAYOUTS, GRID_LAYOUT_LABELS, type GridLayout } from "../../../shared/session-grid";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * The icon-only layout switcher, at the far right of the session strip.
 *
 * It lives here rather than in the editor row because that row disappears when no
 * file is open, which would make the control vanish with it. The trigger shows the
 * current preset; the menu is a compact row of five icons with no visible wording.
 * Icons run widest to narrowest (four panes on the left, single on the right) so
 * the row matches the visual weight of the shapes. Accessible names come from
 * `GRID_LAYOUT_LABELS`, so the control stays usable by keyboard and screen reader.
 *
 * `gridLayoutChoices` is pure so the labels and the checked preset are tested
 * without opening a Radix menu in jsdom (the same split `tabMenuItems` and
 * `panePickerModel` use).
 */
export function GridLayoutMenu(): React.JSX.Element {
  const layout = useAppStore((state) => state.prefs.grid.layout);
  const setGridLayout = useAppStore((state) => state.setGridLayout);

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
          <LayoutIcon layout={layout} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-0 p-1">
        <div className="flex items-center gap-0.5" role="group" aria-label="Grid layout">
          {gridLayoutChoices(layout).map((choice) => (
            <DropdownMenuItem
              key={choice.layout}
              role="menuitemradio"
              aria-checked={choice.checked}
              aria-label={choice.label}
              title={choice.label}
              onSelect={() => setGridLayout(choice.layout)}
              data-testid={`grid-layout-${choice.layout}`}
              data-checked={choice.checked ? "true" : undefined}
              className={cn("size-7 justify-center p-0", choice.checked && "bg-raised text-accent")}
            >
              <LayoutIcon layout={choice.layout} />
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One preset with its accessible label and checked state. */
export interface GridLayoutChoice {
  layout: GridLayout;
  label: string;
  checked: boolean;
}

export function gridLayoutChoices(current: GridLayout): GridLayoutChoice[] {
  // The menu reads widest to narrowest, opposite the canonical model order:
  // four panes at the far left and single at the far right.
  return [...GRID_LAYOUTS].reverse().map((layout) => ({
    layout,
    label: GRID_LAYOUT_LABELS[layout],
    checked: layout === current,
  }));
}

const ICONS: Record<GridLayout, LucideIcon> = {
  single: Square,
  two: Columns2,
  "three-left": PanelsLeftBottom,
  "three-right": PanelsRightBottom,
  four: Grid2x2,
};

const ICON_NAMES: Record<GridLayout, string> = {
  single: "square",
  two: "columns-2",
  "three-left": "panels-left-bottom",
  "three-right": "panels-right-bottom",
  four: "grid-2x2",
};

/** Stable name for tests and diagnostics. */
export function layoutIconName(layout: GridLayout): string {
  return ICON_NAMES[layout];
}

function LayoutIcon({ layout }: { layout: GridLayout }): React.JSX.Element {
  const Icon = ICONS[layout];
  return (
    <Icon className="size-3.5 shrink-0 text-ink-muted" aria-hidden data-icon={ICON_NAMES[layout]} />
  );
}
