'use client';

import type { Node } from '@xyflow/react';
import type { NodePosition, NodeSize } from '../../types';
import type { CanvasLayoutSnapshotNode } from '../../store/selectors';
import type { GroupDerivedEntry } from './groupDerivedSize';

const DEFAULT_NODE_POSITION: NodePosition = { x: 0, y: 0 };
// 容器节点（组 | Agent 容器）的包裹层穿透：React Flow 在节点包裹层上**内联**注入
// pointerEvents（`hasPointerEvents ? 'all' : 'none'`，节点自带 style 在其后展开覆盖），
// 内联值压过任何样式表规则——容器内成员之间的空隙要穿透到画布，只能由投影层注入同形态的
// 内联值。容器内可交互实体收缩到容器头交互条与折叠卡片（GroupNode.tsx / AgentNode.tsx 内
// pointer-events: auto）。口径见 spec 画布节点组.md「选择」/ AG-CN-016。
// 常量引用必须保持稳定：flowNodeMemoizer 对 style 字段做引用比较，
// 每次投影新建对象会导致容器节点 Flow node 被判不等而重建引用。
const CONTAINER_FLOW_NODE_STYLE: NonNullable<Node['style']> = { pointerEvents: 'none' };
// 组节点标记类：激活 globals.css「.react-flow__node-group.iart-canvas-group-node」
// 中和规则，关闭 React Flow 库默认组样式（1px 深色实线边框 / 25% 灰底 /
// hover·selected 默认框），避免与项目组视觉叠成双边框双底色。常量字符串保持引用稳定。
const GROUP_FLOW_NODE_CLASS_NAME = 'iart-canvas-group-node';
const stableFlowNodeDataById = new Map<string, { nodeId: string }>();

type FlowNodeProjectionOptions = {
  renderSizeByNodeId: Readonly<Record<string, NodeSize>> | undefined;
  selectedNodeIdSet: ReadonlySet<string> | undefined;
  /**
   * 容器节点派生尺寸与 position（derived size）。
   * 仅对容器节点（type==='group' | 'agent' 且存在派生 entry）生效，覆盖普通尺寸链路
   * （不参与 preview/declared 收敛判定）。键为容器节点 id。无容器节点时传 undefined。
   */
  groupDerivedByNodeId: Readonly<Record<string, GroupDerivedEntry>> | undefined;
  /**
   * 真实 measured 来源（ReactFlow 对节点 DOM 的实测，即投影层 actualSizeByNodeId）。
   * 用于回注 node.measured 以保住 handleBounds 与连线稳定。
   * 必须是 ReactFlow 实测值，禁止传 projectionSizeByNodeId 等渲染提示（spec：画布节点尺寸管理架构.md
   * 「投影规则」规则 3/7）。首帧尚未测得 measured 的节点（值为 undefined）跳过回注，由 ReactFlow 首次测量补齐。
   */
  realMeasuredByNodeId: Readonly<Record<string, NodeSize>> | undefined;
};

const DEFAULT_FLOW_NODE_PROJECTION_OPTIONS: FlowNodeProjectionOptions = {
  renderSizeByNodeId: undefined,
  selectedNodeIdSet: undefined,
  groupDerivedByNodeId: undefined,
  realMeasuredByNodeId: undefined,
};

const normalizeNodePosition = (position: NodePosition | null | undefined): NodePosition => {
  const x = position !== null && position !== undefined ? position.x : undefined;
  const y = position !== null && position !== undefined ? position.y : undefined;
  return {
    x: typeof x === 'number' ? x : DEFAULT_NODE_POSITION.x,
    y: typeof y === 'number' ? y : DEFAULT_NODE_POSITION.y,
  };
};

const getStableNodeData = (id: string) => {
  const cached = stableFlowNodeDataById.get(id);
  if (cached) return cached;
  const next = { nodeId: id };
  stableFlowNodeDataById.set(id, next);
  return next;
};

export function toFlowNodes(
  nodes: CanvasLayoutSnapshotNode[],
  options: FlowNodeProjectionOptions = DEFAULT_FLOW_NODE_PROJECTION_OPTIONS,
): Node[] {
  const { renderSizeByNodeId, selectedNodeIdSet, groupDerivedByNodeId, realMeasuredByNodeId } = options;

  return nodes.map((node) => {
    const position = node.position;
    const layoutSize = (renderSizeByNodeId !== null && renderSizeByNodeId !== undefined ? renderSizeByNodeId[node.id] : undefined);
    const selected = selectedNodeIdSet !== null && selectedNodeIdSet !== undefined ? selectedNodeIdSet.has(node.id) : false;

    const flowNode: Node = {
      id: node.id,
      type: node.type,
      position: normalizeNodePosition(position),
      data: getStableNodeData(node.id),
      selected,
      draggable: node.draggable ?? true,
    };

    // 容器节点：派生尺寸（derived size）覆盖 size 与 position，不参与普通尺寸收敛判定
    const groupDerived = groupDerivedByNodeId !== null && groupDerivedByNodeId !== undefined
      ? groupDerivedByNodeId[node.id]
      : undefined;
    if (node.type === 'group') {
      // 围栏模型：组是成员节点的"底色/背板"，视觉层始终在成员之下。
      // - zIndex 负值：让组沉到成员之下（成员默认 z=0，选中 z=1000）。
      //   分层（spec 画布节点组.md「展开态」/ 容器机制泛化）：组背板 -2、Agent 容器背板 -1、叶节点 0。
      //   组选中时不加 elevate 会覆盖（React Flow basic 模式会给选中节点 +1000，
      //   -2 被选中加成 998 仍低于选中成员 1000；且非选中成员 0 也高于 -2/-1）。
      //   确保组与 Agent 容器在任何选中组合下都不遮盖成员。
      // - pointerEvents none：容器包裹层必须透空（见 CONTAINER_FLOW_NODE_STYLE），
      //   点击成员间隙穿透到画布；组的可交互实体收缩到标题栏（GroupNode.tsx 内 pointer-events: auto）。
      flowNode.zIndex = -2;
      flowNode.style = CONTAINER_FLOW_NODE_STYLE;
      flowNode.className = GROUP_FLOW_NODE_CLASS_NAME;
    }
    if (node.type === 'group' && groupDerived) {
      flowNode.position = groupDerived.position;
      // 只注入 width/height 作为渲染尺寸提示，不注入 measured。
      // measured 是 ReactFlow 对节点 DOM 的实测结果，程序化注入会让 ReactFlow
      // 误认为节点已测量，不再触发 DOM 测量，导致 actualSizeByNodeId 永远读到注入值
      // 而非真实 DOM 尺寸（spec：画布节点尺寸管理架构.md「实际尺寸」节）。
      // 组节点的 DOM 是自适应容器（由 width/height style 撑开），ReactFlow 会测量真实 DOM。
      flowNode.width = groupDerived.size.width;
      flowNode.height = groupDerived.size.height;
      return flowNode;
    }

    // Agent 容器形态（有成员或折叠，存在派生 entry）：派生尺寸与 position 覆盖普通尺寸链路，
    // 背板 zIndex=-1（低于组背板之上的成员、低于被选中成员；叶形态 Agent 无派生 entry，保持默认层）；
    // 包裹层穿透与组同一口径（CONTAINER_FLOW_NODE_STYLE）——容器内成员之间的空隙落到画布，
    // 容器自身的命中区只有容器头交互条与折叠卡片（AgentNode.tsx 内 pointer-events: auto）。
    // 与组同构走 derived 覆盖路径，不写「禁止 Agent 容器」类特例。
    if (node.type === 'agent' && groupDerived) {
      flowNode.zIndex = -1;
      flowNode.style = CONTAINER_FLOW_NODE_STYLE;
      flowNode.position = groupDerived.position;
      flowNode.width = groupDerived.size.width;
      flowNode.height = groupDerived.size.height;
      return flowNode;
    }

    if (layoutSize !== null && layoutSize !== undefined && typeof layoutSize.width === 'number' && typeof layoutSize.height === 'number') {
      // 只注入 width/height 作为渲染尺寸提示（投影层渲染提示 projectionSizeByNodeId），不冒充 measured。
      // measured 是 ReactFlow 对节点 DOM 的实测结果，程序化注入占位值会让 ReactFlow
      // 误认为节点已按占位尺寸测量，不再触发 DOM 测量，导致 actualSizeByNodeId 冻结为占位值。
      // 节点 DOM 由内容撑开后，ReactFlow 会通过 ResizeObserver 测量真实尺寸并填充 measured。
      flowNode.width = layoutSize.width;
      flowNode.height = layoutSize.height;
    }

    // 回注真实 measured（来源 actualSizeByNodeId），保住 handleBounds 与连线稳定。
    // 机制（ReactFlow v12 @xyflow/system）：节点重投影（adoptUserNodes）时若无 measured 且无显式 handles，
    // handleBounds 被重置为 undefined，isNodeInitialized 返回 false，连线端点坐标计算返回 null → 连线不渲染。
    // 回注 ReactFlow 实测值可让 handleBounds 跨重投影保活，连线在选中/重渲染时不消失。
    // 此处严禁用 projectionSizeByNodeId 等渲染提示冒充 measured（spec「投影规则」规则 3/6/7）。
    // 组节点在上方 early-return（规则 1：组用 derived，不参与 measured 回注规则）。
    const realMeasured = realMeasuredByNodeId !== undefined ? realMeasuredByNodeId[node.id] : undefined;
    if (realMeasured !== undefined && realMeasured.width > 0 && realMeasured.height > 0) {
      flowNode.measured = { width: realMeasured.width, height: realMeasured.height };
    }

    return flowNode;
  });
}

export function mergeFlowNodeSizeByNodeId(
  renderSizeByNodeId: Readonly<Record<string, NodeSize>>,
  transientDimensions: Readonly<Record<string, NodeSize>>,
): Record<string, NodeSize> {
  if (Object.keys(transientDimensions).length === 0) {
    return renderSizeByNodeId as Record<string, NodeSize>;
  }

  return {
    ...renderSizeByNodeId,
    ...transientDimensions,
  };
}
