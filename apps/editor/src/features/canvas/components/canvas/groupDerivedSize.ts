/**
 * 容器节点派生尺寸（derived size）selector——组与 Agent 容器共用。
 *
 * 这是容器节点尺寸与 position 的唯一计算 owner（spec：docs/runtime/画布节点尺寸管理架构.md
 * 「派生尺寸」+ docs/runtime/画布节点组.md「空间边界与移动」）。
 *
 * 派生尺寸语义：由成员节点几何派生的稳态渲染尺寸，不是业务意图、不是测量真相、不参与
 * preview/declared 收敛判定、不回流业务 store。只存在于投影层派生产物中（不落盘，AG-CN-012）。
 *
 * 坐标契约（组与 Agent 容器同一派生规则）：
 * - 展开态：
 *   position = 成员包围盒左上角 − (leftPadding, topPadding + headerHeight)
 *   size = (包围盒宽 + leftPadding + rightPadding, 包围盒高 + topPadding + bottomPadding + headerHeight)
 * - 折叠态：
 *   position 保持折叠前的 position（不因尺寸收缩跳跃）
 *   size = (max(标题宽度, 最小宽度), 折叠高度)
 * - Agent 容器无成员（展开态）：不产出派生 entry，回落既有静态尺寸路径（defaultSize 240×64，
 *   同体两态的单节点形态，spec docs/agent/02「节点形态」）。
 *
 * 成员尺寸源（spec：画布节点尺寸管理架构.md「派生尺寸」节）：
 * 必须经统一解析入口 resolveEffectiveSize 按 layoutModel > measured > default 优先级解析，
 * 不得在此 selector 内部自实现 "actual measured → store fallback" 两档私有链。
 * 成员为 Agent 容器时（组 > Agent 容器两层嵌套），其尺寸由本 selector 第一遍已产出的
 * Agent 容器派生 entry 经 derivedByNodeId 注入解析链。
 */

import type { GraphNode, GroupNodeData, NodePosition, NodeSize } from "../../types";
import type { AgentNodeData } from "../../types/agentNode";
import {
  GROUP_HEADER_HEIGHT,
  GROUP_PADDING,
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_COLLAPSED_HEIGHT,
  computeGroupExpandedBox,
  estimateGroupCollapsedWidth,
} from "@iart/utils/canvas-geometry";
import { isContainerCollapsed, isContainerNode } from "../../services/groupMembership";
import {
  resolveEffectiveSize,
  type EffectiveSizeSources,
} from "../../utils/effectiveSize";

export type GroupDerivedEntry = {
  /** 容器节点派生 position（展开态随成员包围盒；折叠态保持原 position） */
  position: NodePosition;
  /** 容器节点派生 size */
  size: NodeSize;
};

export type GroupDerivedProjection = {
  /** 按容器节点 id（组 | Agent 容器）索引的派生尺寸与 position */
  byGroupId: Record<string, GroupDerivedEntry>;
};

type BuildGroupDerivedSizeParams = {
  /**
   * 全图节点（带 data、groupId；用于派生计算，需包含隐藏的折叠容器成员以保留其数据）。
   * 成员为 Agent 容器时（组 > Agent 容器 > 叶），其几何同样由本 selector 派生。
   */
  nodes: ReadonlyArray<GraphNode>;
  /**
   * 成员节点尺寸来源集合（经 resolveEffectiveSize 统一解析）。
   *
   * 调用方应至少提供 measuredByNodeId（投影层 actualSizeByNodeId）与 defaultByNodeId
   * （store render fallback），让成员尺寸按 layoutModel > measured > default 解析。
   */
  sizeSources: EffectiveSizeSources;
};

const EMPTY_PROJECTION: GroupDerivedProjection = { byGroupId: {} };

/** 读取容器节点的显示名（组 = name；Agent 容器 = label），用于折叠卡片宽度估算。 */
const readContainerDisplayName = (container: GraphNode): string => {
  if (container.type === 'group') {
    const data = container.data as GroupNodeData;
    return data.name ?? '';
  }
  const data = container.data as AgentNodeData;
  return data.label ?? '';
};

/**
 * 展开态派生 entry（成员包围盒 + padding + 容器头高度），position 与 size 由共享
 * 包围盒算法产出，保证投影层、store 层与本 selector 算出的容器几何一致。
 * 无成员或算法无法产出（成员几何非法）时返回 null，由调用方回落。
 */
const deriveExpandedEntry = (
  members: ReadonlyArray<GraphNode>,
  sizeSources: EffectiveSizeSources,
): GroupDerivedEntry | null => {
  // 成员尺寸经统一解析入口 resolveEffectiveSize 按 layoutModel > measured > default 解析，
  // 不在此处自实现私有回退链（spec：画布节点尺寸管理架构.md 派生尺寸节）。
  const memberGeometries = members.map((member) => ({
    position: member.position,
    size: resolveEffectiveSize(member, sizeSources),
  }));

  const box = computeGroupExpandedBox(memberGeometries);
  if (box === null) return null;
  return { position: box.position, size: box.size };
};

/** 折叠态卡片 entry（position 保持原位，不跳跃）。 */
const deriveCollapsedEntry = (container: GraphNode): GroupDerivedEntry => ({
  position: { x: container.position.x, y: container.position.y },
  size: {
    width: estimateGroupCollapsedWidth(readContainerDisplayName(container)),
    height: GROUP_COLLAPSED_HEIGHT,
  },
});

/**
 * 构建全部容器节点（组 | Agent 容器）的派生尺寸与 position。
 *
 * 计算分两遍（组 > Agent 容器 > 叶，嵌套至多两层）：
 * 1. Agent 容器：成员为叶节点，直接派生；产出的派生尺寸注入第 2 遍的解析链，
 *    让组包围盒把成员 Agent 容器按其容器形态范围计入。
 * 2. 组：成员为叶节点或 Agent 容器，经 resolveEffectiveSize（含上一遍注入的 derived）解析。
 *
 * 缓存策略：引用相等 + 浅值比较。输入 nodes/sizeSources 引用未变时返回上次结果。
 * 容器数据（collapsed）变化通过 nodes 引用变化体现。
 */
export const buildGroupDerivedSize = (
  params: BuildGroupDerivedSizeParams,
): GroupDerivedProjection => {
  const { nodes, sizeSources } = params;

  // 先收集所有容器节点（含折叠态，折叠容器成员已隐藏但容器本身可见）
  const containerNodes: GraphNode[] = [];
  for (const node of nodes) {
    if (!isContainerNode(node)) continue;
    containerNodes.push(node);
  }

  if (containerNodes.length === 0) return EMPTY_PROJECTION;

  // 按容器 id 建立成员索引，一次遍历（组节点不得持有 groupId，按资格矩阵排除）
  const membersByContainerId = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.type === "group") continue;
    if (typeof node.groupId !== "string" || node.groupId.length === 0) continue;
    const list = membersByContainerId.get(node.groupId);
    if (list) {
      list.push(node);
    } else {
      membersByContainerId.set(node.groupId, [node]);
    }
  }

  const byGroupId: Record<string, GroupDerivedEntry> = {};

  // 第 1 遍：折叠容器（两类）+ 展开态 Agent 容器
  for (const container of containerNodes) {
    if (isContainerCollapsed(container)) {
      byGroupId[container.id] = deriveCollapsedEntry(container);
      continue;
    }
    if (container.type !== 'agent') continue;
    const members = membersByContainerId.get(container.id);
    if (members === undefined || members.length === 0) {
      // Agent 容器无成员：不产出派生 entry，走既有静态尺寸路径（defaultSize 240×64）
      continue;
    }
    const entry = deriveExpandedEntry(members, sizeSources);
    byGroupId[container.id] = entry ?? {
      position: { x: container.position.x, y: container.position.y },
      size: {
        width: GROUP_COLLAPSED_MIN_WIDTH,
        height: GROUP_HEADER_HEIGHT + GROUP_PADDING.top + GROUP_PADDING.bottom,
      },
    };
  }

  // 第 2 遍：组（成员可能含 Agent 容器——把第 1 遍的派生尺寸注入解析链）
  const agentDerivedSizes: Record<string, NodeSize | undefined> = {};
  for (const [id, entry] of Object.entries(byGroupId)) {
    agentDerivedSizes[id] = entry.size;
  }
  const groupSizeSources: EffectiveSizeSources = {
    ...sizeSources,
    derivedByNodeId: mergeSizeMaps(sizeSources.derivedByNodeId, agentDerivedSizes),
  };

  for (const container of containerNodes) {
    if (container.type !== 'group') continue;
    if (isContainerCollapsed(container)) continue; // 折叠已在第 1 遍产出

    // 展开态：由成员包围盒派生
    const members = membersByContainerId.get(container.id);
    if (members === undefined || members.length === 0) {
      // 空组：给一个最小可见尺寸，position 保持
      byGroupId[container.id] = {
        position: { x: container.position.x, y: container.position.y },
        size: {
          width: GROUP_COLLAPSED_MIN_WIDTH,
          height: GROUP_HEADER_HEIGHT + GROUP_PADDING.top + GROUP_PADDING.bottom,
        },
      };
      continue;
    }

    const entry = deriveExpandedEntry(members, groupSizeSources);
    if (entry === null) {
      byGroupId[container.id] = {
        position: { x: container.position.x, y: container.position.y },
        size: {
          width: GROUP_COLLAPSED_MIN_WIDTH,
          height: GROUP_HEADER_HEIGHT + GROUP_PADDING.top + GROUP_PADDING.bottom,
        },
      };
      continue;
    }
    byGroupId[container.id] = entry;
  }

  return { byGroupId };
};

/** 合并两份尺寸映射（后写覆盖；undefined 被忽略）。 */
function mergeSizeMaps(
  a: Readonly<Record<string, NodeSize | undefined>> | undefined,
  b: Readonly<Record<string, NodeSize | undefined>> | undefined,
): Record<string, NodeSize | undefined> {
  const out: Record<string, NodeSize | undefined> = {};
  if (a) {
    for (const [id, size] of Object.entries(a)) {
      if (size !== undefined) out[id] = size;
    }
  }
  if (b) {
    for (const [id, size] of Object.entries(b)) {
      if (size !== undefined) out[id] = size;
    }
  }
  return out;
}
