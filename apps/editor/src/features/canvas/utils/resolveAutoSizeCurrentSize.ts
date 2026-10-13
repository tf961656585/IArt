import type { NodeSize } from '../types/node';

const isValidNodeSize = (size: NodeSize | null | undefined): size is NodeSize => {
  if (!size) return false;
  const width = Number(size.width);
  const height = Number(size.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
};

const cloneNodeSize = (size: NodeSize): NodeSize => ({
  width: Math.round(Number(size.width)),
  height: Math.round(Number(size.height)),
});

export function resolveAutoSizeCurrentSize(params: {
  currentMeasuredSize: NodeSize | null | undefined;
  fallback: NodeSize | null | undefined;
}): NodeSize | null {
  const currentMeasuredSize = params.currentMeasuredSize ?? null;
  const fallback = params.fallback ?? null;

  if (isValidNodeSize(currentMeasuredSize)) {
    return cloneNodeSize(currentMeasuredSize);
  }

  return isValidNodeSize(fallback) ? cloneNodeSize(fallback) : null;
}
