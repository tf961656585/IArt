'use client';

/**
 * 「删除组及全部成员」确认框。
 *
 * spec：docs/editor/画布对象右键菜单.md §7.3 组菜单表——显式连删必须弹确认框，
 * 列出组成员数量，红色确认按钮；确认后仍可撤销（单条历史记录）。
 *
 * 受控模式与 AddToGroupPopover 一致：request === null 时关闭；
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

/** 删除组确认请求：null 表示确认框关闭。 */
export type DeleteGroupConfirmRequest = {
  groupId: string;
  groupName: string;
  memberCount: number;
};

type DeleteGroupConfirmDialogProps = {
  request: DeleteGroupConfirmRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DeleteGroupConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: DeleteGroupConfirmDialogProps) {
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
            <DialogTitle>删除组及全部成员</DialogTitle>
            <DialogDescription>
              将删除组「{request.groupName}」及其 {request.memberCount}{' '}
              个成员节点和关联内容。删除后可通过撤销恢复。
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

export default DeleteGroupConfirmDialog;
