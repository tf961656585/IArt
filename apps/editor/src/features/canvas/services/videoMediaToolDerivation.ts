import { captureVideoFrame } from '@/client/api/videoFrameCapture';
import { trimVideo } from '@/client/api/videoTrim';
import { getCurrentProjectPath } from '../storage/backend';
import { createDerivedImageInputNode } from '../utils/imageDerivation';
import { createDerivedVideoInputNode } from '../utils/videoDerivation';
import type { GraphNode } from '../types';

type SelectNodesFn = (nodeIds: string[], reason: string) => void;

export type VideoToolSourceRef = {
  /** 源节点 id（素材节点或持有结果区的模型节点） */
  sourceNodeId: string;
  /** 源资产 id（结果区 slot 场景为 slot 资产；素材节点场景为节点资产，可能缺失） */
  sourceAssetId: string | undefined;
  /** 源 slot 标识（结果区场景传入；素材节点场景为 undefined） */
  sourceSlotId: string | undefined;
};

const requireProjectPath = async (): Promise<string> => {
  const projectPath = await getCurrentProjectPath().catch(() => null);
  if (!projectPath) {
    throw new Error('缺少项目路径（仅桌面模式支持视频加工）');
  }
  return projectPath;
};

/**
 * 视频裁切 → 新 videoInput 素材节点（共享执行链路：三处入口同一语义）。
 * 失败抛错，由调用方在发起表面就地反馈；源资产与源节点不受影响。
 */
export const runVideoTrimDerivation = async (params: VideoToolSourceRef & {
  /** 可被 Backend 解析的视频正式地址 */
  sourceUrl: string;
  startTime: number;
  endTime: number;
  withAudio: boolean;
  selectNodes: SelectNodesFn;
}): Promise<GraphNode> => {
  // 前置校验项②（引用资产不可用）在共享服务层兜底：源资产已移除/未落盘时
  // 不发起远端加工请求，各入口（结果区弹窗/素材节点工具栏/放大预览）同一口径。
  const sourceUrl = params.sourceUrl.trim();
  if (!sourceUrl) {
    throw new Error('视频已被移除或还没取回本地，请重新选择后再裁切');
  }
  const projectPath = await requireProjectPath();
  const result = await trimVideo({
    projectPath,
    sourceUrl,
    startTime: params.startTime,
    endTime: params.endTime,
    format: 'mp4',
    withAudio: params.withAudio,
  });
  if (!result.assetId) {
    throw new Error('视频裁切失败：缺少结果资产');
  }
  // 节点内容优先持有资产正式地址（local-media://），/files/ 形式仅为后端兼容回执
  const assetUrl = result.mediaAsset !== null && result.mediaAsset !== undefined
    ? result.mediaAsset.original.url
    : '';
  const created = createDerivedVideoInputNode({
    sourceNodeId: params.sourceNodeId,
    resultUrl: assetUrl || result.url,
    assetId: result.assetId,
    mediaAsset: result.mediaAsset,
    derivedOp: {
      type: 'videoTrim',
      startTime: params.startTime,
      endTime: params.endTime,
      withAudio: params.withAudio,
      sourceAssetId: params.sourceAssetId,
      sourceSlotId: params.sourceSlotId,
    },
    videoMeta: null,
    selectNodes: params.selectNodes,
  });
  if (!created) {
    throw new Error('创建衍生节点失败');
  }
  return created;
};

/**
 * 视频截帧 → 新 imageInput 素材节点（共享执行链路：三处入口同一语义）。
 * 失败抛错，由调用方在发起表面就地反馈；源资产与源节点不受影响。
 */
export const runVideoFrameCaptureDerivation = async (params: VideoToolSourceRef & {
  /** 可被 Backend 解析的视频正式地址 */
  sourceUrl: string;
  timeSec: number;
  selectNodes: SelectNodesFn;
}): Promise<GraphNode> => {
  // 前置校验项②（引用资产不可用）在共享服务层兜底：源资产已移除/未落盘时
  // 不发起远端加工请求，各入口（结果区弹窗/素材节点工具栏/放大预览）同一口径。
  const sourceUrl = params.sourceUrl.trim();
  if (!sourceUrl) {
    throw new Error('视频已被移除或还没取回本地，请重新选择后再截帧');
  }
  const projectPath = await requireProjectPath();
  const result = await captureVideoFrame({
    projectPath,
    sourceUrl,
    timeSec: params.timeSec,
  });
  const created = createDerivedImageInputNode({
    sourceNodeId: params.sourceNodeId,
    resultUrl: result.url,
    assetId: result.assetId,
    mediaAsset: result.mediaAsset,
    derivedOp: {
      type: 'videoFrameCapture',
      timeSec: params.timeSec,
      sourceAssetId: params.sourceAssetId,
      sourceSlotId: params.sourceSlotId,
    },
    selectNodes: params.selectNodes,
  });
  if (!created) {
    throw new Error('创建衍生节点失败');
  }
  return created;
};
