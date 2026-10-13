'use client';

/**
 * 「删除失败节点」确认框。
 *
 * spec：docs/editor/画布对象右键菜单.md §7.6 空白区菜单表——批量清理失败节点必须弹确认框，
 * 列出将删除的节点数，红色确认按钮；确认后仍可撤销（单条历史记录）。
 *
 * 受控模式与 DeleteGroupConfirmDialog / AddToGroupPopover 一致：request === null 时关闭；
 * 触发时先关右键菜单再开本确认框，避免层叠冲突。
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** 删除失败节点确认请求：null 表示确认框关闭。 */
export type DeleteFailedNodesConfirmRequest = {
  /** 请求时刻求得的失败任务节点 id 集合（确认后按此集合删除） */
  nodeIds: string[];
  count: number;
};

type DeleteFailedNodesConfirmDialogProps = {
  request: DeleteFailedNodesConfirmRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DeleteFailedNodesConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: DeleteFailedNodesConfirmDialogProps) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {request !== null && (
        <DialogContent form="standard" size="compact">
          <DialogHeader>
            <DialogTitle>删除失败节点</DialogTitle>
            <DialogDescription>
              将删除画布上 {request.count} 个生成失败的任务节点及其关联内容。删除后可通过撤销恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

export default DeleteFailedNodesConfirmDialog;
