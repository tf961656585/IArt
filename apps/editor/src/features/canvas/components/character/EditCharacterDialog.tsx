'use client';

/**
 * 编辑角色弹窗
 * - 修改角色名称和描述
 */

import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { CharacterStore } from '../../services/characterStore';
import type { CharacterIndexItem } from '../../types/character';

interface EditCharacterDialogProps {
  open: boolean;
  character: CharacterIndexItem;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

export function EditCharacterDialog({
  open,
  character,
  onOpenChange,
  onComplete,
}: EditCharacterDialogProps) {
  const [name, setName] = useState(character.name);
  const [description, setDescription] = useState(character.description);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 重置表单
  useEffect(() => {
    if (open) {
      setName(character.name);
      setDescription(character.description);
      setIsSubmitting(false);
    }
  }, [open, character]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent | undefined) => {
      if (e !== null && e !== undefined) {
        e.preventDefault();
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        toast.error('角色名称不能为空');
        return;
      }

      setIsSubmitting(true);

      try {
        const success = await CharacterStore.update(
          character.id,
          { name: trimmedName, description: description.trim() },
        );

        if (success) {
          toast.success('角色信息已更新');
          onComplete();
        } else {
          toast.error('更新失败');
        }
      } catch (error) {
        console.error('[EditCharacterDialog] 更新失败', error);
        toast.error('更新失败，请稍后重试');
      } finally {
        setIsSubmitting(false);
      }
    },
    [character.id, description, name, onComplete]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="compact">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>编辑角色</DialogTitle>
            <DialogDescription>
              修改角色的名称和描述（图片不可修改）
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-character-name">角色名称 *</Label>
              <Input
                id="edit-character-name"
	                value={name}
	                onChange={(e) => setName(e.target.value)}
	                placeholder="输入角色名称"
	                disabled={isSubmitting}
	              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-character-description">角色描述</Label>
              <Textarea
                id="edit-character-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="输入角色描述（可选）"
                rows={3}
                disabled={isSubmitting}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
