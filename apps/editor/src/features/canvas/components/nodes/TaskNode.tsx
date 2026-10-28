'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { useCanvasStore } from '../../store/canvasStore';
import { useNodeFromStore } from '../../hooks/useNodeFromStore';
import type { GraphNode, TaskNodeData } from '../../types/node';
import { reuseTaskToDraft } from '@/features/promptdock/assetReuse';
import { cancelTask, requeryTask } from '@/client/api/promptDockApi';
import { Button } from '@/components/ui/button';
import { resolveTaskFailurePresentation } from '../../utils/taskFailurePresentation';
import {
  resolveRequeryRejectionMessage,
  resolveTaskFailureActions,
} from '../../utils/taskFailureActions';
import { getTaskStatusOverlayText } from '../../utils/taskStatusMeta';

/**
 * 任务节点渲染组件（孵化胚胎态，docs/editor/visual-design.md §5.4 / §6）。
 *
 * 任务节点 = 资产节点的胚胎态：媒体表面（彩色运行底）+ 孵化 overlay。
 * 状态全部以 overlay 承载：左上状态白 pill 徽章组（状态 pill + 任务身份徽章）、
 * 居中状态胶囊（进行态）、取消圆钮（运行态常驻）、进度 hairline（仅 generating）、
 * 失败 overlay（原因 + 详情折叠 + 按失败阶段分流的动作）。
 *
 * 失败态的动作口径见 docs/editor/失败任务重新查询-design.md：
 * - 查询类失败：主「重新查询结果」+ 次「重新生成」+ 危险「删除任务」；
 * - 提交类 / 无阶段 / 不可重查失败：主「重试」+ 危险「删除任务」；
 * - 重新查询受理后保持失败卡 + 禁用动作，等后端状态通知把节点切到等待态。
 *
 * 深色 = 近黑孵化暗室；浅色 = 去罩描边（令牌分叉，样式承载在 globals.css）。
 * 成功 morph 由任务投影编排负责（taskProjectionService：移除 task 节点、落位 asset 节点）。
 */

type TaskNodeSelection = {
  node: GraphNode<TaskNodeData> | null;
  data: TaskNodeData;
};

const STATUS_LABEL: Record<TaskNodeData['status'], string> = {
  submitting: '提交中',
  generating: '生成中',
  polling: '等待结果',
  downloading: '下载中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * 取消白圆钮（24×24 微型钮，画布孵化节点悬停钮群 h-6 口径）：Button 最小档 2xs 28px
 * 放不下，按 docs/ui-button-standard.md §7 走「宿主场景完整状态的局部控件」保留原生
 * button，样式收进组件局部。`task-cancel` 类名仅作 morphing 淡出状态钩子保留
 * （globals.css `.task-node.morphing` 组规则引用），不再承载任何按钮样式。
 */
const TASK_CANCEL_BUTTON_CLASS = [
  'task-cancel nodrag',
  'absolute top-2 right-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border-0 p-0',
  'bg-white/90 text-[oklch(0.145_0_0)] text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.2)] cursor-pointer',
  'transition-[background-color,transform] duration-150',
  'hover:bg-white hover:scale-[1.06]',
  'focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2',
  '[[data-theme=light]_&]:border [[data-theme=light]_&]:border-border',
].join(' ');

const createFallbackTaskNode = (id: string): GraphNode<TaskNodeData> => ({
  id,
  type: 'task' as const,
  position: { x: 0, y: 0 },
  data: {
    label: '任务',
    modelId: '',
    taskId: '',
    taskIndex: 0,
    batchId: '',
    status: 'submitting',
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    failure: null,
    createdAt: 0,
    updatedAt: 0,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

export const TaskNode = memo(function TaskNode({ id, selected }: NodeProps) {
  const { data: nodeData } = useNodeFromStore<TaskNodeData, TaskNodeSelection>({
    nodeId: id,
    fallback: createFallbackTaskNode(id),
    select: (snapshot) => ({ node: snapshot.node, data: snapshot.data }),
    equalityFn: (prev, next) => prev.node === next.node && prev.data === next.data,
  });

  const typed = nodeData as TaskNodeData;
  const isRunning =
    typed.status === 'submitting' ||
    typed.status === 'generating' ||
    typed.status === 'polling' ||
    typed.status === 'downloading';

  const [requeryPending, setRequeryPending] = useState(false);
  const [requeryError, setRequeryError] = useState<string | null>(null);
  const requeryErrorRef = useRef<HTMLParagraphElement | null>(null);

  // 状态离开 failed（受理后进入 polling，或成功 morph）即清理重新查询的本地待处理态；
  // 再次失败时由最新阶段重新计算按钮，不沿用上一次请求的 pending/错误。
  useEffect(() => {
    if (typed.status !== 'failed') {
      setRequeryPending(false);
      setRequeryError(null);
    }
  }, [typed.status]);

  useEffect(() => {
    if (requeryError) requeryErrorRef.current?.focus();
  }, [requeryError]);

  const failureActions = resolveTaskFailureActions({
    status: typed.status,
    failure: typed.failure,
    remoteRequestId: typed.remoteRequestId ?? null,
  });
  const isQueryFailure = failureActions.primary === 'requery';
  const taskIndexLabel = typed.taskIndex + 1;
  const taskIdentity = `任务 #${taskIndexLabel} · ${typed.modelId || typed.label}`;
  const failureSummaryId = `task-failure-summary-${id}`;
  const primaryPending = requeryPending && isQueryFailure;

  const handleCancel = () => {
    void cancelTask(typed.taskId).then((result) => {
      if (!result.accepted) {
        console.warn('[TaskNode] cancel rejected by backend', { taskId: typed.taskId });
      }
      // 取消命令被接受后，投影服务经「取消接受」路径立即移除节点；
      // 此处只发起命令，节点移除由任务投影编排统一负责。
    });
  };

  const handleRequery = () => {
    if (requeryPending) return;
    setRequeryError(null);
    setRequeryPending(true);
    void requeryTask(typed.taskId)
      .then(() => {
        // 受理回执只表示命令已进入后端；保持 pending，等 task:state-changed 把节点切到
        // 等待态后再由投影撤掉失败 overlay。不能乐观切态，否则拒绝时会闪跳。
      })
      .catch((error: unknown) => {
        setRequeryPending(false);
        setRequeryError(resolveRequeryRejectionMessage(error));
      });
  };

  const handleRegenerate = () => {
    if (requeryPending) return;
    setRequeryError(null);
    reuseTaskToDraft({ batchId: typed.batchId, modelId: typed.modelId });
  };

  const handleDelete = () => {
    if (requeryPending) return;
    const removeNode = useCanvasStore.getState().removeNode;
    removeNode(id, { deleteGroupMembers: false });
  };

  const failurePresentation = useMemo(
    () =>
      resolveTaskFailurePresentation({
        taskInfo: {
          taskId: typed.taskId,
          remoteRequestId: typed.remoteRequestId ?? undefined,
          taskIndex: typed.taskIndex,
          modelId: typed.modelId,
          status: typed.status,
          progress: typed.progressPhase === null ? null : { phase: typed.progressPhase },
          createdAt: typed.createdAt,
          updatedAt: typed.updatedAt,
          error: typed.errorMessage ?? undefined,
          failure: typed.failure,
          batchId: typed.batchId,
        },
        backendMessage: null,
        fallback: '这次生成失败了。',
      }),
    [typed],
  );

  const overlayStatusText = getTaskStatusOverlayText(typed.status, typed.progressPhase);
  // 终态（failed/succeeded/cancelled）无 overlayText，回落中文状态文案（徽章 pill 展示）。
  const statusLabel = overlayStatusText
    ? overlayStatusText.replace(/\.\.\.$/, '')
    : (STATUS_LABEL[typed.status] ?? typed.status);

  return (
    <div
      data-task-node={id}
      data-status={typed.status}
      className={
        'task-node pointer-events-auto h-full w-full' + (selected ? ' is-selected' : '')
      }
    >
      <div className="task-surface is-image h-full w-full">
        <div className="task-hatch" aria-hidden="true" />

        {/* 左上徽章组：失败态由失败 overlay 自带头部承载，避免两行动作把 overlay 撑满后
            外部徽章被盖住；其余状态保持原徽章组。 */}
        {typed.status !== 'failed' ? (
          <div className="task-badges">
            <span className="task-status-badge">
              {isRunning ? (
                <span className="dot">
                  <i className="ping" />
                  <i className="core" />
                </span>
              ) : null}
              <span className="lbl">{statusLabel}</span>
            </span>
            <span className="task-id-badge font-mono">
              任务 #{typed.taskIndex + 1} · {typed.modelId || typed.label}
            </span>
          </div>
        ) : null}

        {/* 居中状态胶囊：进行态显示（spinner + 文案 + 进度副行） */}
        {isRunning ? (
          <div className="task-center" role="status" aria-live="polite">
            <span className="pill">
              <span className="row">
                <span className="spinner" />
                <span>{statusLabel}…</span>
              </span>
              {typed.status === 'generating' && typeof typed.progressPercent === 'number' ? (
                <span className="sub">{typed.progressPercent}%</span>
              ) : null}
              {typed.status === 'polling' && (typed.requeryCount ?? 0) > 0 ? (
                <span className="sub">重新查询结果</span>
              ) : null}
            </span>
          </div>
        ) : null}

        {/* 取消白圆钮：运行态常驻 */}
        {isRunning ? (
          <button
            type="button"
            className={TASK_CANCEL_BUTTON_CLASS}
            aria-label={`取消任务 #${typed.taskIndex + 1}`}
            onClick={(event) => {
              event.stopPropagation();
              handleCancel();
            }}
          >
            ✕
          </button>
        ) : null}

        {/* 进度 hairline：仅 generating */}
        {typed.status === 'generating' ? (
          <div className="task-hatch-hairline">
            <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, (typed.progressPercent ?? 0) / 100))})` }} />
          </div>
        ) : null}

        {/* 失败 overlay：自带头部 + 中间滚动区 + 固定动作区（按失败阶段分流） */}
        {typed.status === 'failed' ? (
          <div
            className="task-failure"
            role="group"
            aria-label={`${taskIdentity} 失败`}
            aria-describedby={failureSummaryId}
            aria-busy={primaryPending || undefined}
          >
            <div className="failure-head">
              <span className="task-status-badge">✕ 失败</span>
              <span className="failure-id font-mono" title={taskIdentity}>
                {taskIdentity}
              </span>
            </div>
            <div className="failure-scroll">
              {requeryError ? (
                <p className="requery-error" role="alert" tabIndex={-1} ref={requeryErrorRef}>
                  {requeryError}
                </p>
              ) : null}
              <p className="sum" id={failureSummaryId}>
                {failurePresentation?.summary ?? typed.errorMessage ?? '这次生成失败了。'}
              </p>
              {failurePresentation &&
              (failurePresentation.backendMessage || failurePresentation.rawDetailText) ? (
                <details className="failure-details">
                  <summary>详情</summary>
                  <pre>{failurePresentation.backendMessage ?? failurePresentation.rawDetailText}</pre>
                </details>
              ) : null}
            </div>
            <div className="failure-acts">
              <div className="acts acts-primary">
                <Button
                  type="button"
                  variant="primary"
                  size="2xs"
                  className="nodrag task-failure-action"
                  aria-label={
                    primaryPending
                      ? `正在重新查询任务 #${taskIndexLabel} 的结果`
                      : isQueryFailure
                        ? `重新查询任务 #${taskIndexLabel} 的结果`
                        : `重试任务 #${taskIndexLabel}`
                  }
                  aria-disabled={requeryPending || undefined}
                  onClick={isQueryFailure ? handleRequery : handleRegenerate}
                >
                  {primaryPending ? <span className="btn-spinner" aria-hidden="true" /> : null}
                  {primaryPending ? '正在重新查询…' : isQueryFailure ? '重新查询结果' : '重试'}
                </Button>
                {failureActions.secondary === 'regenerate' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="2xs"
                    className="nodrag task-failure-action task-failure-secondary"
                    aria-label={`用任务 #${taskIndexLabel} 的原配置重新生成`}
                    aria-disabled={requeryPending || undefined}
                    onClick={handleRegenerate}
                  >
                    重新生成
                  </Button>
                ) : null}
              </div>
              <div className="acts acts-danger">
                <Button
                  type="button"
                  variant="ghost-destructive"
                  size="2xs"
                  className="nodrag task-failure-action"
                  aria-label={`删除任务 #${taskIndexLabel}`}
                  aria-disabled={requeryPending || undefined}
                  onClick={handleDelete}
                >
                  删除任务
                </Button>
              </div>
            </div>
            {primaryPending ? (
              <span className="sr-only" role="status" aria-live="polite">
                正在重新查询结果。
              </span>
            ) : null}
          </div>
        ) : null}

        {/* 取消 note：命令已受理、投影待移除的短暂窗口（视觉重量低于失败） */}
        {typed.status === 'cancelled' ? (
          <div className="task-cancelled-note">
            <span>已取消</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export default TaskNode;
