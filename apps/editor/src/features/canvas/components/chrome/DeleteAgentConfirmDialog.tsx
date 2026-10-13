'use client';

/**
 * 「删除这个 Agent？」确认框（AG-CT-011，文案口径 docs/editor/画布对象右键菜单.md §7.2b）。
 *
 * 删除 Agent 节点并级联物理删除会话（会话、全部消息、发送留痕等历史不可恢复），
 * 产物成员保留画布原位；删除不提供撤销兜底。所有删除入口（右键菜单、选中态工具栏、
 * 键盘 Delete）都经 requestAgentDeleteConfirm 通道汇聚到本确认框，禁止旁路。
 *
 * 受控模式与 DeleteGroupConfirmDialog 一致：request === null 时关闭；
 * 触发方先关闭自身浮层（菜单 / 工具栏）再开本确认框，避免层叠冲突。
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

type DeleteAgentConfirmDialogProps = {
  /** 待删 Agent 节点 id 集合；null 表示确认框关闭 */
  request: readonly string[] | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DeleteAgentConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: DeleteAgentConfirmDialogProps) {
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
            <DialogTitle>删除这个 Agent？</DialogTitle>
            <DialogDescription>
              删除这个 Agent
              后，它的会话和全部消息记录将被清除，无法恢复。生成的内容仍保留在画布。
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

export default DeleteAgentConfirmDialog;
