'use client';

/**
 * 提示词收藏管理弹窗
 */

import { useState } from 'react';
import { IconEdit, IconCopy, IconTrash, IconPlus } from '@tabler/icons-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { usePromptCollection } from '../../hooks/usePromptCollection';
import { PromptEditDialog } from './PromptEditDialog';
import type { PromptCollectionItem } from '../../types/promptCollection';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可选：应用到当前字段的回调 */
  onApply: ((content: string) => void) | undefined;
}

export function PromptCollectionDialog({ open, onOpenChange, onApply }: Props) {
  const { items, isLoading, error, add, update, remove } = usePromptCollection();
  const [editItem, setEditItem] = useState<PromptCollectionItem | null>(null);
  const [isAddMode, setIsAddMode] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirmId === id) {
      await remove(id);
      setDeleteConfirmId(null);
      toast.success('已删除');
    } else {
      setDeleteConfirmId(id);
      // 3秒后重置确认状态
      setTimeout(() => setDeleteConfirmId(null), 3000);
    }
  };

  const handleSave = async (name: string, content: string) => {
    if (editItem) {
      const success = await update(editItem.id, name, content);
      if (success) {
        toast.success('已更新');
      }
    } else {
      const id = await add(name, content);
      if (id) {
        toast.success('已添加');
      }
    }
    setEditItem(null);
    setIsAddMode(false);
  };

  const truncateContent = (content: string, maxLength = 80) => {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...';
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent form="standard" size="standard">
          <DialogHeader>
            <DialogTitle>提示词收藏</DialogTitle>
          </DialogHeader>

          <DialogBody variant="scroll" className="-mx-6 px-6">
            {isLoading ? (
              <div className="py-8 text-center text-muted-foreground">
                加载中...
              </div>
            ) : error ? (
              <div className="py-8 text-center text-muted-foreground">
                收藏没能加载出来，请重试
              </div>
            ) : items.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                还没有收藏的提示词，点下面的按钮添加
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="group flex items-start gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors"
                  >
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (onApply !== null && onApply !== undefined) {
                          onApply(item.content);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (onApply !== null && onApply !== undefined) {
                            onApply(item.content);
                          }
                        }
                      }}
                    >
                      <div className="font-medium text-sm truncate">
                        {item.name}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {truncateContent(item.content)}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => setEditItem(item)}
                        title="编辑"
                      >
                        <IconEdit size={16} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => handleCopy(item.content)}
                        title="复制"
                      >
                        <IconCopy size={16} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className={
                          deleteConfirmId === item.id
                            ? 'h-8 w-8 text-destructive hover:text-destructive bg-destructive/10'
                            : 'h-8 w-8 text-destructive hover:text-destructive'
                        }
                        onClick={() => handleDelete(item.id)}
                        title={deleteConfirmId === item.id ? '再次点击确认删除' : '删除'}
                      >
                        <IconTrash size={16} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DialogBody>

          <div className="pt-4 border-t">
            <Button onClick={() => setIsAddMode(true)}>
              <IconPlus size={16} className="mr-2" />
              新增收藏
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 编辑/新增弹窗 */}
      <PromptEditDialog
        open={isAddMode || !!editItem}
        onOpenChange={(open) => {
          if (!open) {
            setIsAddMode(false);
            setEditItem(null);
          }
        }}
        initialName={editItem ? editItem.name : undefined}
        initialContent={editItem ? editItem.content : undefined}
        onSave={handleSave}
        mode={editItem ? 'edit' : 'add'}
      />
    </>
  );
}
