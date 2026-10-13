"use client";

/**
 * 基础节点卡片组件
 * - 所有节点类型的基础 UI
 * - 支持端口渲染、选中状态
 * - 节点壳层负责在几何变化后刷新 ReactFlow internals
 * - 支持交互期占位壳降级（spec：画布交互期渲染降级契约.md「占位壳契约」）
 */

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { labelResizeObserverCallback } from "@/client/utils/resizeObserverDebugLabel";
import type { NodeSize, NodeTaskInfo } from "../../types/node";
import { useCanvasStore } from "../../store/canvasStore";
import { isStartupPhaseForDesired, selectPreparationPhase } from "../../store/selectors.nodeSizeRuntime";
import { useObservedElementMetrics } from "../../hooks/useObservedElementMetrics";
import { logCanvasDebugEvent } from "../../debug/canvasDebug";
import { useNodeCardGeometryKey } from "./useNodeCardGeometryKey";
import { resolveStableSizeWithPlaceholder, usePlaceholderShellDegrade } from "./usePlaceholderShellDegrade";

export type BaseNodeContentRenderMode = "full" | "identity";

export interface BaseNodeContentRenderContext {
  selected: boolean | undefined;
  active: boolean | undefined;
}

export interface BaseNodeContentRenderDecision {
  mode: BaseNodeContentRenderMode;
  keepSize: boolean | undefined;
  placeholder: ReactNode | undefined;
}

export type BaseNodeContentRenderPolicy = BaseNodeContentRenderDecision | ((context: BaseNodeContentRenderContext) => BaseNodeContentRenderDecision);

export const createSelectionContentPolicy = (options: { activeOnly: boolean | undefined; keepSize: boolean | undefined; placeholder: ReactNode | undefined } | undefined): BaseNodeContentRenderPolicy => {
  const { activeOnly = true, keepSize = true, placeholder } = options ?? {};
  return ({ selected, active }) => {
    const allow = activeOnly ? Boolean(selected && active) : Boolean(selected);
    if (allow) {
      return { mode: "full", keepSize, placeholder: undefined };
    }
    return { mode: "identity", keepSize, placeholder };
  };
};

export const selectionOnlyContentPolicy: BaseNodeContentRenderPolicy = {
  mode: "full",
  keepSize: undefined,
  placeholder: undefined,
};

export const resolveContentRenderDecision = (policy: BaseNodeContentRenderPolicy | undefined, context: BaseNodeContentRenderContext): BaseNodeContentRenderDecision => {
  if (!policy) {
    return {
      mode: "full",
      keepSize: undefined,
      placeholder: undefined,
    };
  }
  return typeof policy === "function" ? policy(context) : policy;
};

export const resolveStableMinSize = (value: CSSProperties["minWidth"], stable: number | undefined): CSSProperties["minWidth"] => {
  if (!stable || !Number.isFinite(stable)) return value;
  if (value === undefined || value === null) return stable;
  if (typeof value === "number") return Math.max(value, stable);
  return value;
};

type BaseNodeCardOptionalProps = {
  /** 节点 ID，用于自动同步尺寸到 store */
  /** 节点图标 */
  icon: ReactNode | undefined;
  /** 标题栏右侧插槽（默认空） */
  headerRight: ReactNode | undefined;
  /** 标题栏额外 className（默认不改变外观） */
  headerClassName: string | undefined;
  /** 标题文本额外 className（默认不改变外观） */
  titleClassName: string | undefined;
  /** 标题 hover 时滚动显示（仅溢出时启用） */
  titleMarqueeOnHover: boolean | undefined;
  /** 节点颜色 */
  color: string | undefined;
  /** 是否选中 */
  selected: boolean | undefined;
  /** 节点内容 */
  children: ReactNode | undefined;
  /** 渲染在节点卡片根部的浮层（不会被内容区域裁剪） */
  overlay: ReactNode | undefined;
  /** 底部操作区 */
  footer: ReactNode | undefined | undefined;
  /** 内容渲染策略（扩展点） */
  contentRenderPolicy: BaseNodeContentRenderPolicy | undefined;
  /** identity-only 模式下的摘要 */
  identitySummary: ReactNode | undefined;
  /** identity-only 模式下的提示文案 */
  identityHint: ReactNode | undefined;
  /** 执行状态 */
  status: "idle" | NodeTaskInfo["status"] | undefined;
  /** 进度 */
  progress: number | undefined | undefined;
  /** 最小宽度（用于可调尺寸节点） */
  minWidth: CSSProperties["minWidth"] | undefined | undefined;
  /** 最小高度（用于可调尺寸节点） */
  minHeight: CSSProperties["minHeight"] | undefined | undefined;
  /** 固定宽度（可选） */
  width: CSSProperties["width"] | undefined;
  /** 固定高度（可选） */
  height: CSSProperties["height"] | undefined;
  /** 让卡片填充父级（用于可手动调整尺寸的节点） */
  fill: boolean | undefined;
  /** 内容区额外 className */
  contentClassName: string | undefined;
  /** 根容器 data-* 属性（用于测试或验收证据标注） */
  rootDataAttributes: Record<`data-${string}`, string | number | undefined> | undefined;
  /** 是否可删除 */
  deletable: boolean | undefined;
};

type BaseNodeCardRequiredProps = {
  /** 节点 ID，用于自动同步尺寸到 store */
  nodeId: string | undefined;
  /** 节点标题 */
  title: string;
  /** 是否选中 */
  selected: boolean | undefined;
};

type BaseNodeCardPublicOptionalProps = Partial<BaseNodeCardOptionalProps>;

type BaseNodeCardNormalizedProps = BaseNodeCardRequiredProps & BaseNodeCardOptionalProps;

export type BaseNodeCardProps = BaseNodeCardRequiredProps & BaseNodeCardPublicOptionalProps;

const normalizeBaseNodeCardProps = (props: BaseNodeCardProps): BaseNodeCardNormalizedProps => {
  return {
    nodeId: props.nodeId,
    title: props.title,
    selected: props.selected,
    icon: props.icon,
    headerRight: props.headerRight,
    headerClassName: props.headerClassName,
    titleClassName: props.titleClassName,
    titleMarqueeOnHover: props.titleMarqueeOnHover,
    color: props.color,
    children: props.children,
    overlay: props.overlay,
    footer: props.footer,
    contentRenderPolicy: props.contentRenderPolicy,
    identitySummary: props.identitySummary,
    identityHint: props.identityHint,
    status: props.status,
    progress: props.progress,
    minWidth: props.minWidth,
    minHeight: props.minHeight,
    width: props.width,
    height: props.height,
    fill: props.fill,
    contentClassName: props.contentClassName,
    rootDataAttributes: props.rootDataAttributes,
    deletable: props.deletable,
  };
}

/** 状态指示器 */
function StatusIndicator({ status, progress }: { status: BaseNodeCardProps["status"] | undefined; progress: number | undefined }) {
  if (!status || status === "idle") return null;

  const statusColors: Record<string, string> = {
    submitting: "bg-sky-500",
    generating: "bg-blue-500",
    polling: "bg-yellow-500",
    downloading: "bg-cyan-500",
    succeeded: "bg-green-500",
    failed: "bg-red-500",
  };

  const isAnimated = status === "submitting" || status === "generating" || status === "polling" || status === "downloading";

  return (
    <div className="absolute -top-1 -right-1 flex items-center gap-1">
      <div className={cn("w-3 h-3 rounded-full", statusColors[status], isAnimated ? "animate-pulse" : "")} />
      {progress !== undefined && status === "polling" && <span className="text-xs text-muted-foreground">{progress}%</span>}
    </div>
  );
}

const MARQUEE_GAP_PX = 24;
const MARQUEE_MIN_DURATION_S = 4;
const MARQUEE_SPEED_PX_PER_S = 40;

// 内容区溢出可观测性（阶段 4：scrollHeight 留痕）。
// 画布节点禁止内部滚动后，内容被压缩时不再被滚动条掩盖，而是溢出节点边界。
// 通过 canvasDebug 事件留痕，让「Layout Model 估算偏小」导致的溢出在 dev 期可见。
// epsilon 吸收亚像素抖动；delta 阈值避免持续溢出时刷屏（仅溢出量明显变化时再记）。
const CONTENT_OVERFLOW_EPSILON_PX = 1;
const CONTENT_OVERFLOW_DELTA_THRESHOLD_PX = 4;

const TitleMarquee = memo(function TitleMarquee({ title, className, style }: { title: string; className: string | undefined; style: CSSProperties | undefined }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<{
    overflow: boolean;
    shiftPx: number;
    durationS: number;
  }>({ overflow: false, shiftPx: 0, durationS: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    let rafId: number | null = null;

    const measure = () => {
      const containerEl = containerRef.current;
      const textEl = textRef.current;
      if (!containerEl || !textEl) return;

      const containerWidth = Math.max(0, Math.round(containerEl.clientWidth));
      const textWidth = Math.max(0, Math.round(textEl.scrollWidth));

      const overflow = textWidth > containerWidth + 1;
      if (!overflow) {
        setState((prev) => (prev.overflow ? { overflow: false, shiftPx: 0, durationS: 0 } : prev));
        return;
      }

      const shiftPx = textWidth + MARQUEE_GAP_PX;
      const durationS = Math.max(MARQUEE_MIN_DURATION_S, shiftPx / MARQUEE_SPEED_PX_PER_S);
      setState((prev) => {
        const next = { overflow: true, shiftPx, durationS };
        if (prev.overflow === next.overflow && prev.shiftPx === next.shiftPx && prev.durationS === next.durationS) {
          return prev;
        }
        return next;
      });
    };

    const scheduleMeasure = () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          measure();
        });
      } else {
        measure();
      }
    };

    scheduleMeasure();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(
        labelResizeObserverCallback(
          () => scheduleMeasure(),
          "BaseNodeCard.titleMarquee",
        ),
      );
      resizeObserver.observe(container);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", scheduleMeasure);
    }

    return () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else if (typeof window !== "undefined") {
        window.removeEventListener("resize", scheduleMeasure);
      }
    };
  }, [title]);

  return (
    <div ref={containerRef} className={cn("iart-title-marquee-container min-w-0 overflow-hidden", className)} style={style}>
      <div
        className="iart-title-marquee-track inline-flex items-center will-change-transform"
        data-overflow={state.overflow ? "true" : "false"}
        style={
          state.overflow
            ? ({
                "--iart-marquee-shift": `${state.shiftPx}px`,
                "--iart-marquee-duration": `${state.durationS.toFixed(2)}s`,
              } as CSSProperties)
            : undefined
        }
      >
        <span ref={textRef} className={cn("whitespace-nowrap", className)}>
          {title}
        </span>
        {state.overflow ? (
          <span aria-hidden className={cn("ml-6 whitespace-nowrap", className)}>
            {title}
          </span>
        ) : null}
      </div>
    </div>
  );
});

/** 基础节点卡片 */
export const BaseNodeCard = memo(function BaseNodeCard({ nodeId, title, icon, headerRight, headerClassName, titleClassName, titleMarqueeOnHover, color = "#6b7280", selected, children, overlay, footer, contentRenderPolicy, identitySummary, identityHint, status, progress, minWidth, minHeight, width, height, fill, contentClassName, rootDataAttributes }: BaseNodeCardProps) {
  const normalizedProps = normalizeBaseNodeCardProps({
    nodeId,
    title,
    icon,
    headerRight,
    headerClassName,
    titleClassName,
    titleMarqueeOnHover,
    color,
    selected,
    children,
    overlay,
    footer,
    contentRenderPolicy,
    identitySummary,
    identityHint,
    status,
    progress,
    minWidth,
    minHeight,
    width,
    height,
    fill,
    contentClassName,
    rootDataAttributes,
    deletable: undefined,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMeasuredRef = useRef<NodeSize | null>(null);
  // 交互期占位壳降级（spec：画布交互期渲染降级契约.md「占位壳契约」）。
  // 订阅 isPlaceholder + 占位尺寸 + mount 注册占位，逻辑承载在共享 hook 内（与 ContentNodeCard 对称）。
  const { isPlaceholder, placeholderStableSize } = usePlaceholderShellDegrade(nodeId);
  const isActive = useCanvasStore((state) =>
    Boolean(contentRenderPolicy && nodeId && state.selectedNodeIds.length === 1 && state.selectedNodeIds[0] === nodeId));
  const isSelected = selected === true;
  // 占位态强制 identity policy（在 policy 入参层覆盖，不改既有 policy 行为）。
  // 占位 policy 与既有 selection policy 是叠加关系（占位优先），不是替代关系。
  const effectivePolicy: BaseNodeContentRenderPolicy | undefined = isPlaceholder
    ? { mode: "identity", keepSize: true, placeholder: undefined }
    : contentRenderPolicy;
  const renderDecision = resolveContentRenderDecision(effectivePolicy, {
    selected: isSelected,
    active: isActive,
  });
  const renderMode = renderDecision.mode ?? "full";
  const shouldRenderContent = renderMode !== "identity";
  const keepIdentitySize = renderMode === "identity" ? (renderDecision.keepSize ?? false) : false;

  const fallbackHint = identityHint === undefined ? (isSelected && !isActive ? "已选中多个，单独选中后才能编辑" : "选中以编辑") : identityHint;
  const hasSummary = Boolean(identitySummary);
  const hasHint = !(fallbackHint === null || fallbackHint === undefined || fallbackHint === "");
  const defaultIdentityPlaceholder =
    hasSummary || hasHint ? (
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {hasSummary ? <div className="line-clamp-2">{identitySummary}</div> : null}
        {hasHint ? <div className="text-[11px]">{fallbackHint}</div> : null}
      </div>
    ) : null;
  const contentPlaceholder = !shouldRenderContent ? (renderDecision.placeholder ?? defaultIdentityPlaceholder) : null;
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
    elementRef: containerRef,
    lastMeasuredRef,
    width,
    height,
    minWidth: resolvedMinWidth,
    minHeight: resolvedMinHeight,
    scope: "BaseNodeCard",
  });

  // 内容区溢出可观测性（阶段 4）：把 useObservedElementMetrics 挂到内容区 div，
  // 比较 scrollHeight（内容自然高度）与可见高度，命中「内容被压缩/溢出」时经 canvasDebug 留痕。
  // 只在 fill 模式（有固定外壳）+ runtime 期启用；启动期/非 fill 不挂 observer（性能要求，与
  // ResultAreaContainer `enabled: !isStartupPhase` 对齐）。本阶段只做留痕，不接入 Layout Model 闭环。
  const preparationPhase = useCanvasStore(selectPreparationPhase);
  const isStartupPhase = isStartupPhaseForDesired(preparationPhase);
  const enableContentOverflowDetection = fill === true && !isStartupPhase;
  const { ref: contentAreaObservedRef, metrics: contentAreaMetrics } = useObservedElementMetrics<HTMLDivElement>({
    observeMutations: true,
    rafDebounce: true,
    enabled: enableContentOverflowDetection,
  });
  const contentAreaDomRef = useRef<HTMLDivElement | null>(null);
  // 溢出去重状态：只在「从无溢出到有溢出」或「溢出量变化超过阈值」时打日志，避免持续溢出刷屏。
  const contentOverflowStateRef = useRef<{ wasOverflowing: boolean; lastScrollHeight: number }>({
    wasOverflowing: false,
    lastScrollHeight: 0,
  });
  const handleContentAreaRef = useCallback(
    (el: HTMLDivElement | null) => {
      contentAreaDomRef.current = el;
      contentAreaObservedRef(el);
    },
    [contentAreaObservedRef],
  );
  const evaluateContentOverflow = useCallback(
    (values: { width: number; height: number; scrollHeight: number }) => {
      if (!nodeId) return;
      if (values.height <= 0 || values.scrollHeight <= 0) return;
      const overflowing = values.scrollHeight > values.height + CONTENT_OVERFLOW_EPSILON_PX;
      const prev = contentOverflowStateRef.current;
      if (!overflowing) {
        contentOverflowStateRef.current = { wasOverflowing: false, lastScrollHeight: 0 };
        return;
      }
      const firstOverflow = !prev.wasOverflowing;
      const amountChanged = Math.abs(values.scrollHeight - prev.lastScrollHeight) >= CONTENT_OVERFLOW_DELTA_THRESHOLD_PX;
      if (firstOverflow || amountChanged) {
        logCanvasDebugEvent("node:contentOverflow", {
          nodeId,
          contentSize: { width: values.width, height: values.scrollHeight },
          viewportSize: { width: values.width, height: values.height },
        });
      }
      contentOverflowStateRef.current = { wasOverflowing: true, lastScrollHeight: values.scrollHeight };
    },
    [nodeId],
  );
  // 路径 A：observer 驱动（RO 盒尺寸变化 / MO 直接子节点增删 / 挂载首测）。
  // 命中盒尺寸变化或直接结构变化时以实测 metrics 评估溢出。
  useEffect(() => {
    if (!enableContentOverflowDetection) {
      contentOverflowStateRef.current = { wasOverflowing: false, lastScrollHeight: 0 };
      return;
    }
    evaluateContentOverflow(contentAreaMetrics);
  }, [contentAreaMetrics, enableContentOverflowDetection, evaluateContentOverflow]);
  // 路径 B：props 签名驱动重测。内容区直接子节点（如 ResultAreaContainer）在内容增长时通常
  // 不增删自身（childList/subtree:false 的 MO 捕获不到深层变化），但内容变化必然伴随上层
  // 重渲染产生新的 children 引用，据此直接重读 scrollHeight 弥补 MO 限制。
  useEffect(() => {
    if (!enableContentOverflowDetection) return;
    const el = contentAreaDomRef.current;
    if (!el) return;
    evaluateContentOverflow({ width: el.clientWidth, height: el.clientHeight, scrollHeight: el.scrollHeight });
  }, [children, enableContentOverflowDetection, evaluateContentOverflow]);

  return (
    <div ref={containerRef} data-iart-node-card="true" {...(normalizedProps.rootDataAttributes ?? {})} className={cn("relative min-w-[180px] rounded border bg-card shadow-sm transition-shadow flex flex-col overflow-visible", fill && "h-full w-full", isSelected && "node-card-selected shadow-md")} style={{ minWidth: resolvedMinWidth, minHeight: resolvedMinHeight, width, height }}>
      {overlay}

      {/* 状态指示器 */}
      <StatusIndicator status={status} progress={progress} />

      {/* 标题栏 */}
      <div className={cn("flex shrink-0 items-center gap-2 px-3 py-2 border-b rounded-t", headerClassName)} style={{ backgroundColor: `${color}20` }}>
        {icon && (
          <span className="text-lg" style={{ color }}>
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1" style={{ color }}>
          {titleMarqueeOnHover ? <TitleMarquee title={title} className={cn("font-medium text-sm", titleClassName)} style={undefined} /> : <span className={cn("font-medium text-sm truncate", titleClassName)}>{title}</span>}
        </div>
        {headerRight ? <div className="ml-auto shrink-0 flex items-center gap-2">{headerRight}</div> : null}
      </div>

      {/* 内容区 */}
      {shouldRenderContentArea ? (
        <div ref={handleContentAreaRef} data-iart-node-card-content="true" className={cn("p-3 text-sm", fill && "flex-1 min-h-0", contentClassName)}>
          {content}
        </div>
      ) : null}

      {/* 底部操作区 */}
      {footer && <div className="shrink-0 px-3 py-2 border-t bg-muted/30 rounded-b">{footer}</div>}
    </div>
  );
});

export default BaseNodeCard;
