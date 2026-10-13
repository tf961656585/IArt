"use client";

/**
 * 图片缩放预览状态机。
 *
 * 职责：维护缩放倍率、平移偏移、拖拽中态、HUD 可见态；提供滚轮、键盘、双击、
 * Pointer 平移的统一处理器。所有入口（画布资产节点 / 画布图片节点 /
 * 右侧工作区资产预览 / 上传文件预览）共享本 hook，保证能力一致。
 *
 * 设计参照：
 * - `features/canvas/components/dialogs/useCropInteraction.ts` 的 PointerEvents 状态机
 *   + `setPointerCapture` 模式（避免 mousemove 边缘中断）。
 * - `features/canvas/hooks/useNonPassiveWheel.ts` 处理 Radix Dialog Portal 异步挂载。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useNonPassiveWheel } from "@/features/canvas/hooks/useNonPassiveWheel";
import {
  clampZoomScale,
  computeActualPixelsScale,
  computeMouseAnchoredZoom,
  computeWheelZoomFactor,
  getImageContentFrameFromElement,
  ZOOM_SCALE_FIT,
} from "./zoomableImageGeometry";

export type ZoomableImageState = {
  /** 缩放倍率，1 = Fit。 */
  scale: number;
  /** 平移偏移（CSS 像素）。 */
  pan: { x: number; y: number };
  /** 是否处于拖拽中。 */
  isPanning: boolean;
  /** HUD（含操作提示与百分比）是否完全可见。 */
  hudVisible: boolean;
  /**
   * 适配模式。contain = object-contain（完整可见，可能留黑边，即 fit 档）；
   * cover = object-cover（填满视口，可能裁切边缘，即 fill 档）。
   * 依据 docs/runtime/媒体放大预览交互契约.md「档位切换」。
   */
  fitMode: "contain" | "cover";
};

const INITIAL_STATE: ZoomableImageState = {
  scale: ZOOM_SCALE_FIT,
  pan: { x: 0, y: 0 },
  isPanning: false,
  hudVisible: true,
  fitMode: "contain",
};

/** HUD 自动淡出时长（毫秒）。 */
const HUD_AUTO_HIDE_DELAY_MS = 2500;

export type UseZoomableImageParams = {
  /** 图片元素的 ref。缩放锚点计算依赖其 object-contain 内容框。 */
  imageRef: React.RefObject<HTMLImageElement | null>;
  /** 是否启用缩放能力。false 时仅展示，所有交互处理器退化为 no-op。 */
  enabled: boolean;
  /** 滚轮缩放的步进 base，默认 1.15。 */
  wheelZoomBase: number | undefined;
  /** 滚轮缩进的单位像素，默认 100。 */
  wheelZoomUnit: number | undefined;
};

export type UseZoomableImageResult = {
  state: ZoomableImageState;
  /** 重置为 Fit（缩放=1，平移=0，适配模式=contain）。 */
  reset: () => void;
  /** 切换适配模式（fit ↔ fill），同步重置缩放与平移。 */
  setFitMode: (mode: "contain" | "cover") => void;
  /** 切换到指定倍率，以图片中心为锚点。 */
  setScaleCentered: (nextScale: number) => void;
  /** 切换到实际像素 1:1 档位。 */
  setActualPixels: () => void;
  /** 处理滚轮缩放（鼠标锚点）。 */
  handleWheel: (event: WheelEvent) => void;
  /** 处理键盘（+/-/0/R）。挂到 DialogContent.onKeyDownCapture。 */
  handleKeyDownCapture: (event: ReactKeyboardEvent) => void;
  /** 双击切换 Fit ↔ 2×（鼠标锚点）。 */
  handleDoubleClick: (
    event: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>,
  ) => void;
  /** Pointer 按下：开始平移。 */
  handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Pointer 移动：累加平移。 */
  handlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Pointer 抬起 / 取消：结束平移。 */
  handlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 鼠标移动：唤回 HUD。挂到 surface onMouseMove。 */
  handleSurfaceMouseMove: () => void;
  /** 当前应使用的鼠标光标样式。 */
  cursor: "default" | "grab" | "grabbing";
};

const isEditableEventTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
};

const shouldIgnoreZoomKeyDown = (
  event: ReactKeyboardEvent,
): boolean => {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  return isEditableEventTarget(event.target);
};

export function useZoomableImage(
  params: UseZoomableImageParams,
): UseZoomableImageResult {
  const { imageRef, enabled, wheelZoomBase, wheelZoomUnit } = params;

  const [scale, setScale] = useState<number>(INITIAL_STATE.scale);
  const [pan, setPan] = useState<{ x: number; y: number }>(INITIAL_STATE.pan);
  const [isPanning, setIsPanning] = useState<boolean>(INITIAL_STATE.isPanning);
  const [hudVisible, setHudVisible] = useState<boolean>(
    INITIAL_STATE.hudVisible,
  );
  const [fitMode, setFitModeState] = useState<"contain" | "cover">(
    INITIAL_STATE.fitMode,
  );

  const panAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const panPointerIdRef = useRef<number | null>(null);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHudTimer = useCallback(() => {
    if (hudTimerRef.current !== null) {
      clearTimeout(hudTimerRef.current);
      hudTimerRef.current = null;
    }
  }, []);

  const showHud = useCallback(() => {
    setHudVisible(true);
    clearHudTimer();
    hudTimerRef.current = setTimeout(() => {
      setHudVisible(false);
      hudTimerRef.current = null;
    }, HUD_AUTO_HIDE_DELAY_MS);
  }, [clearHudTimer]);

  const reset = useCallback(() => {
    setScale(ZOOM_SCALE_FIT);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    setFitModeState("contain");
    panAnchorRef.current = null;
    panPointerIdRef.current = null;
    showHud();
  }, [showHud]);

  // 切换适配模式（fit ↔ fill）。切换时同步重置缩放与平移：
  // 两种模式的几何基准不同（contain vs cover 内容框），前一个模式的缩放/平移
  // 对后一个模式无意义，保留会导致新模式打开即被裁切或偏移。
  // 依据 docs/runtime/媒体放大预览交互契约.md「档位切换」。
  const setFitMode = useCallback(
    (mode: "contain" | "cover") => {
      setFitModeState(mode);
      setScale(ZOOM_SCALE_FIT);
      setPan({ x: 0, y: 0 });
      setIsPanning(false);
      panAnchorRef.current = null;
      panPointerIdRef.current = null;
      showHud();
    },
    [showHud],
  );

  const setScaleCentered = useCallback(
    (nextScaleRaw: number) => {
      const nextScale = clampZoomScale(nextScaleRaw);
      const image = imageRef.current;
      const frame =
        image !== null ? getImageContentFrameFromElement(image) : null;
      if (frame === null) {
        setScale(nextScale);
        setPan({ x: 0, y: 0 });
        showHud();
        return;
      }
      const result = computeMouseAnchoredZoom({
        prevScale: scale,
        nextScale,
        // 以图片中心为锚点。
        mouseClient: {
          x: frame.left + frame.width / 2,
          y: frame.top + frame.height / 2,
        },
        frame,
        prevPan: pan,
      });
      setScale(result.scale);
      setPan(result.pan);
      showHud();
    },
    [imageRef, pan, scale, showHud],
  );

  const setActualPixels = useCallback(() => {
    const image = imageRef.current;
    if (image === null) return;
    const targetScale = computeActualPixelsScale(image);
    setScaleCentered(targetScale);
  }, [imageRef, setScaleCentered]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      const image = imageRef.current;
      if (image === null) return;
      const frame = getImageContentFrameFromElement(image);
      if (frame === null) return;
      const factor = computeWheelZoomFactor(event.deltaY, {
        base: wheelZoomBase,
        unit: wheelZoomUnit,
      });
      const nextScale = clampZoomScale(scale * factor);
      if (nextScale === scale) return;
      const result = computeMouseAnchoredZoom({
        prevScale: scale,
        nextScale,
        mouseClient: { x: event.clientX, y: event.clientY },
        frame,
        prevPan: pan,
      });
      setScale(result.scale);
      setPan(result.pan);
      showHud();
    },
    [enabled, imageRef, pan, scale, showHud, wheelZoomBase, wheelZoomUnit],
  );

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent) => {
      if (!enabled) return;
      if (event.defaultPrevented) return;
      if (shouldIgnoreZoomKeyDown(event)) return;
      const key = event.key;
      if (key === "+" || key === "=") {
        event.preventDefault();
        event.stopPropagation();
        setScaleCentered(scale * 1.2);
        return;
      }
      if (key === "-" || key === "_") {
        event.preventDefault();
        event.stopPropagation();
        setScaleCentered(scale / 1.2);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        event.stopPropagation();
        setActualPixels();
        return;
      }
      if (key === "r" || key === "R") {
        event.preventDefault();
        event.stopPropagation();
        reset();
        return;
      }
    },
    [enabled, reset, scale, setActualPixels, setScaleCentered],
  );

  const handleDoubleClick = useCallback(
    (
      event:
        | React.MouseEvent<HTMLElement>
        | React.PointerEvent<HTMLElement>,
    ) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      const image = imageRef.current;
      if (image === null) {
        // 没有图片元素时退化为切换 1 ↔ 2。
        const next = scale <= ZOOM_SCALE_FIT + 0.001 ? 2 : ZOOM_SCALE_FIT;
        setScaleCentered(next);
        return;
      }
      const frame = getImageContentFrameFromElement(image);
      const targetScale =
        scale <= ZOOM_SCALE_FIT + 0.001 ? 2 : ZOOM_SCALE_FIT;
      const clamped = clampZoomScale(targetScale);
      if (frame === null) {
        setScaleCentered(clamped);
        return;
      }
      const result = computeMouseAnchoredZoom({
        prevScale: scale,
        nextScale: clamped,
        mouseClient: { x: event.clientX, y: event.clientY },
        frame,
        prevPan: pan,
      });
      setScale(result.scale);
      setPan(result.pan);
      showHud();
    },
    [enabled, imageRef, pan, scale, setScaleCentered, showHud],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setIsPanning(true);
      panAnchorRef.current = { x: event.clientX, y: event.clientY };
      panPointerIdRef.current = event.pointerId;
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(
          event.pointerId,
        );
      } catch {
        // setPointerCapture 可能在极少数情况下抛错（元素不可见等），忽略。
      }
      showHud();
    },
    [enabled, showHud],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      const anchor = panAnchorRef.current;
      if (anchor === null) return;
      if (
        panPointerIdRef.current !== null &&
        event.pointerId !== panPointerIdRef.current
      ) {
        return;
      }
      event.preventDefault();
      const dx = event.clientX - anchor.x;
      const dy = event.clientY - anchor.y;
      panAnchorRef.current = { x: event.clientX, y: event.clientY };
      setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
    },
    [enabled],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (
        panPointerIdRef.current !== null &&
        event.pointerId !== panPointerIdRef.current
      ) {
        return;
      }
      setIsPanning(false);
      panAnchorRef.current = null;
      panPointerIdRef.current = null;
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(
          event.pointerId,
        );
      } catch {
        // 忽略。
      }
    },
    [enabled],
  );

  const handleSurfaceMouseMove = useCallback(() => {
    if (!enabled) return;
    showHud();
  }, [enabled, showHud]);

  useNonPassiveWheel(imageRef, {
    enabled,
    capture: true,
    onWheel: handleWheel,
  });

  useEffect(() => {
    return () => {
      if (hudTimerRef.current !== null) {
        clearTimeout(hudTimerRef.current);
        hudTimerRef.current = null;
      }
    };
  }, []);

  const cursor: "default" | "grab" | "grabbing" = useMemo(() => {
    if (!enabled) return "default";
    if (isPanning) return "grabbing";
    return scale > ZOOM_SCALE_FIT ? "grab" : "default";
  }, [enabled, isPanning, scale]);

  const state: ZoomableImageState = useMemo(
    () => ({ scale, pan, isPanning, hudVisible, fitMode }),
    [fitMode, hudVisible, isPanning, pan, scale],
  );

  return {
    state,
    reset,
    setFitMode,
    setScaleCentered,
    setActualPixels,
    handleWheel,
    handleKeyDownCapture,
    handleDoubleClick,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleSurfaceMouseMove,
    cursor,
  };
}
