import type {
  CliCanvasGeometrySnapshot,
  CliCanvasInspectAnnotation,
  CliCanvasInspectContainer,
  CliCanvasInspectMinGap,
  CliCanvasInspectNearestNeighbor,
  CliCanvasInspectNode,
  CliCanvasInspectNodeAsset,
  CliCanvasInspectOverlap,
  CliCanvasInspectResult,
  CliCanvasInspectSceneViewport,
  CliCanvasInspectUnplacedAsset,
  RuntimeMediaAssetView,
} from "@iart/contracts";
import {
  CANVAS_DEFAULT_AGENT_SIZE,
  CANVAS_DEFAULT_ASSET_SIZE,
  CANVAS_DEFAULT_MEDIA_INPUT_SIZE,
  CANVAS_DEFAULT_NODE_SIZE,
  computeCanvasAudioNodeSize,
  computeCanvasMediaNodeSize,
  computeGroupRenderBox,
  type CanvasMemberGeometry,
  type CanvasSize,
} from "@iart/utils/canvas-geometry";

import { resolveLocalMediaFilePath } from "./cli-canvas-projection.cjs";
import type { CliAssetGenerationSource } from "./cli-storage-queries.cjs";

/**
 * 画布场景图投影（`canvas.inspect` 的纯函数实现）。
 *
 * 输入是 Editor 持久化的节点 payload（nodes.payloadJson 原样）、画布注释载荷
 * （graph.annotations 原样）、项目媒体资产与生成来源索引；输出 `CliCanvasInspectResult`。
 * 全部几何公式来自共享模块 `@iart/utils/canvas-geometry`，本模块只做数据形状解析、
 * 身份 join 与容器两遍派生编排。
 *
 * 输出分档（批次 1a）：
 * - compact（缺省）：节点不嵌套 asset 摘要；节点级 prompt_preview 截断 200 字符；
 * - full（`--full`）：嵌套 asset 摘要 + 完整提示词；
 * - `--prompt-limit N`：优先级最高，0 = 不输出提示词（null），N>0 截断到 N 字符；
 * - `--group <容器id>`：只输出该容器、其后代节点/嵌套容器与绑定到这些节点的注释；
 * - `--no-unplaced`：不输出未落画布资产。
 *
 * fidelity 语义：
 * - derived：几何由持久化数据离线算出（项目未打开也可用），viewport/selection 为 null；
 * - exact：传入窗口侧 `canvas.geometry.get` 快照，且每个画布节点与容器都拿到精确几何时，
 *   用精确尺寸/容器框合并；任一缺失整体降回 derived 并 debug 留痕（不部分冒充 exact）。
 *
 * 容器 position 口径：展开态容器位置由成员包围盒派生（computeGroupRenderBox），绝不使用
 * 持久化的组 position；只有折叠态（Editor 语义本就是保持原位）与空容器（没有任何成员
 * 几何可派生，只能以持久化 position 为锚点）会读取持久化位置，并 debug 留痕。
 */

/** 持有资产引用的节点类型全集（与 cli-canvas-projection 的资产引用口径一致）。 */
const ASSET_REFERENCE_NODE_TYPES: ReadonlySet<string> = new Set([
  "asset",
  "imageInput",
  "videoInput",
  "audioInput",
]);

const isContainerNodeType = (nodeType: string): boolean => nodeType === "group" || nodeType === "agent";

/** compact 档提示词缺省截断长度（字符）。 */
const PROMPT_PREVIEW_LIMIT = 200;

interface MediaMeta {
  width: number;
  height: number;
  aspectRatio: number | null;
}

interface RawNodeData {
  label: string | null;
  name: string | null;
  assetId: string | null;
  taskId: string | null;
  batchId: string | null;
  sourceBatchId: string | null;
  sourceTaskId: string | null;
  createdAt: number | null;
  mediaType: string | null;
  imageMeta: MediaMeta | null;
  videoMeta: MediaMeta | null;
  audioUrl: string | null;
  segmentsCount: number;
  segmentModeEnabled: boolean;
  collapsed: boolean;
}

interface RawCanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  groupId: string | null;
  data: RawNodeData;
}

interface RawAnnotation {
  annotation_id: string;
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  boundToNodeId: string | null;
}

/** 投影构建结果：`--group` 指向不存在的容器时由调用方映射 `group_not_found`。 */
export type CanvasInspectBuildOutcome =
  | { ok: true; result: CliCanvasInspectResult }
  | { ok: false; reason: "group_not_found" };

const readFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readPositiveNumber = (value: unknown): number | null => {
  const parsed = readFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const readMediaMeta = (value: unknown): MediaMeta | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { width?: unknown; height?: unknown; aspectRatio?: unknown };
  const width = readPositiveNumber(raw.width);
  const height = readPositiveNumber(raw.height);
  if (width === null || height === null) return null;
  return { width, height, aspectRatio: readPositiveNumber(raw.aspectRatio) };
};

/** 持久化节点 payload → 投影用的收窄行；缺 id/type/position 的载荷返回 null（调用方留痕跳过）。 */
const parseCanvasNodePayload = (payload: unknown): RawCanvasNode | null => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as { id?: unknown; type?: unknown; position?: unknown; groupId?: unknown; data?: unknown };
  const id = typeof raw.id === "string" ? raw.id : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  const position =
    raw.position !== null && typeof raw.position === "object"
      ? (raw.position as { x?: unknown; y?: unknown })
      : null;
  const x = position !== null ? readFiniteNumber(position.x) : null;
  const y = position !== null ? readFiniteNumber(position.y) : null;
  if (id.length === 0 || type.length === 0 || x === null || y === null) return null;
  const data =
    raw.data !== null && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? (raw.data as {
          label?: unknown;
          name?: unknown;
          assetId?: unknown;
          taskId?: unknown;
          batchId?: unknown;
          sourceBatchId?: unknown;
          sourceTaskId?: unknown;
          createdAt?: unknown;
          mediaType?: unknown;
          imageMeta?: unknown;
          videoMeta?: unknown;
          audioUrl?: unknown;
          segments?: unknown;
          segmentModeEnabled?: unknown;
          collapsed?: unknown;
        })
      : null;
  const segmentsCount = data !== null && Array.isArray(data.segments) ? data.segments.length : 0;
  return {
    id,
    type,
    position: { x, y },
    groupId: readNonEmptyString(raw.groupId),
    data: {
      label: data !== null ? readNonEmptyString(data.label) : null,
      name: data !== null ? readNonEmptyString(data.name) : null,
      assetId: data !== null ? readNonEmptyString(data.assetId) : null,
      taskId: data !== null ? readNonEmptyString(data.taskId) : null,
      batchId: data !== null ? readNonEmptyString(data.batchId) : null,
      sourceBatchId: data !== null ? readNonEmptyString(data.sourceBatchId) : null,
      sourceTaskId: data !== null ? readNonEmptyString(data.sourceTaskId) : null,
      createdAt: data !== null ? readFiniteNumber(data.createdAt) : null,
      mediaType: data !== null ? readNonEmptyString(data.mediaType) : null,
      imageMeta: data !== null ? readMediaMeta(data.imageMeta) : null,
      videoMeta: data !== null ? readMediaMeta(data.videoMeta) : null,
      audioUrl: data !== null ? readNonEmptyString(data.audioUrl) : null,
      segmentsCount,
      segmentModeEnabled: data !== null && data.segmentModeEnabled === true,
      collapsed: data !== null && data.collapsed === true,
    },
  };
};

/** 持久化注释 payload → 投影收窄行；缺 id/position/size 的注释返回 null（调用方留痕跳过）。 */
const parseAnnotationPayload = (payload: unknown): RawAnnotation | null => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as {
    id?: unknown;
    content?: unknown;
    position?: unknown;
    size?: unknown;
    binding?: unknown;
  };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (id.length === 0) return null;
  const position =
    raw.position !== null && typeof raw.position === "object"
      ? (raw.position as { x?: unknown; y?: unknown })
      : null;
  const size =
    raw.size !== null && typeof raw.size === "object"
      ? (raw.size as { width?: unknown; height?: unknown })
      : null;
  const x = position !== null ? readFiniteNumber(position.x) : null;
  const y = position !== null ? readFiniteNumber(position.y) : null;
  const width = size !== null ? readFiniteNumber(size.width) : null;
  const height = size !== null ? readFiniteNumber(size.height) : null;
  if (x === null || y === null || width === null || height === null) return null;
  const binding =
    raw.binding !== null && typeof raw.binding === "object" && !Array.isArray(raw.binding)
      ? (raw.binding as { type?: unknown; nodeId?: unknown })
      : null;
  const boundToNodeId =
    binding !== null && binding.type === "node" && typeof binding.nodeId === "string" && binding.nodeId.length > 0
      ? binding.nodeId
      : null;
  return {
    annotation_id: id,
    content: typeof raw.content === "string" ? raw.content : "",
    position: { x, y },
    size: { width, height },
    boundToNodeId,
  };
};

const readAssetOriginalMeta = (asset: RuntimeMediaAssetView): MediaMeta | null => {
  const width = readPositiveNumber(asset.original.width);
  const height = readPositiveNumber(asset.original.height);
  if (width === null || height === null) return null;
  return { width, height, aspectRatio: width / height };
};

/**
 * 节点尺寸（画布本体尺寸）：媒体节点按媒体展示尺寸、音频按音频策略、任务与 Agent 与
 * 未知类型按共享常量兜底。容器节点不走本函数（由容器两遍派生给出）。
 */
const resolveLeafNodeSize = (
  node: RawCanvasNode,
  assetById: ReadonlyMap<string, RuntimeMediaAssetView>,
): CanvasSize => {
  switch (node.type) {
    case "asset": {
      const asset = node.data.assetId !== null ? assetById.get(node.data.assetId) : undefined;
      const mediaType = node.data.mediaType ?? asset?.mediaType ?? null;
      if (mediaType !== "image" && mediaType !== "video") return { ...CANVAS_DEFAULT_ASSET_SIZE };
      const meta = asset !== undefined ? readAssetOriginalMeta(asset) : node.data.imageMeta ?? node.data.videoMeta;
      return computeCanvasMediaNodeSize({
        media: meta,
        defaultAspectRatio: mediaType === "image" ? 3 / 2 : 16 / 9,
        fallback: CANVAS_DEFAULT_ASSET_SIZE,
      });
    }
    case "imageInput":
    case "videoInput": {
      const asset = node.data.assetId !== null ? assetById.get(node.data.assetId) : undefined;
      const meta =
        (asset !== undefined ? readAssetOriginalMeta(asset) : null) ??
        (node.type === "imageInput" ? node.data.imageMeta : node.data.videoMeta);
      return computeCanvasMediaNodeSize({
        media: meta,
        defaultAspectRatio: node.type === "imageInput" ? 3 / 2 : 16 / 9,
        fallback: CANVAS_DEFAULT_MEDIA_INPUT_SIZE,
      });
    }
    case "audioInput":
      return computeCanvasAudioNodeSize({
        segmentsCount: node.data.segmentsCount,
        segmentModeEnabled: node.data.segmentModeEnabled,
        hasAudioUrl: node.data.audioUrl !== null,
      });
    case "agent":
      return { ...CANVAS_DEFAULT_AGENT_SIZE };
    case "task":
    default:
      return { ...CANVAS_DEFAULT_NODE_SIZE };
  }
};

/** 提示词截断：limit=null 不截断，limit=0 不输出，limit>0 截断并追加省略号。 */
const toPromptPreview = (prompt: string | null, limit: number | null): string | null => {
  if (prompt === null || limit === 0) return null;
  if (limit === null || prompt.length <= limit) return prompt;
  return `${prompt.slice(0, limit)}…`;
};

const toIsoCreatedAt = (createdAt: number | null): string | null => {
  if (createdAt === null || !Number.isFinite(createdAt)) return null;
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** 资产节点 / 素材节点的共同身份来源：节点 payload 的来源键优先，生成来源索引兜底。 */
interface NodeIdentity {
  assetId: string | null;
  asset: RuntimeMediaAssetView | undefined;
  generation: CliAssetGenerationSource | undefined;
  taskId: string | null;
  batchId: string | null;
  createdAt: number | null;
  prompt: string | null;
  sourceFileName: string | null;
}

const resolveNodeIdentity = (params: {
  node: RawCanvasNode;
  assetById: ReadonlyMap<string, RuntimeMediaAssetView>;
  generationIndex: ReadonlyMap<string, CliAssetGenerationSource>;
  promptByTaskId: ReadonlyMap<string, string | null>;
}): NodeIdentity | null => {
  const { node } = params;
  if (!ASSET_REFERENCE_NODE_TYPES.has(node.type)) return null;
  const assetId = node.data.assetId;
  const asset = assetId !== null ? params.assetById.get(assetId) : undefined;
  if (assetId !== null && asset === undefined) {
    console.debug("[cli-canvas-inspect] 节点引用的资产不在项目库，asset 摘要输出 null", {
      nodeId: node.id,
      assetId,
    });
  }
  const generation = assetId !== null ? params.generationIndex.get(assetId) : undefined;
  const sourceTaskId = node.data.sourceTaskId ?? generation?.taskId ?? null;
  const createdAt = asset?.lifecycle.createdAt ?? generation?.taskCreatedAt ?? null;
  return {
    assetId,
    asset,
    generation,
    taskId: sourceTaskId,
    batchId: node.data.sourceBatchId ?? generation?.batchId ?? null,
    createdAt,
    prompt: generation?.prompt ?? (sourceTaskId !== null ? params.promptByTaskId.get(sourceTaskId) ?? null : null),
    sourceFileName: asset?.original.sourceFileName ?? null,
  };
};

const buildNodeAsset = (params: {
  identity: NodeIdentity;
  projectPath: string;
  promptLimit: number | null;
}): CliCanvasInspectNodeAsset | null => {
  const { identity } = params;
  if (identity.assetId === null || identity.asset === undefined) return null;
  const asset = identity.asset;
  return {
    asset_id: identity.assetId,
    media_type: asset.mediaType,
    width: readPositiveNumber(asset.original.width),
    height: readPositiveNumber(asset.original.height),
    file_name: asset.original.sourceFileName,
    batch_id: identity.batchId,
    task_id: identity.taskId,
    model_id: identity.generation?.modelId ?? null,
    prompt_preview: toPromptPreview(identity.prompt, params.promptLimit),
    created_at: toIsoCreatedAt(asset.lifecycle.createdAt),
    local_file_path: resolveLocalMediaFilePath(params.projectPath, asset),
  };
};

const buildUnplacedAssets = (params: {
  assets: readonly RuntimeMediaAssetView[];
  referencedAssetIds: ReadonlySet<string>;
  generationIndex: ReadonlyMap<string, CliAssetGenerationSource>;
}): CliCanvasInspectUnplacedAsset[] => {
  const unplaced: CliCanvasInspectUnplacedAsset[] = [];
  for (const asset of params.assets) {
    if (params.referencedAssetIds.has(asset.assetId)) continue;
    unplaced.push({
      asset_id: asset.assetId,
      media_type: asset.mediaType,
      file_name: asset.original.sourceFileName,
      created_at: toIsoCreatedAt(asset.lifecycle.createdAt),
      // 未落画布资产没有节点上下文可承载来源批次，改由生成来源索引回填；
      // 导入素材等无产出来源的资产如实输出 null。
      batch_id: params.generationIndex.get(asset.assetId)?.batchId ?? null,
    });
  }
  return unplaced;
};

const toBBox = (position: { x: number; y: number }, size: CanvasSize): {
  x: number;
  y: number;
  width: number;
  height: number;
} => ({ x: position.x, y: position.y, width: size.width, height: size.height });

interface ContainerPair {
  aId: string;
  bId: string;
  gap: number;
  overlapWidth: number;
  overlapHeight: number;
}

/**
 * 两个包围盒的 Chebyshev 间距：`dx = max(a.x-(b.x+b.w), b.x-(a.x+a.w))`，dy 同；
 * `gap = max(dx,dy)`。gap<0 即两框相交（overlap 尺寸同时给出）。
 */
const measurePair = (
  aId: string,
  bId: string,
  a: CliCanvasInspectContainer,
  b: CliCanvasInspectContainer,
): ContainerPair => {
  const dx = Math.max(a.position.x - (b.position.x + b.size.width), b.position.x - (a.position.x + a.size.width));
  const dy = Math.max(a.position.y - (b.position.y + b.size.height), b.position.y - (a.position.y + a.size.height));
  return {
    aId,
    bId,
    gap: Math.max(dx, dy),
    overlapWidth: Math.min(a.position.x + a.size.width, b.position.x + b.size.width) - Math.max(a.position.x, b.position.x),
    overlapHeight:
      Math.min(a.position.y + a.size.height, b.position.y + b.size.height) - Math.max(a.position.y, b.position.y),
  };
};

/** 顶层容器两两几何（只取 `group_id == null` 的容器，按标识升序稳定配对）。 */
const collectTopLevelPairs = (containers: readonly CliCanvasInspectContainer[]): ContainerPair[] => {
  const sorted = [...containers].sort((left, right) => left.group_node_id.localeCompare(right.group_node_id));
  const pairs: ContainerPair[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (a === undefined || b === undefined) continue;
      pairs.push(measurePair(a.group_node_id, b.group_node_id, a, b));
    }
  }
  return pairs;
};

const pickMinGap = (pairs: readonly ContainerPair[]): CliCanvasInspectMinGap | null => {
  if (pairs.length === 0) return null;
  let best = pairs[0];
  if (best === undefined) return null;
  for (const pair of pairs) {
    if (pair.gap < best.gap) best = pair;
  }
  return { a_id: best.aId, b_id: best.bId, gap: best.gap };
};

const buildOverlaps = (pairs: readonly ContainerPair[]): CliCanvasInspectOverlap[] =>
  pairs
    .filter((pair) => pair.gap < 0)
    .map((pair) => ({
      a_id: pair.aId,
      b_id: pair.bId,
      overlap_width: pair.overlapWidth,
      overlap_height: pair.overlapHeight,
    }));

const buildNearestNeighbors = (
  containers: readonly CliCanvasInspectContainer[],
  pairs: readonly ContainerPair[],
): ReadonlyMap<string, CliCanvasInspectNearestNeighbor | null> => {
  const nearest = new Map<string, CliCanvasInspectNearestNeighbor | null>();
  for (const container of containers) {
    nearest.set(container.group_node_id, null);
  }
  if (containers.length < 2) return nearest;
  for (const pair of pairs) {
    const applyNeighbor = (containerId: string, neighborId: string): void => {
      const current = nearest.get(containerId) ?? null;
      if (current === null || pair.gap < current.gap || (pair.gap === current.gap && neighborId < current.node_id)) {
        nearest.set(containerId, { node_id: neighborId, gap: pair.gap });
      }
    };
    applyNeighbor(pair.aId, pair.bId);
    applyNeighbor(pair.bId, pair.aId);
  }
  return nearest;
};

/** `--group` 作用域：目标容器 + 其全部后代节点/嵌套容器；容器不存在返回 null。 */
const collectGroupScope = (nodes: readonly RawCanvasNode[], groupId: string): Set<string> | null => {
  const target = nodes.find((node) => node.id === groupId && isContainerNodeType(node.type));
  if (target === undefined) return null;
  const scope = new Set<string>([target.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.id === target.id || scope.has(node.id)) continue;
      if (node.groupId !== null && scope.has(node.groupId)) {
        scope.add(node.id);
        changed = true;
      }
    }
  }
  return scope;
};

/**
 * 画布场景图投影。
 *
 * `exact` 传入窗口侧 `canvas.geometry.get` 快照；只有每个画布节点与容器都拿到精确几何时
 * 才合并为 fidelity=exact，否则（含传 null）输出 derived 且 viewport/selection 为 null。
 */
export const buildCanvasInspectResult = (params: {
  projectPath: string;
  payloads: readonly unknown[];
  annotations: readonly unknown[];
  assets: readonly RuntimeMediaAssetView[];
  generationIndex: ReadonlyMap<string, CliAssetGenerationSource>;
  exact: CliCanvasGeometrySnapshot | null;
  full: boolean;
  promptLimit: number | null;
  group: string | null;
  includeUnplaced: boolean;
}): CanvasInspectBuildOutcome => {
  const parsedNodes: RawCanvasNode[] = [];
  const seenNodeIds = new Set<string>();
  for (const payload of params.payloads) {
    const node = parseCanvasNodePayload(payload);
    if (node === null) {
      console.debug("[cli-canvas-inspect] 节点载荷缺 id/type/position，跳过该节点");
      continue;
    }
    if (seenNodeIds.has(node.id)) {
      console.debug("[cli-canvas-inspect] 节点标识重复，保留首个", { nodeId: node.id });
      continue;
    }
    seenNodeIds.add(node.id);
    parsedNodes.push(node);
  }

  const parsedAnnotations: RawAnnotation[] = [];
  for (const payload of params.annotations) {
    const annotation = parseAnnotationPayload(payload);
    if (annotation === null) {
      console.debug("[cli-canvas-inspect] 注释载荷缺 id/position/size，跳过该注释");
      continue;
    }
    parsedAnnotations.push(annotation);
  }
  if (params.annotations.length === 0) {
    console.debug("[cli-canvas-inspect] 画布图无注释，annotations 输出空集合", {
      projectPath: params.projectPath,
    });
  }

  const scopedIds = params.group !== null ? collectGroupScope(parsedNodes, params.group) : null;
  if (params.group !== null && scopedIds === null) {
    console.debug("[cli-canvas-inspect] --group 指向的容器不存在", { group: params.group });
    return { ok: false, reason: "group_not_found" };
  }

  const assetById = new Map(params.assets.map((asset) => [asset.assetId, asset] as const));
  const promptByTaskId = new Map<string, string | null>();
  for (const generation of params.generationIndex.values()) {
    if (!promptByTaskId.has(generation.taskId)) {
      promptByTaskId.set(generation.taskId, generation.prompt);
    }
  }

  // 提示词截断优先级：--prompt-limit > --full / compact 缺省。
  const promptLimit = params.promptLimit ?? (params.full ? null : PROMPT_PREVIEW_LIMIT);

  const allLeafNodes = parsedNodes.filter((node) => !isContainerNodeType(node.type));
  const allContainerNodes = parsedNodes.filter((node) => isContainerNodeType(node.type));
  const leafNodes = scopedIds === null ? allLeafNodes : allLeafNodes.filter((node) => scopedIds.has(node.id));
  const containerNodes =
    scopedIds === null ? allContainerNodes : allContainerNodes.filter((node) => scopedIds.has(node.id));

  const membersByContainerId = new Map<string, RawCanvasNode[]>();
  for (const node of parsedNodes) {
    if (node.type === "group" || node.groupId === null) continue;
    const members = membersByContainerId.get(node.groupId);
    if (members === undefined) {
      membersByContainerId.set(node.groupId, [node]);
    } else {
      members.push(node);
    }
  }

  const sizeByNodeId = new Map<string, CanvasSize>();
  for (const node of allLeafNodes) {
    sizeByNodeId.set(node.id, resolveLeafNodeSize(node, assetById));
  }

  const readMemberGeometry = (members: readonly RawCanvasNode[]): CanvasMemberGeometry[] =>
    members.map((member) => {
      const resolved = sizeByNodeId.get(member.id);
      if (resolved === undefined) {
        console.debug("[cli-canvas-inspect] 成员尺寸缺失，按节点类型兜底尺寸计入容器包围盒", {
          memberId: member.id,
          memberType: member.type,
        });
      }
      return {
        position: member.position,
        size: resolved ?? resolveLeafNodeSize(member, assetById),
      };
    });

  const readContainerName = (node: RawCanvasNode): string =>
    (node.type === "group" ? node.data.name : node.data.label) ?? "";

  const containerById = new Map<string, CliCanvasInspectContainer>();
  const toContainer = (
    node: RawCanvasNode,
    box: { position: { x: number; y: number }; size: CanvasSize },
  ): CliCanvasInspectContainer => ({
    group_node_id: node.id,
    name: readContainerName(node),
    type: node.type === "group" ? "group" : "agent_container",
    member_ids: (membersByContainerId.get(node.id) ?? []).map((member) => member.id),
    position: box.position,
    size: box.size,
    bbox: toBBox(box.position, box.size),
    collapsed: node.data.collapsed,
    nearest_neighbor: null,
  });

  // 第一遍：折叠容器（两类）与展开态 Agent 容器（成员为叶节点）。
  for (const container of allContainerNodes) {
    const name = readContainerName(container);
    if (container.data.collapsed) {
      // 折叠态语义本就是保持折叠前位置（Editor deriveCollapsedEntry 同口径）。
      const box = computeGroupRenderBox({
        collapsed: true,
        position: container.position,
        name,
        members: [],
      });
      sizeByNodeId.set(container.id, box.size);
      containerById.set(container.id, toContainer(container, box));
      continue;
    }
    if (container.type !== "agent") continue;
    const members = membersByContainerId.get(container.id) ?? [];
    if (members.length === 0) {
      // Agent 容器无成员＝单节点形态：Editor buildGroupDerivedSize 不产出派生 entry，
      // 回落静态 240×64；此时只有持久化 position 可作为锚点（留痕）。
      console.debug("[cli-canvas-inspect] Agent 容器无成员，按单节点静态尺寸并以持久化位置为锚点", {
        nodeId: container.id,
      });
      const size = { ...CANVAS_DEFAULT_AGENT_SIZE };
      sizeByNodeId.set(container.id, size);
      containerById.set(container.id, toContainer(container, { position: container.position, size }));
      continue;
    }
    // 展开态 position 由成员包围盒派生（position 入参在非空成员下不被消费）。
    const box = computeGroupRenderBox({
      collapsed: false,
      position: { x: 0, y: 0 },
      name,
      members: readMemberGeometry(members),
    });
    sizeByNodeId.set(container.id, box.size);
    containerById.set(container.id, toContainer(container, box));
  }

  // 第二遍：组（成员可能含 Agent 容器，使用第一遍产出的容器尺寸）。
  for (const container of allContainerNodes) {
    if (container.type !== "group" || container.data.collapsed) continue;
    const members = membersByContainerId.get(container.id) ?? [];
    if (members.length === 0) {
      console.debug("[cli-canvas-inspect] 组无成员，以持久化位置为锚点回落折叠卡片形态", {
        nodeId: container.id,
      });
    }
    const box = computeGroupRenderBox({
      collapsed: false,
      // 非空成员时位置由成员包围盒派生；空组回落折叠卡片时以持久化位置为唯一锚点。
      position: container.position,
      name: readContainerName(container),
      members: readMemberGeometry(members),
    });
    sizeByNodeId.set(container.id, box.size);
    containerById.set(container.id, toContainer(container, box));
  }

  const referencedAssetIds = new Set<string>();
  for (const node of parsedNodes) {
    if (!ASSET_REFERENCE_NODE_TYPES.has(node.type)) continue;
    if (node.data.assetId !== null) referencedAssetIds.add(node.data.assetId);
  }

  const derivedNodes: CliCanvasInspectNode[] = leafNodes.map((node) => {
    const size = sizeByNodeId.get(node.id) ?? resolveLeafNodeSize(node, assetById);
    const identity = resolveNodeIdentity({
      node,
      assetById,
      generationIndex: params.generationIndex,
      promptByTaskId,
    });
    const isTaskNode = node.type === "task";
    const prompt =
      isTaskNode && node.data.taskId !== null ? promptByTaskId.get(node.data.taskId) ?? null : identity?.prompt ?? null;
    return {
      node_id: node.id,
      node_type: node.type,
      name: node.data.label ?? "",
      position: node.position,
      size,
      bbox: toBBox(node.position, size),
      group_id: node.groupId,
      asset_id: ASSET_REFERENCE_NODE_TYPES.has(node.type) ? node.data.assetId : null,
      task_id: isTaskNode ? node.data.taskId : identity?.taskId ?? null,
      batch_id: isTaskNode ? node.data.batchId : identity?.batchId ?? null,
      created_at: toIsoCreatedAt(isTaskNode ? node.data.createdAt : identity?.createdAt ?? null),
      prompt_preview: toPromptPreview(prompt, promptLimit),
      source_file_name: identity?.sourceFileName ?? null,
      asset:
        params.full && identity !== null
          ? buildNodeAsset({ identity, projectPath: params.projectPath, promptLimit })
          : null,
    };
  });

  const derivedContainers = containerNodes
    .map((node) => containerById.get(node.id))
    .filter((container): container is CliCanvasInspectContainer => container !== undefined);

  const scopedAnnotations =
    scopedIds === null
      ? parsedAnnotations
      : parsedAnnotations.filter(
          (annotation) => annotation.boundToNodeId !== null && scopedIds.has(annotation.boundToNodeId),
        );
  const derivedAnnotations: CliCanvasInspectAnnotation[] = scopedAnnotations.map((annotation) => ({
    annotation_id: annotation.annotation_id,
    content: annotation.content,
    position: annotation.position,
    size: annotation.size,
    bound_to_node_id: annotation.boundToNodeId,
  }));

  let finalNodes = derivedNodes;
  let finalContainers = derivedContainers;
  let viewport: CliCanvasInspectSceneViewport | null = null;
  let selection: CliCanvasInspectResult["selection"] = null;
  let exactMerged = false;

  const exact = params.exact;
  if (exact !== null) {
    // exact 完整性：每个画布节点都要有精确尺寸，每个容器都要有精确 position+size。
    const missingNodeIds = parsedNodes
      .filter((node) => exact.sizes[node.id] === undefined)
      .map((node) => node.id);
    const missingContainerIds = allContainerNodes
      .filter((node) => exact.containers[node.id] === undefined)
      .map((node) => node.id);
    if (missingNodeIds.length > 0 || missingContainerIds.length > 0) {
      console.debug("[cli-canvas-inspect] 窗口几何未覆盖全部画布节点/容器，整体回落 derived", {
        missingNodeIds,
        missingContainerIds,
      });
    } else {
      finalNodes = derivedNodes.map((node) => {
        const size = exact.sizes[node.node_id];
        if (size === undefined) return node;
        return { ...node, size, bbox: toBBox(node.position, size) };
      });
      finalContainers = derivedContainers.map((container) => {
        const entry = exact.containers[container.group_node_id];
        if (entry === undefined) return container;
        return {
          ...container,
          position: entry.position,
          size: entry.size,
          bbox: toBBox(entry.position, entry.size),
        };
      });
      // 画布窗口上报的可视区宽高随几何快照一起返回（width/height 均可空）；
      // 派生模式没有窗口视口，viewport 整体为 null。
      viewport = exact.viewport === null ? null : { ...exact.viewport };
      selection = exact.selection;
      exactMerged = true;
    }
  }

  const topLevelContainerIds = new Set(
    containerNodes.filter((node) => node.groupId === null).map((node) => node.id),
  );
  const topLevelContainers = finalContainers.filter((container) => topLevelContainerIds.has(container.group_node_id));
  const pairs = collectTopLevelPairs(topLevelContainers);
  const nearestByContainerId = buildNearestNeighbors(topLevelContainers, pairs);
  const containersWithNeighbors = finalContainers.map((container) => ({
    ...container,
    nearest_neighbor: nearestByContainerId.get(container.group_node_id) ?? null,
  }));

  const includeUnplaced = params.includeUnplaced && params.group === null;
  if (!includeUnplaced) {
    console.debug("[cli-canvas-inspect] 未落画布资产按要求置空", {
      projectPath: params.projectPath,
      includeUnplaced: params.includeUnplaced,
      group: params.group,
    });
  }

  return {
    ok: true,
    result: {
      fidelity: exactMerged ? "exact" : "derived",
      nodes: finalNodes,
      containers: containersWithNeighbors,
      assets_not_on_canvas: includeUnplaced
        ? buildUnplacedAssets({
            assets: params.assets,
            referencedAssetIds,
            generationIndex: params.generationIndex,
          })
        : [],
      viewport,
      selection,
      annotations: derivedAnnotations,
      overlaps: buildOverlaps(pairs),
      min_gap: pickMinGap(pairs),
    },
  };
};
