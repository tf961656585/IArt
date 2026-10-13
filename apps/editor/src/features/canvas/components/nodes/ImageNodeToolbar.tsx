'use client';

import { memo, useCallback, useState } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import {
  IconBorderOuter,
  IconColorFilter,
  IconContrast,
  IconCrop,
  IconFlipHorizontal,
  IconFlipVertical,
  IconLayoutGrid,
  IconMaximize,
  IconPencil,
  IconResize,
  IconRotateClockwise,
  IconScissors,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { transformImage } from '@/client/api/imageTransform';
import { ensureBackendConsumableImageSource } from '../../utils/mediaUtils';
import { createDerivedImageInputNode } from '../../utils/imageDerivation';
import { getImageOperation, type ImageOperationId } from '../../image-ops/registry';
import { useCanvasSelectionBridge } from '../canvas/useCanvasSelectionBridge';

interface ImageNodeToolbarProps {
  nodeId: string;
  imageUrl: string | null;
  visible: boolean;
  onOutpaintClick: () => void;
  onResizeClick: () => void;
  onCropClick: () => void;
  onSplitClick: () => void;
  onAnnotateClick: () => void;
  onEdgeDetectClick: () => void;
  onChromaKeyClick: () => void;
  onDifferenceKeyClick: () => void;
  onSmartSplitClick: () => void;
}

export const ImageNodeToolbar = memo(function ImageNodeToolbar({
  nodeId,
  imageUrl,
  visible,
  onOutpaintClick,
  onResizeClick,
  onCropClick,
  onSplitClick,
  onAnnotateClick,
  onEdgeDetectClick,
  onChromaKeyClick,
  onDifferenceKeyClick,
  onSmartSplitClick,
}: ImageNodeToolbarProps) {
  const hasImage = Boolean(imageUrl);
  const [processingOp, setProcessingOp] = useState<ImageOperationId | null>(null);
  const { selectNodes } = useCanvasSelectionBridge();

  const runTransformOp = useCallback(
    async (opId: ImageOperationId) => {
      if (!imageUrl) return;
      const op = getImageOperation(opId);

      setProcessingOp(opId);
      try {
        const sourceUrl = await ensureBackendConsumableImageSource(imageUrl);
        const result = await transformImage(sourceUrl, op.ops);
        const created = createDerivedImageInputNode({
          sourceNodeId: nodeId,
            resultUrl: result.url,
          assetId: result.assetId,
          mediaAsset: result.mediaAsset,
          derivedOp: op.derivedOp,
          selectNodes,
        });
        if (!created) throw new Error('创建衍生节点失败');
      } catch (error) {
        console.error(`[ImageNodeToolbar] ${opId} failed`, error);
      } finally {
        setProcessingOp(null);
      }
    },
    [imageUrl, nodeId, selectNodes],
  );

  if (!hasImage) {
    return null;
  }

  const processing = Boolean(processingOp);

  return (
    <NodeToolbar
      nodeId={nodeId}
      isVisible={visible}
      position={Position.Top}
      /* offset 14 = 选中环外扩 6px + 视觉余量 8px（对齐设计层 node-chrome.js BAR_GAP，
         选中环走 box-shadow 不入 bounding box，须从环外缘起算恢复呼吸感） */
      offset={14}
    >
      <div className="rounded border bg-card shadow-sm p-1 flex gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                void runTransformOp('mirrorX');
              }}
              aria-label="水平镜像"
              title="水平镜像"
            >
              <IconFlipHorizontal size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            水平镜像
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onCropClick();
              }}
              aria-label="裁剪图片"
              title="裁剪图片"
            >
              <IconCrop size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            裁剪图片
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onSplitClick();
              }}
              aria-label="图片分割"
              title="图片分割"
            >
              <IconLayoutGrid size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            图片分割
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onSmartSplitClick();
              }}
              aria-label="智能切图"
              title="智能切图"
            >
              <IconScissors size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            智能切图
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onOutpaintClick();
              }}
              aria-label="扩图"
              title="扩图"
            >
              <IconMaximize size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            扩图
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onAnnotateClick();
              }}
              aria-label="画笔标注"
              title="画笔标注"
            >
              <IconPencil size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            画笔标注
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                void runTransformOp('mirrorY');
              }}
              aria-label="垂直镜像"
              title="垂直镜像"
            >
              <IconFlipVertical size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            垂直镜像
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                void runTransformOp('rotate90');
              }}
              aria-label="旋转 90°"
              title="旋转 90°"
            >
              <IconRotateClockwise size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            旋转 90°
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onEdgeDetectClick();
              }}
              aria-label="边缘检测"
              title="边缘检测"
            >
              <IconBorderOuter size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            边缘检测
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onChromaKeyClick();
              }}
              aria-label="色度抠图"
              title="色度抠图"
            >
              <IconColorFilter size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            色度抠图
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onDifferenceKeyClick();
              }}
              aria-label="差异抠图"
              title="差异抠图"
            >
              <IconContrast size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            差异抠图
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              disabled={processing}
              onClick={(e) => {
                e.stopPropagation();
                onResizeClick();
              }}
              aria-label="调整尺寸"
              title="调整尺寸"
            >
              <IconResize size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            调整图片尺寸
          </TooltipContent>
        </Tooltip>
      </div>
    </NodeToolbar>
  );
});

export default ImageNodeToolbar;
