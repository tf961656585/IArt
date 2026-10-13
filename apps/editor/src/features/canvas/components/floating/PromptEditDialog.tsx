'use client';

/**
 * 提示词编辑/新增弹窗
 */

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string | undefined;
  initialContent: string | undefined;
  onSave: (name: string, content: string) => Promise<void>;
  mode: 'add' | 'edit';
}

export function PromptEditDialog({
  open,
  onOpenChange,
  initialName = '',
  initialContent = '',
  onSave,
  mode,
}: Props) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);

  // 重置表单
  useEffect(() => {
    if (open) {
      setName(initialName);
      setContent(initialContent);
    }
  }, [open, initialName, initialContent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;

    setIsSaving(true);
    try {
      await onSave(name.trim(), content.trim());
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const isValid = name.trim().length > 0 && content.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle>
            {mode === 'add' ? '新增提示词收藏' : '编辑提示词收藏'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="prompt-name">名称</Label>
            <Input
              id="prompt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="为这个提示词起个名字..."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt-content">提示词内容</Label>
            <Textarea
              id="prompt-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="输入提示词内容..."
              rows={6}
              className="resize-none"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={!isValid || isSaving}>
              {isSaving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
