"use client";

/**
 * 图片缩放预览组件。
 *
 * 承载所有"放大看图片"场景的统一能力：鼠标锚点滚轮缩放、PointerEvents 平移、
 * 键盘缩放、双击切换 Fit/2×、档位预设、HUD 自动淡出。所有入口（画布资产节点 /
 * 画布图片节点 / 右侧工作区资产预览 / 上传文件预览）通过本组件共享同一套行为。
 *
 * 关键实现：
 * - surface 用 `<div role="presentation">`，不再像 ImageInputNode 旧实现那样误用
 *   `<button>`（避免按钮嵌套按钮）。
 * - 尺寸契约：surface 以 `flex-1 min-h-0` 撑满父级剩余空间，调用方必须给容器确定高度
 *   （canvas 形态 `DialogContent` 传 `fill`）。父级高度不确定时百分比高度退化为 auto，
 *   surface 与 `<img>` 会按图片自身比例撑开，超出部分被 `overflow-hidden` 裁切。
 *   依据 docs/runtime/媒体放大预览交互契约.md「初始尺寸契约」。
 * - 内部 `<img>` 以 `object-contain` 适配 surface，叠加 `transform: translate + scale`。
 * - 滚轮事件用 `nowheel` class（React Flow 约定）+ `useNonPassiveWheel` 双保险。
 * - HUD 自动淡出通过 CSS transition + opacity，由 hook 控制 hudVisible 状态。
 * - 槽内交互守卫：可交互浮层（HUD / 底部插槽 / 工具栏）在本组件统一阻断 pointerdown 与双击冒泡，
 *   否则 surface 的指针捕获会把槽内按钮的 click 吞掉（见 SLOT_INTERACTION_GUARD）。
 */

import { forwardRef, useImperativeHandle, useRef } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  IconChevronDown,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useZoomableImage } from "./useZoomableImage";
import {
  ZOOM_SCALE_FIT,
} from "./zoomableImageGeometry";
import type {
  ZoomableImagePreviewHandle,
  ZoomableImagePreviewProps,
} from "./zoomableImageTypes";

const DEFAULT_EMPTY_TEXT = "还没有可以预览的图片";
const DEFAULT_ERROR_TEXT = "图片加载失败";

type SurfaceInteractionHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

/**
 * 槽内交互守卫：预览面上的可交互浮层（缩放 HUD / 底部插槽 / 工具栏）自己消费指针按下与双击，
 * 不让它们冒泡到 surface。
 *
 * 为什么必须由本组件统一施加：surface 的 pointerdown 会 `preventDefault` + `setPointerCapture`
 * 以启动平移，而指针一旦被 surface 捕获，浏览器会把随后的兼容鼠标事件（mouseup / click）一并
 * 重定向到捕获元素——槽内按钮的 onClick 永远收不到（真机实测：相册「下一张」点击后计数不变、
 * 翻页无效；jsdom 的 `fireEvent.click` 直接投递目标节点，看不见这条链路）。这条约束属于本组件
 * 的槽位契约，下放给调用方或槽内部件去记必然漏——工具栏曾就地写过同一份 stopPropagation，
 * 底部插槽没有，于是后加的相册导航槽再踩一次。新增任何槽位都必须挂上本守卫。
 */
const SLOT_INTERACTION_GUARD = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>): void => {
    event.stopPropagation();
  },
  onMouseDown: (event: ReactMouseEvent<HTMLElement>): void => {
    event.stopPropagation();
  },
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>): void => {
    event.stopPropagation();
  },
};

export const ZoomableImagePreview = forwardRef<
  ZoomableImagePreviewHandle,
  ZoomableImagePreviewProps
>(function ZoomableImagePreview(props, ref) {
  const {
    src,
    alt = undefined,
    zoomable = true,
    isLoading = false,
    errorText = undefined,
    emptyText = undefined,
    imageClassName = undefined,
    surfaceClassName = undefined,
    onLoad = undefined,
    onError = undefined,
    toolbar = undefined,
    bottomStartSlot = undefined,
    slotAlwaysVisible = false,
    enableFill = false,
  } = props;

  const imageRef = useRef<HTMLImageElement | null>(null);

  const {
    state,
    reset,
    setFitMode,
    setScaleCentered,
    setActualPixels,
    handleKeyDownCapture,
    handleDoubleClick,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleSurfaceMouseMove,
    cursor,
  } = useZoomableImage({
    imageRef,
    enabled: Boolean(zoomable && src),
    wheelZoomBase: undefined,
    wheelZoomUnit: undefined,
  });

  useImperativeHandle(
    ref,
    (): ZoomableImagePreviewHandle => ({
      reset,
    }),
    [reset],
  );

  const surfaceHandlers: SurfaceInteractionHandlers | null = zoomable
    ? {
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerUp,
        onDoubleClick: handleDoubleClick,
        onMouseMove: (event) => {
          handleSurfaceMouseMove();
          // 不阻止合成事件冒泡；仅消费 hover 信号。
          void event;
        },
      }
    : null;

  const hasImage = Boolean(src);
  const showError = Boolean(errorText);
  const showEmpty = !hasImage && !isLoading && !showError;
  const showLoading = isLoading && !showError;
  const imgHiddenByLoading = isLoading || showError;

  const scalePercent = Math.round(state.scale * 100);
  // fit 档高亮条件：适配模式为 contain 且缩放为 1。
  // fill 档高亮条件：适配模式为 cover 且缩放为 1。
  const isAtBaseScale = Math.abs(state.scale - ZOOM_SCALE_FIT) < 0.001;
  const isFit = state.fitMode === "contain" && isAtBaseScale;
  const isFill = state.fitMode === "cover" && isAtBaseScale;

  const hudOpacityClass = state.hudVisible
    ? "opacity-100"
    : "opacity-30 hover:opacity-100";

  // 底部插槽（导航按钮等核心控件）的可见性策略。
  // 依据 docs/runtime/媒体放大预览交互契约.md「导航可见性」：导航控件常驻可见，
  // 不跟随缩放 HUD 自动淡出。slotAlwaysVisible=true 时强制 opacity-100。
  const slotOpacityClass = slotAlwaysVisible ? "opacity-100" : hudOpacityClass;

  const dropdownItems = [
    {
      key: "fit",
      label: isFit ? "适合窗口（当前）" : "适合窗口",
      onSelect: () => reset(),
    },
    ...(enableFill
      ? [
          {
            key: "fill",
            label: isFill ? "填满窗口（当前）" : "填满窗口",
            onSelect: () => setFitMode("cover"),
          },
        ]
      : []),
    {
      key: "actual",
      label: "原始大小 100%",
      onSelect: () => setActualPixels(),
    },
    {
      key: "200",
      label: "放大到 200%",
      onSelect: () => setScaleCentered(2),
    },
    {
      key: "400",
      label: "放大到 400%",
      onSelect: () => setScaleCentered(4),
    },
  ] as const;

  return (
    <div
      role="presentation"
      className={cn(
        "relative h-full w-full flex-1 min-h-0 overflow-hidden rounded-md bg-black/85 select-none",
        zoomable && "nowheel",
        surfaceClassName,
      )}
      style={{ cursor: zoomable ? cursor : "default" }}
      // onKeyDownCapture 挂到 surface（Radix Dialog Content 默认会让内部元素获得焦点，
      // 这里用 capture 保证在缩放键被默认处理前拦截）。
      tabIndex={zoomable ? -1 : undefined}
      // 让 surface 在 Dialog 内可接收键盘事件而不抢焦点：仅在缩放启用时纳入 tab 顺序为 -1。
      {...(surfaceHandlers === null
        ? {}
        : {
            onPointerDown: surfaceHandlers.onPointerDown,
            onPointerMove: surfaceHandlers.onPointerMove,
            onPointerUp: surfaceHandlers.onPointerUp,
            onPointerCancel: surfaceHandlers.onPointerCancel,
            onDoubleClick: surfaceHandlers.onDoubleClick,
            onMouseMove: surfaceHandlers.onMouseMove,
          })}
    >
      <div
        className="h-full w-full"
        onKeyDownCapture={zoomable ? handleKeyDownCapture : undefined}
      >
        {hasImage ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            ref={imageRef}
            src={src}
            alt={alt ?? ""}
            className={cn(
              "h-full w-full select-none",
              // fit 档用 object-contain（完整可见，可能留黑边）；
              // fill 档用 object-cover（填满视口，可能裁切边缘）。
              // 依据 docs/runtime/媒体放大预览交互契约.md「档位切换」。
              state.fitMode === "cover" ? "object-cover" : "object-contain",
              imgHiddenByLoading && "invisible",
              imageClassName,
            )}
            style={{
              transform: `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.scale})`,
              transformOrigin: "center center",
            }}
            draggable={false}
            onLoad={onLoad ?? undefined}
            onError={onError ?? undefined}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : null}

        {showLoading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-md bg-black/60 px-4 py-2 text-sm text-white/85">
              加载中…
            </div>
          </div>
        ) : null}

        {showError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="max-w-md text-sm text-white/85">
              {errorText ?? DEFAULT_ERROR_TEXT}
            </div>
          </div>
        ) : null}

        {showEmpty ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="max-w-md text-sm text-white/65">
              {emptyText ?? DEFAULT_EMPTY_TEXT}
            </div>
          </div>
        ) : null}

        {zoomable && hasImage ? (
          <div
            className={cn(
              "pointer-events-auto absolute left-3 top-3 flex items-center gap-2 text-xs text-white/85 transition-opacity duration-200",
              hudOpacityClass,
            )}
            {...SLOT_INTERACTION_GUARD}
          >
            <span className="rounded bg-black/55 px-2 py-1">
              滚轮/+- 缩放 · 双击放大 · 0 原始大小 · R 重置
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded bg-black/55 px-2 py-1 text-white/85 transition-colors hover:bg-black/75 focus-visible:outline-none"
                  aria-label="切换缩放档位"
                >
                  <span>{scalePercent}%</span>
                  <IconChevronDown size={12} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[12rem]">
                {dropdownItems.map((item) => (
                  <DropdownMenuItem
                    key={item.key}
                    onSelect={() => item.onSelect()}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}

        {bottomStartSlot ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-3 flex items-center justify-start px-3 transition-opacity duration-200",
              slotOpacityClass,
            )}
            {...SLOT_INTERACTION_GUARD}
          >
            {bottomStartSlot}
          </div>
        ) : null}

        {toolbar ? (
          <div
            role="presentation"
            className={cn(
              "pointer-events-auto absolute right-3 top-3 flex items-center gap-2 transition-opacity duration-200",
              hudOpacityClass,
            )}
            {...SLOT_INTERACTION_GUARD}
          >
            {toolbar}
          </div>
        ) : null}
      </div>
    </div>
  );
});

ZoomableImagePreview.displayName = "ZoomableImagePreview";
