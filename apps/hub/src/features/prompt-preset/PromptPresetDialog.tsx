import { useEffect, useState } from 'react';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from '@iart/ui';
import type { PromptPresetRecord, SavePromptPresetPayload } from './PromptPresetTab.hooks';

export interface PromptPresetDialogProps {
  open: boolean;
  /** 编辑目标；null 表示新增 */
  preset: PromptPresetRecord | null;
  onOpenChange: (open: boolean) => void;
  /** 保存回调（返回是否成功；失败时弹窗保持打开并展示错误） */
  onSave: (payload: SavePromptPresetPayload) => Promise<boolean>;
}

export function PromptPresetDialog({ open, preset, onOpenChange, onSave }: PromptPresetDialogProps) {
  const isEdit: boolean = Boolean(preset && preset.id);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState('');

  // 打开时重置表单（等价 vanilla openPromptPresetModal 的填值行为）
  useEffect(() => {
    if (!open) return;
    setName(preset && preset.name ? String(preset.name) : '');
    setContent(preset && preset.content ? String(preset.content) : '');
    setStatusText('');
    setSaving(false);
  }, [open, preset]);

  const confirm = async (): Promise<void> => {
    if (saving) return;
    const trimmedName: string = name.trim();
    const trimmedContent: string = content.trim();
    if (!trimmedName || !trimmedContent) {
      setStatusText('请填写名称与提示词内容');
      return;
    }
    setSaving(true);
    setStatusText(isEdit ? '正在保存...' : '正在创建...');
    try {
      const ok: boolean = await onSave({
        id: isEdit ? String(preset && preset.id) : undefined,
        name: trimmedName,
        content: trimmedContent,
      });
      if (ok) {
        onOpenChange(false);
      } else {
        setStatusText('没能保存，请重试');
      }
    } catch (error: unknown) {
      console.error('[hub] savePromptPreset modal error:', error);
      setStatusText('没能保存，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑预设' : '新增预设'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="prompt-preset-name">名称（必填）</Label>
            <Input
              id="prompt-preset-name"
              value={name}
              placeholder="请输入预设名称"
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="prompt-preset-content">提示词内容（必填）</Label>
            <Textarea
              id="prompt-preset-content"
              value={content}
              placeholder="请输入提示词内容"
              rows={8}
              disabled={saving}
              onChange={(event) => setContent(event.target.value)}
            />
          </div>
          {statusText ? <div className="text-xs text-muted-foreground">{statusText}</div> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={saving} onClick={() => void confirm()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
