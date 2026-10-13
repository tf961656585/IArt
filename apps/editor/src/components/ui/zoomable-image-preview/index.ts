/**
 * 图片缩放预览组件 barrel。
 *
 * 导出主组件、状态机 hook、几何工具与类型，供 4 个预览入口统一接入。
 */

export { ZoomableImagePreview } from "./ZoomableImagePreview";
export { useZoomableImage } from "./useZoomableImage";
export type {
  UseZoomableImageParams,
  UseZoomableImageResult,
  ZoomableImageState,
} from "./useZoomableImage";
export type {
  ZoomableImagePreviewHandle,
  ZoomableImagePreviewProps,
} from "./zoomableImageTypes";
export {
  ZOOM_SCALE_DOUBLE_CLICK,
  ZOOM_SCALE_FIT,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
  clampZoomScale,
  computeActualPixelsScale,
  computeMouseAnchoredZoom,
  computeWheelZoomFactor,
} from "./zoomableImageGeometry";
