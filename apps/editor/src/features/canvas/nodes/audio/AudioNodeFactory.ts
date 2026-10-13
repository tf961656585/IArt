/**
 * 音频节点分段变更判定
 * - 音频分段编辑后用于判断是否需要触发结构修订
 */

import type { AudioSegment } from '../../types/audioSegment';

/**
 * 检查分段是否已变更（用于判断是否需要重新切分）
 */
export function hasSegmentsChanged(
  oldSegments: AudioSegment[] | undefined,
  newSegments: AudioSegment[] | undefined
): boolean {
  if (!oldSegments && !newSegments) return false;
  if (!oldSegments || !newSegments) return true;
  if (oldSegments.length !== newSegments.length) return true;

  for (let i = 0; i < oldSegments.length; i++) {
    const oldSeg = oldSegments[i];
    const newSeg = newSegments[i];
    if (!oldSeg || !newSeg) return true;
    if (
      oldSeg.id !== newSeg.id ||
      oldSeg.name !== newSeg.name ||
      oldSeg.startTime !== newSeg.startTime ||
      oldSeg.endTime !== newSeg.endTime
    ) {
      return true;
    }
  }

  return false;
}
