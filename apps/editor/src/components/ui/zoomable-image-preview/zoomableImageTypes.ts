/**
 * 图片缩放预览组件类型契约。
 *
 * 可选 props 通过 `Partial<{...}>` 统一声明（参照 tooltip-button.tsx:13-20）。
 */

import type React from "react";

export type ZoomableImagePreviewScale = number;

export type ZoomableImagePreviewProps = {
  /** 图片 URL。空串/undefined 时渲染加载或空态。 */
  src: string;
} & Partial<{
  alt: string | undefined;
  /** 是否启用完整缩放能力。默认 true。 */
  zoomable: boolean | undefined;
  /** 加载中态。true 时显示加载占位，图片渲染但隐藏。 */
  isLoading: boolean | undefined;
  /** 加载失败态文案。非空时显示错误占位。 */
  errorText: string | undefined;
  /** 空态文案（无 src 时）。 */
  emptyText: string | undefined;
  /** 自定义图片类名（合并到内部 img className）。 */
  imageClassName: string | undefined;
  /** 自定义 surface（黑色画布）类名。 */
  surfaceClassName: string | undefined;
  /** 透传给内部 img 的 onLoad。 */
  onLoad: (() => void) | undefined;
  /** 透传给内部 img 的 onError。 */
  onError: (() => void) | undefined;
  /**
   * 工具栏插槽（渲染在右上角）。用于注入各入口的特有操作（下载/打开位置/关闭等）。
   * 内部已包含缩放百分比与档位切换 HUD，插槽只承载业务操作。
   */
  toolbar: React.ReactNode | undefined;
  /**
   * 左下角插槽（导航按钮、画廊选择/移除等）。
   */
  bottomStartSlot: React.ReactNode | undefined;
  /**
   * 底部插槽（bottomStartSlot）是否常驻可见。
   * 默认 false：插槽跟随缩放 HUD 一起自动淡出。
   * true：插槽不跟随 HUD 淡出，始终保持 opacity-100。用于导航按钮等核心功能控件。
   * 依据 docs/runtime/媒体放大预览交互契约.md「导航可见性」节：导航控件常驻可见。
   */
  slotAlwaysVisible: boolean | undefined;
  /**
   * 是否启用 fill 档（填满视口，可能裁切边缘）。
   * 默认 false：dropdownItems 只有 fit/actual/200%/400% 缩放档位。
   * true：dropdownItems 额外包含 fill 项，用户可从 fit 切到 fill。
   * 依据 docs/runtime/媒体放大预览交互契约.md「档位切换」：fill 档走 CSS object-cover，
   * 可能裁切边缘；切换不持久化，每次打开回到 fit 默认档。
   */
  enableFill: boolean | undefined;
}>;

export type ZoomableImagePreviewHandle = {
  /** 重置缩放与平移。 */
  reset: () => void;
};
