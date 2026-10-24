"use client";

/**
 * 容器握把（spec：画布节点组.md AG-CN-019 / AG-CN-020）。
 *
 * 屏幕恒定尺寸的容器拖动握把，替换旧「展开态远缩放标题气泡」：
 * - 视觉 24px、命中 44px；宽度 max(88, min(240, 容器屏幕宽))（容器屏宽 < 88px 时保持 88px，
 *   允许略宽于容器）；
 * - 所有尺寸写成「屏幕 px ÷ safeZoom」的画布 px（不用 transform: scale(1/zoom)，
 *   避免缩放引入布局语义问题）；
 * - 放置于容器框上方（成员区域之外），顶到视口顶边时由调用方翻转为 inside（框内首行）；
 * - 按钮无 `nodrag`：拖动走 React Flow 既有节点拖动链路，不引入第二套拖动/写回；
 * - 单击（位移 ≤ 4px，由 React Flow 既有全局阈值判定）只调既有 locateToNode 定位。
 *
 * 组与 Agent 容器同构复用本组件。
 */

import { memo, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import {
  CONTAINER_GRIP_HIT_SCREEN_SIZE,
  CONTAINER_GRIP_MAX_WIDTH_SCREEN_SIZE,
  CONTAINER_GRIP_MIN_WIDTH_SCREEN_SIZE,
  CONTAINER_GRIP_VISUAL_SCREEN_SIZE,
  type ContainerGripPlacement,
} from "../../services/groupGeometry";

export type { ContainerGripPlacement } from "../../services/groupGeometry";

export type GripDotsProps = {
  /** 圆点直径（画布 px；调用方按屏幕 px ÷ zoom 传入） */
  size: number;
  color?: string;
};

/**
 * 2 列 × 3 行握把点（6 个圆点）。折叠卡与容器头 chip 常显，握把内复用。
 * 默认色 --muted-foreground（chip/card 内不过重）；纯装饰（aria-hidden），不带交互语义。
 */
export const GripDots = memo(function GripDots({ size, color }: GripDotsProps) {
  const dotColor = color ?? "var(--muted-foreground)";
  return (
    <span
      aria-hidden="true"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, max-content)",
        gap: size,
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
        color: dotColor,
      }}
    >
      {Array.from({ length: 6 }, (_, index) => (
        <i
          key={index}
          style={{
            display: "block",
            width: size,
            height: size,
            borderRadius: "50%",
            backgroundColor: dotColor,
          }}
        />
      ))}
    </span>
  );
});

/** 每实例注入的 accent 令牌（pill 边框经 color-mix 派生） */
type GripCssVars = CSSProperties & { "--grip-accent": string };

export type ContainerGripProps = {
  containerId: string;
  label: string;
  memberCount: number;
  accent: string;
  zoom: number;
  screenWidth: number;
  placement: ContainerGripPlacement;
  isDragging: boolean;
  onLocate: () => void;
};

const GRIP_FOCUS_CLASS =
  "focus-visible:outline-2 focus-visible:outline-[var(--chrome-ring)] focus-visible:outline-offset-2";

export const ContainerGrip = memo(function ContainerGrip({
  containerId,
  label,
  memberCount,
  accent,
  zoom,
  screenWidth,
  placement,
  isDragging,
  onLocate,
}: ContainerGripProps) {
  const safeZoom = zoom > 0 ? zoom : 1;
  const widthScreen = Math.max(
    CONTAINER_GRIP_MIN_WIDTH_SCREEN_SIZE,
    Math.min(
      CONTAINER_GRIP_MAX_WIDTH_SCREEN_SIZE,
      Number.isFinite(screenWidth) ? screenWidth : CONTAINER_GRIP_MAX_WIDTH_SCREEN_SIZE,
    ),
  );

  const placementStyle: CSSProperties =
    placement === "above"
      ? { bottom: "100%", alignItems: "flex-end" }
      : { top: "0px", alignItems: "flex-start" };

  const buttonStyle: GripCssVars = {
    position: "absolute",
    left: 0,
    zIndex: 3,
    display: "flex",
    pointerEvents: "auto",
    padding: 0,
    border: 0,
    background: "transparent",
    userSelect: "none",
    touchAction: "none",
    cursor: isDragging ? "grabbing" : "grab",
    width: `${widthScreen / safeZoom}px`,
    height: `${CONTAINER_GRIP_HIT_SCREEN_SIZE / safeZoom}px`,
    ...placementStyle,
    "--grip-accent": accent,
  };

  const pillStyle: CSSProperties = {
    width: "100%",
    height: `${CONTAINER_GRIP_VISUAL_SCREEN_SIZE / safeZoom}px`,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: `${6 / safeZoom}px`,
    padding: `0 ${10 / safeZoom}px`,
    borderRadius: `${8 / safeZoom}px`,
    border: `${1 / safeZoom}px solid color-mix(in srgb, var(--grip-accent) 45%, var(--color-border))`,
    background: "var(--card)",
    boxShadow: "var(--shadow-md)",
    color: "var(--foreground)",
    fontSize: `${12 / safeZoom}px`,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
  };

  const labelStyle: CSSProperties = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: "1 1 auto",
  };

  const labelText = label + (memberCount > 0 ? ` · ${memberCount}` : "");
  const accessibleText = `拖动移动${label}；单击定位`;

  return (
    <button
      type="button"
      data-testid="container-grip"
      data-container-id={containerId}
      data-placement={placement}
      aria-label={accessibleText}
      title={accessibleText}
      onClick={onLocate}
      className={cn(GRIP_FOCUS_CLASS)}
      style={buttonStyle}
    >
      <span data-testid="container-grip-pill" style={pillStyle}>
        <GripDots size={2 / safeZoom} />
        <span data-testid="container-grip-label" style={labelStyle}>
          {labelText}
        </span>
      </span>
    </button>
  );
});
