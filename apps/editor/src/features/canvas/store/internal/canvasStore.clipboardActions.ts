import type { GraphNode } from '../../types';
import { generateNodeId } from '../../types/node';
import { findIllegalMemberships } from '../../services/groupMembership';
import { buildClipboardPayloadFromSelection } from '../../clipboard/selectionPayload';
import { syncNodeContentToSystemClipboard } from '../../clipboard/systemClipboardSync';
import { reportSystemClipboardResult } from '@/client/utils/clipboardWriteWithToast';
import {
  normalizeTextInputNodeData,
} from '../../nodes/textInput/enhancedTextNode';
import {
  trackCurrentProjectNodeTypeUsage,
} from '../../storage';
import {
  extractTaskIdsFromNodeData,
  updateTaskIdIndex,
} from './canvasStore.shared';
import { markGraphDirty, markNodesDirty } from './canvasStore.persistence';
import {
  type CanvasPasteResult,
  type CanvasStoreGet,
  type CanvasStoreSet,
  type NodeGraphActions,
  type TextInputGraphNode,
} from './canvasStore.core';

/**
 * 粘贴含非法成员关系时的用户可见拒绝文案（AG-CN-013）。
 * 只写「发生了什么 + 结果」；违规明细（节点 id / 原因）只进 console.error 日志。
 */
const PASTE_ILLEGAL_MEMBERSHIP_USER_MESSAGE = '这部分内容的归属关系无法识别，未放入画布。';

export const createCanvasClipboardActions = (
  set: CanvasStoreSet,
  get: CanvasStoreGet
): Pick<
  NodeGraphActions,
  | 'copySelectedNodes'
  | 'pasteClipboardPayload'
  | 'pasteNodes'
  | 'hasClipboardContent'
  | 'getNodeIdsByTaskId'
> => ({
  copySelectedNodes: () => {
    const { nodeGraph, selectedNodeIds } = get();
    if (!nodeGraph) return;

    const payload = buildClipboardPayloadFromSelection({
      nodeGraph,
      selectedNodeIds,
    });
    if (!payload) return;

    set((state) => {
      state.clipboardPayload = payload;
    });

    // 系统通道（单选时附加触发，fire-and-forget）：
    // - 多选不触发（决策 B）
    // - 系统通道失败不阻塞内部复制（spec 禁止项）
    // - projectPath 在 sync 内部通过 getRuntimeProjectPath() 获取，不从 canvasStore 读
    // Zustand set 是同步的，内部 payload 已先于系统通道触发，无需额外同步机制
    if (payload.nodes.length === 1) {
      const node = payload.nodes[0];
      if (node !== null && node !== undefined) {
        void syncNodeContentToSystemClipboard(node, get().mediaAssets)
          .then(reportSystemClipboardResult)
          .catch((error) => {
            console.warn('[systemClipboardSync] uncaught error', error);
          });
      }
    }
  },

  pasteClipboardPayload: (payload, targetPosition) => {
    const { nodeGraph, taskIdIndex } = get();
    // 粘贴端不做可复制过滤：payload 的另一条合法来源是 bundle 导入
    //（insertBundleIntoCanvas → buildClipboardPayloadFromNodeGraphSnippet），
    // 导入必须完整保留 Agent 等节点（会话缺失由节点不可用态呈现）。
    // 用户复制的候选过滤在构造端（buildClipboardPayloadFromSelection）。
    if (!nodeGraph || payload.nodes.length === 0) {
      return {
        nodes: [],
        nodeIds: [],
      };
    }

    // 粘贴/导入边界校验（AG-CN-013 旧输入拒绝）：非法成员关系拒绝该输入，不修复、不降级、
    // 不静默转换。悬空目标除外——容器未随片段一起粘贴时由下方 groupId 重映射合法置空
    //（合法粘贴重映射）；组持有 groupId、自指、容器套容器、目标非容器等结构性违规照拒。
    // 拒绝必须发生在任何状态写入之前（拒绝后画布不被部分写入）。
    const illegalMemberships = findIllegalMemberships(payload.nodes, {
      ignoreDanglingTarget: true,
    });
    if (illegalMemberships.length > 0) {
      console.error(
        '[canvas:paste] illegal-membership 拒绝粘贴（含非法成员关系）',
        { violations: illegalMemberships },
      );
      throw new Error(PASTE_ILLEGAL_MEMBERSHIP_USER_MESSAGE);
    }

    const nodeIdMapping = new Map<string, string>();
    const newNodes: GraphNode[] = payload.nodes.map((node) => {
      const newId = generateNodeId();
      nodeIdMapping.set(node.id, newId);
      const cloned = structuredClone(node) as GraphNode;
      return {
        ...cloned,
        id: newId,
      };
    });

    // 重映射 groupId：连同所属容器一起粘贴时指向新容器 id；否则置 undefined，避免悬空引用。
    // 组节点自身的 groupId 强制为 undefined（纵深防御：组持有 groupId 已在上方校验拒绝）。
    for (const node of newNodes) {
      if (node.type === 'group') {
        node.groupId = undefined;
        continue;
      }
      const sourceGroupId = node.groupId;
      if (typeof sourceGroupId === 'string') {
        node.groupId = nodeIdMapping.get(sourceGroupId);
      }
    }

    const offset = targetPosition
      ? {
          x: targetPosition.x - payload.centerPosition.x,
          y: targetPosition.y - payload.centerPosition.y,
        }
      : { x: 50, y: 50 };

    for (const node of newNodes) {
      node.position = {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      };
    }

    // textInput 粘贴时只做 segments 归一，剥离残留的 upstream 段（旧拓扑 text-source
    // 连线的拓扑表达，新模型下无法被喂值）。
    for (const node of newNodes) {
      if (node.type !== 'textInput') continue;
      const textNode = node as TextInputGraphNode;
      textNode.data = normalizeTextInputNodeData(textNode.data);
    }

    set((state) => {
      if (!state.nodeGraph) return;
      const nextTaskIdIndex = new Map(taskIdIndex);
      state.nodeGraph.nodes.push(...newNodes);

      markNodesDirty(
        state,
        newNodes.map((node) => node.id)
      );

      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      markGraphDirty(state);
      state.structureRevision += 1;

      for (const pastedNode of newNodes) {
        updateTaskIdIndex(nextTaskIdIndex, [], extractTaskIdsFromNodeData(pastedNode.data), pastedNode.id);
      }
      state.taskIdIndex = nextTaskIdIndex;
    });

    get().saveToHistory();

    const pastedNodeTypeKeys = Array.from(new Set(newNodes.map((node) => node.type)));
    if (pastedNodeTypeKeys.length > 0) {
      void trackCurrentProjectNodeTypeUsage(pastedNodeTypeKeys);
    }
    const result: CanvasPasteResult = {
      nodes: newNodes,
      nodeIds: newNodes.map((node) => node.id),
    };
    return result;
  },

  pasteNodes: (targetPosition) => {
    const { clipboardPayload } = get();
    if (!clipboardPayload) {
      return {
        nodes: [],
        nodeIds: [],
      };
    }
    return get().pasteClipboardPayload(clipboardPayload, targetPosition);
  },

  hasClipboardContent: () => {
    const { clipboardPayload } = get();
    return clipboardPayload !== null && clipboardPayload.nodes.length > 0;
  },

  getNodeIdsByTaskId: (taskId) => {
    return get().taskIdIndex.get(taskId) ?? [];
  },
});
