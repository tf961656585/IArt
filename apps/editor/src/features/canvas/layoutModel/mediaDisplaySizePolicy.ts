/**
 * 媒体展示尺寸策略（Layout-Model-Driven 唯一口径）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md「计算分层·媒体尺寸层」
 * spec: docs/runtime/画布节点尺寸管理架构.md「禁止事项」（禁止渲染层 CSS 私造口径）
 *
 * 职责：把媒体宽高比按统一策略派生为带上下限钳制的展示尺寸
 * （displayWidth / displayHeight）。公式与常量由 @iart/utils/canvas-geometry 承载，
 * 本模块只保留 Layout Model / PromptDock 投影的入口导出，不另行维护数值或算术。
 *
 * 上下限钳制：
 * - MIN_WIDTH：展示宽度下限，避免极小宽图塌缩到不可读。
 * - MAX_DISPLAY_DIMENSION：展示宽/高双向上限，避免极端宽高比撑爆画布。
 *
 * 纯函数约束（与 Layout Model 主函数一致）：
 * - 给定相同输入，输出确定（无 Date.now()、无 Math.random()、无 DOM 访问）。
 * - 不读取 ReactFlow store、不订阅 ResizeObserver。
 */

import { computeCanvasMediaDisplaySize } from "@iart/utils/canvas-geometry";
import type { MediaMeta } from "../types/node";

/** 媒体展示宽度下限（px）。 */
export { CANVAS_MEDIA_MIN_WIDTH as MIN_WIDTH } from "@iart/utils/canvas-geometry";

/** 媒体展示尺寸上限（px，宽与高同时受此约束）。 */
export { CANVAS_MEDIA_MAX_DISPLAY_DIMENSION as MAX_DISPLAY_DIMENSION } from "@iart/utils/canvas-geometry";

/**
 * 按媒体 meta 计算期望展示尺寸（宽高同时受 MAX_DISPLAY_DIMENSION 双向约束，
 * 宽度受 MIN_WIDTH 下限保护）。
 *
 * 返回 null 表示无可用 meta，调用方应回落注册表 defaultSize（布局模型层已处理）。
 *
 * 纯函数。
 *
 * @param meta 媒体宽高元信息（width / height / aspectRatio），缺失返回 null
 * @param defaultAspectRatio 节点类型默认宽高比（image 3/2、video 16/9），仅在 meta.aspectRatio
 *   缺失时作为兜底推导输入
 */
export function computeMediaDisplaySize(
  meta: MediaMeta | null | undefined,
  defaultAspectRatio: number,
): { width: number; height: number } | null {
  return computeCanvasMediaDisplaySize(meta, defaultAspectRatio);
}
