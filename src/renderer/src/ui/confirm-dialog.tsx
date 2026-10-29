/**
 * A small confirmation dialog (git-checkpoint plan step 11).
 *
 * The app already has bespoke confirmation surfaces (package consent, project
 * trust), but git grows a family of small destructive confirmations — discard a
 * file, drop a stash, restore a checkpoint — and each needs the same three
 * things: an explicit action name, the exact target, and a cancel that is the
 * default. This is that one component, built on the owned Radix dialog.
 */

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** The consequence, in the user's terms. */
  description: ReactNode;
  /** Names the action; never "OK" (the plan's D10/D13 wording). */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` tints the confirm button for an irreversible action. */
  tone?: "danger" | "accent";
  /** Extra content between the description and the buttons (a file list). */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined} data-testid="confirm-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
        <div className="mt-4 flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
