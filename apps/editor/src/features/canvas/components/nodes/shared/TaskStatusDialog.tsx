'use client';

import type { ReactNode } from 'react';
import { IconCopy, IconFolder } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatBeijingTime } from '@/shared/utils/time';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { NodeTaskInfo } from '../../../types';
import { getTaskStatusLabel } from '../../../utils/taskStatusMeta';
import { resolveTaskFailurePresentation } from '../../../utils/taskFailurePresentation';

export interface TaskStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string | undefined;
  taskInfo: NodeTaskInfo | null;
  backendMessage: string | null | undefined;
  batchId: string | null | undefined;
  onCopyTaskId: () => void | undefined;
  onOpenArchive: (taskId: string | undefined) => void | undefined;
  canOpenArchive: boolean | undefined;
  openArchiveDisabledReason: string | undefined;
}

function FieldRow({ label, value, mono }: { label: string; value: string; mono: boolean | undefined }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 break-words', mono && 'font-mono text-[12px]')}>{value}</span>
    </div>
  );
}

function DisabledActionTooltip({ reason, children }: { reason: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

const formatTime = (value: number | undefined): string =>
  value ? formatBeijingTime(value) : '-';

const copyText = async (value: string) => {
  if (!value.trim()) return;
  if (navigator.clipboard === null || navigator.clipboard === undefined) {
    console.debug('[TaskStatusDialog] 跳过复制：clipboard API 不可用');
    return;
  }
  await navigator.clipboard.writeText(value);
};

export function TaskStatusDialog({
  open,
  onOpenChange,
  title,
  taskInfo,
  backendMessage,
  batchId,
  onCopyTaskId,
  onOpenArchive,
  canOpenArchive,
  openArchiveDisabledReason,
}: TaskStatusDialogProps) {
  const statusLabel = getTaskStatusLabel((taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined), (taskInfo !== null && taskInfo !== undefined && taskInfo.progress !== null && taskInfo.progress !== undefined ? taskInfo.progress.phase : undefined) as string | undefined) ?? ((taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined) || '-');
  const failure = resolveTaskFailurePresentation({ taskInfo, backendMessage: backendMessage ?? null, fallback: undefined });
  const normalizedBatchId = typeof batchId === 'string' ? batchId.trim() : '';
  const supplementalDetails = [
    { label: '任务编号', value: (taskInfo !== null && taskInfo !== undefined ? taskInfo.taskId : undefined) || '-', mono: true },
    { label: '生成批次编号', value: normalizedBatchId || (taskInfo !== null && taskInfo !== undefined ? taskInfo.batchId : undefined) || '-', mono: true },
    { label: '模型编号', value: (taskInfo !== null && taskInfo !== undefined ? taskInfo.modelId : undefined) || '-', mono: true },
    { label: '请求编号', value: (taskInfo !== null && taskInfo !== undefined ? taskInfo.remoteRequestId : undefined) || '-', mono: true },
    { label: '创建时间', value: formatTime((taskInfo !== null && taskInfo !== undefined ? taskInfo.createdAt : undefined)), mono: false },
  ];
  const archiveDisabledReason = openArchiveDisabledReason || '这次任务没有可查看的日志文件';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="wide">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title || '任务详情'}</DialogTitle>
        </DialogHeader>

        {/* pr-2 与内容槽裁剪余量（-mx-1 px-1）等量配对：余量把内容右边界相对基线外推 4px，右内距需 8px 才能保持内容几何不变 */}
        <DialogBody className="pr-2">
          {!taskInfo ? (
            <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">还没有任务详情</div>
          ) : (
            <div className="min-w-0 space-y-4">
              <section className="rounded-md border p-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">任务摘要</div>
                <div className="space-y-2">
                  <FieldRow label="状态" value={statusLabel} mono={undefined} />
                  {failure ? <FieldRow label="失败原因" value={failure.summary} mono={undefined} /> : null}
                  <FieldRow label="更新时间" value={formatTime(taskInfo.updatedAt)} mono={undefined} />
                </div>
              </section>

              <details className="rounded-md border p-3">
                <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
                  详细信息
                </summary>
                <div className="mt-3 space-y-2">
                  {failure !== null && failure !== undefined && failure.code !== null ? <FieldRow label="错误码" value={failure.code} mono /> : null}
                  {failure !== null && failure !== undefined && failure.reasonTags.length > 0 ? (
                    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 text-sm">
                      <span className="text-muted-foreground">错误类型</span>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {failure.reasonTags.map((tag) => (
                          <span key={tag} className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {supplementalDetails.map((item) => (
                    <FieldRow key={item.label} label={item.label} value={item.value} mono={item.mono} />
                  ))}
                </div>
              </details>

              {failure ? (
                <section className="min-w-0 rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-muted-foreground">错误详情</div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="2xs"
                      onClick={() => void copyText(failure.copyText)}
                    >
                      <IconCopy size={15} />
                      复制错误详情
                    </Button>
                  </div>
                  {failure.backendMessage ? (
                    <details>
                      <summary className="cursor-pointer select-none text-xs text-muted-foreground">服务返回内容</summary>
                      <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs">
                        {failure.backendMessage}
                      </pre>
                    </details>
                  ) : null}
                  {failure.rawDetailText ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer select-none text-xs text-muted-foreground">完整报错信息</summary>
                      <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs">
                        {failure.rawDetailText}
                      </pre>
                    </details>
                  ) : null}
                </section>
              ) : null}
            </div>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0 flex-wrap gap-2">
          {onCopyTaskId ? (
            <Button type="button" variant="secondary" onClick={onCopyTaskId}>
              <IconCopy size={16} />
              复制错误详情
            </Button>
          ) : (
            <Button type="button" variant="secondary" disabled>
              <IconCopy size={16} />
              复制错误详情
            </Button>
          )}

          {onOpenArchive ? (
            canOpenArchive ? (
              <Button type="button" variant="outline" onClick={() => onOpenArchive((taskInfo !== null && taskInfo !== undefined ? taskInfo.taskId : undefined))}>
                <IconFolder size={16} />
                打开任务文件夹
              </Button>
            ) : (
              <DisabledActionTooltip reason={archiveDisabledReason}>
                <Button type="button" variant="outline" disabled>
                  <IconFolder size={16} />
                  打开任务文件夹
                </Button>
              </DisabledActionTooltip>
            )
          ) : null}

          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TaskStatusDialog;
