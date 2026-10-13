import { Button, Card, CardContent } from '@iart/ui';
import { formatTime } from '../../client/utils/time';
import type { PromptPresetRecord } from './PromptPresetTab.hooks';

export interface PresetItemProps {
  preset: PromptPresetRecord;
  isDeleteConfirming: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** 内容预览截断（等价 vanilla truncatePresetContent：空白折叠 + 超长省略） */
function truncatePresetContent(value: string | null | undefined, maxLength: number): string {
  const text: string = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const limit: number = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 80;
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '...';
}

export function PresetItem({ preset, isDeleteConfirming, onCopy, onEdit, onDelete }: PresetItemProps) {
  return (
    <Card className="gap-0 p-0 transition hover:bg-elevated hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CardContent className="flex items-center justify-between gap-4 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-sm font-medium">{preset.name ? String(preset.name) : '未命名预设'}</div>
          <div className="truncate text-xs text-muted-foreground">
            {truncatePresetContent(preset.content ? String(preset.content) : '', 90)}
          </div>
          <span className="w-fit rounded-full bg-success/10 px-2 py-0.5 font-mono text-xs text-success">
            {preset.updatedAt ? '更新于 ' + formatTime(preset.updatedAt) : '预设'}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" onClick={onCopy}>
            复制
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            编辑
          </Button>
          {/* 行内两段式删除确认（按钮样式标准 §4/§6）：静止态是行内危险动作 → ghost-destructive；
              进入确认态后这颗按钮就是最终执行钮，后果强度需匹配 → destructive 实底。
              非字面量 variant 待登记 BTN-003 白名单 */}
          <Button
            size="sm"
            variant={isDeleteConfirming ? 'destructive' : 'ghost-destructive'}
            onClick={onDelete}
          >
            {isDeleteConfirming ? '确认删除' : '删除'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
