import { toast } from 'sonner';
import type { MediaAsset } from '@iart/contracts';

import { useCanvasStore } from '../../store/canvasStore';
import { transformImage } from '@/client/api/imageTransform';
import { getImageOperation, type ImageOperationId } from '../../image-ops/registry';
import { ensureBackendConsumableImageSource } from '../../utils/mediaUtils';
import { createDerivedAssetNode } from '../../utils/assetDerivation';
import { cropImage } from '@/client/api/imageCrop';
import { resizeImage } from '@/client/api/imageResize';
import { splitImage } from '@/client/api/imageSplit';
import { smartSplitImage } from '@/client/api/imageSmartSplit';
import { edgeDetectImage } from '@/client/api/imageEdgeDetect';
import { chromaKeyImage } from '@/client/api/imageChromaKey';
import { differenceKeyImage } from '@/client/api/imageDifferenceKey';
import { trimVideo } from '@/client/api/videoTrim';
import { captureVideoFrame } from '@/client/api/videoFrameCapture';
import { processVideoSpriteSheet } from '@/client/api/videoSpriteSheet';
import { outpaintImageWithModel } from '../../services/imageOutpaint';
import { importLocalFile } from '../../services/localMediaImport';
import { getCurrentProjectPath } from '../../storage/backend';
import type { GraphNode, AssetNodeData } from '../../types/node';
import type { ResizeKernel } from '@iart/contracts/media-processing-contract';
import type { ImageCropRect } from '../dialogs/ImageCropDialog';
import type { ImageSplitDialogPayload } from '../dialogs/ImageSplitDialog';
import type { ImageSmartSplitDialogPayload } from '../dialogs/ImageSmartSplitDialog';
import type { SpriteSheetDialogPayload } from '../dialogs/VideoSpriteSheetDialog';
import type { VideoTrimDialogPayload } from '../dialogs/VideoTrimDialog';
import type { ImageOutpaintDialogConfirmPayload } from '../dialogs/imageOutpaintDialogTypes';

/**
 * 资产节点加工工具执行器（确定性媒体工具链路的资产节点入口）。
 *
 * 复用与素材节点入口同一批后端 API 与弹窗（spec 媒体工具加工.md「禁止同一工具在不同入口
 * 表面的行为分叉」）；差异只在产出去处：本入口产出**独立资产节点** + derivedFrom 血缘
 *（设计层 D19；spec「加工产出为独立资产节点」），源资产不变（非破坏）。
 * 失败就地 toast 反馈，源资产不受影响。
 */

export type ToolCtx = {
  node: GraphNode;
  data: AssetNodeData;
  /** 加工源地址（backend 可解析；由调用方经 ensureBackendConsumableImageSource 归一） */
  sourceUrl: string;
  /** 源资产（扩图占位需要） */
  asset: MediaAsset | undefined;
  /** 派生节点选中（经 useCanvasSelectionBridge 注入；缺省不改变选择） */
  selectNodes?: ((nodeIds: string[], reason: string) => void) | undefined;
};

const selectNewNode = (ctx: ToolCtx, nodeId: string | undefined): void => {
  if (!nodeId || !ctx.selectNodes) return;
  ctx.selectNodes([nodeId], 'asset-derivation');
};

/** 单图派生通用出口：加工产出资产 → 独立资产节点（携带血缘）。 */
const deriveSingle = (
  ctx: ToolCtx,
  result: {
    assetId: string;
    mediaAsset: MediaAsset | null;
    tool: string;
    label: string;
    mediaType: 'image' | 'video';
  },
): void => {
  const created = createDerivedAssetNode({
    sourceNodeId: ctx.node.id,
    assetId: result.assetId,
    mediaAsset: result.mediaAsset,
    mediaType: result.mediaType,
    derivedFrom: { sourceAssetId: ctx.data.assetId, tool: result.tool },
    label: result.label,
  });
  if (!created) {
    toast.error('没能生成新的素材节点，请重试');
    return;
  }
  selectNewNode(ctx, created.id);
};

const fail = (label: string, error: unknown): void => {
  console.error(`[canvas] ${label}失败`, error);
  toast.error(`${label}失败，请重试。`);
};

/** 直接变换（水平/垂直镜像、旋转 90°）：transformImage → 派生资产节点。 */
export const runDirectTransform = async (
  ctx: ToolCtx,
  opId: ImageOperationId,
): Promise<void> => {
  try {
    const op = getImageOperation(opId);
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const result = await transformImage(consumable, op.ops);
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: opId,
      label: op.label,
      mediaType: 'image',
    });
  } catch (error) {
    fail('加工', error);
  }
};

export const runCrop = async (ctx: ToolCtx, rect: ImageCropRect): Promise<void> => {
  try {
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const result = await cropImage(consumable, rect);
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'crop',
      label: '裁剪图片',
      mediaType: 'image',
    });
  } catch (error) {
    fail('裁剪图片', error);
  }
};

export const runResize = async (
  ctx: ToolCtx,
  percent: number,
  kernel: ResizeKernel,
): Promise<void> => {
  try {
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const result = await resizeImage(consumable, percent, kernel);
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'resize',
      label: '调整尺寸',
      mediaType: 'image',
    });
  } catch (error) {
    fail('调整尺寸', error);
  }
};

/** 图片分割：产出多块 → 取首块派生资产节点（与素材节点入口同参数链路）。 */
export const runSplit = async (
  ctx: ToolCtx,
  payload: ImageSplitDialogPayload,
): Promise<void> => {
  try {
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const result = await splitImage(consumable, {
      horizontalPercents: payload.horizontalPercents,
      verticalPercents: payload.verticalPercents,
    });
    const first = result.tiles[0];
    if (!first) throw new Error('分割无产出');
    deriveSingle(ctx, {
      assetId: first.assetId,
      mediaAsset: first.mediaAsset ?? null,
      tool: 'split',
      label: `图片分割 ${result.rows}×${result.cols}`,
      mediaType: 'image',
    });
  } catch (error) {
    fail('图片分割', error);
  }
};

export const runSmartSplit = async (
  ctx: ToolCtx,
  payload: ImageSmartSplitDialogPayload,
): Promise<void> => {
  try {
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const result = await smartSplitImage(consumable, {
      alphaThreshold: payload.alphaThreshold,
      minArea: payload.minArea,
      dilateIterations: payload.dilateIterations,
      padding: payload.padding,
    });
    const first = result.tiles[0];
    if (!first) throw new Error('智能切图无产出');
    deriveSingle(ctx, {
      assetId: first.assetId,
      mediaAsset: first.mediaAsset ?? null,
      tool: 'smartSplit',
      label: `智能切图 ${result.tileCount} 块`,
      mediaType: 'image',
    });
  } catch (error) {
    fail('智能切图', error);
  }
};

export const runEdgeDetect = async (
  ctx: ToolCtx,
  threshold: number,
): Promise<void> => {
  try {
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const result = await edgeDetectImage(consumable, threshold, 'sobel');
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'edgeDetect',
      label: '边缘检测',
      mediaType: 'image',
    });
  } catch (error) {
    fail('边缘检测', error);
  }
};

export const runChromaKey = async (
  ctx: ToolCtx,
  params: { targetColor: { r: number; g: number; b: number }; tolerance: number; feather: number },
): Promise<void> => {
  try {
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const result = await chromaKeyImage(
      consumable,
      params.targetColor,
      params.tolerance,
      params.feather,
    );
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'chromaKey',
      label: '色度抠图',
      mediaType: 'image',
    });
  } catch (error) {
    fail('色度抠图', error);
  }
};

export const runDiffKey = async (
  ctx: ToolCtx,
  params: { threshold: number; softness: number; secondSourceUrl: string },
): Promise<void> => {
  try {
    const consumable = await ensureBackendConsumableImageSource(ctx.sourceUrl);
    const secondConsumable = await ensureBackendConsumableImageSource(params.secondSourceUrl);
    const result = await differenceKeyImage(
      consumable,
      secondConsumable,
      params.threshold,
      params.softness,
    );
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'diffKey',
      label: '差异抠图',
      mediaType: 'image',
    });
  } catch (error) {
    fail('差异抠图', error);
  }
};

/** 画笔标注：canvas 导出 Blob → importLocalFile → 派生资产节点。 */
export const runAnnotate = async (ctx: ToolCtx, blob: Blob): Promise<void> => {
  try {
    const file = new File([blob], 'annotated.png', { type: blob.type || 'image/png' });
    const imported = await importLocalFile(file);
    deriveSingle(ctx, {
      assetId: imported.assetId,
      mediaAsset: imported.asset ?? null,
      tool: 'annotate',
      label: '画笔标注',
      mediaType: 'image',
    });
  } catch (error) {
    fail('画笔标注', error);
  }
};

/**
 * 扩图（异步 AI 加工，资产上的动作）：先产出持有同一源图的占位资产节点（derivedFrom
 * outpaint），提交扩图任务并把 taskId 写入其 sourceTaskId/outpaintTaskId；成功终态经
 * taskProjectionService 回填结果资产（非破坏：源资产节点不变）。
 */
export const runOutpaint = async (
  ctx: ToolCtx,
  payload: ImageOutpaintDialogConfirmPayload,
): Promise<void> => {
  if (!ctx.asset) {
    toast.error('这张图片已经不能用了，请重新选择');
    return;
  }
  const placeholder = createDerivedAssetNode({
    sourceNodeId: ctx.node.id,
    assetId: ctx.asset.id,
    mediaAsset: ctx.asset,
    mediaType: 'image',
    derivedFrom: { sourceAssetId: ctx.data.assetId, tool: 'outpaint' },
    label: payload.modelId,
  });
  if (!placeholder) {
    toast.error('没能创建扩图结果，请重试');
    return;
  }
  try {
    const result = await outpaintImageWithModel({
      modelId: payload.modelId,
      sourceImage: payload.sourceImage,
      aspectRatio: payload.aspectRatio,
      imageSize: payload.imageSize,
      userPrompt: payload.userPrompt,
      taskBinding: undefined,
      onTaskAccepted: (taskId) => {
        // 只锚 outpaintTaskId（不写 sourceTaskId：该资产非任务生成，「复用」不渲染）。
        useCanvasStore.getState().updateNodeData(
          placeholder.id,
          { outpaintTaskId: taskId } satisfies Partial<AssetNodeData>,
          'asset-outpaint',
        );
      },
    });
    if (result.kind === 'completed') {
      // 直返形态无 backend task（少见）：结果 URL 已由 backend 落盘为资产，占位节点即承载。
      toast.success('扩图完成');
      return;
    }
    selectNewNode(ctx, placeholder.id);
    toast.info('已开始扩图，结果会出现在新节点上');
  } catch (error) {
    fail('扩图', error);
    useCanvasStore.getState().removeNode(placeholder.id, { deleteGroupMembers: false });
  }
};

const requireProjectPath = async (): Promise<string> => {
  const projectPath = await getCurrentProjectPath().catch(() => null);
  if (!projectPath) throw new Error('缺少项目路径（仅桌面模式支持视频加工）');
  return projectPath;
};

export const runTrim = async (
  ctx: ToolCtx,
  payload: VideoTrimDialogPayload,
): Promise<void> => {
  try {
    const projectPath = await requireProjectPath();
    const result = await trimVideo({
      projectPath,
      sourceUrl: ctx.sourceUrl,
      startTime: payload.startTime,
      endTime: payload.endTime,
      format: undefined,
      withAudio: payload.withAudio,
    });
    if (!result.assetId) throw new Error('视频裁切未产出资产');
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'trim',
      label: '裁切视频',
      mediaType: 'video',
    });
  } catch (error) {
    fail('裁切视频', error);
  }
};

export const runFrameCapture = async (
  ctx: ToolCtx,
  timeSec: number,
): Promise<void> => {
  try {
    const projectPath = await requireProjectPath();
    const result = await captureVideoFrame({
      projectPath,
      sourceUrl: ctx.sourceUrl,
      timeSec,
    });
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset ?? null,
      tool: 'frameCapture',
      label: '截取帧',
      mediaType: 'image',
    });
  } catch (error) {
    fail('截取帧', error);
  }
};

export const runSpriteSheet = async (
  ctx: ToolCtx,
  payload: SpriteSheetDialogPayload,
): Promise<void> => {
  try {
    const result = await processVideoSpriteSheet(ctx.sourceUrl, {
      startTime: payload.startTime,
      endTime: payload.endTime,
      fpsMultiplier: payload.fpsMultiplier,
    });
    deriveSingle(ctx, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'spriteSheet',
      label: '序列帧图集',
      mediaType: 'image',
    });
  } catch (error) {
    fail('序列帧图集', error);
  }
};
