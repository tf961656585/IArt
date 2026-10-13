/**
 * 媒体展示尺寸策略（Layout-Model-Driven 唯一口径）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md「计算分层·媒体尺寸层」
 * spec: docs/runtime/画布节点尺寸管理架构.md「禁止事项」（禁止渲染层 CSS 私造口径）
 *
 * 职责：把媒体宽高比按统一策略函数派生为带上下限钳制的展示尺寸
 * （displayWidth / displayHeight）。本模块是媒体展示尺寸策略的**单一事实源**，
 * 唯一消费者为 Layout Model 媒体尺寸层（`computeMediaNodeSize`）；渲染层不得
 * 复现本策略（不得用 CSS width/max-width/max-height/aspect-ratio 私造第二口径）。
 *
 * 上下限钳制：
 * - MIN_WIDTH：展示宽度下限，避免极小宽图塌缩到不可读。
 * - MAX_DISPLAY_DIMENSION：展示宽/高双向上限，避免极端宽高比撑爆画布。
 *
 * 具体数值为实现层裁定项（spec 不固化数值），修改数值必须同步更新测试锚点。
 *
 * 纯函数约束（与 Layout Model 主函数一致）：
 * - 给定相同输入，输出确定（无 Date.now()、无 Math.random()、无 DOM 访问）。
 * - 不读取 ReactFlow store、不订阅 ResizeObserver。
 */

import { computeFittedSize } from "@/client/components/file-upload/imageConstraints";
import type { MediaMeta } from "../types/node";

/**
 * 媒体展示宽度下限（px）。
 *
 * 实现层裁定值；当 fitted.width 低于此值时抬升到该下限（高度按 aspect 同步推导，
 * 若超过 MAX_DISPLAY_DIMENSION 则改走 fitted 结果）。
 */
export const MIN_WIDTH = 180;

/**
 * 媒体展示尺寸上限（px，宽与高同时受此约束）。
 *
 * 实现层裁定值；computeFittedSize 按此值对原始宽高做等比缩放，
 * 再由本策略函数叠加 MIN_WIDTH 下限与 MAX_DISPLAY_DIMENSION 双向校验。
 */
export const MAX_DISPLAY_DIMENSION = 320;

/**
 * 按媒体 meta 计算期望展示尺寸（宽高同时受 MAX_DISPLAY_DIMENSION 双向约束，
 * 宽度受 MIN_WIDTH 下限保护）。
 *
 * 钳制语义：
 * 1. computeFittedSize 把原始宽高按 MAX_DISPLAY_DIMENSION 等比缩放，保证长边 ≤ 上限。
 * 2. 若 fitted.width < MIN_WIDTH，把宽度抬升到 MIN_WIDTH（高度 = MIN_WIDTH / aspect）。
 * 3. 若抬升后高度超过 MAX_DISPLAY_DIMENSION（竖图场景），回退到 fitted 结果（保上限优先）。
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
  if (meta === null || meta === undefined) return null;
  if (!meta.width || !meta.height) return null;
  const aspect = meta.aspectRatio || meta.width / meta.height || defaultAspectRatio;
  const fitted = computeFittedSize(meta.width, meta.height, MAX_DISPLAY_DIMENSION);
  const desiredWidth = Math.max(fitted.width, MIN_WIDTH);
  const desiredHeight = desiredWidth / aspect;
  const withinBounds =
    desiredWidth <= MAX_DISPLAY_DIMENSION && desiredHeight <= MAX_DISPLAY_DIMENSION;
  const finalWidth = withinBounds ? desiredWidth : fitted.width;
  const finalHeight = finalWidth / aspect;
  return { width: Math.round(finalWidth), height: Math.round(finalHeight) };
}
