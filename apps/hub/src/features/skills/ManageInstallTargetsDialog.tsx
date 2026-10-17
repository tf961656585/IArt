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
 * 「管理自定义 Agent 目录」集中管理弹层（docs/hub/skill-store.md §3.2 UI 口径）：
 * 内置目标只读展示（带「内置」徽标，不可编辑/删除）；自定义目标统一增删改——
 * 名称与文件夹都可编辑，文件夹支持键入/粘贴，也可用「选择文件夹」唤起系统选择框
 * （选择框显示隐藏文件）。改路径只改注册表指向，原文件夹里的 Skill 文件不搬移。
 * Skill 卡片只读展示目标行，不在此弹层之外提供管理入口。
 *
 * 弹层内每次操作后自行刷新列表；关闭由父级刷新 customTargets + installedState
 * （新目标目录里可能已有已装 skill，重新添加同一目录会被状态扫描自动识别）。
 */

/** 错误码 → 用户提示（集中一处；unknown-target 仅 install/reveal 链路产生，弹层内按兜底处理） */
const CUSTOM_TARGET_ERROR_TEXT: Record<SkillCustomTargetErrorCode, string> = {
  // 粘贴路径成为 invalid-request 主来源（非绝对路径 / 目标路径是文件等）：指认字段并给出修法
  'invalid-request': '文件夹路径不对，请填写完整的文件夹路径（可用 ~ 开头）',
  'duplicate-dir': '该文件夹已被其他自定义目录使用，请另选一个文件夹',
  'nested-dir': '该文件夹与其他自定义目录的文件夹重叠，请另选位置',
  'reserved-dir': '不能使用应用数据所在的文件夹，请另选一个文件夹',
  'not-found': '该目录不存在，可能已被删除',
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
  // 行内编辑（名称 + 文件夹共用一个编辑态；与删除共用忙碌位；同一时刻只操作一行）
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNameDraft, setEditNameDraft] = useState('');
  const [editDirDraft, setEditDirDraft] = useState('');
  const [editPicking, setEditPicking] = useState(false);
  /** 行内提示：error 为红色，success 为静默语义色（如改路径成功说明） */
  const [rowNotice, setRowNotice] = useState<{ id: string; kind: 'error' | 'success'; text: string } | null>(null);
  // 删除确认
  const [removing, setRemoving] = useState<CustomSkillInstallTarget | null>(null);

  const resetForm = useCallback((): void => {
    setName('');
    setDir('');
    setAddNotice(null);
    setEditingId(null);
    setEditNameDraft('');
    setEditDirDraft('');
    setEditPicking(false);
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
        showHiddenFiles: true,
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
      setAddNotice('请填写或选择文件夹路径');
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

  /** 进入编辑态只铺草稿，不写盘；名称与文件夹各留一份可编辑草稿 */
  const startEdit = (entry: CustomSkillInstallTarget): void => {
    setEditingId(entry.id);
    setEditNameDraft(entry.name);
    setEditDirDraft(entry.skillsDir);
    setRowNotice(null);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setEditNameDraft('');
    setEditDirDraft('');
    setRowNotice(null);
  };

  /** 编辑态「选择文件夹」：与添加区同一条选择框通道（同样显示隐藏文件），结果只回填草稿 */
  const pickEditDir = async (entry: CustomSkillInstallTarget): Promise<void> => {
    if (editPicking) return;
    if (!platform.isElectron()) {
      setRowNotice({ id: entry.id, kind: 'error', text: '请在桌面应用中选择文件夹' });
      return;
    }
    try {
      setEditPicking(true);
      setRowNotice(null);
      const result: SelectFolderResult = await platform.selectFolder({
        title: '选择 Skill 安装文件夹',
        defaultPath: undefined,
        buttonLabel: '选择',
        showHiddenFiles: true,
      });
      if (result.status === 'canceled') return;
      if (result.status === 'success') {
        setEditDirDraft(result.path);
        return;
      }
      console.error('[hub] pickSkillTargetDir failed:', result.errorCode, result.debugMessage || '');
      setRowNotice({ id: entry.id, kind: 'error', text: formatSelectFolderFailure(result, '没能选择文件夹，请重试') });
    } catch (error: unknown) {
      console.error('[hub] pickSkillTargetDir error:', error);
      setRowNotice({ id: entry.id, kind: 'error', text: '没能选择文件夹，请重试' });
    } finally {
      setEditPicking(false);
    }
  };

  const saveEdit = async (entry: CustomSkillInstallTarget): Promise<void> => {
    const trimmedName: string = editNameDraft.trim();
    if (!trimmedName) {
      setRowNotice({ id: entry.id, kind: 'error', text: '请填写名称' });
      return;
    }
    // 前端只拦空值；路径形态（绝对路径、~ 等）交主进程裁定
    const trimmedDir: string = editDirDraft.trim();
    if (!trimmedDir) {
      setRowNotice({ id: entry.id, kind: 'error', text: '请填写或选择文件夹路径' });
      return;
    }
    const pathChanged: boolean = trimmedDir !== entry.skillsDir;
    setBusyId(entry.id);
    setRowNotice(null);
    const result = await platform.updateCustomSkillInstallTarget(entry.id, trimmedName, trimmedDir);
    setBusyId(null);
    if (!result.ok) {
      setRowNotice({ id: entry.id, kind: 'error', text: CUSTOM_TARGET_ERROR_TEXT[result.error] });
      // 该目标可能已被别处删除：刷新列表，让行与注册表对齐
      if (result.error === 'not-found') await loadTargets();
      return;
    }
    setEditingId(null);
    setEditNameDraft('');
    setEditDirDraft('');
    await loadTargets();
    if (pathChanged) {
      // 只改注册表指向，不搬移已有文件：把后果说清，避免用户以为 Skill 会跟着走
      setRowNotice({
        id: entry.id,
        kind: 'success',
        text: '路径已更新。原来文件夹里的 Skill 文件不会被移动，如需在新文件夹使用请重新安装。',
      });
    }
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
      setRowNotice({ id: entry.id, kind: 'error', text: CUSTOM_TARGET_ERROR_TEXT[result.error] });
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
            <DialogTitle>管理自定义 Agent 目录</DialogTitle>
          </DialogHeader>
          {/* 组间空档 16px（gap-4，visual-design §8.6 律三间隙阶梯）：内置列表 ↔ 自定义列表/空态 ↔ 表单区 */}
          <div className="flex flex-col gap-4">
            {/* 内置目标：只读展示，不可编辑/删除 */}
            <div className="flex flex-col gap-2">
              {INSTALL_TARGETS.map((row) => (
                <div
                  key={row.target}
                  className="flex items-center gap-2 rounded-md bg-elevated px-3 py-2 text-sm"
                >
                  <span>{row.label}</span>
                  <Badge variant="secondary">内置</Badge>
                </div>
              ))}
            </div>
            {/* 自定义目标 */}
            {targets === null ? (
              <div className="py-1 text-center text-sm text-muted-foreground">正在读取自定义目录...</div>
            ) : loadFailed ? (
              <div className="flex flex-col items-center gap-2 py-1">
                <div className="text-sm text-destructive">没能读取自定义目录</div>
                <Button type="button" variant="outline" size="sm" onClick={() => void loadTargets()}>
                  重试
                </Button>
              </div>
            ) : targets.length === 0 ? (
              <div className="py-1 text-sm text-muted-foreground">
                还没有自定义目录。添加后，可以把 Skill 安装到你指定的文件夹。
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {targets.map((entry) => (
                  <div key={entry.id} className="flex flex-col gap-1 rounded-md bg-elevated px-3 py-2">
                    {editingId === entry.id ? (
                      <div className="flex flex-col gap-2">
                        {/* 行内编辑排钉 32px 档：输入框与 size="sm" 按钮同高（visual-design §8.6 律一） */}
                        <div className="flex items-center gap-2">
                          <Input
                            value={editNameDraft}
                            maxLength={50}
                            aria-label={`编辑名称 ${entry.name}`}
                            disabled={busyId === entry.id}
                            onChange={(event) => setEditNameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void saveEdit(entry);
                              }
                            }}
                            className="h-8 text-sm"
                          />
                          <Button
                            size="sm"
                            aria-label={`保存 ${entry.name}`}
                            disabled={busyId === entry.id}
                            onClick={() => void saveEdit(entry)}
                          >
                            保存
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`取消 ${entry.name}`}
                            disabled={busyId === entry.id}
                            onClick={cancelEdit}
                          >
                            取消
                          </Button>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            value={editDirDraft}
                            aria-label={`编辑文件夹 ${entry.name}`}
                            disabled={busyId === entry.id || editPicking}
                            onChange={(event) => setEditDirDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void saveEdit(entry);
                              }
                            }}
                            className="h-8 min-w-0 flex-1 font-mono text-xs"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`选择文件夹 ${entry.name}`}
                            disabled={busyId === entry.id || editPicking}
                            onClick={() => void pickEditDir(entry)}
                          >
                            选择文件夹
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm">{entry.name}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`编辑 ${entry.name}`}
                            disabled={busyId === entry.id}
                            onClick={() => startEdit(entry)}
                          >
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost-destructive"
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
                      <div
                        className={
                          rowNotice.kind === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                        }
                      >
                        {rowNotice.text}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {/* 添加区：路径可键入/粘贴或用系统选择框；分组语义由小节标题承载（visual-design §8.6 律三） */}
            <div className="flex flex-col gap-2">
              <div className="text-2xs font-semibold tracking-wider text-muted-foreground">添加自定义目录</div>
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
                  {/* 可键入 / 可粘贴路径（参与 Tab 序）；「选择文件夹」按钮另行唤起系统选择框。
                      前端只拦空值，路径形态的合法性交主进程裁定（invalid-request） */}
                  <Input
                    id="skill-target-dir"
                    value={dir}
                    placeholder="选择或粘贴文件夹路径"
                    disabled={adding}
                    onChange={(event) => setDir(event.target.value)}
                    className="min-w-0 flex-1 font-mono text-xs"
                  />
                  <Button type="button" variant="outline" disabled={picking} onClick={() => void pickDir()}>
                    选择文件夹
                  </Button>
                </div>
              </div>
              {addNotice ? <div className="text-xs text-destructive">{addNotice}</div> : null}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            {/* 忙碌态由 loading prop 承载（spinner + aria-busy + 自动禁用），不改写文案 */}
            <Button type="button" loading={adding} onClick={() => void addTarget()}>
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        title="删除自定义目录"
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
