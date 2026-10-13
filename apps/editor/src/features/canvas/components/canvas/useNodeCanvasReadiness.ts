"use client";

import { useEffect, useRef } from "react";
import { useStore as useReactFlowStore } from "@xyflow/react";

/**
 * NodeCanvas 启动自检（spec：layout-model-driven 启动收敛）。
 *
 * 替换原先独立的 CanvasStartupReadyProbe：NodeCanvas 自身挂载后订阅 ReactFlow
 * `nodeLookup.size`，使用 requestAnimationFrame 统计连续稳定帧数；连续 2 帧节点数
 * 未变化即认为节点已挂载完成，调用 `onReady` 放行 waiting-interactive → ready。
 * 硬超时 60 帧（约 1 秒 @60fps）兜底放行，防止节点迟迟未稳定卡住画布。
 *
 * graphId 变化时重置计数器与 rAF 链，避免旧 graph 的稳定误判为新 graph 就绪。
 *
 * 测试 / 预览环境无 ReactFlowProvider 时，selector 返回 0 fallback，
 * rAF 链通过硬超时兜底放行（60 帧 ≈ 1s），不阻塞 ready 流转。
 */
export function useNodeCanvasReadiness(params: {
  graphId: string | null;
  onReady: () => void;
}): void {
  const { graphId, onReady } = params;

  // 用 ref 持有最新的 onReady，避免 effect 依赖 onReady 导致 graphId 没变也重启 rAF。
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // 订阅 nodeLookup.size（primitive，避免对象引用变更触发重渲染）。
  // 测试环境或部分 mock 下 state / state.nodeLookup 可能为 undefined，加防御性 fallback。
  const nodeLookupSize = useReactFlowStore((state) => {
    if (state === null || state === undefined) return 0;
    const lookup = state.nodeLookup;
    if (lookup === null || lookup === undefined) return 0;
    return typeof lookup.size === "number" ? lookup.size : 0;
  });

  // nodeLookupSize 的 ref：rAF 回调读取最新值。
  const nodeLookupSizeRef = useRef(nodeLookupSize);
  nodeLookupSizeRef.current = nodeLookupSize;

  useEffect(() => {
    if (!graphId) return undefined;

    let rafId: number | null = null;
    let stableFrameCount = 0;
    let totalFrameCount = 0;
    let lastObservedSize: number | null = null;
    let settled = false;

    const HARD_TIMEOUT_FRAMES = 60;
    const STABLE_FRAMES_REQUIRED = 2;

    const fire = () => {
      if (settled) return;
      settled = true;
      onReadyRef.current();
    };

    const tick = () => {
      if (settled) return;
      totalFrameCount += 1;
      // rAF 回调通过 ref 读取最新的 nodeLookupSize，避免每次 size 变更重启 effect。
      const currentSize = nodeLookupSizeRef.current;
      if (lastObservedSize !== null && currentSize === lastObservedSize) {
        stableFrameCount += 1;
      } else {
        stableFrameCount = 0;
      }
      lastObservedSize = currentSize;

      if (stableFrameCount >= STABLE_FRAMES_REQUIRED) {
        fire();
        return;
      }
      if (totalFrameCount >= HARD_TIMEOUT_FRAMES) {
        console.info("[canvas:prep] node-canvas readiness hard-timeout", {
          graphId,
          totalFrameCount,
          lastObservedSize,
        });
        fire();
        return;
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      settled = true;
    };
  }, [graphId]);

  // void nodeLookupSize; // 仅触发订阅；effect 不依赖它，靠 ref 读取。
  void nodeLookupSize;
}
