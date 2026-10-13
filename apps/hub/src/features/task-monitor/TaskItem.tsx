import { Badge, Card, CardContent } from '@iart/ui';
import { formatTime } from '../../client/utils/time';
import type { TaskSummaryItem } from '../../client/types';
import { RUNNING_STATUSES, STATUS_LABEL, type TaskProgress, type TaskStatus } from './TaskMonitorTab.hooks';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

/** 状态徽章视觉映射（等价 vanilla STATUS_BADGE_CLASS 的 pending/running/polling/downloading/success/failed） */
const STATUS_BADGE_VARIANT: Record<TaskStatus, BadgeVariant> = {
  submitting: 'outline',
  generating: 'secondary',
  polling: 'outline',
  downloading: 'secondary',
  succeeded: 'outline',
  failed: 'destructive',
  cancelled: 'outline',
};

/** 成功态徽章用 success token 派生色（spec §5.2 语义色；不引入 emerald 字面量） */
const SUCCESS_BADGE_CLASS = 'border-success/30 bg-success/10 text-success';

/** 进度文本（等价 vanilla renderTasks 的 progress 拼装：percent + message，空则“运行中...”） */
function buildProgressText(progress: TaskProgress): string {
  let text = '';
  if (progress.percent != null) text += progress.percent + '%';
  if (progress.message) text += (text ? ' ' : '') + progress.message;
  return text || '正在处理...';
}

export interface TaskItemProps {
  task: TaskSummaryItem;
  progress: TaskProgress | undefined;
}

/** 单条任务展示：状态徽章 + modelId + 创建时间 + 运行中进度 + 失败原因（等价 vanilla renderTasks 的 task-item） */
export function TaskItem({ task, progress }: TaskItemProps) {
  return (
    <Card className="gap-0 p-0">
      <CardContent className="flex flex-col gap-1.5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={STATUS_BADGE_VARIANT[task.status]}
            className={task.status === 'succeeded' ? SUCCESS_BADGE_CLASS : undefined}
          >
            {STATUS_LABEL[task.status]}
          </Badge>
          {task.modelId ? <span className="font-mono text-xs text-muted-foreground">{task.modelId}</span> : null}
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{formatTime(task.createdAt)}</span>
        </div>
        {progress !== undefined && RUNNING_STATUSES.has(task.status) ? (
          <div className="text-xs text-muted-foreground">{buildProgressText(progress)}</div>
        ) : null}
        {task.status === 'failed' && task.errorMessage ? (
          <div className="text-xs text-destructive">生成没能完成，请重试</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
