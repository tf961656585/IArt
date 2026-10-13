'use client';

import { IconAlertTriangle, IconFilePlus } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface EmptyProjectDialogProps {
  open: boolean;
  projectPath: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function EmptyProjectDialog({
  open,
  projectPath,
  onConfirm,
  onCancel,
}: EmptyProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconAlertTriangle size={18} />
            <span>项目里还没有内容</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>没能读到项目内容，要以空项目打开吗？</p>
          {projectPath ? (
            <div className="rounded-md border p-2 text-xs text-muted-foreground">
              {projectPath}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onConfirm} className="inline-flex items-center gap-2">
            <IconFilePlus size={16} />
            作为空项目打开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EmptyProjectDialog;
