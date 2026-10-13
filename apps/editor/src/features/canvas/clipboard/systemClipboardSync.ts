import type { MediaAsset, ProjectMediaAssets } from '@iart/contracts';
import type { GraphNode, ModelNodeData } from '../types/node';
import type {
  ResultAreaFormalSlot,
  ImageInputNodeData,
} from '../types/nodeDataTypes';
import {
  writeImageFromUrlToClipboard,
  writeTextToClipboard,
  type ClipboardWriteImageResponse,
  type ClipboardWriteTextResponse,
} from '@/client/utils/electronBridge';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';

/**
 * 系统通道同步的结果判别：
 * - text: 将写入文本（已解析出最终字符串）
 * - image: 将写入图像（已解析出 local-media:// URL）
 * - skip: 跳过系统通道（多选、不支持节点、视频/音频、无内容）
 *
 * skip 不触发 toast（静默），详见 spec 决策记录。
 */
export type SystemClipboardSyncOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }
  | { kind: 'skip'; reason: SkipReason };

export type SkipReason =
  | 'multiple-selection'
  | 'unsupported-node-type'
  | 'media-not-image'
  | 'empty-content'
  | 'no-content';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * 遍历 model 节点的 resultArea.slots，找第一个有内容的 slot：
 * - text slot：写文本
 * - media slot：按 MediaAsset.mediaType 判别 image/video/audio
 *   - image → 写图像
 *   - video/audio → 直接 skip（决策 A + spec：不跨过 video 找后续 slot）
 * - slot 无内容（itemType undefined 或字段空）→ 继续看下一个
 */
const resolveModelOutcome = (
  data: ModelNodeData,
  mediaAssets: ProjectMediaAssets,
): SystemClipboardSyncOutcome => {
  const slots = data.resultArea.slots;
  for (const slot of slots) {
    const outcome = resolveSingleSlotOutcome(slot, mediaAssets);
    if (outcome === null) continue; // 此 slot 无内容，看下一个
    return outcome;
  }
  return { kind: 'skip', reason: 'no-content' };
};

const resolveSingleSlotOutcome = (
  slot: ResultAreaFormalSlot,
  mediaAssets: ProjectMediaAssets,
): SystemClipboardSyncOutcome | null => {
  if (slot.itemType === 'text') {
    if (isNonEmptyString(slot.textValue)) {
      return { kind: 'text', text: slot.textValue };
    }
    return null;
  }
  if (slot.itemType === 'media') {
    const assetId = slot.assetId;
    if (!isNonEmptyString(assetId)) return null;
    const asset: MediaAsset | undefined = mediaAssets[assetId];
    if (!asset) return null;
    if (asset.mediaType === 'image') {
      const url = asset.original.url;
      if (!isNonEmptyString(url)) return null;
      return { kind: 'image', url };
    }
    // video / audio：直接 skip，不跨过找后续 slot
    return { kind: 'skip', reason: 'media-not-image' };
  }
  // itemType undefined（allocated 未落定）：此 slot 无内容
  return null;
};

/**
 * 按节点类型分发到系统剪贴板写入方式。
 *
 * 纯函数：不调 bridge，不读 store。所有依赖通过参数传入。
 * 调用方负责传入准确的 mediaAssets（通常来自 canvasStore）。
 */
export const resolveSystemClipboardPayload = (
  node: GraphNode,
  ctx: { mediaAssets: ProjectMediaAssets },
): SystemClipboardSyncOutcome => {
  switch (node.type) {
    case 'imageInput': {
      const data = node.data as ImageInputNodeData;
      const assetId = data.assetId;
      if (!isNonEmptyString(assetId)) return { kind: 'skip', reason: 'no-content' };
      const asset = ctx.mediaAssets[assetId];
      if (!asset) return { kind: 'skip', reason: 'no-content' };
      const url = asset.original.url;
      if (!isNonEmptyString(url)) return { kind: 'skip', reason: 'no-content' };
      return { kind: 'image', url };
    }
    case 'model': {
      return resolveModelOutcome(node.data as ModelNodeData, ctx.mediaAssets);
    }
    case 'videoInput':
    case 'audioInput':
      // 决策 A：MVP 不做视频/音频
      return { kind: 'skip', reason: 'media-not-image' };
    case 'group':
      return { kind: 'skip', reason: 'unsupported-node-type' };
    default:
      return { kind: 'skip', reason: 'unsupported-node-type' };
  }
};

/**
 * sync 操作的统一返回值（成功/失败/skip 三态）。
 * - skipped=true 时 ok=true，reason 是 SkipReason
 * - skipped 不为 true 时，ok 和 reason 来自 bridge 响应
 */
export type SystemClipboardSyncResult =
  | ({ skipped: true } & { ok: true; reason: SkipReason })
  | ({ skipped: false } & ClipboardWriteTextResponse)
  | ({ skipped: false } & ClipboardWriteImageResponse);

/**
 * 按节点内容分发写入系统剪贴板。
 *
 * projectPath 在函数内部通过 getRuntimeProjectPath() 获取（canvasStore 不持有此字段，
 * 见 spec 决策记录）。
 *
 * 异常兜底：bridge 抛错时返回 { ok: false, reason: 'invoke-failed' }，调用方负责 .catch。
 */
export const syncNodeContentToSystemClipboard = async (
  node: GraphNode,
  mediaAssets: ProjectMediaAssets,
): Promise<SystemClipboardSyncResult> => {
  const outcome = resolveSystemClipboardPayload(node, { mediaAssets });

  if (outcome.kind === 'skip') {
    return { skipped: true, ok: true, reason: outcome.reason };
  }

  try {
    if (outcome.kind === 'text') {
      const response = await writeTextToClipboard(outcome.text);
      return { skipped: false, ...response };
    }
    // outcome.kind === 'image'
    const projectPath = getRuntimeProjectPath();
    const response = await writeImageFromUrlToClipboard(outcome.url, projectPath);
    return { skipped: false, ...response };
  } catch (error) {
    console.warn('[systemClipboardSync] bridge invoke failed', error);
    // 与 writeTextToClipboard / writeImageFromUrlToClipboard 的失败语义对齐
    return { skipped: false, ok: false, reason: 'invoke-failed' };
  }
};
