import { useCallback, useEffect, useState } from 'react';
import type { SelectFolderResult } from '@iart/backend-sdk';
import type {
  CustomSkillInstallTarget,
  SkillCustomTargetErrorCode,
  SkillListCustomTargetsResult,
} from '@iart/contracts';
import { Badge, Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@iart/ui';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { formatSelectFolderFailure } from '../../client/projects/utils';
import { INSTALL_TARGETS } from './SkillsTab.hooks';
import { ConfirmDialog } from '../settings/provider-connection/ConfirmDialog';

/**
 * 「管理安装目标」集中管理弹层（docs/hub/skill-store.md §3.2 UI 口径）：
 * 内置目标只读展示（带「内置」徽标，不可改名/删除）；自定义目标统一增删改，
 * 目录唯一来源是系统选择框（复用 selectFolder 平台方法）。Skill 卡片只读展示目标行，
 * 不在此弹层之外提供管理入口。
 *
 * 弹层内每次操作后自行刷新列表；关闭由父级刷新 customTargets + installedState
 * （新目标目录里可能已有已装 skill，重新添加同一目录会被状态扫描自动识别）。
 */

/** 错误码 → 用户提示（集中一处；unknown-target 仅 install/reveal 链路产生，弹层内按兜底处理） */
const CUSTOM_TARGET_ERROR_TEXT: Record<SkillCustomTargetErrorCode, string> = {
  'invalid-request': '请检查输入后重试',
  'duplicate-dir': '该文件夹已被其他安装目标使用，请另选一个文件夹',
  'nested-dir': '该文件夹与其他安装目标的文件夹重叠，请另选位置',
  'reserved-dir': '不能使用应用数据所在的文件夹',
  'not-found': '该目标不存在，可能已被删除',
  'unknown-target': '操作失败，请重试',
  'persist-failed': '保存失败，请重试',
  'invoke-failed': '操作失败，请重试',
};

export interface ManageInstallTargetsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManageInstallTargetsDialog({ open, onOpenChange }: ManageInstallTargetsDialogProps) {
  const { platform } = useHubRuntime();

  /** 自定义目标列表；null = 正在读取 */
  const [targets, setTargets] = useState<CustomSkillInstallTarget[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // 添加区
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addNotice, setAddNotice] = useState<string | null>(null);
  // 行内操作（改名/删除共用一个忙碌位与行内错误位；同一时刻只操作一行）
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [rowNotice, setRowNotice] = useState<{ id: string; text: string } | null>(null);
  // 删除确认
  const [removing, setRemoving] = useState<CustomSkillInstallTarget | null>(null);

  const resetForm = useCallback((): void => {
    setName('');
    setDir('');
    setAddNotice(null);
    setRenamingId(null);
    setRenameDraft('');
    setRowNotice(null);
    setBusyId(null);
    setRemoving(null);
  }, []);

  const loadTargets = useCallback(async (): Promise<void> => {
    try {
      const result: SkillListCustomTargetsResult = await platform.listCustomSkillInstallTargets();
      setTargets(result.targets);
      setLoadFailed(false);
    } catch (error: unknown) {
      console.warn('[skills] listCustomSkillInstallTargets failed:', error);
      setTargets([]);
      setLoadFailed(true);
    }
  }, [platform]);

  // 打开时重置表单并加载注册表
  useEffect(() => {
    if (!open) return;
    resetForm();
    setTargets(null);
    setLoadFailed(false);
    void loadTargets();
  }, [loadTargets, open, resetForm]);

  const pickDir = async (): Promise<void> => {
    if (picking) return;
    if (!platform.isElectron()) {
      setAddNotice('请在桌面应用中选择文件夹');
      return;
    }
    try {
      setPicking(true);
      setAddNotice(null);
      const result: SelectFolderResult = await platform.selectFolder({
        title: '选择 Skill 安装文件夹',
        defaultPath: undefined,
        buttonLabel: '选择',
      });
      if (result.status === 'canceled') return;
      if (result.status === 'success') {
        setDir(result.path);
        return;
      }
      console.error('[hub] pickSkillTargetDir failed:', result.errorCode, result.debugMessage || '');
      setAddNotice(formatSelectFolderFailure(result, '没能选择文件夹，请重试'));
    } catch (error: unknown) {
      console.error('[hub] pickSkillTargetDir error:', error);
      setAddNotice('没能选择文件夹，请重试');
    } finally {
      setPicking(false);
    }
  };

  const addTarget = async (): Promise<void> => {
    const trimmedName: string = name.trim();
    if (!trimmedName) {
      setAddNotice('请填写名称');
      return;
    }
    const trimmedDir: string = dir.trim();
    if (!trimmedDir) {
      setAddNotice('请选择文件夹');
      return;
    }
    setAdding(true);
    setAddNotice(null);
    const result = await platform.addCustomSkillInstallTarget(trimmedName, trimmedDir);
    setAdding(false);
    if (!result.ok) {
      setAddNotice(CUSTOM_TARGET_ERROR_TEXT[result.error]);
      return;
    }
    setName('');
    setDir('');
    await loadTargets();
  };

  const startRename = (entry: CustomSkillInstallTarget): void => {
    setRenamingId(entry.id);
    setRenameDraft(entry.name);
    setRowNotice(null);
  };

  const cancelRename = (): void => {
    setRenamingId(null);
    setRenameDraft('');
    setRowNotice(null);
  };

  const saveRename = async (entry: CustomSkillInstallTarget): Promise<void> => {
    const trimmed: string = renameDraft.trim();
    if (!trimmed) {
      setRowNotice({ id: entry.id, text: '请填写名称' });
      return;
    }
    setBusyId(entry.id);
    setRowNotice(null);
    const result = await platform.updateCustomSkillInstallTarget(entry.id, trimmed);
    setBusyId(null);
    if (!result.ok) {
      setRowNotice({ id: entry.id, text: CUSTOM_TARGET_ERROR_TEXT[result.error] });
      // 该目标可能已被别处删除：刷新列表，让行与注册表对齐
      if (result.error === 'not-found') await loadTargets();
      return;
    }
    setRenamingId(null);
    setRenameDraft('');
    await loadTargets();
  };

  const confirmRemove = async (): Promise<void> => {
    const entry = removing;
    if (entry === null) return;
    setRemoving(null);
    setBusyId(entry.id);
    setRowNotice(null);
    const result = await platform.removeCustomSkillInstallTarget(entry.id);
    setBusyId(null);
    if (!result.ok) {
      setRowNotice({ id: entry.id, text: CUSTOM_TARGET_ERROR_TEXT[result.error] });
      // 该目标可能已被别处删除：刷新列表，让行与注册表对齐
      if (result.error === 'not-found') await loadTargets();
      return;
    }
    await loadTargets();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent form="standard" size="compact">
          <DialogHeader>
            <DialogTitle>管理安装目标</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {/* 内置目标：只读展示，不可改名/删除 */}
            <div className="flex flex-col gap-1.5">
              {INSTALL_TARGETS.map((row) => (
                <div
                  key={row.target}
                  className="flex items-center gap-2 rounded-lg bg-elevated px-2 py-1.5 text-sm"
                >
                  <span>{row.label}</span>
                  <Badge variant="secondary">内置</Badge>
                </div>
              ))}
            </div>
            {/* 自定义目标 */}
            {targets === null ? (
              <div className="py-1 text-center text-sm text-muted-foreground">正在读取安装目标...</div>
            ) : loadFailed ? (
              <div className="flex flex-col items-center gap-2 py-1">
                <div className="text-sm text-destructive">没能读取安装目标</div>
                <Button type="button" variant="outline" size="sm" onClick={() => void loadTargets()}>
                  重试
                </Button>
              </div>
            ) : targets.length === 0 ? (
              <div className="py-1 text-sm text-muted-foreground">
                还没有自定义目标。添加后，可以把 Skill 安装到你指定的文件夹。
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {targets.map((entry) => (
                  <div key={entry.id} className="flex flex-col gap-1 rounded-lg bg-elevated px-2 py-1.5">
                    {renamingId === entry.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={renameDraft}
                          maxLength={50}
                          aria-label={`改名 ${entry.name}`}
                          disabled={busyId === entry.id}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void saveRename(entry);
                            }
                          }}
                          className="h-7 text-sm"
                        />
                        <Button
                          size="sm"
                          aria-label={`保存 ${entry.name} 的改名`}
                          disabled={busyId === entry.id}
                          onClick={() => void saveRename(entry)}
                        >
                          保存
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`取消 ${entry.name} 的改名`}
                          disabled={busyId === entry.id}
                          onClick={cancelRename}
                        >
                          取消
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm">{entry.name}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`改名 ${entry.name}`}
                            disabled={busyId === entry.id}
                            onClick={() => startRename(entry)}
                          >
                            改名
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`删除 ${entry.name}`}
                            disabled={busyId === entry.id}
                            onClick={() => setRemoving(entry)}
                          >
                            删除
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="break-all font-mono text-xs text-muted-foreground">{entry.skillsDir}</div>
                    {rowNotice?.id === entry.id ? (
                      <div className="text-xs text-destructive">{rowNotice.text}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {/* 添加区：目录唯一来源是系统选择框 */}
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="skill-target-name">名称</Label>
                <Input
                  id="skill-target-name"
                  value={name}
                  maxLength={50}
                  placeholder="例如：工作电脑"
                  disabled={adding}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addTarget();
                    }
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="skill-target-dir">文件夹</Label>
                <div className="flex gap-2">
                  <Input
                    id="skill-target-dir"
                    value={dir}
                    readOnly
                    placeholder="请选择文件夹"
                    className="min-w-0 flex-1 font-mono text-xs"
                  />
                  <Button type="button" variant="outline" disabled={picking} onClick={() => void pickDir()}>
                    选择文件夹
                  </Button>
                </div>
              </div>
              {addNotice ? <div className="text-xs text-destructive">{addNotice}</div> : null}
              <div className="flex justify-end">
                <Button type="button" disabled={adding} onClick={() => void addTarget()}>
                  {adding ? '正在添加…' : '添加'}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        title="删除安装目标"
        message={removing === null ? '' : `将移除「${removing.name}」。已安装到该文件夹的 Skill 文件不会被删除，需要时可以手动清理。`}
        confirmLabel="删除"
        danger
        onResolve={(confirmed) => {
          if (confirmed) {
            void confirmRemove();
          } else {
            setRemoving(null);
          }
        }}
      />
    </>
  );
}
