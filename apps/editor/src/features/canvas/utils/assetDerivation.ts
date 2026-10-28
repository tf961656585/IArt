import type { MediaAsset } from '@iart/contracts';
import { CANVAS_MEDIA_MAX_DISPLAY_DIMENSION } from '@iart/utils/canvas-geometry';
import { useCanvasStore } from '../store/canvasStore';
import {
  computeDerivedNodePosition,
  DERIVED_NODE_HEIGHT_ESTIMATE,
  DERIVED_NODE_OFFSET_X,
  DERIVED_NODE_WIDTH_ESTIMATE,
} from './derivedNodePlacement';
import { isGroupMember, isContainerNode } from '../services/groupMembership';
import type { GraphNode, AssetNodeData, NodePosition } from '../types';

/**
 * 资产节点加工产出（spec：docs/editor/媒体工具加工.md「产出与非破坏」）。
 *
 * 资产节点选中态工具栏（设计层 node-chrome D19）触发的确定性加工，产出以
 * **独立资产节点**承载（区别于素材节点入口的历史派生 imageInput），源资产与源节点
 * 不变；加工血缘（源资产引用 + 工具标识）写入产出资产节点的 derivedFrom（payload =
 * 资产 metadata 的画布投影），不进入画布关系。
 *
 * 单一图块产出走 `createDerivedAssetNode`；切分成多块（图片分割 / 智能切图）走
 * `createDerivedAssetNodesInGrid`：同一次加工的多块产物一次落布、一次选中、一条历史。
 */

/** 批量派生网格间距（与素材节点入口的分割落布保持一致的行列步长） */
const GRID_GAP_X = 40;
const GRID_GAP_Y = 40;
const DERIVATION_SELECT_REASON = 'asset-derivation';

/**
 * 批量落布的单元格边长（画布 px）。
 *
 * 取值 = 媒体展示尺寸上限（320）+ 间距（40）：同批图块按源图坐标换算后，
 * 相邻整块之间至少留出一个「最大展示尺寸 + 间距」的格子，2×2 就摆成 2×2。
 * 上限常量取自共享几何包，不在此处复制数值。
 */
const BATCH_TILE_CELL = CANVAS_MEDIA_MAX_DISPLAY_DIMENSION + GRID_GAP_X;

/** 整批平移的最大尝试次数（先右移再下移；用尽后接受基准位置并留痕） */
const MAX_BATCH_SHIFT_ATTEMPTS = 8;

export type CreateDerivedAssetNodeParams = {
  /** 源资产节点 id */
  sourceNodeId: string;
  /** 加工产出的资产 id（必须已注册进 mediaAssets 或随 mediaAsset 提供） */
  assetId: string;
  mediaAsset: MediaAsset | null | undefined;
  mediaType: AssetNodeData['mediaType'];
  /** 血缘：源资产 id + 工具注册 id */
  derivedFrom: { sourceAssetId: string; tool: string };
  /** 展示标签（缺省回落工具 id） */
  label?: string | undefined;
  /** 显式落点（批量派生按切分/切图坐标排布时给出；缺省走单图派生落位规则） */
  position?: NodePosition | undefined;
  selectNodes?: ((nodeIds: string[], reason: string) => void) | undefined;
};

/** 分块的原始切分几何（源图像素，左上角为原点） */
export type DerivedAssetSourceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * 批量派生的单块描述。
 *
 * - 给出 `sourceRect`（源图像素）时按源图坐标换算画布位置，保持原图内部布局
 *   （2×2 摆成 2×2，不再纵向顺延成长列）。
 * - 只给出 `row`/`col`（0-based 网格坐标）时退化为等距网格兜底。
 */
export type DerivedAssetGridItem = {
  assetId: string;
  mediaAsset: MediaAsset | null | undefined;
  label: string;
  /** 原始切分几何；整批齐全且提供 `sourceSize` 时按源图坐标排布 */
  sourceRect?: DerivedAssetSourceRect | undefined;
  /** 无 `sourceRect` 时的网格行坐标（0-based） */
  row?: number | undefined;
  /** 无 `sourceRect` 时的网格列坐标（0-based） */
  col?: number | undefined;
};

export type BatchSourceSize = {
  width: number;
  height: number;
};

export type CreateDerivedAssetNodesInGridParams = {
  /** 源资产节点 id */
  sourceNodeId: string;
  mediaType: AssetNodeData['mediaType'];
  /** 血缘：源资产 id + 工具注册 id（整批同源同工具） */
  derivedFrom: { sourceAssetId: string; tool: string };
  /** 源图总宽高（源图像素）；与 item.sourceRect 一起决定按源图坐标换算的比例 */
  sourceSize?: BatchSourceSize | undefined;
  items: DerivedAssetGridItem[];
  selectNodes?: ((nodeIds: string[], reason: string) => void) | undefined;
};

const buildAssetNodeData = (params: {
  assetId: string;
  mediaType: AssetNodeData['mediaType'];
  derivedFrom: { sourceAssetId: string; tool: string };
  label: string | undefined;
}): AssetNodeData => ({
  label: params.label ?? params.derivedFrom.tool,
  sourceBatchId: '',
  sourceTaskId: '',
  sourceModelId: '',
  mediaType: params.mediaType,
  assetId: params.assetId,
  derivedFrom: {
    sourceAssetId: params.derivedFrom.sourceAssetId,
    tool: params.derivedFrom.tool,
  },
  outpaintTaskId: undefined,
});

/**
 * 在给定落点创建一个派生资产节点（不注册 mediaAssets、不选中）。
 * 批量与单个入口共用的唯一建节点实现。
 */
const createAssetNodeAt = (params: {
  sourceNode: GraphNode;
  position: NodePosition;
  assetId: string;
  mediaType: AssetNodeData['mediaType'];
  derivedFrom: { sourceAssetId: string; tool: string };
  label: string | undefined;
}): GraphNode<AssetNodeData> | null => {
  const { addNode } = useCanvasStore.getState();
  // 成员节点创建落布的系统默认初值（组 spec「成员节点创建落布时自动建立为默认初值」）：
  // 源在容器内 → 派生品入同组；源无组 → 不传 membership，自由落布。
  // 目标非法时由 addNode 的 membership 通道降级为自由节点并留痕，不裸写 groupId。
  const membership =
    isGroupMember(params.sourceNode) && params.sourceNode.groupId !== undefined
      ? { groupId: params.sourceNode.groupId }
      : undefined;
  const newNode = addNode(
    'asset',
    params.position,
    buildAssetNodeData({
      assetId: params.assetId,
      mediaType: params.mediaType,
      derivedFrom: params.derivedFrom,
      label: params.label,
    }),
    membership,
  );
  return newNode === null ? null : (newNode as GraphNode<AssetNodeData>);
};

const findSourceNode = (sourceNodeId: string): GraphNode | null =>
  useCanvasStore.getState().nodeGraph?.nodes.find((node) => node.id === sourceNodeId) ?? null;

const registerMediaAssets = (assets: ReadonlyArray<MediaAsset | null | undefined>): void => {
  const patch: Record<string, MediaAsset> = {};
  for (const mediaAsset of assets) {
    if (mediaAsset !== null && mediaAsset !== undefined && mediaAsset.id) {
      patch[mediaAsset.id] = mediaAsset;
    }
  }
  if (Object.keys(patch).length === 0) return;
  useCanvasStore.getState().setProjectMediaAssets(patch, { source: 'user-action' });
};

export const createDerivedAssetNode = (
  params: CreateDerivedAssetNodeParams,
): GraphNode<AssetNodeData> | null => {
  if (!params.assetId) return null;

  const sourceNode = findSourceNode(params.sourceNodeId);
  if (!sourceNode) {
    console.debug('[assetDerivation] source node not found, skip derive', {
      sourceNodeId: params.sourceNodeId,
    });
    return null;
  }

  registerMediaAssets([params.mediaAsset]);

  const position =
    params.position ??
    computeDerivedNodePosition(sourceNode, useCanvasStore.getState().nodeGraph?.nodes ?? [], undefined);

  const newNode = createAssetNodeAt({
    sourceNode,
    position,
    assetId: params.assetId,
    mediaType: params.mediaType,
    derivedFrom: params.derivedFrom,
    label: params.label,
  });
  if (!newNode) return null;

  params.selectNodes?.([newNode.id], DERIVATION_SELECT_REASON);
  return newNode;
};

/** 单块在画布上的相对落点与占位尺寸（相对批基准点） */
type BatchItemBox = {
  offset: NodePosition;
  width: number;
  height: number;
};

type NodeBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const toNodeBox = (position: NodePosition, width: number, height: number): NodeBox => ({
  left: position.x,
  top: position.y,
  right: position.x + Math.max(width, 1),
  bottom: position.y + Math.max(height, 1),
});

const boxesOverlap = (a: NodeBox, b: NodeBox): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * 把整批图块换算成相对落点与占位尺寸。
 *
 * 有完整原始几何（每块 `sourceRect` + 源图 `sourceSize`，且每块都落在源图范围内）时
 * 按「源图坐标 → 画布位置」等比换算：同批最大图块映射为一个展示格（`BATCH_TILE_CELL`），
 * 其余按原始宽高等比缩放，原图的相对左右 / 上下关系与行列结构保持不变。逐轴取最大值是
 * 为了让极宽或极高的图块不会把另一轴的整批间距压扁。
 *
 * 降级口径：几何缺失 / 越界（坐标系不一致）时退化为等距网格（`row`/`col`）并留痕。
 * 节点自身的显示尺寸由布局模型按媒体宽高比派生，本函数只负责相对位置——因此整批不可能
 * 因单块尺寸未知而错乱。
 */
const computeBatchItemBoxes = (params: {
  items: DerivedAssetGridItem[];
  sourceSize: BatchSourceSize | undefined;
}): BatchItemBox[] => {
  const geometryRects: DerivedAssetSourceRect[] = [];
  const declaredSize = params.sourceSize;
  const sourceSize =
    declaredSize !== undefined && declaredSize.width > 0 && declaredSize.height > 0
      ? declaredSize
      : undefined;

  if (sourceSize !== undefined) {
    for (const item of params.items) {
      const rect = item.sourceRect;
      if (rect === undefined) {
        geometryRects.length = 0;
        break;
      }
      const withinSource =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= sourceSize.width + 1 &&
        rect.y + rect.height <= sourceSize.height + 1;
      if (!withinSource) {
        geometryRects.length = 0;
        break;
      }
      geometryRects.push(rect);
    }
  }

  if (sourceSize !== undefined && geometryRects.length === params.items.length) {
    const maxWidth = Math.max(...geometryRects.map((rect) => rect.width), 1);
    const maxHeight = Math.max(...geometryRects.map((rect) => rect.height), 1);
    const scaleX = BATCH_TILE_CELL / maxWidth;
    const scaleY = BATCH_TILE_CELL / maxHeight;
    return geometryRects.map((rect) => ({
      offset: { x: rect.x * scaleX, y: rect.y * scaleY },
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    }));
  }

  if (params.items.some((item) => item.sourceRect !== undefined)) {
    console.debug('[assetDerivation] source geometry incomplete, fall back to grid placement', {
      itemCount: params.items.length,
      sourceSize,
    });
  }

  return params.items.map((item) => ({
    offset: {
      x: (item.col ?? 0) * BATCH_TILE_CELL,
      y: (item.row ?? 0) * BATCH_TILE_CELL,
    },
    width: BATCH_TILE_CELL,
    height: BATCH_TILE_CELL,
  }));
};

/**
 * 整批落点：基准点在源节点右侧。
 *
 * 与既有节点重叠时**整批平移**（先按整批宽度右移，再按整批高度下移），
 * 不逐块下推——逐块下推会把 2×2 拉成长列，破坏原图内部布局。
 *
 * 容器节点（组 / Agent 容器）与源节点自身不参与碰撞：容器是成员的承载面，
 * 不是障碍物；源节点已在基准点左侧留出偏移量。
 */
const resolveBatchOrigin = (params: {
  existingNodes: GraphNode[];
  sourceNodeId: string;
  base: NodePosition;
  boxes: BatchItemBox[];
}): NodePosition => {
  const existingBoxes = params.existingNodes
    .filter((node) => node.id !== params.sourceNodeId && !isContainerNode(node))
    .map((node) =>
      toNodeBox(node.position, DERIVED_NODE_WIDTH_ESTIMATE, DERIVED_NODE_HEIGHT_ESTIMATE),
    );

  const collides = (dx: number, dy: number): boolean =>
    params.boxes.some((item) => {
      const box = toNodeBox(
        {
          x: params.base.x + dx + item.offset.x,
          y: params.base.y + dy + item.offset.y,
        },
        item.width,
        item.height,
      );
      return existingBoxes.some((existing) => boxesOverlap(box, existing));
    });

  const batchWidth = Math.max(...params.boxes.map((item) => item.offset.x + item.width), 1);
  const batchHeight = Math.max(...params.boxes.map((item) => item.offset.y + item.height), 1);

  for (let attempt = 0; attempt <= MAX_BATCH_SHIFT_ATTEMPTS; attempt += 1) {
    const dx = attempt * (batchWidth + GRID_GAP_X);
    if (!collides(dx, 0)) return { x: params.base.x + dx, y: params.base.y };
  }
  for (let attempt = 1; attempt <= MAX_BATCH_SHIFT_ATTEMPTS; attempt += 1) {
    const dy = attempt * (batchHeight + GRID_GAP_Y);
    if (!collides(0, dy)) return { x: params.base.x, y: params.base.y + dy };
  }

  console.debug('[assetDerivation] batch placement kept base position after shift attempts', {
    base: params.base,
    itemCount: params.boxes.length,
  });
  return { x: params.base.x, y: params.base.y };
};

/**
 * 批量派生（图片分割 / 智能切图的全部图块）：每块一个独立资产节点。
 *
 * - 落点：按每块的原始切分几何（源图像素）换算画布相对位置，整批从源节点右侧起步，
 *   保持原图内部布局；与既有节点重叠时整批平移（先右后下），不逐块下推。
 * - 血缘：整批同一 `derivedFrom`（源资产 id + 工具 id）。
 * - 历史：整批一次落布 = 一条历史（外层已开批则并入外层）。
 * - 选中：created 全部一次性选中。
 */
export const createDerivedAssetNodesInGrid = (
  params: CreateDerivedAssetNodesInGridParams,
): GraphNode<AssetNodeData>[] | null => {
  if (params.items.length === 0) return null;
  if (params.items.some((item) => !item.assetId)) return null;

  const sourceNode = findSourceNode(params.sourceNodeId);
  if (!sourceNode) {
    console.debug('[assetDerivation] source node not found, skip batch derive', {
      sourceNodeId: params.sourceNodeId,
      itemCount: params.items.length,
    });
    return null;
  }

  registerMediaAssets(params.items.map((item) => item.mediaAsset));

  const existingNodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
  const boxes = computeBatchItemBoxes({ items: params.items, sourceSize: params.sourceSize });
  const origin = resolveBatchOrigin({
    existingNodes,
    sourceNodeId: params.sourceNodeId,
    base: { x: sourceNode.position.x + DERIVED_NODE_OFFSET_X, y: sourceNode.position.y },
    boxes,
  });

  const historyBatchWasActive = useCanvasStore.getState().historyBatchActive;
  if (!historyBatchWasActive) {
    useCanvasStore.setState((state) => {
      state.historyBatchActive = true;
    });
  }

  const created: GraphNode<AssetNodeData>[] = [];
  for (const [index, item] of params.items.entries()) {
    const box = boxes[index];
    if (box === undefined) continue;
    const node = createAssetNodeAt({
      sourceNode,
      position: { x: origin.x + box.offset.x, y: origin.y + box.offset.y },
      assetId: item.assetId,
      mediaType: params.mediaType,
      derivedFrom: params.derivedFrom,
      label: item.label,
    });
    if (!node) continue;
    created.push(node);
  }

  if (!historyBatchWasActive) {
    useCanvasStore.setState((state) => {
      state.historyBatchActive = false;
    });
    if (created.length > 0) useCanvasStore.getState().saveToHistory();
  }

  if (created.length === 0) return null;

  params.selectNodes?.(
    created.map((node) => node.id),
    DERIVATION_SELECT_REASON,
  );
  return created;
};

/** 扩图（异步 AI 加工）提交时记录任务引用；成功投影由 taskProjectionService 回填。 */
export const bindOutpaintTaskToAssetNode = (nodeId: string, taskId: string): void => {
  useCanvasStore.getState().updateNodeData(
    nodeId,
    { outpaintTaskId: taskId } satisfies Partial<AssetNodeData>,
    'asset-outpaint',
  );
};

/**
 * 扩图成功回填：把产出资产注册进 mediaAssets 并把持有该扩图任务的资产节点
 * assetId 换成结果资产、清除 outpaintTaskId。
 * 由 taskProjectionService 在匹配到 outpaintTaskId 的成功终态时调用。
 */
export const applyOutpaintResultToAssetNode = (params: {
  nodeId: string;
  resultAssetId: string;
  mediaAsset: MediaAsset | null | undefined;
}): void => {
  const state = useCanvasStore.getState();
  if (params.mediaAsset !== null && params.mediaAsset !== undefined && params.mediaAsset.id) {
    state.setProjectMediaAssets(
      { [params.mediaAsset.id]: params.mediaAsset },
      { source: 'backend-notification' },
    );
  }
  state.updateNodeData(
    params.nodeId,
    {
      assetId: params.resultAssetId,
      outpaintTaskId: undefined,
    } satisfies Partial<AssetNodeData>,
    'asset-outpaint-result',
  );
};
