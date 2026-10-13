import type { SpriteSheetLayout } from '@iart/contracts/media-processing-contract';

type ComputeLayoutParams = {
  fps: number | undefined;
  multiplier: number;
  startTime: number;
  endTime: number;
  videoWidth: number;
  videoHeight: number;
};

/**
 * 前端布局计算纯函数，算法与后端 computeSpriteSheetLayout 一致。
 * fps 为 undefined 时返回 null（无法计算）。
 */
export function computeLayout(params: ComputeLayoutParams): SpriteSheetLayout | null {
  const { fps, multiplier, startTime, endTime, videoWidth, videoHeight } = params;

  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) {
    return null;
  }
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) || videoWidth <= 0 || videoHeight <= 0) {
    return null;
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return null;
  }

  const duration = Math.max(0, endTime - startTime);
  const frameCount = Math.max(1, Math.floor(fps * multiplier * duration));
  const frameAspect = videoWidth / videoHeight;

  let cols = Math.ceil(Math.sqrt(frameCount * frameAspect));
  let rows = Math.ceil(frameCount / cols);

  while (cols > 1 && (cols - 1) * rows >= frameCount) {
    cols -= 1;
    rows = Math.ceil(frameCount / cols);
  }

  const MAX_ATLAS_SIZE = 8192;
  let frameWidth = videoWidth;
  let frameHeight = videoHeight;
  let atlasWidth = frameWidth * cols;
  let atlasHeight = frameHeight * rows;
  if (atlasWidth > MAX_ATLAS_SIZE || atlasHeight > MAX_ATLAS_SIZE) {
    const scale = Math.min(MAX_ATLAS_SIZE / atlasWidth, MAX_ATLAS_SIZE / atlasHeight);
    frameWidth = Math.floor(videoWidth * scale);
    frameHeight = Math.floor(videoHeight * scale);
    atlasWidth = frameWidth * cols;
    atlasHeight = frameHeight * rows;
  }

  return {
    frameCount,
    rows,
    cols,
    frameWidth,
    frameHeight,
    atlasWidth,
    atlasHeight,
  };
}
