/**
 * 素材节点内容存在性判定（唯一事实源）。
 *
 * spec docs/runtime/已退场对象与术语.md：素材节点（textInput/imageInput/videoInput/audioInput）
 * 的输出只来自自持内容；空素材节点不存在可连输出端口。
 * StaticOutputProvider（静态输出推导的空判定）与 ContentNodeCard（输出端口渲染过滤）
 * 必须复用本判定，禁止各自实现第二套空口径。
 */

import type {
  GraphNode,
  GraphNodeType,
  ImageInputNodeData,
  VideoInputNodeData,
  AudioInputNodeData,
} from '../types/node';
import type { DynamicRecord } from '@/client/utils/typeGuards';
import { cast } from '@/lib/utils';
import { composeEnhancedTextInput, normalizeTextInputNodeData } from './textInput/enhancedTextNode';

export type MaterialNodeType = Extract<GraphNodeType, 'textInput' | 'imageInput' | 'videoInput' | 'audioInput'>;

export const isMaterialNodeType = (nodeType: GraphNodeType): nodeType is MaterialNodeType =>
  nodeType === 'textInput' || nodeType === 'imageInput' || nodeType === 'videoInput' || nodeType === 'audioInput';

/**
 * 素材节点的用户界面显示名（唯一事实源）。
 * 术语分层（docs/product/00-产品定位与核心动作.md）：素材节点在 UI 层直接以
 * 具体素材名呈现（图片素材 / 视频素材 / 音频素材 / 文本素材），同一概念唯一叫法。
 */
export const MATERIAL_NODE_TYPE_LABEL: Record<MaterialNodeType, string> = {
  textInput: '文本素材',
  imageInput: '图片素材',
  videoInput: '视频素材',
  audioInput: '音频素材',
};

/**
 * 判定素材节点当前是否持有可输出的自持内容。
 * 非素材节点不受空内容约束，一律返回 true。
 */
export function hasMaterialNodeContent(node: GraphNode): boolean {
  switch (node.type) {
    case 'textInput': {
      const normalized = normalizeTextInputNodeData(cast<DynamicRecord>(node.data));
      const text = composeEnhancedTextInput({
        data: normalized,
        options: undefined,
      });
      return text.trim().length > 0;
    }
    case 'imageInput': {
      const data = node.data as ImageInputNodeData | undefined;
      return Boolean(data !== null && data !== undefined ? data.imageUrl : undefined);
    }
    case 'videoInput': {
      const data = node.data as VideoInputNodeData | undefined;
      return Boolean(data !== null && data !== undefined ? data.videoUrl : undefined);
    }
    case 'audioInput': {
      const data = node.data as AudioInputNodeData | undefined;
      const segments = (data !== null && data !== undefined ? data.segments : undefined) ?? [];
      const segmentModeEnabled = (data !== null && data !== undefined ? data.segmentModeEnabled : undefined) ?? false;

      // 分段模式：存在已切分（有 segmentUrl）的分段才算有内容
      if (segmentModeEnabled && segments.length > 0) {
        return segments.some((seg) => seg.sliced && Boolean(seg.segmentUrl));
      }

      return Boolean(data !== null && data !== undefined ? data.audioUrl : undefined);
    }
    default:
      return true;
  }
}
