'use client';

/**
 * 提示词字段操作组件
 * - 收藏当前提示词
 * - 从收藏中应用提示词
 */

import { useState, useCallback } from 'react';
import { IconBookmarkPlus, IconBookmarks } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { usePromptCollection } from '../../hooks/usePromptCollection';
import { cn } from '@/lib/utils';

interface PromptFieldActionsProps {
  /** 当前提示词内容 */
  value: string;
  /** 应用收藏到当前字段 */
  onApply: (content: string) => void;
  /** 字段名称（用于默认收藏名） */
  fieldName: string | undefined;
  /** 自定义类名 */
  className: string | undefined;
}

export function PromptFieldActions({
  value,
  onApply,
  className,
}: PromptFieldActionsProps) {
  const { items, add } = usePromptCollection();
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const [applyPopoverOpen, setApplyPopoverOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const handleSave = useCallback(async () => {
    if (!value.trim()) {
      toast.error('提示词内容为空');
      return;
    }
    const name = saveName.trim();
    if (!name) {
      toast.error('请输入收藏名称');
      return;
    }
    const id = await add(name, value.trim());
    if (id) {
      toast.success('已收藏');
      setSavePopoverOpen(false);
      setSaveName('');
    }
  }, [value, saveName, add]);

  const handleApply = useCallback((content: string) => {
    onApply(content);
    setApplyPopoverOpen(false);
    toast.success('已应用');
  }, [onApply]);

  const truncateContent = (content: string, maxLength = 60) => {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...';
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {/* 收藏当前提示词 */}
      <Popover open={savePopoverOpen} onOpenChange={setSavePopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="收藏此提示词"
            disabled={!value.trim()}
          >
            <IconBookmarkPlus size={14} />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64" align="end">
          <div className="space-y-3">
            <Label htmlFor="save-prompt-name">收藏名称</Label>
            <Input
              id="save-prompt-name"
              placeholder="请输入名称"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSave();
                }
              }}
            />
            <Button className="w-full" size="sm" onClick={handleSave} disabled={!saveName.trim()}>
              收藏
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* 从收藏中应用 */}
      <Popover open={applyPopoverOpen} onOpenChange={setApplyPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="从收藏中选择"
            disabled={items.length === 0}
          >
            <IconBookmarks size={14} />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-2">
            <Label>选择收藏</Label>
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                还没有收藏的提示词
              </p>
            ) : (
              <ScrollArea className="max-h-64">
                <div className="space-y-1">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        'w-full text-left p-2 rounded-md transition-colors',
                        'hover:bg-accent hover:text-accent-foreground'
                      )}
                      onClick={() => handleApply(item.content)}
                    >
                      <div className="font-medium text-sm truncate">
                        {item.name}
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-2">
                        {truncateContent(item.content)}
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
