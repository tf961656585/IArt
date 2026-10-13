"use client";

/**
 * 定位到节点（locate to node）的唯一主抽象。
 *
 * spec：docs/runtime/画布节点定位.md
 *
 * 职责：把视口平滑移动到使目标节点进入视野中心位置。语义固定为「居中 + 固定 zoom」——
 * 不依赖 ReactFlow 内部 measured（视口外节点 measured 缺失会导致 fitView 失效），
 * 而是在 JS 侧用 store 派生几何计算中心点，调 reactFlowInstance.setCenter。
 *
 * 几何源统一走 resolveEffectiveSize 契约（spec：画布节点尺寸管理架构.md）：
 * - 普通节点 position：store nodeGraph.nodes[i].position（业务稳态坐标）
 * - 组节点 position：派生 position（展开态由 buildGroupDerivedSize 按成员包围盒派生；
 *   折叠态派生 position 保持 store position，两者一致）
 * - 节点 size：resolveEffectiveSize 解析，优先级组节点 derived > default、
 *   普通节点 layoutModel > measured > default（desired 收窄为 runtime 期漂移校准，不进入主优先级链）
 *
 * measured 来源是 ui.lastMeasuredSizeByNodeId（会话态缓存，spec：画布节点尺寸管理架构.md
 * 「measured 的会话态缓存」），覆盖视口外但曾挂载过的节点；缓存为空时由 resolveEffectiveSize
 * 回退到 desired/default。这使得定位对视口外节点、未挂载节点、尺寸未收敛节点均稳定生效。
 *
 * 所有定位入口（组搜索定位、模型节点定位 companion、结果区定位 owner、检查器定位预览源、
 * outpaint 创建后定位等）必须经过本 hook，禁止各自实现 setCenter 调用。
 */

import { useCallback } from "react";
import type { DesiredSize, NodeSize } from "../types";
import { useCanvasStore } from "../store/canvasStore";
import { selectGraphNodeById } from "../store/selectors";
import { selectStoreRenderFallbackSizeByNodeId } from "../store/selectors.nodeSizeRuntime";
import { resolveEffectiveSize } from "../utils/effectiveSize";
import type { EffectiveSizeSources } from "../utils/effectiveSize";
import { buildGroupDerivedSize } from "../components/canvas/groupDerivedSize";
import type { GroupDerivedEntry } from "../components/canvas/groupDerivedSize";
import { useOptionalReactFlow } from "../components/canvas/useOptionalReactFlow";
import { useCanvasSelectionBridge } from "../components/canvas/useCanvasSelectionBridge";
import { logCanvasDebugEvent } from "../debug/canvasDebug";
import type { GraphNode } from "../types";

/** 定位过渡时长默认值（ms），与既有 setCenter 调用（260~300）同量级。 */
const LOCATE_DEFAULT_DURATION = 300;
/** 定位后默认 zoom。既有全部 setCenter 调用均用 zoom=1，是事实上的主口径。 */
const LOCATE_DEFAULT_ZOOM = 1;

/** useLocateToNode 的可选覆盖项。reason 作为独立必填参数,不在此对象内。 */
export type LocateToNodeOverrides = {
  /** 定位后 zoom。默认 1。 */
  zoom: number;
  /** 过渡时长 ms。默认 300。 */
  duration: number;
  /** 定位后是否选中目标节点。默认 true。outpaint 创建后定位等场景传 false 保持原选择。 */
  select: boolean;
};

/** useLocateToNode 的完整入参选项(内部使用,合并 reason + overrides)。 */
export type LocateToNodeOptions = {
  reason: string;
} & LocateToNodeOverrides;

/**
 * 组装定位所需的 EffectiveSizeSources。
 *
 * 与 canvasStore.layoutActions.ts 的 buildLayoutSizeSources 同构模式：
 * - measured 用 store 会话态缓存 lastMeasuredSizeByNodeId（覆盖视口外节点）
 * - desired 保留完整 entry（含 state），由 resolveEffectiveSize 按 pending/accepted 分档处理
 * - derived 由 buildGroupDerivedSize 纯函数计算（依赖 nodes + actual + fallback）
 * - default 留 undefined，让 resolveEffectiveSize 走注册表 default → DEFAULT_NODE_SIZE
 *
 * 纯函数，便于测试。输入是 store 快照，输出是 EffectiveSizeSources + 组派生 position map
 * （组节点定位中心点需要派生 position，不只是派生 size）。
 */
const buildLocateGeometry = (
  state: ReturnType<typeof useCanvasStore.getState>,
): {
  sizeSources: EffectiveSizeSources;
  groupDerivedByNodeId: Readonly<Record<string, GroupDerivedEntry>>;
} => {
  const graph = state.nodeGraph;
  const nodes: ReadonlyArray<GraphNode> =
    graph !== null && graph !== undefined ? graph.nodes : [];

  // measured 会话态缓存：视口外节点保留最近一次 DOM 实测
  const measuredByNodeId: Readonly<Record<string, NodeSize>> =
    state.ui.lastMeasuredSizeByNodeId ?? {};

  // store render fallback：成员未挂载且无 measured 时的尺寸兜底
  const fallbackSizeByNodeId = selectStoreRenderFallbackSizeByNodeId(state);

  // desired 保留完整 entry（含 state）：resolveEffectiveSize 按 layoutModel > measured > default 解析
  // （desired 收窄为 runtime 期漂移校准，不进入主优先级链）
  const desiredRaw = state.ui.desiredSizeByNodeId ?? {};
  const desiredByNodeId: Record<string, DesiredSize | undefined> = {};
  for (const key of Object.keys(desiredRaw)) {
    desiredByNodeId[key] = desiredRaw[key];
  }

  // 组节点派生尺寸与派生 position（纯函数，输入 nodes + sizeSources）。
  // 成员尺寸经 resolveEffectiveSize 按 layoutModel > measured > default 解析，与派生尺寸 selector 同口径。
  // buildGroupDerivedSize 内部不消费 derivedByNodeId（组节点本身的 derived 不进成员解析链路），
  // 这里传 undefined 即可。
  const groupDerivedProjection = buildGroupDerivedSize({
    nodes,
    sizeSources: {
      measuredByNodeId,
      desiredByNodeId,
      derivedByNodeId: undefined,
      defaultByNodeId: fallbackSizeByNodeId,
      layoutModelByNodeId: undefined,
    },
  });

  // derived 投影为 size-only map（resolveEffectiveSize 的 derivedByNodeId 参数签名）
  const derivedByNodeId: Record<string, NodeSize | undefined> = {};
  for (const groupId of Object.keys(groupDerivedProjection.byGroupId)) {
    const entry = groupDerivedProjection.byGroupId[groupId];
    if (entry !== undefined) {
      derivedByNodeId[groupId] = entry.size;
    }
  }

  return {
    sizeSources: {
      measuredByNodeId,
      desiredByNodeId,
      derivedByNodeId,
      defaultByNodeId: undefined,
      layoutModelByNodeId: undefined,
    },
    groupDerivedByNodeId: groupDerivedProjection.byGroupId,
  };
};

/**
 * useLocateToNode 返回的定位函数类型。
 *
 * 支持两种调用形式:
 * - locate(nodeId, reason):使用默认 zoom(1)、duration(300)、select(true)
 * - locate(nodeId, reason, overrides):覆盖默认值
 *
 * 用函数重载声明，使默认值在实现内部处理，调用点签名清晰。
 */
export interface LocateToNodeFn {
  (nodeId: string, reason: string): void;
  (nodeId: string, reason: string, overrides: Partial<LocateToNodeOverrides>): void;
}

/**
 * 定位到节点的唯一主抽象。
 *
 * 返回一个定位函数。调用它执行:
 * 1. 竞态保护:重查目标节点存在性,不存在则 no-op + debug 日志
 * 2. 几何解析:组装 EffectiveSizeSources,取 position + resolveEffectiveSize 取 size
 * 3. 视口变换:setCenter(centerX, centerY, { zoom, duration })
 * 4. 选择反馈:selectNodes([nodeId], reason)(除非 overrides.select === false)
 *
 * reason 作为独立必填参数(不放在 overrides 内),强制每个调用点显式提供审计来源。
 *
 * ReactFlow 实例不可用(无 Provider,如测试环境)时返回 no-op 函数,不抛错。
 */
export function useLocateToNode(): LocateToNodeFn {
  const reactFlowInstance = useOptionalReactFlow();
  const { selectNodes } = useCanvasSelectionBridge();

  const locate = useCallback(
    (
      nodeId: string,
      reason: string,
      overrides: Partial<LocateToNodeOverrides> | undefined = undefined,
    ) => {
      // RF 实例不可用(测试环境或 Provider 缺失):no-op,不抛错
      if (reactFlowInstance === null) {
        logCanvasDebugEvent("locate:no-react-flow-instance", {
          nodeId,
          reason,
        });
        return;
      }

      const state = useCanvasStore.getState();

      // 竞态保护:重查目标节点存在性
      const node = selectGraphNodeById(nodeId)(state);
      if (node === null) {
        logCanvasDebugEvent("locate:missing-node", {
          nodeId,
          reason,
        });
        return;
      }

      const { sizeSources, groupDerivedByNodeId } = buildLocateGeometry(state);

      // 解析 size:统一走 resolveEffectiveSize 契约
      const size = resolveEffectiveSize(node, sizeSources);

      // 解析 position:
      // - 组节点展开态:用派生 position(成员包围盒派生,非 store 业务坐标)
      // - 组节点折叠态:派生 position 保持 store position,用派生或 store 均可;
      //   统一用派生(buildGroupDerivedSize 折叠态返回 store position,保持一致)
      // - 普通节点:用 store position(业务稳态坐标)
      let positionX: number = node.position.x;
      let positionY: number = node.position.y;
      if (node.type === "group") {
        const derived = groupDerivedByNodeId[nodeId];
        if (derived !== undefined) {
          positionX = derived.position.x;
          positionY = derived.position.y;
        }
        // 派生缺失(理论不应发生,buildGroupDerivedSize 对每个 group 节点都有产出):
        // 回退到 store position,size 走 resolveEffectiveSize 的组节点 derived 缺失回退
      }

      const centerX = positionX + size.width / 2;
      const centerY = positionY + size.height / 2;

      const zoom = overrides !== undefined && overrides.zoom !== undefined
        ? overrides.zoom
        : LOCATE_DEFAULT_ZOOM;
      const duration = overrides !== undefined && overrides.duration !== undefined
        ? overrides.duration
        : LOCATE_DEFAULT_DURATION;
      const select = overrides === undefined || overrides.select === undefined
        ? true
        : overrides.select;

      // 视口变换:setCenter 是立即执行的 imperative API
      void reactFlowInstance.setCenter(centerX, centerY, { zoom, duration });

      // 选择反馈(除非调用方显式禁用)
      if (select) {
        selectNodes([nodeId], reason);
      }
    },
    [reactFlowInstance, selectNodes],
  );

  // 用重载签名包装,让调用方能以 (nodeId, reason) 或 (nodeId, reason, overrides) 形式调用
  return locate as LocateToNodeFn;
}
