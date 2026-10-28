import { toast } from 'sonner';
import type { MediaAsset } from '@iart/contracts';
import type { ResizeKernel } from '@iart/contracts/media-processing-contract';

import { useCanvasStore } from '../../store/canvasStore';
import { useExecutionStore } from '../../store/executionStore';
import { transformImage } from '@/client/api/imageTransform';
import { getImageOperation, type ImageOperationId } from '../../image-ops/registry';
import { ensureBackendConsumableImageSource } from '../../utils/mediaUtils';
import {
  createDerivedAssetNode,
  createDerivedAssetNodesInGrid,
} from '../../utils/assetDerivation';
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
import {
  formatOutpaintPreflightSummary,
  validateImageOutpaintPreflight,
} from '../../services/imageOutpaintPreflight';
import { importLocalFile } from '../../services/localMediaImport';
import { getCurrentProjectPath } from '../../storage/backend';
import type { AssetNodeData } from '../../types/node';
import type { ChromeSubject } from './mediaNodeModel';
import type { ImageCropRect } from '../dialogs/ImageCropDialog';
import type { ImageSplitDialogPayload } from '../dialogs/ImageSplitDialog';
import type { ImageSmartSplitDialogPayload } from '../dialogs/ImageSmartSplitDialog';
import type { SpriteSheetDialogPayload } from '../dialogs/VideoSpriteSheetDialog';
import type { VideoTrimDialogPayload } from '../dialogs/VideoTrimDialog';
import type { ImageOutpaintDialogConfirmPayload } from '../dialogs/imageOutpaintDialogTypes';

/**
 * 媒体工具执行器（确定性媒体加工的唯一执行链路）。
 *
 * 资产节点与导入素材节点共用同一套工具与同一组后端 API（设计层 D27；spec
 * docs/editor/媒体工具加工.md「禁止同一工具不同入口行为分叉」）。两条旧入口
 * （资产节点入口 / 素材节点入口）合并到这里，数据统一从 `ctx.subject`（媒体主体投影）
 * 取：`node.id`、`assetId`、`mediaAsset`、`sourceUrl`、`mediaType`。
 *
 * 产出一律是**独立资产节点** + derivedFrom 血缘（D19；spec「加工产出独立资产节点、
 * 源节点不变」），源资产不变（非破坏）。分割类工具产出全部图块，每块一个资产节点。
 * 执行前做前置校验：源不可用不发起后端请求（spec「执行前做前置校验」）；失败就地
 * toast 反馈，源资产不受影响。
 */

export type ToolCtx = {
  /** 选中态媒体主体投影（资产节点与导入素材节点同一形态） */
  subject: ChromeSubject;
  /** 派生节点选中（经 useCanvasSelectionBridge 注入；缺省不改变选择） */
  selectNodes?: ((nodeIds: string[], reason: string) => void) | undefined;
};

type SourceContext = {
  /** 加工源地址（backend 可解析） */
  sourceUrl: string;
  /** 源资产身份 id（血缘来源） */
  sourceAssetId: string;
};

const selectNewNode = (ctx: ToolCtx, nodeId: string | undefined): void => {
  if (!nodeId || !ctx.selectNodes) return;
  ctx.selectNodes([nodeId], 'asset-derivation');
};

/** 失败后卡片上给出的下一步建议（用户可读，不写内部术语） */
const PROCESSING_RETRY_HINT = '可以检查参数后再试一次；原文件不会被改动。';
const PROCESSING_BLOCKED_HINT = '按提示调整后可以再试一次。';

/**
 * 开始执行：清掉该节点上一次的加工问题标注（失败 / 校验）。
 * 重试立刻让旧标记消失，避免「上一次失败」与本次执行结果混在一起。
 */
const beginProcessing = (ctx: ToolCtx): void => {
  useExecutionStore.getState().clearNodeProcessingIssue(ctx.subject.node.id);
};

/** 执行成功：清掉加工问题标注（问题标记只在失败 / 待处理期间常驻） */
const completeProcessing = (ctx: ToolCtx): void => {
  useExecutionStore.getState().clearNodeProcessingIssue(ctx.subject.node.id);
};

/** 前置条件未满足（源不可用 / 参数不合法）：卡片标「先处理」 */
const reportBlocked = (ctx: ToolCtx, message: string): void => {
  useExecutionStore.getState().setProcessingIssue(ctx.subject.node.id, {
    kind: 'processing-blocked',
    message,
    hint: PROCESSING_BLOCKED_HINT,
  });
};

/** 执行失败：卡片标「失败」并保留可展开原因 */
const reportFailed = (ctx: ToolCtx, label: string, error: unknown): void => {
  useExecutionStore.getState().setProcessingIssue(ctx.subject.node.id, {
    kind: 'processing-failed',
    message: `${label}没有完成`,
    detail: extractFailureDetail(error),
    hint: PROCESSING_RETRY_HINT,
  });
};

const extractFailureDetail = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : undefined;
  }
  if (typeof error === 'string') {
    const message = error.trim();
    return message.length > 0 ? message : undefined;
  }
  return undefined;
};

/**
 * 加工源前置校验（spec「执行前做前置校验」）：
 * 源地址为空（资产被移除/未取回本地）时不发起后端请求；视频给出可理解的恢复提示。
 */
const requireSource = (ctx: ToolCtx, actionLabel: string): SourceContext | null => {
  const sourceUrl = ctx.subject.sourceUrl.trim();
  if (!sourceUrl) {
    const message =
      ctx.subject.mediaType === 'video'
        ? `视频已被移除或还没取回本地，请重新选择后再${actionLabel}`
        : '这张图片已经不能用了，请重新选择';
    toast.error(message);
    reportBlocked(ctx, message);
    return null;
  }
  const sourceAssetId = ctx.subject.assetId ?? '';
  if (!sourceAssetId) {
    const message = '这个素材的原文件找不到了，暂时没法加工';
    toast.error(message);
    reportBlocked(ctx, message);
    return null;
  }
  return { sourceUrl, sourceAssetId };
};

/** 单图派生通用出口：加工产出资产 → 独立资产节点（携带血缘）。 */
const deriveSingle = (
  ctx: ToolCtx,
  sourceAssetId: string,
  result: {
    assetId: string;
    mediaAsset: MediaAsset | null;
    tool: string;
    label: string;
    mediaType: 'image' | 'video';
  },
): void => {
  const created = createDerivedAssetNode({
    sourceNodeId: ctx.subject.node.id,
    assetId: result.assetId,
    mediaAsset: result.mediaAsset,
    mediaType: result.mediaType,
    derivedFrom: { sourceAssetId, tool: result.tool },
    label: result.label,
  });
  if (!created) {
    toast.error('没能生成新的素材，请重试');
    reportFailed(ctx, result.label, new Error('产出节点没有落到画布上'));
    return;
  }
  completeProcessing(ctx);
  selectNewNode(ctx, created.id);
};

const fail = (ctx: ToolCtx, label: string, error: unknown): void => {
  console.error(`[canvas] ${label}失败`, error);
  reportFailed(ctx, label, error);
  toast.error(`${label}失败，请重试。`);
};

/** 直接变换（水平/垂直镜像、旋转 90°）：transformImage → 派生资产节点。 */
export const runDirectTransform = async (
  ctx: ToolCtx,
  opId: ImageOperationId,
): Promise<void> => {
  beginProcessing(ctx);
  const op = getImageOperation(opId);
  const source = requireSource(ctx, op.label);
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const result = await transformImage(consumable, op.ops);
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: opId,
      label: op.label,
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, op.label, error);
  }
};

export const runCrop = async (ctx: ToolCtx, rect: ImageCropRect): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '裁剪图片');
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const result = await cropImage(consumable, rect);
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'crop',
      label: '裁剪图片',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '裁剪图片', error);
  }
};

export const runResize = async (
  ctx: ToolCtx,
  percent: number,
  kernel: ResizeKernel,
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '调整尺寸');
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const result = await resizeImage(consumable, percent, kernel);
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'resize',
      label: '调整尺寸',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '调整尺寸', error);
  }
};

/**
 * 图片分割：产出**全部图块**，每块一个独立资产节点。
 *
 * 落点按每块的原始切分几何（源图像素 x/y/width/height）换算，保持原图的 2×2 / 行列
 * 结构，不再用固定估算尺寸把整批排成长列。
 */
export const runSplit = async (
  ctx: ToolCtx,
  payload: ImageSplitDialogPayload,
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '分割图片');
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const result = await splitImage(consumable, {
      horizontalPercents: payload.horizontalPercents,
      verticalPercents: payload.verticalPercents,
    });
    if (result.tiles.length === 0) throw new Error('分割无产出');
    const created = createDerivedAssetNodesInGrid({
      sourceNodeId: ctx.subject.node.id,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: source.sourceAssetId, tool: 'split' },
      sourceSize: {
        width: result.originalWidth,
        height: result.originalHeight,
      },
      items: result.tiles.map((tile) => ({
        assetId: tile.assetId,
        mediaAsset: tile.mediaAsset ?? null,
        sourceRect: { x: tile.x, y: tile.y, width: tile.width, height: tile.height },
        row: tile.row,
        col: tile.col,
        label: `图片分割 ${tile.row + 1}-${tile.col + 1}`,
      })),
      selectNodes: ctx.selectNodes,
    });
    if (!created) {
      toast.error('没能生成新的素材，请重试');
      reportFailed(ctx, '图片分割', new Error('图块没有落到画布上'));
      return;
    }
    completeProcessing(ctx);
  } catch (error) {
    fail(ctx, '图片分割', error);
  }
};

/**
 * 智能切图：产出**全部元素图块**，每块一个独立资产节点。
 *
 * 落点按每块在原图中的真实坐标（tile.x/tile.y）换算，元素在原图中的左右 / 上下关系
 * 保持不变（不再按切图顺序单列纵向顺延）。
 */
export const runSmartSplit = async (
  ctx: ToolCtx,
  payload: ImageSmartSplitDialogPayload,
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '智能切图');
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const result = await smartSplitImage(consumable, {
      alphaThreshold: payload.alphaThreshold,
      minArea: payload.minArea,
      dilateIterations: payload.dilateIterations,
      padding: payload.padding,
    });
    if (result.tiles.length === 0) throw new Error('智能切图无产出');
    const created = createDerivedAssetNodesInGrid({
      sourceNodeId: ctx.subject.node.id,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: source.sourceAssetId, tool: 'smartSplit' },
      sourceSize: {
        width: result.originalWidth,
        height: result.originalHeight,
      },
      items: result.tiles.map((tile, index) => ({
        assetId: tile.assetId,
        mediaAsset: tile.mediaAsset ?? null,
        sourceRect: { x: tile.x, y: tile.y, width: tile.width, height: tile.height },
        label: `智能切图 ${index + 1}`,
      })),
      selectNodes: ctx.selectNodes,
    });
    if (!created) {
      toast.error('没能生成新的素材，请重试');
      reportFailed(ctx, '智能切图', new Error('元素图块没有落到画布上'));
      return;
    }
    completeProcessing(ctx);
  } catch (error) {
    fail(ctx, '智能切图', error);
  }
};

export const runEdgeDetect = async (
  ctx: ToolCtx,
  threshold: number,
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '边缘检测');
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const result = await edgeDetectImage(consumable, threshold, 'sobel');
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'edgeDetect',
      label: '边缘检测',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '边缘检测', error);
  }
};

export const runChromaKey = async (
  ctx: ToolCtx,
  params: { targetColor: { r: number; g: number; b: number }; tolerance: number; feather: number },
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '色度抠图');
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const result = await chromaKeyImage(
      consumable,
      params.targetColor,
      params.tolerance,
      params.feather,
    );
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'chromaKey',
      label: '色度抠图',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '色度抠图', error);
  }
};

export const runDiffKey = async (
  ctx: ToolCtx,
  params: { threshold: number; softness: number; secondSourceUrl: string },
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '差异抠图');
  if (!source) return;
  try {
    const consumable = await ensureBackendConsumableImageSource(source.sourceUrl);
    const secondConsumable = await ensureBackendConsumableImageSource(params.secondSourceUrl);
    const result = await differenceKeyImage(
      consumable,
      secondConsumable,
      params.threshold,
      params.softness,
    );
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'diffKey',
      label: '差异抠图',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '差异抠图', error);
  }
};

/** 画笔标注：canvas 导出 Blob → importLocalFile → 派生资产节点。 */
export const runAnnotate = async (ctx: ToolCtx, blob: Blob): Promise<void> => {
  beginProcessing(ctx);
  const sourceAssetId = ctx.subject.assetId ?? '';
  if (!sourceAssetId) {
    const message = '这个素材的原文件找不到了，暂时没法加工';
    toast.error(message);
    reportBlocked(ctx, message);
    return;
  }
  try {
    const file = new File([blob], 'annotated.png', { type: blob.type || 'image/png' });
    const imported = await importLocalFile(file);
    deriveSingle(ctx, sourceAssetId, {
      assetId: imported.assetId,
      mediaAsset: imported.asset ?? null,
      tool: 'annotate',
      label: '画笔标注',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '画笔标注', error);
  }
};

/**
 * 扩图（异步 AI 加工，资产上的动作）：先做统一前置校验（源图为空 / 模型不可用 /
 * prompt 超限 → toast 摘要并中止，不创建占位节点），再产出持有同一源图的占位资产节点
 * （derivedFrom outpaint），提交扩图任务并把 taskId 写入其 outpaintTaskId；成功终态经
 * taskProjectionService 回填结果资产（非破坏：源资产节点不变）。
 */
export const runOutpaint = async (
  ctx: ToolCtx,
  payload: ImageOutpaintDialogConfirmPayload,
): Promise<void> => {
  beginProcessing(ctx);
  const issues = await validateImageOutpaintPreflight(ctx.subject.node.id, payload);
  // 节点级诊断写回 executionStore：导入素材节点仍按原口径在卡片上标出问题字段。
  useExecutionStore.getState().setPreflightIssues(issues);
  if (issues.length > 0) {
    const summary = formatOutpaintPreflightSummary(issues);
    toast.error(summary);
    reportBlocked(ctx, summary);
    return;
  }

  const mediaAsset = ctx.subject.mediaAsset;
  const sourceAssetId = ctx.subject.assetId ?? '';
  if (!mediaAsset || !sourceAssetId) {
    const message = '这张图片已经不能用了，请重新选择';
    toast.error(message);
    reportBlocked(ctx, message);
    return;
  }

  const placeholder = createDerivedAssetNode({
    sourceNodeId: ctx.subject.node.id,
    assetId: sourceAssetId,
    mediaAsset,
    mediaType: 'image',
    derivedFrom: { sourceAssetId, tool: 'outpaint' },
    label: payload.modelId.trim(),
  });
  if (!placeholder) {
    toast.error('没能创建扩图结果，请重试');
    reportFailed(ctx, '扩图', new Error('扩图结果没有落到画布上'));
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
      completeProcessing(ctx);
      toast.success('扩图完成');
      return;
    }
    completeProcessing(ctx);
    selectNewNode(ctx, placeholder.id);
    toast.info('已开始扩图，结果会出现在新节点上');
  } catch (error) {
    fail(ctx, '扩图', error);
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
  beginProcessing(ctx);
  const source = requireSource(ctx, '裁切');
  if (!source) return;
  try {
    const projectPath = await requireProjectPath();
    const result = await trimVideo({
      projectPath,
      sourceUrl: source.sourceUrl,
      startTime: payload.startTime,
      endTime: payload.endTime,
      format: 'mp4',
      withAudio: payload.withAudio,
    });
    if (!result.assetId) throw new Error('视频裁切未产出资产');
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'trim',
      label: '裁切视频',
      mediaType: 'video',
    });
  } catch (error) {
    fail(ctx, '裁切视频', error);
  }
};

export const runFrameCapture = async (
  ctx: ToolCtx,
  timeSec: number,
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '截帧');
  if (!source) return;
  try {
    const projectPath = await requireProjectPath();
    const result = await captureVideoFrame({
      projectPath,
      sourceUrl: source.sourceUrl,
      timeSec,
    });
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset ?? null,
      tool: 'frameCapture',
      label: '截取帧',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '截取帧', error);
  }
};

export const runSpriteSheet = async (
  ctx: ToolCtx,
  payload: SpriteSheetDialogPayload,
): Promise<void> => {
  beginProcessing(ctx);
  const source = requireSource(ctx, '生成序列帧图集');
  if (!source) return;
  try {
    const result = await processVideoSpriteSheet(source.sourceUrl, {
      startTime: payload.startTime,
      endTime: payload.endTime,
      fpsMultiplier: payload.fpsMultiplier,
    });
    deriveSingle(ctx, source.sourceAssetId, {
      assetId: result.assetId,
      mediaAsset: result.mediaAsset,
      tool: 'spriteSheet',
      label: '序列帧图集',
      mediaType: 'image',
    });
  } catch (error) {
    fail(ctx, '序列帧图集', error);
  }
};
