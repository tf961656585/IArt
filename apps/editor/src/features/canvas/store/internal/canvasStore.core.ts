import type { ProjectMediaAssets } from '@iart/contracts';
import type { EditorPersistenceState } from '@iart/contracts/editor-storage-contract';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import type {
  CanvasAnnotation,
  CanvasContainerSize,
  ClipboardPayload,
  CreateNodeGraphParams,
  GraphNode,
  ModelNodeData,
  NodeGraph,
  NodeGraphMeta,
  NodeGraphSettings,
  NodeGraphViewport,
  NodePosition,
  DesiredSize,
  NodeSize,
  NodeSizeProposal,
  TextInputNodeData,
} from '../../types';
import { CURRENT_NODE_GRAPH_SCHEMA_VERSION } from '../../types/nodeGraph';
import type { AnnotationBinding } from '../../types/annotation';
import { nodeRegistry } from '../../nodes/registry';
import type { LayoutApplyResult, LayoutOrderMode } from '../../layout/autoLayoutTypes';
import type { AlignmentMode } from '../../layout/alignment';
import { areArraysShallowEqual, type CanvasDirtyFlags, type DeferredHistoryBaseline, type HistoryEntry, type LoadRepairDiagnostics } from './canvasStore.shared';
import { createDirtyState } from './canvasStore.persistence';
import type { MediaAssetWriteSource } from '../../services/projectMediaAssetMerge';

export const DEFAULT_VIEWPORT: NodeGraphViewport = { x: 0, y: 0, zoom: 1 };
export type CanvasDynamicObject = DynamicRecord;
type LegacyNodeGraphMeta = NodeGraph & { meta: NodeGraphMeta | null | undefined };
export type TextInputGraphNode = GraphNode<TextInputNodeData>;

/**
 * 自动布局 store action 的 options。
 *
 * store action 负责把 UI 传入的 measured + store 内部的 desired 组装成 EffectiveSizeSources，
 * 再传给 computeAutoLayout。UI 层只需提供 measuredSizeByNodeId（ReactFlow DOM 实测）和
 * 可选的 derivedSizeByNodeId（组节点派生尺寸），不需感知 EffectiveSizeSources 细节。
 */
export type CanvasAutoLayoutStoreOptions = {
  /** 实测尺寸映射（来自 ReactFlow DOM 实测，UI 层经 ref 上抛） */
  measuredSizeByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  /** 组节点派生尺寸映射（来自投影层 groupDerivedProjection，可选） */
  derivedSizeByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  /**
   * 显式摆放顺序（可选；CLI canvas.layout --order 承载，spec CLI-030）。
   * 数组序即最高优先摆放序：order 中节点按给定序占格（重复 id 按首次出现去重），未指定的
   * 参与节点按现状数组序跟排在后；缺省时完全不传——默认排序行为不变（布局引擎按传入数组序
   * 占格、内部零排序，spec：画布自动布局算法.md「分区内流式摆放」插入序口径）。
   */
  order?: readonly string[] | undefined;
  /**
   * 本次排布列数（可选；CLI canvas.layout --columns 承载，spec §5.3「均映射列数语义」 /
   * CLI-032）。缺省时单列垂直摆放（既有口径不变）；给出时按网格分行摆放（行优先）。
   * 容器内整理经 CanvasGroupAutoLayoutStoreOptions 携带同名列（其必填语义不变）；
   * 全局整理自 2026-10-14 起按 spec 对齐透传（此前执行侧忽略、固定单列）。
   */
  columns?: number | undefined;
  /**
   * 本次格子间距（非负整数，缺省 `NODE_GAP=120`；CLI `canvas.layout --gap` 承载）。
   * 这是本次调用的入参，不是持久化布局偏好；列/行推进量精确等于该值
   *（spec：docs/runtime/画布自动布局算法.md「网格摆放」）。
   */
  gap?: number | undefined;
  /**
   * 本次排序口径（CLI `canvas.layout --order-mode` 承载，spec CLI-058）。
   * 缺省 `position` = 视觉阅读序；`insertion` = 传入数组序；`created` 由主进程解析为
   * 显式 `order` 后传入，画布侧收到时按 `insertion` 处理并留 debug 日志。
   */
  orderMode?: LayoutOrderMode | undefined;
};

/**
 * 容器内整理 store action 的 options。
 *
 * 在通用自动布局选项之上承载本次排布列数：容器内整理支持按本次选取的网格列数摆放成员
 *（`m×n` 快速选择）；列数列在本类型保持必填显式语义（容器内整理调用方必须显式给值）。
 * spec：docs/editor/画布对象右键菜单.md §7.3、docs/runtime/画布自动布局算法.md「网格摆放」。
 */
export type CanvasGroupAutoLayoutStoreOptions = CanvasAutoLayoutStoreOptions & {
  /** 本次排布列数；缺省或为 1 时单列垂直摆放（与既有整理口径一致）。 */
  columns: number | undefined;
};

/**
 * 删除节点选项。
 *
 * `deleteGroupMembers` 控制删除组节点时的成员处理语义（spec：画布节点组.md「操作与删除边界」）：
 * - `false` / `undefined`（默认，dissolve 解散）：删容器节点（组 | Agent 容器） + 指向它的成员
 *   groupId 置 undefined，成员保留为自由节点。删除组默认采用解散；删除 Agent 容器只允许解散。
 * - `true`（显式连删，仅组、需显式确认）：组节点 + 全部显式成员一并删除；
 *   成员中的 Agent 容器被删时照常先在途终止，其自身的成员仍按解散语义保留、不被连删扩大删除。
 *   Agent 容器不提供连删选项：对 Agent 容器该标志恒不适用（AG-CN-007），删除恒为解散。
 */
export type RemoveNodesOptions = {
  deleteGroupMembers: boolean;
};

/**
 * `addNode` 创建时的成员关系指定（节点创建即入容器，AG-CT-001 产物自动包含的机制接口）。
 *
 * groupId 指向目标容器节点 id，作为新节点的顶层 `groupId` 字段一次性落图；
 * 目标不存在、不是容器节点或不符合成员资格矩阵时，节点照常创建为自由节点并记 debug 留痕。
 */
export type AddNodeMembership = {
  groupId: string;
};

/** `replaceNode` 单个继任节点的创建描述（key/位置/自定义 data，同 addNode 入参口径）。 */
export type ReplaceNodeCreation = {
  key: string;
  position: NodePosition;
  data?: CanvasDynamicObject | undefined;
};

export const resolveNodeDefinitionKey = (node: GraphNode): string | null => {
  if (node.type !== 'model') return node.type;
  const modelData = node.data as Partial<ModelNodeData> | undefined;
  const modelIdCandidate = (modelData !== null && modelData !== undefined ? modelData.modelId : undefined);
  const modelId = typeof modelIdCandidate === 'string' ? modelIdCandidate.trim() : '';
  return modelId || null;
};

export const resolveNodeCategory = (node: GraphNode): string | undefined => {
  const key = resolveNodeDefinitionKey(node);
  if (!key) return undefined;
  const definition = nodeRegistry.get(key);
  return definition !== undefined ? definition.category : undefined;
};

export const normalizeNodeGraphMeta = (meta: Partial<NodeGraphMeta> | null | undefined): NodeGraphMeta => {
  const now = new Date().toISOString();
  const rawMeta = meta ?? {};
  const rawTags = rawMeta.tags;
  const rawSelectedCharacterIds = rawMeta.selectedCharacterIds;
  const rawVersion = rawMeta.version;
  const rawCreatedAt = rawMeta.createdAt;
  const rawUpdatedAt = rawMeta.updatedAt;
  const tags = Array.isArray(rawTags) ? [...rawTags] : [];
  const selectedCharacterIds = Array.isArray(rawSelectedCharacterIds)
    ? [...rawSelectedCharacterIds]
    : [];
  const createdBy = typeof rawMeta.createdBy === 'string' ? rawMeta.createdBy : undefined;
  const category = typeof rawMeta.category === 'string' ? rawMeta.category : undefined;
  return {
    version: typeof rawVersion === 'string' && rawVersion.trim() ? rawVersion : '1.0.0',
    schemaVersion: CURRENT_NODE_GRAPH_SCHEMA_VERSION,
    createdAt: typeof rawCreatedAt === 'string' && rawCreatedAt.trim() ? rawCreatedAt : now,
    updatedAt: typeof rawUpdatedAt === 'string' && rawUpdatedAt.trim() ? rawUpdatedAt : now,
    createdBy,
    tags,
    category,
    selectedCharacterIds,
  };
};

export const ensureNodeGraphMeta = (nodeGraph: NodeGraph): void => {
  const graph = nodeGraph as LegacyNodeGraphMeta;
  graph.meta = normalizeNodeGraphMeta(graph.meta);
};


export type AnnotationUpdatePatch = Partial<Omit<CanvasAnnotation, 'style'>> & {
  style?: Partial<CanvasAnnotation['style']> | undefined;
};

/** 画板 Store 状态 */
export interface NodeGraphState {
  /** 当前画板 */
  nodeGraph: NodeGraph | null;
  /** 项目级媒体资产注册表 */
  mediaAssets: ProjectMediaAssets;
  /** 选中的节点 ID 列表 */
  selectedNodeIds: string[];
  /** 选中的注释 ID 列表（目前仅支持单选） */
  selectedAnnotationIds: string[];
  /** 正在编辑的注释 ID */
  editingAnnotationId: string | null;
  /** 等待绑定目标的注释 */
  pendingAnnotationBinding: { annotationId: string } | null;
  /** 是否正在拖拽 */
  isDragging: boolean;
  /** 是否正在连接 */
  isConnecting: boolean;
  /** 是否正在视口交互（平移/缩放） */
  isCanvasInteracting: boolean;
  /** 是否正在视口交互（平移/缩放，延迟态） */
  isCanvasInteractingDelayed: boolean;
  /** 待进入编辑态的文本节点 id（由程序化建边交互触发，供 TextInputNode 消费；spec：程序化建边交互.md） */
  pendingTextEditNodeId: string | null;
  /** 待进入组名内联编辑的组节点 id（由右键菜单「重命名组」触发，供 GroupNode 消费并清空） */
  pendingGroupRenameNodeId: string | null;
  /**
   * Agent 删除确认请求（AG-CT-011：删除 Agent 必须经确认框，禁旁路）。
   * 所有不经确认的删除入口（键盘 Delete、工具栏、菜单、选中集删除）命中 Agent 节点时
   * 都写本请求通道，由确认框宿主（AgentDeleteConfirmHost）消费：确认才走 removeNodes 删除咽喉。
   */
  pendingAgentDeleteConfirmNodeIds: string[] | null;
  /** 待提示：历史媒体迁移告警（用于用户可见”需重传”引导） */
  pendingMediaMigrationNotice: string | null;
  /** 历史记录 */
  history: HistoryEntry[];
  /** 历史记录索引 */
  historyIndex: number;
  /** 打开项目后延后提交的首个历史基线 */
  deferredHistoryBaseline: DeferredHistoryBaseline | null;
  /** 最近一次打开链路的分类与 repair 计数，仅用于验证与调试 */
  lastLoadDiagnostics: LoadRepairDiagnostics | null;
  /** 最大历史记录数 */
  maxHistorySize: number;
  /** 是否有未保存的更改 */
  hasUnsavedChanges: boolean;
  /** 持久化状态（Storage Service 返回） */
  persistenceState: EditorPersistenceState | null;
  /** 是否处于关闭握手中 */
  isClosing: boolean;
  /** 保存增量修订号（用于避免并发保存覆盖） */
  dirtyRevision: number;
  /** 增量保存脏标记 */
  dirty: CanvasDirtyFlags;
  /** 结构变更修订号（节点/边/元数据） */
  structureRevision: number;
  /** 非结构数据变更修订号（node.data 等不影响图结构的字段） */
  dataRevision: number;
  /** 任务相关修订号（仅由 taskInfo/items 等任务承载字段驱动） */
  taskRevision: number;
  /** 仅节点坐标变更修订号（拖拽） */
  positionRevision: number;
  /** 视口变更修订号（缩放/平移） */
  viewportRevision: number;
  /** 自动布局修订号（驱动尺寸缓存失效：布局/整理后节点几何变化，派生尺寸需重算） */
  layoutRevision: number;
  /** 剪贴板数据 */
  clipboardPayload: ClipboardPayload | null;
  /** 批量删除进行中标记：为 true 时各子 action 跳过各自的 saveToHistory */
  historyBatchActive: boolean;

  /** UI 临时态：不落盘、不进入历史 */
  ui: {
    /** 业务意图尺寸（desired size，含 pending/accepted 两态，仅会话态，不写入 graph model） */
    desiredSizeByNodeId: Record<string, DesiredSize>;
    /**
     * Layout Model 节点尺寸（spec：画布启动性能与Layout-Model架构.md）。
     *
     * Layout-Model-Driven 范式下节点尺寸的唯一业务事实源。由纯函数 computeLayoutModel
     * 从 nodeGraph + mediaAssets + urlIndex + defaultSize 表计算。
     *
     * desired 的反馈环降级为 runtime 期单节点级漂移校准，不再进入主优先级链。
     * 启动期（loading-project → ready）零反馈环：layoutModelByNodeId 在 hydrate 收敛后
     * 一次性全量计算，启动期不写 desired、不进 commit gate。
     *
     * 不持久化（spec 禁止），工程关闭后清空。
     */
    layoutModelByNodeId: Record<string, NodeSize>;
    /**
     * measured size 的会话态快照缓存（spec：画布节点尺寸管理架构.md「measured 的会话态缓存」）。
     * 记录每个节点最近一次 ReactFlow DOM 实测尺寸，节点移出视口（虚拟化卸载）后仍保留，
     * 供全局整理等"需要全图尺寸但部分节点已卸载"的消费者使用。
     * 不回流为 desired，不持久化，工程关闭后清空。
     */
    lastMeasuredSizeByNodeId: Record<string, NodeSize>;
    /**
     * 全局整理预挂载测量态（spec：画布自动布局算法.md「全局整理的预挂载测量」）。
     * 为 true 时，渲染层临时关闭节点虚拟化（onlyRenderVisibleElements=false），
     * 让视口外从未挂载的节点产出 measured，供全局整理消费可信 sizeMap。
     * measured 收敛后由整理入口清回 false。仅会话态，不持久化。
     */
    preLayoutMeasuring: boolean;
    /**
     * 占位壳节点 id 集合（spec：画布交互期渲染降级契约.md「占位壳契约」）。
     * 记录当前处于占位壳形态的节点 id：
     * - 交互期新进入视口的节点由节点 mount 时的 useLayoutEffect 加入
     * - 收敛期 moveEnd 后由分帧升级调度器按帧批量移除
     * - 收敛期被新交互中断时未升级占位壳保持占位态
     * 仅会话态，不持久化。组件通过 selectIsPlaceholderNode(nodeId) 单节点作用域订阅，
     * 不订阅整个 Set（避免击穿 memo 隔离）。
     */
    placeholderNodeIds: Set<string>;
    /**
     * 画布容器屏幕像素尺寸（React Flow 容器实测，NodeCanvas 内同步写入）。
     * 供任务节点视口锚定落位等需要「可见世界矩形」的会话态消费方使用。
     * 仅会话态，不持久化；未挂载/未测量时为 null。
     */
    canvasContainerSize: CanvasContainerSize | null;
    /**
     * 拖拽落点悬停目标组 id（drop-target 高亮）：拖成员节点悬停在目标展开组上方时写入，
     * 仅当「松手将改变归属」（命中组 ≠ 节点原组）时非 null，命中结果变化才写 store。
     * 拖拽结束/未拖拽时为 null。仅会话态，不持久化。
     */
    groupDropTargetGroupId: string | null;
    /**
     * 正在被拖动的组节点 id（拖组视觉反馈 .is-dragging）。非组拖拽或未拖拽时为 null。
     * 仅会话态，不持久化。
     */
    groupDraggingId: string | null;
  };

  /**
   * 启动阶段镜像（spec：画布启动性能与Layout-Model架构.md）。
   *
   * 真实事实源是 useCanvasPreparationController 内部的 useState<PreparationState>，
   * 但 desired producers / commit gate / useFlowNodeActualSize 等组件无法直接订阅
   * 那个 controller（它在 CanvasEditor 顶层），因此 controller 在每次 phase 变化时
   * 把 phase 同步到 store 的本字段，让消费方用 useCanvasStore(selectPreparationPhase)
   * 单点订阅 phase。消费方据此判断是否处于启动期（loading-project → ready 之间）
   * 以禁用 desired 反馈环（spec：desired producers / commit gate 在启动期必须 no-op）。
   * 仅会话态，不持久化。
   */
  preparationPhase: string;

  /** taskId -> nodeId[] 倒排索引（仅会话态，从 node.data 派生） */
  taskIdIndex: Map<string, string[]>;
}

/** 画板 Store 操作 */
export interface NodeGraphActions {
  // 画板操作
  createNewNodeGraph: (params: CreateNodeGraphParams) => void;
  loadNodeGraph: (nodeGraph: NodeGraph) => Promise<void>;
  setProjectMediaAssets: (
    patch: ProjectMediaAssets,
    options: { source: MediaAssetWriteSource } | undefined,
  ) => void;
  updateNodeGraphMeta: (updates: Partial<Pick<NodeGraph, 'name' | 'description' | 'status'>>) => void;
  clearNodeGraph: () => void;
  setSelectedCharacters: (characterIds: string[]) => void;

  // 节点操作
  /**
   * 创建并落图节点。`membership` 提供创建即入容器的成员关系（groupId 指向现存容器节点），
   * 供产物自动包含等投影链调用；非法目标不建立成员关系（节点照常创建，debug 留痕）。
   */
  addNode: (key: string, position: NodePosition, customData: CanvasDynamicObject | undefined, membership?: AddNodeMembership) => GraphNode | null;
  updateNode: (nodeId: string, updates: Partial<GraphNode>) => void;
  updateNodeData: (nodeId: string, data: CanvasDynamicObject, via: string | undefined) => void;
  updateNodeDataBatch: (payload: Array<{ id: string; data: CanvasDynamicObject }>, via: string | undefined) => void;
  updateNodePosition: (nodeId: string, position: NodePosition) => void;
  updateNodePositionsBatch: (payload: Array<{ id: string; position: NodePosition }>) => void;
  /** 提交尺寸提案，经去重后写入 desiredSizeByNodeId（pending 态） */
  submitNodeSizeProposal: (proposal: NodeSizeProposal) => void;
  /** 将 pending desired 迁移到 accepted（actual 已收敛） */
  acceptDesiredSize: (nodeId: string) => void;
  /** 清除指定节点的 desired（含 pending/accepted） */
  clearDesiredSize: (nodeId: string) => void;
  /**
   * 把当前 ReactFlow actualSizeByNodeId 快照合并写入 measured 会话态缓存。
   * 供 NodeCanvas 在 measured 变化时上抛，让视口外节点保留最近一次 measured（spec：
   * 画布节点尺寸管理架构.md「measured 的会话态缓存」）。不回流为 desired。
   */
  commitMeasuredSizeSnapshot: (snapshot: Readonly<Record<string, NodeSize>>) => void;
  /**
   * 全量重算 Layout Model（spec：画布启动性能与Layout-Model架构.md）。
   *
   * 调用时机：loadNodeGraph 完成、hydrate 收敛后；clearNodeGraph 后清空。
   * 必须在 hydrate 完全收敛后的最终 state.nodeGraph 上调用。
   */
  recomputeLayoutModelFull: () => void;
  /**
   * 按 nodeId 增量重算 Layout Model。
   *
   * 调用时机：
   * - 节点内容变化（slot 增减、form 字段、折叠态）
   * - 媒体 metadata 异步返回（受影响节点集合）
   * - 节点结构变化（含受影响 group 节点）
   *
   * fallback：受影响集合 > 阈值时退化为全量重算。
   */
  recomputeLayoutModelForNodes: (nodeIds: string[]) => void;
  removeNode: (nodeId: string, options: RemoveNodesOptions | undefined) => void;
  removeNodes: (nodeIds: string[], options: RemoveNodesOptions | undefined) => void;
  /**
   * 原位替换节点（构造性保证成员身份继任与历史原子，AG-CN-017「替换继任保持成员身份」）。
   *
   * 预检（不改图）：source 必须存在且非容器节点（组 | Agent 容器，含 agent 类型）；
   * creations 非空且每个 key 都能被 nodeRegistry 创建；任一失败整体拒绝（debug 留痕、
   * 返回空数组、画布零改动）。
   *
   * membership：`membershipOverride` 优先，否则继承 source.groupId（undefined 则继任节点
   * 为自由节点）；每个继任节点都经 addNode 的 membership 通道创建（canBeMemberOf 校验
   * 与降级留痕复用，不裸写 groupId）。
   *
   * 执行顺序：逐个 addNode → 绑定 source 的注释改绑首个继任节点（替换继任语义，
   * 不级联删除）→ removeNodes 移除 source；全部成功才删 source，不存在「源已删、
   * 新未建」中间态。
   *
   * 历史：自开自关 historyBatchActive（外层已开批则并入外层），一次替换 = 一条全图快照，
   * undo 一步回到替换前、redo 一步恢复。
   *
   * 返回成功创建的继任节点数组；整体拒绝或部分创建失败（防御性，预检已挡）返回已建部分。
   */
  replaceNode: (
    sourceId: string,
    creations: ReadonlyArray<ReplaceNodeCreation>,
    membershipOverride?: AddNodeMembership,
  ) => GraphNode[];
  duplicateNode: (nodeId: string) => GraphNode | null;
  /**
   * 解散 Agent 容器（AG-CT-010）：解除全部成员关系，成员保留画布原位；Agent 节点不删除，
   * 随成员清空回落单节点形态；不触碰会话、不终止在途。一次成员关系变更事务写一条历史
   * （撤销整体恢复成员关系与成员位置）。
   * 无成员 / 目标不存在 / 目标非 Agent 节点时为 no-op（debug 留痕）并返回 false。
   */
  dissolveAgentContainer: (nodeId: string) => boolean;

  // 组操作
  /**
   * 建组（成员归属同一历史）。position 缺省按成员包围盒左上角；空成员清单默认拒绝，
   * 仅 `options.allowEmpty`（CLI 空组建组，spec CLI-044）放行——position 必须由调用方给出
   * （无成员无法派生包围盒）。
   */
  createGroup: (
    nodeIds: string[],
    position: NodePosition | undefined,
    options?: { allowEmpty?: boolean },
  ) => string | null;
  ungroupNode: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  /** 换色：更新组颜色（单条历史）。色值取值域为 groupPalette 调色板。 */
  setGroupColor: (groupId: string, color: string) => void;
  toggleGroupCollapse: (groupId: string) => void;
  addNodesToGroup: (nodeIds: readonly string[], targetGroupId: string) => void;
  removeNodesFromGroup: (nodeIds: readonly string[]) => void;
  moveNodesBetweenGroups: (nodeIds: readonly string[], targetGroupId: string) => void;
  /**
   * 容器内整理（组与 Agent 容器同一动作，门按 isContainerNode 判定）。
   * 折叠态容器与无成员容器拒绝执行（返回 null）。
   */
  autoLayoutContainer: (
    containerId: string,
    options: CanvasGroupAutoLayoutStoreOptions | undefined,
    /**
     * 计划模式（仅 CLI `canvas.layout --dry-run` 消费）：true = 零写入、零撤销记录，
     * 返回的 positions 为计划值、changedCount 为计划发生位移的节点数。界面入口不传。
     */
    dryRun?: boolean,
  ) => Promise<LayoutApplyResult | null>;
  /**
   * 容器内整理的计划模式（CLI canvas.layout --scope group:<id> --dry-run）：
   * 与 autoLayoutContainer 同一算法，零写入、零撤销记录。
   */
  planAutoLayoutContainer: (
    containerId: string,
    options: CanvasGroupAutoLayoutStoreOptions | undefined,
  ) => Promise<LayoutApplyResult | null>;

  // 注释操作
  createAnnotation: (position: NodePosition) => CanvasAnnotation | null;
  addAnnotationForNode: (nodeId: string) => CanvasAnnotation | null;
  /**
   * 批量插入已构造好的注释（用于导入 bundle 时降级注释与显式 annotations 的写入）。
   * 注释是画布级实体，不经过剪贴板 payload 片段格式；位置按 targetPosition 偏移。
   * 整批合并为 1 条历史。
   */
  insertAnnotationsBatch: (
    annotations: CanvasAnnotation[],
    options: { offset: NodePosition | undefined; saveHistory: boolean },
  ) => CanvasAnnotation[];
  updateAnnotation: (annotationId: string, updates: AnnotationUpdatePatch) => void;
  updateAnnotationContent: (annotationId: string, content: string) => void;
  updateAnnotationPosition: (annotationId: string, position: NodePosition) => void;
  updateAnnotationSize: (annotationId: string, size: NodeSize) => void;
  removeAnnotation: (annotationId: string) => void;
  unbindAnnotation: (annotationId: string) => void;
  startAnnotationBinding: (annotationId: string) => void;
  cancelAnnotationBinding: () => void;
  bindAnnotation: (annotationId: string, binding: AnnotationBinding) => boolean;

  // 选择操作
  setEditingAnnotation: (annotationId: string | null) => void;
  projectSelectionContract: (selection: SelectionContractSnapshot) => void;

  // 视图操作
  setViewport: (viewport: NodeGraphViewport) => void;
  fitView: () => void;
  /** 同步画布容器实测尺寸（NodeCanvas 内由 React Flow 内部 store 驱动）；null 表示未测量 */
  setCanvasContainerSize: (size: CanvasContainerSize | null) => void;

  // 画板设置
  setNodeGraphSettings: (settings: Partial<NodeGraphSettings>) => void;
  toggleSnapToGrid: (enabled: boolean | undefined) => void;
  setSnapGrid: (grid: [number, number]) => void;

  // 拖拽/连接状态
  setDragging: (isDragging: boolean) => void;
  setConnecting: (isConnecting: boolean) => void;
  setCanvasInteracting: (isInteracting: boolean) => void;
  setCanvasInteractingDelayed: (isInteracting: boolean) => void;

  // 占位壳态生命周期（spec：画布交互期渲染降级契约.md「占位壳契约」、
  // 画布启动性能与Layout-Model架构.md「ReactFlow 双挂载的消除」启动期占位壳契约）
  /**
   * 标记单节点为占位壳形态（幂等：已在集合则无操作）。
   * 由节点 mount 时的 useLayoutEffect 在交互期调用。
   */
  markNodeAsPlaceholder: (nodeId: string) => void;
  /**
   * 批量把节点加入占位集合（幂等：已在集合则无操作）。
   * 启动期 loadNodeGraph 完成后调用，把全部新加载节点预置为占位壳态，
   * 让 NodeCanvas 在 waiting-interactive 阶段以轻量子树挂载，
   * readiness 通过后由分帧升级调度器批量升为完整形态。
   */
  markNodesAsPlaceholder: (nodeIds: string[]) => void;
  /**
   * 批量从占位集合移除节点（幂等：不在集合则无操作）。
   * 由分帧升级调度器每帧调用，触发组件从占位态重渲染为完整态。
   */
  markNodesAsFull: (nodeIds: string[]) => void;
  /**
   * 清空占位集合（收敛期全部升级完成或中断时调用）。
   */
  clearPlaceholderUpgrade: () => void;

  // 文本节点编辑请求（程序化建边交互：资产落定即连接，spec：程序化建边交互.md）
  requestNodeTextEdit: (nodeId: string) => void;
  clearNodeTextEditRequest: () => void;
  /** 组名内联编辑请求（右键菜单「重命名组」触发，GroupNode 消费后清空） */
  requestGroupRename: (nodeId: string) => void;
  clearGroupRenameRequest: () => void;

  /** Agent 删除确认请求（AG-CT-011 禁旁路：删除入口命中 Agent 节点时写入，确认框宿主消费） */
  requestAgentDeleteConfirm: (nodeIds: string[]) => void;
  clearAgentDeleteConfirmRequest: () => void;

  clearPendingMediaMigrationNotice: () => void;

  // 自动布局
  autoLayout: (options: CanvasAutoLayoutStoreOptions | undefined) => Promise<LayoutApplyResult | null>;
  /**
   * 全局整理的计划模式（CLI `canvas.layout --dry-run`）：与 autoLayout 同一算法，
   * 零写入、零撤销记录；positions 为计划值、changedCount 为计划发生位移的节点数。
   */
  planAutoLayout: (options: CanvasAutoLayoutStoreOptions | undefined) => Promise<LayoutApplyResult | null>;
  /**
   * 带预挂载测量的全局整理（spec：画布自动布局算法.md「全局整理的预挂载测量」）。
   * 编排：设 preLayoutMeasuring=true → 等 measured 覆盖全部参与节点 → 调 autoLayout 核心 → 清标志。
   * 用于标题栏"整理"按钮入口，覆盖冷启动后视口外节点从未挂载、measured 缺失导致落到偏小 default 的场景。
   */
  autoLayoutWithPreMeasure: (options: CanvasAutoLayoutStoreOptions | undefined) => Promise<LayoutApplyResult | null>;

  /**
   * 整理组间布局（CLI `canvas layout --scope containers`）：
   * 把所有最外层容器（组 | 独立 Agent 容器）当整体，只消除容器之间的派生占位相交；
   * 不重叠的容器保持原位，重叠的整组平移到最近空位，内部相对布局不变。
   * 单次 updateNodePositionsBatch 写回 = 单条原子历史；无重叠时返回空 positions。
   */
  layoutContainers: () => Promise<{
    positions: Record<string, NodePosition>;
    changedCount: number;
    /**
     * 本次检查的最外层容器 id（CLI 执行报告 inspected 口径）。附加字段，既有消费者
     * （只读 positions/changedCount）行为不变。
     */
    inspectedContainerIds: string[];
    /** 被跳过的容器与稳定原因短句（no_derived_box / position_search_failed / not_a_container）。 */
    skipped: Array<{ node_id: string; reason: string }>;
  } | null>;

  /**
   * 容器让位的计划模式（CLI `canvas.layout --scope containers --dry-run`）：
   * 与 layoutContainers 同一算法，零写入、零撤销记录。
   */
  planLayoutContainers: () => Promise<{
    positions: Record<string, NodePosition>;
    changedCount: number;
    inspectedContainerIds: string[];
    skipped: Array<{ node_id: string; reason: string }>;
  } | null>;

  // 对齐/分布选中节点（spec：画布节点组.md「对齐作用域」）
  alignSelection: (mode: AlignmentMode) => void;

  // 历史操作
  undo: () => void;
  redo: () => void;
  saveToHistory: () => void;
  commitDeferredHistoryBaseline: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // 剪贴板操作
  copySelectedNodes: () => void;
  pasteClipboardPayload: (payload: ClipboardPayload, targetPosition: NodePosition | undefined) => CanvasPasteResult;
  pasteNodes: (targetPosition: NodePosition | undefined) => CanvasPasteResult;
  hasClipboardContent: () => boolean;

  // taskId 倒排索引查询
  getNodeIdsByTaskId: (taskId: string) => string[];

  // 标记更改
  markAsSaved: (expectedDirtyRevision: number | undefined) => void;
  syncPersistenceState: (state: EditorPersistenceState | null) => void;
  setClosing: (value: boolean) => void;

  // 统一删除调度
  deleteSelectedElements: () => void;

  // 多选图片批量接入生成模型（spec：多选图片批量接入生成模型交互.md）
}

export type CanvasStore = NodeGraphState & NodeGraphActions;
export type CanvasStoreSet = (fn: (state: CanvasStore) => void) => void;
export type CanvasStoreGet = () => CanvasStore;

export type SelectionContractSnapshot = Pick<
  NodeGraphState,
  | 'selectedNodeIds'
  | 'selectedAnnotationIds'
  | 'editingAnnotationId'
  | 'pendingAnnotationBinding'
>;

export type CanvasPasteResult = {
  nodes: GraphNode[];
  nodeIds: string[];
};

const isPendingAnnotationBindingEqual = (
  left: NodeGraphState['pendingAnnotationBinding'],
  right: NodeGraphState['pendingAnnotationBinding']
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.annotationId === right.annotationId;
};

export const isSelectionContractEqual = (
  prev: SelectionContractSnapshot,
  next: SelectionContractSnapshot
): boolean => {
  return (
    areArraysShallowEqual(prev.selectedNodeIds, next.selectedNodeIds) &&
    areArraysShallowEqual(prev.selectedAnnotationIds, next.selectedAnnotationIds) &&
    Object.is(prev.editingAnnotationId, next.editingAnnotationId) &&
    isPendingAnnotationBindingEqual(prev.pendingAnnotationBinding, next.pendingAnnotationBinding)
  );
};

export const createInitialCanvasState = (): NodeGraphState => ({
  nodeGraph: null,
  mediaAssets: {},
  selectedNodeIds: [],
  selectedAnnotationIds: [],
  editingAnnotationId: null,
  pendingAnnotationBinding: null,
  isDragging: false,
  isConnecting: false,
  isCanvasInteracting: false,
  isCanvasInteractingDelayed: false,
  pendingTextEditNodeId: null,
  pendingGroupRenameNodeId: null,
  pendingAgentDeleteConfirmNodeIds: null,
  pendingMediaMigrationNotice: null,
  history: [],
  historyIndex: -1,
  deferredHistoryBaseline: null,
  lastLoadDiagnostics: null,
  maxHistorySize: 50,
  hasUnsavedChanges: false,
  persistenceState: null,
  isClosing: false,
  dirtyRevision: 0,
  dirty: createDirtyState(),
  structureRevision: 0,
  dataRevision: 0,
  taskRevision: 0,
  positionRevision: 0,
  viewportRevision: 0,
  layoutRevision: 0,
  clipboardPayload: null,
  historyBatchActive: false,
  ui: {
    desiredSizeByNodeId: {},
    layoutModelByNodeId: {},
    lastMeasuredSizeByNodeId: {},
    preLayoutMeasuring: false,
    placeholderNodeIds: new Set(),
    canvasContainerSize: null,
    groupDropTargetGroupId: null,
    groupDraggingId: null,
  },
  preparationPhase: 'resolving-project',
  taskIdIndex: new Map(),
});
