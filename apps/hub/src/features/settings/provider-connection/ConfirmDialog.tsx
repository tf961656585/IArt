import type { ReactNode } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@iart/ui';

/**
 * 服务商与模型管理专用确认弹窗（危险操作二次确认）。
 * 复用 @iart/ui Dialog，替换 Electron renderer 不支持的 window.confirm。
 * 父层经 onResolve 收到用户决定：true=确认 / false=取消（ESC/关闭按钮视为取消）。
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  /** 确认按钮文案（默认「确认」） */
  confirmLabel?: string;
  /** 危险操作样式（红色确认按钮） */
  danger?: boolean;
  onResolve: (confirmed: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  danger = false,
  onResolve,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onResolve(false);
      }}
    >
      <DialogContent
        form="standard"
        size="compact"
        // 二次确认必须显式决定（取消/确认/×/ESC）：阻断 Radix 点击外部自动关闭。
        // 触发场景：用户双击「更新模型服务」时，第二下的 pointerdown 落在刚盖上的
        // overlay 上，DismissableLayer 视为 outside-interact 直接关弹窗，
        // 表现为"确认弹窗自动消失、无法点击"。ESC 与 × 关闭仍走 onOpenChange=取消。
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-left">{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onResolve(false)}>
            取消
          </Button>
          <Button type="button" variant={danger ? 'destructive' : 'primary'} onClick={() => onResolve(true)}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
