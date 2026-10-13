import type { ImageTransformOp } from '@/client/api/imageTransform';
import type { ImageDerivedOp } from '../types';

export type ImageOperationId =
  | 'mirrorX'
  | 'mirrorY'
  | 'rotate90'
  | 'rotate180'
  | 'rotate270';

export type ImageOperationDefinition = {
  id: ImageOperationId;
  label: string;
  derivedOp: ImageDerivedOp;
  ops: ImageTransformOp[];
};

export const IMAGE_OPERATION_REGISTRY: Record<ImageOperationId, ImageOperationDefinition> = {
  mirrorX: {
    id: 'mirrorX',
    label: '水平镜像',
    derivedOp: { type: 'mirrorX' },
    ops: [{ type: 'mirrorX' }],
  },
  mirrorY: {
    id: 'mirrorY',
    label: '垂直镜像',
    derivedOp: { type: 'mirrorY' },
    ops: [{ type: 'mirrorY' }],
  },
  rotate90: {
    id: 'rotate90',
    label: '旋转 90°',
    derivedOp: { type: 'rotate', deg: 90 },
    ops: [{ type: 'rotate', deg: 90 }],
  },
  rotate180: {
    id: 'rotate180',
    label: '旋转 180°',
    derivedOp: { type: 'rotate', deg: 180 },
    ops: [{ type: 'rotate', deg: 180 }],
  },
  rotate270: {
    id: 'rotate270',
    label: '旋转 270°',
    derivedOp: { type: 'rotate', deg: 270 },
    ops: [{ type: 'rotate', deg: 270 }],
  },
};

export const getImageOperation = (id: ImageOperationId): ImageOperationDefinition => {
  return IMAGE_OPERATION_REGISTRY[id];
};

export const listImageOperations = (): ImageOperationDefinition[] => {
  return Object.values(IMAGE_OPERATION_REGISTRY);
};
