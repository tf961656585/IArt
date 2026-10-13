'use client';

import { IconDatabase, IconHistory } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatBeijingTime } from '@/shared/utils/time';

interface RecoveryDialogProps {
  open: boolean;
  pendingChangeCount: number;
  lastPersistedAt: string | null;
  onRecover: () => void;
  onDiscard: () => void;
}

export function RecoveryDialog({ open, pendingChangeCount, lastPersistedAt, onRecover, onDiscard }: RecoveryDialogProps) {
  const savedAtText = lastPersistedAt ? formatBeijingTime(lastPersistedAt) : '';
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDiscard()}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconHistory size={18} />
            <span>上次还有改动没恢复</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>上次关闭前还有没保存完成的改动，要恢复吗？</p>
          <div className="flex items-center gap-2 rounded-md border p-2">
            <IconDatabase size={16} />
            <div className="space-y-1">
              <div>最近保存时间：{savedAtText || '未知'}</div>
              <div>要恢复的改动：{pendingChangeCount > 0 ? pendingChangeCount : '无'}</div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDiscard}>
            放弃
          </Button>
          <Button onClick={onRecover}>恢复改动</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RecoveryDialog;
