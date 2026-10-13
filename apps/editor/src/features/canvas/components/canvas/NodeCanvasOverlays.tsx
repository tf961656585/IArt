"use client";

import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type ConnectionRejectHint = {
  x: number;
  y: number;
  placement: "top" | "bottom";
  title: string;
  description: string | undefined;
};

type ImportWarningsDialogState = {
  open: boolean;
  warnings: string[];
};

export function NodeCanvasEmptyState({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-muted/30">
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}

export function ConnectionRejectHintOverlay({
  hint,
}: {
  hint: ConnectionRejectHint | null;
}) {
  if (!hint) return null;
  return (
    <div
      className="absolute z-feedback pointer-events-none"
      style={{
        left: hint.x,
        top: hint.y,
        transform:
          hint.placement === "top"
            ? "translate(-50%, calc(-100% - 12px))"
            : "translate(-50%, 12px)",
      }}
    >
      <div className="animate-in fade-in-0 zoom-in-95 relative w-[300px] rounded-md bg-destructive text-destructive-foreground px-3 py-2 shadow-lg">
        <div
          className={cn(
            "absolute left-1/2 -translate-x-1/2 w-2 h-2 bg-destructive rotate-45",
            hint.placement === "top" ? "-bottom-1" : "-top-1",
          )}
        />
        <div className="text-xs font-semibold leading-4">{hint.title}</div>
        {hint.description && (
          <div className="mt-1 text-xs leading-4 opacity-90">
            {hint.description}
          </div>
        )}
      </div>
    </div>
  );
}

export function PendingPlacementBanner({
  pendingPlacement,
  onCancel,
}: {
  pendingPlacement: { characterName: string } | null;
  onCancel: () => void;
}) {
  if (!pendingPlacement) return null;
  return (
    <div
      className={cn(
        "absolute top-4 left-1/2 -translate-x-1/2",
        "flex items-center gap-2 px-4 py-2",
        "bg-primary text-primary-foreground rounded-full",
        "shadow-lg z-canvas-banner",
        "animate-in fade-in-0 zoom-in-95",
      )}
    >
      <span className="text-sm font-medium">
        点击画布放置「{pendingPlacement.characterName}」
      </span>
      <button
        className="ml-2 px-2 py-0.5 text-xs bg-primary-foreground/20 hover:bg-primary-foreground/30 rounded transition-colors"
        onClick={onCancel}
      >
        ESC 取消
      </button>
    </div>
  );
}

export function PendingAnnotationBindingBanner({
  active,
  onCancel,
}: {
  active: boolean;
  onCancel: () => void;
}) {
  if (!active) return null;
  return (
    <div
      className={cn(
        "absolute top-16 left-1/2 -translate-x-1/2",
        "flex items-center gap-2 px-4 py-2",
        "bg-primary text-primary-foreground rounded-full",
        "shadow-lg z-canvas-banner",
        "animate-in fade-in-0 zoom-in-95",
      )}
    >
      <span className="text-sm font-medium">点击要绑定的节点</span>
      <button
        className="ml-2 px-2 py-0.5 text-xs bg-primary-foreground/20 hover:bg-primary-foreground/30 rounded transition-colors"
        onClick={onCancel}
      >
        ESC 取消
      </button>
    </div>
  );
}

export function BundleImportWarningsDialog({
  dialog,
  setDialog,
}: {
  dialog: ImportWarningsDialogState;
  setDialog: Dispatch<SetStateAction<ImportWarningsDialogState>>;
}) {
  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(nextOpen) => {
        setDialog((prev) => ({ ...prev, open: nextOpen }));
      }}
    >
      <DialogContent form="standard" size="compact">
        <DialogHeader className="space-y-1">
          <DialogTitle>导入警告</DialogTitle>
          <DialogDescription>
            本次导入产生了 {dialog.warnings.length} 条警告，内容如下。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[360px] overflow-auto space-y-2 text-sm">
          {dialog.warnings.map((warning, index) => (
            <div
              key={`${index}-${warning}`}
              className="rounded-md border border-border/60 bg-background px-3 py-2"
            >
              {warning}
            </div>
          ))}
        </div>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setDialog((prev) => ({
                ...prev,
                open: false,
              }))
            }
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
