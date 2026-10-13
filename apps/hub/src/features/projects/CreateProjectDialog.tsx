import { useEffect, useState } from 'react';
import type { SelectFolderResult } from '@iart/backend-sdk';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@iart/ui';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { formatSelectFolderFailure } from '../../client/projects/utils';
import type { CreateProjectPayload } from './ProjectsTab.hooks';

export interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (payload: CreateProjectPayload) => void;
}

export function CreateProjectDialog({ open, onOpenChange, onConfirm }: CreateProjectDialogProps) {
  const { platform } = useHubRuntime();
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [picking, setPicking] = useState(false);
  const [statusText, setStatusText] = useState('');

  // 打开时重置表单，等价 vanilla openCreateProjectModal 的清空行为
  useEffect(() => {
    if (!open) return;
    setName('');
    setDir('');
    setStatusText('');
  }, [open]);

  const pickDir = async (): Promise<void> => {
    if (picking) return;
    if (!platform.isElectron()) {
      setStatusText('请在桌面应用中选择保存位置');
      return;
    }

    try {
      setPicking(true);
      setStatusText('请选择项目保存位置...');
      const result: SelectFolderResult = await platform.selectFolder({
        title: '选择项目保存位置',
        defaultPath: undefined,
        buttonLabel: '选择',
      });

      if (result && result.status === 'canceled') {
        setStatusText('已取消选择保存位置');
        return;
      }

      if (result && result.status === 'success' && result.path) {
        setDir(result.path);
        setStatusText('已选择保存位置');
        return;
      }

      if (result && result.status === 'error') {
        console.error('[hub] pickCreateProjectDir failed:', result.errorCode, result.debugMessage || '');
        setStatusText(formatSelectFolderFailure(result, '没能选择保存位置，请重试'));
        return;
      }

      setStatusText('没能选择保存位置，请重试');
    } catch (error: unknown) {
      console.error('[hub] pickCreateProjectDir error:', error);
      setStatusText('没能选择保存位置，请重试');
    } finally {
      setPicking(false);
    }
  };

  const confirm = (): void => {
    const trimmedName: string = name.trim();
    const trimmedDir: string = dir.trim();
    if (!trimmedName) {
      setStatusText('请输入项目名称');
      return;
    }
    if (!trimmedDir) {
      setStatusText('请选择项目保存位置');
      return;
    }
    onConfirm({ name: trimmedName, dir: trimmedDir });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-project-name">项目名称</Label>
            <Input
              id="create-project-name"
              value={name}
              placeholder="请输入项目名称"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  confirm();
                }
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-project-dir">保存位置</Label>
            <div className="flex gap-2">
              <Input id="create-project-dir" value={dir} readOnly placeholder="请选择保存位置" className="flex-1" />
              <Button type="button" variant="outline" disabled={picking} onClick={() => void pickDir()}>
                选择
              </Button>
            </div>
          </div>
          {statusText ? <div className="text-xs text-muted-foreground">{statusText}</div> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={confirm}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
