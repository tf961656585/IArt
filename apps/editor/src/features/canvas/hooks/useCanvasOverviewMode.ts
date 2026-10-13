/**
 * 画布概览模式（Overview Mode）控制器
 *
 * 目标：
 * - 大图低缩放时用 Canvas 绘制缩略卡片兜底性能
 * - 退出概览时避免“重新加载”体感（不卸载 ReactFlow 节点树，只隐藏绘制）
 * - 采用“元素数量阈值 + 缩放阈值 + 退出延迟”的策略，避免频繁抖动切换
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type CanvasOverviewPolicy = {
  /** 是否启用概览模式 */
  enabled: boolean;
  /** 进入概览的缩放阈值（<= enterZoom） */
  enterZoom: number;
  /** 退出概览的缩放阈值（>= exitZoom），用于滞后避免抖动 */
  exitZoom: number;
  /** 仅当节点数达到阈值时才允许启用（自动策略） */
  minNodes: number;
  /** 仅当节点数达到第二档阈值时才允许启用（自动策略，大图保守档） */
  minElements: number;
  /** 退出概览：在 moveEnd 后延迟（ms）再切回，改善连续性 */
  exitDelayMs: number;
};

export const DEFAULT_CANVAS_OVERVIEW_POLICY: CanvasOverviewPolicy = {
  enabled: true,
  // 仍以原来的 0.2 为进入阈值；退出阈值略高（滞后）避免 0.2 附近抖动。
  enterZoom: 0.2,
  exitZoom: 0.24,
  // 自动策略：小图不启用概览，避免不必要的模式切换。
  minNodes: 800,
  minElements: 1600,
  // 退出延迟：用户选择 150–250ms，这里取中位 200ms。
  exitDelayMs: 200,
};

const clampPositive = (value: unknown, fallback: number): number => {
  const num = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(num) && num > 0 ? num : fallback;
};

const clampNonNegative = (value: unknown, fallback: number): number => {
  const num = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(num) && num >= 0 ? num : fallback;
};

const clampBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  return fallback;
};

const normalizePolicy = (policy: Partial<CanvasOverviewPolicy> | undefined): CanvasOverviewPolicy => {
  const merged: CanvasOverviewPolicy = {
    ...DEFAULT_CANVAS_OVERVIEW_POLICY,
    ...(policy ?? {}),
  };

  merged.enabled = clampBoolean(merged.enabled, DEFAULT_CANVAS_OVERVIEW_POLICY.enabled);
  merged.enterZoom = clampPositive(merged.enterZoom, DEFAULT_CANVAS_OVERVIEW_POLICY.enterZoom);
  merged.exitZoom = clampPositive(merged.exitZoom, DEFAULT_CANVAS_OVERVIEW_POLICY.exitZoom);
  merged.minNodes = Math.floor(clampNonNegative(merged.minNodes, DEFAULT_CANVAS_OVERVIEW_POLICY.minNodes));
  merged.minElements = Math.floor(clampNonNegative(merged.minElements, DEFAULT_CANVAS_OVERVIEW_POLICY.minElements));
  merged.exitDelayMs = Math.floor(clampNonNegative(merged.exitDelayMs, DEFAULT_CANVAS_OVERVIEW_POLICY.exitDelayMs));

  // 兜底：exitZoom 必须 >= enterZoom
  if (merged.exitZoom < merged.enterZoom) {
    merged.exitZoom = merged.enterZoom;
  }

  return merged;
};

const isEligibleBySize = (policy: CanvasOverviewPolicy, nodeCount: number): boolean => {
  if (!policy.enabled) return false;
  const nodes = Math.max(0, nodeCount);
  return nodes >= policy.minNodes || nodes >= policy.minElements;
};

type CanvasOverviewMode = {
  /** 是否处于概览模式（overlay 显示 + Flow 层隐藏/禁交互） */
  isOverview: boolean;
  /**
   * 是否正在准备退出概览（moveEnd 后延迟窗口）
   * - 仍保持 isOverview=true（继续隐藏 Flow 层）
   * - 允许上层在后台预先构建/同步 Flow 数据，避免“缩回瞬间”卡顿
   */
  preparingExit: boolean;
  /** 当前是否满足“自动策略”的规模条件 */
  eligibleBySize: boolean;
  /** 进入/退出判定用的当前策略（已归一化） */
  policy: CanvasOverviewPolicy;
  /** onMoveStart 通知：开始缩放/平移 */
  onMoveStart: () => void;
  /** onMoveEnd 通知：结束缩放/平移 */
  onMoveEnd: () => void;
};

/**
 * 画布概览模式 Hook
 * - 进入：满足规模条件 && zoom <= enterZoom（可在 move 中触发，保证大图缩小时不卡）
 * - 退出：满足退出条件（zoom >= exitZoom 或不满足规模条件），在 moveEnd 后延迟 exitDelayMs 再退出
 */
export const useCanvasOverviewMode = (params: {
  graphId: string | null;
  zoom: number;
  nodeCount: number;
  policy: Partial<CanvasOverviewPolicy> | undefined;
}): CanvasOverviewMode => {
  const { graphId, zoom, nodeCount, policy: policyPatch } = params;
  const policy = useMemo(() => normalizePolicy(policyPatch), [policyPatch]);
  const eligibleBySize = useMemo(() => isEligibleBySize(policy, nodeCount), [policy, nodeCount]);

  const latestRef = useRef({
    graphId,
    zoom,
    eligibleBySize,
    policy,
  });
  latestRef.current = { graphId, zoom, eligibleBySize, policy };

  const movingRef = useRef(false);
  const exitTimerRef = useRef<number | null>(null);

  const [isOverview, setIsOverview] = useState(false);
  const [preparingExit, setPreparingExit] = useState(false);

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const cancelExit = useCallback(() => {
    clearExitTimer();
    setPreparingExit(false);
  }, [clearExitTimer]);

  const scheduleExit = useCallback(() => {
    const { policy } = latestRef.current;
    if (exitTimerRef.current !== null) return;
    setPreparingExit(true);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setPreparingExit(false);
      setIsOverview(false);
    }, policy.exitDelayMs);
  }, []);

  const shouldExitNow = useCallback((): boolean => {
    const { zoom, eligibleBySize, policy } = latestRef.current;
    if (!eligibleBySize) return true;
    return zoom >= policy.exitZoom;
  }, []);

  const ensureEnterOrExit = useCallback(() => {
    const { zoom, eligibleBySize, policy } = latestRef.current;
    if (!eligibleBySize) {
      if (isOverview) {
        if (movingRef.current) return;
        cancelExit();
        setIsOverview(false);
      }
      return;
    }

    if (!isOverview) {
      if (zoom <= policy.enterZoom) {
        cancelExit();
        setIsOverview(true);
      }
      return;
    }

    // 已在概览中：达到退出阈值后，仅在 moveEnd 后延迟退出，避免滚轮过程抖动与重载体感。
    if (zoom >= policy.exitZoom) {
      if (movingRef.current) return;
      scheduleExit();
    } else {
      // 用户又缩回去了：取消退出准备。
      cancelExit();
    }
  }, [cancelExit, isOverview, scheduleExit]);

  const onMoveStart = useCallback(() => {
    movingRef.current = true;
    cancelExit();
  }, [cancelExit]);

  const onMoveEnd = useCallback(() => {
    movingRef.current = false;
    if (!isOverview) return;
    if (!shouldExitNow()) {
      cancelExit();
      return;
    }
    scheduleExit();
  }, [cancelExit, isOverview, scheduleExit, shouldExitNow]);

  // graphId 切换：取消任何待退出计时，避免跨画板串状态。
  useEffect(() => {
    cancelExit();
    movingRef.current = false;
    clearExitTimer();
    setIsOverview(false);
  }, [graphId, cancelExit, clearExitTimer]);

  // zoom/规模变化时：驱动进入/退出判定。
  useEffect(() => {
    ensureEnterOrExit();
  }, [ensureEnterOrExit, zoom, eligibleBySize]);

  // 组件卸载：清理定时器。
  useEffect(() => {
    return () => {
      clearExitTimer();
    };
  }, [clearExitTimer]);

  return {
    isOverview,
    preparingExit,
    eligibleBySize,
    policy,
    onMoveStart,
    onMoveEnd,
  };
};

