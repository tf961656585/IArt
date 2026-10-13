/**
 * 图片缩放预览几何工具。
 *
 * 设计目标：缩放以鼠标光标位置为锚点，保持光标下的图片像素在屏幕上不动。
 *
 * 复用 `features/canvas/utils/imageGeometry.ts` 中已有的 `ImageContentFrame` 类型与
 * `getImageContentFrameFromElement`、`clientPointToImageNorm`、`computeContainContentFrame`
 * 计算能力，避免重复实现 object-contain 内容框推导。
 */

import {
  clientPointToImageNorm,
  computeContainContentFrame,
  getImageContentFrameFromElement,
  type CssBox,
  type ImageContentFrame,
  type NaturalImageSize,
  type NormalizedPoint,
} from "@/features/canvas/utils/imageGeometry";

/** 缩放范围。下限允许总览，上限覆盖超高清图细节查看。 */
export const ZOOM_SCALE_MIN = 0.2;
export const ZOOM_SCALE_MAX = 12;

/** Fit（适合窗口）档位。 */
export const ZOOM_SCALE_FIT = 1;
/** 实际像素 1:1 档位，由运行时按图片原始分辨率动态计算，这里仅作为语义占位。 */
export const ZOOM_SCALE_ACTUAL_PIXELS = 1;
/** 双击快速放大档位。 */
export const ZOOM_SCALE_DOUBLE_CLICK = 2;

/**
 * 把 value 限制在 [min, max] 区间。
 * 沿用 imageGeometry.ts:40 / useCropInteraction.ts:10 的局部 clamp 惯例，
 * 不触动仓库内既有的多处 clamp 重复实现。
 */
export const clampZoomScale = (value: number): number => {
  if (!Number.isFinite(value)) return ZOOM_SCALE_FIT;
  return Math.max(ZOOM_SCALE_MIN, Math.min(ZOOM_SCALE_MAX, value));
};

/**
 * 乘性缩放因子。基于 deltaY 计算连续乘性步进，触控板连续滑动会自然加速。
 *
 * 公式：`factor = base ^ (deltaY / unit)`，每 `unit` 像素位移对应一次 `base` 倍缩放。
 * - `deltaY > 0`（向下/向外滚）→ 缩小。
 * - `deltaY < 0`（向上/向内滚）→ 放大。
 */
export const computeWheelZoomFactor = (
  deltaY: number,
  options: { base: number | undefined; unit: number | undefined },
): number => {
  const base = options.base ?? 1.15;
  const unit = options.unit ?? 100;
  const safeUnit = unit > 0 ? unit : 100;
  // 向外滚（deltaY>0）应缩小，所以指数取负。
  const exponent = -deltaY / safeUnit;
  return Math.pow(base, exponent);
};

export type MouseAnchoredZoomInput = {
  /** 当前缩放倍率。 */
  prevScale: number;
  /** 目标缩放倍率（已被 clamp 到合法区间）。 */
  nextScale: number;
  /** 鼠标客户端坐标。 */
  mouseClient: { x: number; y: number };
  /** 图片元素当前在屏幕上渲染出的 object-contain 内容框。 */
  frame: ImageContentFrame;
  /** 缩放前的平移偏移（像素）。 */
  prevPan: { x: number; y: number };
};

export type MouseAnchoredZoomResult = {
  scale: number;
  pan: { x: number; y: number };
};

/**
 * 以鼠标光标为锚点计算缩放后的平移量，使光标下的图片像素保持在屏幕原位。
 *
 * 数学推导：
 *   设图片内容框在屏幕上的左上角为 `frame.left/top`，宽高 `frame.width/height`。
 *   归一化锚点 `n ∈ [0,1]²` 表示鼠标落在图片内容框内的相对位置（由
 *   `clientPointToImageNorm` 计算，落在内容框外则取最近边缘）。
 *   缩放前锚点的屏幕坐标：
 *     anchorScreen.x = frame.left + n.x * frame.width
 *     anchorScreen.y = frame.top  + n.y * frame.height
 *   图片以中心为几何缩放原点（CSS `scale` 以 `transformOrigin: center` 为基准），
 *   再叠加平移 `pan`。缩放前锚点经变换后的屏幕位置：
 *     P_before = center + (anchorScreen - center) * prevScale + prevPan
 *   缩放后要求 P_after = P_before，反解 nextPan：
 *     nextPan = P_before - center - (anchorScreen - center) * nextScale
 *
 * 若鼠标不在图片内容框内（如快速滚动时光标已移出），退化为以图片中心为锚点
 * （即 nextPan 按比例缩放 prevPan）。
 */
export const computeMouseAnchoredZoom = (
  input: MouseAnchoredZoomInput,
): MouseAnchoredZoomResult => {
  const { prevScale, nextScale, mouseClient, frame, prevPan } = input;
  if (nextScale === prevScale) {
    return { scale: prevScale, pan: prevPan };
  }

  const centerX = frame.left + frame.width / 2;
  const centerY = frame.top + frame.height / 2;

  const anchorNorm: NormalizedPoint | null = clientPointToImageNorm(
    mouseClient,
    frame,
  );

  if (anchorNorm === null) {
    // 鼠标不在内容框内：以中心为锚点等比例缩放平移量。
    return {
      scale: nextScale,
      pan: {
        x: prevPan.x * (nextScale / prevScale),
        y: prevPan.y * (nextScale / prevScale),
      },
    };
  }

  const anchorScreenX = frame.left + anchorNorm.x * frame.width;
  const anchorScreenY = frame.top + anchorNorm.y * frame.height;

  // 缩放前锚点变换后的屏幕坐标。
  const transformedX =
    centerX + (anchorScreenX - centerX) * prevScale + prevPan.x;
  const transformedY =
    centerY + (anchorScreenY - centerY) * prevScale + prevPan.y;

  // 反解 nextPan 使缩放后锚点仍落在同一屏幕位置。
  const nextPanX = transformedX - centerX - (anchorScreenX - centerX) * nextScale;
  const nextPanY = transformedY - centerY - (anchorScreenY - centerY) * nextScale;

  return {
    scale: nextScale,
    pan: { x: nextPanX, y: nextPanY },
  };
};

/**
 * 计算"实际像素 1:1"档位对应的缩放倍率。
 *
 * 图片以 object-contain 适配容器，`frame.scale` 是图片原始像素 → CSS 像素的缩放比。
 * 当 `frame.scale = 1` 时，CSS 像素 == 原始像素，即"实际像素"。
 * 因此实际像素档位在预览组件坐标系下就是 `1 / frame.scale`。
 */
export const computeActualPixelsScale = (
  image: HTMLImageElement,
): number => {
  const frame = getImageContentFrameFromElement(image);
  if (frame === null) return ZOOM_SCALE_FIT;
  if (frame.scale <= 0) return ZOOM_SCALE_FIT;
  return clampZoomScale(1 / frame.scale);
};

/**
 * 重新计算容器尺寸变化后的 Fit 倍率。Fit 永远是 1（object-contain 已经把图片适配容器）。
 * 此函数保留作为语义占位与未来扩展入口，当前直接返回 1。
 */
export const computeFitScale = (
  _natural: NaturalImageSize,
  _box: CssBox,
): number => {
  return ZOOM_SCALE_FIT;
};

export {
  clientPointToImageNorm,
  computeContainContentFrame,
  getImageContentFrameFromElement,
};
