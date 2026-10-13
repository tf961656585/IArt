"use client";

import {
  forwardRef,
  memo,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from '@/lib/utils';
import type { NodeSize } from '../../types/node';
import {
  resolveContentRenderDecision,
  resolveStableMinSize,
  type BaseNodeContentRenderPolicy,
} from './BaseNodeCard';
import { useCanvasStore } from '../../store/canvasStore';
import { useExecutionStore } from '../../store/executionStore';
import {
  EMPTY_PREFLIGHT_ISSUES,
  type ExecutionPreflightIssue,
} from '../../types/executionPreflight';
import { useNodeCardGeometryKey } from "./useNodeCardGeometryKey";
import { resolveStableSizeWithPlaceholder, usePlaceholderShellDegrade } from './usePlaceholderShellDegrade';

export interface ContentNodeCardProps {
  /** 节点 ID，用于自动同步尺寸到 store */
  nodeId: string | undefined;
  selected: boolean | undefined;
  /** 渲染在节点卡片根部的浮层（不会被内容区域裁剪） */
  overlay: ReactNode | undefined;
  children: ReactNode | undefined;
  /** 内容渲染策略（扩展点） */
  contentRenderPolicy: BaseNodeContentRenderPolicy | undefined;
  /** identity-only 模式下的提示文案 */
  identityHint: ReactNode | undefined;
  /** identity-only 模式下的占位内容 */
  identityPlaceholder: ReactNode | undefined;
  minWidth: CSSProperties['minWidth'] | undefined;
  minHeight: CSSProperties['minHeight'] | undefined;
  width: CSSProperties['width'] | undefined;
  /** 让卡片填充父级（用于可手动调整尺寸的节点） */
  fill: boolean | undefined;
  /** 无边框无内边距模式（用于图片/视频等媒体节点） */
  noPadding: boolean | undefined;
  className: string | undefined;
}

export const ContentNodeCard = memo(
		  forwardRef<HTMLDivElement, ContentNodeCardProps>(function ContentNodeCard(
	    {
	      nodeId,
	      selected,
	      overlay,
	      children,
	      contentRenderPolicy,
              identityHint,
              identityPlaceholder,
              minWidth,
              minHeight,
              width,
              fill,
              noPadding,
	      className,
	    },
	    ref,
		  ) {
    const internalRef = useRef<HTMLDivElement>(null);
    const lastMeasuredRef = useRef<NodeSize | null>(null);
    // 交互期占位壳降级（spec：画布交互期渲染降级契约.md「占位壳契约」）。
    // 订阅 isPlaceholder + 占位尺寸 + mount 注册占位，逻辑承载在共享 hook 内（与 BaseNodeCard 对称）。
    const { isPlaceholder, placeholderStableSize } = usePlaceholderShellDegrade(nodeId);
    const isActive = useCanvasStore((state) =>
      Boolean(contentRenderPolicy && nodeId && state.selectedNodeIds.length === 1 && state.selectedNodeIds[0] === nodeId),
    );
    const isSelected = selected === true;
    // 执行前置校验问题（spec：节点执行前置校验，节点级诊断为优先呈现）。
    // 素材节点作为空内容/资产不可用问题的定位节点，同样需要节点级呈现。
    const preflightIssues = useExecutionStore((state) => {
      if (!nodeId) return EMPTY_PREFLIGHT_ISSUES;
      const grouped = state.preflightIssuesByNodeId as
        | Record<string, ExecutionPreflightIssue[]>
        | undefined;
      return (
        (grouped !== null && grouped !== undefined
          ? grouped[nodeId]
          : undefined) ?? EMPTY_PREFLIGHT_ISSUES
      );
    });
    // 占位态强制 identity policy（在 policy 入参层覆盖，不改既有 policy 行为）。
    // 占位 policy 与既有 selection policy 是叠加关系（占位优先），不是替代关系。
    const effectivePolicy: BaseNodeContentRenderPolicy | undefined = isPlaceholder
      ? { mode: 'identity', keepSize: true, placeholder: undefined }
      : contentRenderPolicy;
    const renderDecision = resolveContentRenderDecision(effectivePolicy, {
      selected: isSelected,
      active: isActive,
    });
    const renderMode = renderDecision.mode ?? 'full';
    const shouldRenderContent = renderMode !== 'identity';
    const keepIdentitySize = renderMode === 'identity' ? renderDecision.keepSize ?? false : false;

    const fallbackHint =
      identityHint === undefined
        ? isSelected && !isActive
          ? '已选中多个，单独选中后才能编辑'
          : '选中以编辑'
        : identityHint;
    const hasHint = !(fallbackHint === null || fallbackHint === undefined || fallbackHint === '');
    const defaultIdentityPlaceholder = hasHint ? (
      <div className="text-xs text-muted-foreground">{fallbackHint}</div>
    ) : null;
    const contentPlaceholder = !shouldRenderContent
      ? renderDecision.placeholder ?? identityPlaceholder ?? defaultIdentityPlaceholder
      : null;
    // stableSize 来源：占位态用 resolveEffectiveSize 四档（含 default 兜底，新节点不塌缩）；
    // 既有 identity 态（selection policy）保持 lastMeasuredRef 路径不变。
    const stableSize = resolveStableSizeWithPlaceholder({
      isPlaceholder,
      placeholderStableSize,
      lastMeasured: lastMeasuredRef.current,
      keepIdentitySize,
    });
    const resolvedMinWidth = resolveStableMinSize(minWidth, (stableSize !== null && stableSize !== undefined ? stableSize.width : undefined));
    const resolvedMinHeight = resolveStableMinSize(minHeight, (stableSize !== null && stableSize !== undefined ? stableSize.height : undefined));
    const content = shouldRenderContent ? children : contentPlaceholder;
    const shouldRenderContentArea = !(content === null || content === undefined);
    useNodeCardGeometryKey({
      nodeId,
      elementRef: internalRef,
      lastMeasuredRef,
      width,
      height: undefined,
      minWidth: resolvedMinWidth,
      minHeight: resolvedMinHeight,
      scope: "ContentNodeCard",
    });

    // 同时暴露给外部 ref 和内部使用
    useImperativeHandle(ref, () => internalRef.current as HTMLDivElement, []);

    return (
      <div
        ref={internalRef}
        className={cn(
          'relative rounded border bg-card shadow-sm text-sm text-foreground transition-shadow overflow-visible',
          fill && 'h-full w-full',
          isSelected && 'node-card-selected shadow-md',
          className,
        )}
        style={{ minWidth: resolvedMinWidth, minHeight: resolvedMinHeight, width }}
      >
        {overlay}
        {preflightIssues.length > 0 ? (
          <div className="m-2 space-y-1 rounded bg-destructive/10 p-2 text-xs text-destructive">
            {preflightIssues.map((issue, index) => (
              <div key={`${issue.kind}-${index}`}>{issue.message}</div>
            ))}
          </div>
        ) : null}
        {shouldRenderContentArea ? (
          <div
            className={cn(
              'w-full rounded overflow-hidden',
              fill && 'h-full min-h-0',
              noPadding ? 'p-0' : 'p-3',
            )}
          >
            {noPadding ? content : <div className={cn('flex flex-col gap-2', fill && 'h-full min-h-0')}>{content}</div>}
          </div>
        ) : null}
      </div>
    );
  })
);

export default ContentNodeCard;
