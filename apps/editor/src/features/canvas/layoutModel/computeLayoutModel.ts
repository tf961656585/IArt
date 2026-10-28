/**
 * Layout Model 主纯函数（Layout-Model-Driven）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md
 *
 * 职责：把 `nodeGraph + mediaAssets + urlIndex + defaultSize 表`
 * 一次性纯函数计算为节点尺寸的「唯一业务事实源」。
 *
 * 纯函数性约束：
 * - 给定相同输入，输出确定（无 `Date.now()`、无 `Math.random()`、无 DOM / window 访问）。
 * - 不读取 ReactFlow store、不订阅 ResizeObserver。
 * - 禁止 `as unknown as X` 双重断言、禁止非空断言 `!`（由 ESLint 守卫）。
 *
 * 分层（spec「计算分层」节）：
 * - chrome overhead 层：`resolveChromeOverhead`（按节点类型 + variant 查表）
 * - 媒体尺寸层：`computeMediaDisplaySize`（共享策略模块，带 MIN_WIDTH / MAX_DISPLAY_DIMENSION 钳制）；
 *   meta 来源优先级 `MediaAsset.original → 节点 data imageMeta/videoMeta → defaultSize`（spec「媒体尺寸层」）
 *   imageInput / videoInput / asset 三类媒体承载节点同口径——节点比例必须与媒体比例一致。
 *
 * 派生节点（group / agent 容器）：尺寸由 `buildGroupDerivedSize` 派生（依赖成员节点尺寸），
 * 本函数对 group / agent 节点返回 defaultSize（实际派生由调用方在 runtime 期通过
 * buildGroupDerivedSize 完成；agent 无成员时 defaultSize 240×64 即单节点形态静态尺寸）。
 *
 * static 节点（textInput）：返回 defaultSize。
 * audioInput 已改裁 layoutModel，由 `computeAudioInputSize` 按分段数派生（见 audioInputSizePolicy.ts）。
 *
 * 模型节点已退出画布（打开阶段拒绝旧数据），原「form 尺寸层 / result area layout 层 /
 * 结构性实测回流」随结果区一并移除。
 */

import type { MediaAsset, ProjectMediaAssets } from "@iart/contracts";
import type {
  GraphNode,
  GraphNodeType,
  MediaMeta,
  NodeSize,
} from "../types/node";
import type {
  AudioInputNodeData,
  ImageInputNodeData,
  VideoInputNodeData,
} from "../types/nodeDataTypes";
import type { NodeGraph } from "../types/nodeGraph";
import { resolveChromeOverhead } from "./chromeConstants";
import { lookupAssetIdByUrl, type UrlIndex } from "./urlIndex";
import { resolveMediaAssetOriginalAspectRatio } from "../services/resultAreaMediaSlots";
import { computeMediaDisplaySize } from "./mediaDisplaySizePolicy";
import { computeAudioInputSize } from "./audioInputSizePolicy";

/**
 * Layout Model 输入（spec 契约）。
 */
export type LayoutModelInput = {
  /** 画板节点图（节点结构、位置、data） */
  nodeGraph: NodeGraph;
  /** 项目媒体资产集合 */
  mediaAssets: ProjectMediaAssets;
  /** URL → assetId 反向索引 */
  urlIndex: UrlIndex;
  /**
   * 节点 defaultSize 表（注册表投影）。
   *
   * Layout Model 是纯函数，不读 NodeDefinition 注册表；调用方预先投影为
   * `Record<nodeType, NodeSize>` 传入。
   */
  defaultSizeByNodeType: Readonly<Record<GraphNodeType, NodeSize | undefined>>;
};

/**
 * Layout Model 输出（spec 契约）。
 */
export type LayoutModelOutput = {
  /** 按 nodeId 索引的节点权威尺寸 */
  byNodeId: Readonly<Record<string, NodeSize>>;
  /** 内容指纹，用于跳过重复 apply */
  semanticKey: string;
  /** 版本号，用于 diff */
  revision: number;
};

const LAYOUT_MODEL_REVISION = 1;

/**
 * 计算媒体节点（imageInput / videoInput）的 Layout Model 尺寸。
 *
 * spec：docs/runtime/画布启动性能与Layout-Model架构.md「媒体尺寸层」
 *
 * 尺寸 = `computeMediaDisplaySize(meta, defaultAspectRatio)` + chrome overhead。
 *
 * meta 来源优先级（spec「媒体尺寸层」三级）：
 * 1. `MediaAsset.original.width/height`（经 assetId / urlIndex 反查得到）
 * 2. 节点 data 携带的 imageMeta / videoMeta（含 width/height/aspectRatio，覆盖历史数据）
 * 3. 节点类型默认宽高比（image 3/2、video 16/9）——由策略函数在 meta 完全缺失时由调用方回落 defaultSize
 *
 * chrome overhead 对 imageInput / videoInput 为 {0,0}（noPadding 媒体卡片填满 wrapper，
 * 见 chromeConstants.ts）。
 *
 * 纯函数。
 */
function computeMediaNodeSize(params: {
  node: GraphNode;
  mediaAssets: ProjectMediaAssets;
  urlIndex: UrlIndex;
  defaultSize: NodeSize | undefined;
}): NodeSize {
  const { node, mediaAssets, urlIndex, defaultSize } = params;
  // 按 node.type 类型守卫读取 media node data 字段（imageInput / videoInput）
  const nodeData = readMediaNodeData(node);
  const defaultAspectRatio = getDefaultMediaAspectRatio(node.type);
  const assetIdRaw = nodeData.assetId;
  const asset = typeof assetIdRaw === "string" && assetIdRaw.length > 0
    ? mediaAssets[assetIdRaw] ?? null
    : null;

  // urlIndex fallback：assetId 缺失时，通过 url 反查
  let resolvedAsset: MediaAsset | null | undefined = asset;
  if ((resolvedAsset === null || resolvedAsset === undefined)) {
    const url = nodeData.url;
    if (url !== null && url !== undefined && url.length > 0) {
      const resolvedId = lookupAssetIdByUrl(urlIndex, url);
      if (resolvedId !== undefined) {
        resolvedAsset = mediaAssets[resolvedId] ?? null;
      }
    }
  }

  // chrome overhead
  const chrome = resolveChromeOverhead(node.type, undefined);

  // 默认尺寸兜底
  const fallback = defaultSize ?? { width: 240, height: 160 };

  // meta 来源优先级 1：MediaAsset.original.width/height
  let meta: MediaMeta | null = null;
  if (resolvedAsset !== null && resolvedAsset !== undefined) {
    const aspect = resolveMediaAssetOriginalAspectRatio(resolvedAsset);
    if (aspect !== null && aspect > 0) {
      const w = resolvedAsset.original.width;
      const h = resolvedAsset.original.height;
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
        meta = { width: w, height: h, aspectRatio: aspect };
      }
    }
  }

  // meta 来源优先级 2：节点 data 携带的 imageMeta / videoMeta（覆盖 MediaAsset.original 缺失场景）
  if (meta === null) {
    const nodeDataMeta = nodeData.mediaMeta;
    if (
      nodeDataMeta !== null &&
      nodeDataMeta !== undefined &&
      typeof nodeDataMeta.width === "number" &&
      typeof nodeDataMeta.height === "number" &&
      nodeDataMeta.width > 0 &&
      nodeDataMeta.height > 0
    ) {
      const aspectFromMeta =
        nodeDataMeta.aspectRatio && nodeDataMeta.aspectRatio > 0
          ? nodeDataMeta.aspectRatio
          : nodeDataMeta.width / nodeDataMeta.height;
      meta = {
        width: nodeDataMeta.width,
        height: nodeDataMeta.height,
        aspectRatio: aspectFromMeta,
      };
    }
  }

  // 无任何 meta：返回 defaultSize（由阶段 5 漂移监控校准；启动期 spec 不允许 DOM 测量）
  if (meta === null) {
    return fallback;
  }

  // 统一策略函数：带 MIN_WIDTH / MAX_DISPLAY_DIMENSION 钳制
  const displaySize = computeMediaDisplaySize(meta, defaultAspectRatio);
  if (displaySize === null) {
    return fallback;
  }

  // 总尺寸 = display + chrome（imageInput/videoInput chrome 为 {0,0}，totalWidth/Height = display）
  const totalWidth = Math.max(displaySize.width, chrome.overheadX + displaySize.width);
  const totalHeight = Math.max(displaySize.height, chrome.overheadY + displaySize.height);
  return { width: totalWidth, height: totalHeight };
}

/**
 * 媒体节点默认宽高比（meta 完全缺失时的 fallback，由策略函数消费）。
 *
 * image 3/2、video 16/9（spec「媒体尺寸层」）。
 */
function getDefaultMediaAspectRatio(nodeType: GraphNodeType): number {
  if (nodeType === "imageInput") return 3 / 2;
  // videoInput 按 16/9 视频默认
  return 16 / 9;
}

/**
 * 计算资产节点（asset）的 Layout Model 尺寸。
 *
 * 设计要求（spec：docs/runtime/画布节点尺寸管理架构.md「媒体节点比例一致性」）：
 * 承载 image / video 媒体的节点，其宽高比必须与媒体实际宽高比一致——
 * 节点比例与媒体比例不符视为 bug（渲染层 object-fit: contain 会产生灰边）。
 *
 * 尺寸 = `computeMediaDisplaySize(meta, defaultAspectRatio)` + chrome overhead
 * （asset chrome 为 {0,0}：媒体满幅面，wrapper = 卡片 border-box，见 chromeConstants.ts）。
 *
 * meta 来源：`MediaAsset.original.width/height`（经节点 data.assetId 直连）。
 * - mediaType 为 audio：卡片形态（播放钮 + 波形 + 时长），固定 248×64
 *   （docs/editor/画布资产节点媒体播放-design.md §3.6）。
 * - asset / original 尺寸缺失：无法确定媒体比例，回落 defaultSize（defaultSize
 *   仅作为 meta 缺失时的兜底，媒体比例可得时永远以媒体比例为准）。
 *
 * 纯函数。
 */
function computeAssetNodeSize(params: {
  node: GraphNode;
  mediaAssets: ProjectMediaAssets;
  defaultSize: NodeSize | undefined;
}): NodeSize {
  const { node, mediaAssets, defaultSize } = params;
  const fallback = defaultSize ?? { width: 240, height: 180 };

  const nodeData = node.data as { mediaType?: string; assetId?: string | null | undefined };
  if (nodeData.mediaType === "audio") {
    return { width: 248, height: 64 };
  }
  if (nodeData.mediaType !== "image" && nodeData.mediaType !== "video") {
    return fallback;
  }
  const assetId = typeof nodeData.assetId === "string" ? nodeData.assetId : "";
  if (assetId.length === 0) return fallback;
  const asset = mediaAssets[assetId];
  if (asset === null || asset === undefined) return fallback;

  const aspect = resolveMediaAssetOriginalAspectRatio(asset);
  const width = asset.original.width;
  const height = asset.original.height;
  if (aspect === null || aspect <= 0) return fallback;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    return fallback;
  }

  const defaultAspectRatio = nodeData.mediaType === "image" ? 3 / 2 : 16 / 9;
  const chrome = resolveChromeOverhead("asset", undefined);
  const displaySize = computeMediaDisplaySize(
    { width, height, aspectRatio: aspect },
    defaultAspectRatio,
  );
  if (displaySize === null) return fallback;

  // 总尺寸 = display + chrome（asset chrome 为 {0,0}，totalWidth/Height = display）
  const totalWidth = Math.max(displaySize.width, chrome.overheadX + displaySize.width);
  const totalHeight = Math.max(displaySize.height, chrome.overheadY + displaySize.height);
  return { width: totalWidth, height: totalHeight };
}

/**
 * 类型守卫辅助：从 media node 读取 assetId / url / 节点 data 媒体 meta。
 *
 * 按 node.type 收窄到具体的 media node data 类型，避免双重断言。
 * 返回结构携带 assetId / url / mediaMeta（imageMeta | videoMeta，按节点类型）。
 */
function readMediaNodeData(node: GraphNode): {
  assetId: string | null | undefined;
  url: string | null | undefined;
  mediaMeta: MediaMeta | null | undefined;
} {
  if (node.type === "imageInput") {
    const data = node.data as ImageInputNodeData;
    return { assetId: data.assetId, url: data.imageUrl, mediaMeta: data.imageMeta };
  }
  if (node.type === "videoInput") {
    const data = node.data as VideoInputNodeData;
    return { assetId: data.assetId, url: data.videoUrl, mediaMeta: data.videoMeta };
  }
  return { assetId: null, url: null, mediaMeta: null };
}

/**
 * 计算静态节点（textInput）的 Layout Model 尺寸。
 *
 * 静态节点尺寸由 defaultSize 决定（注册表默认值）。
 *
 * 纯函数。
 */
function computeStaticNodeSize(defaultSize: NodeSize | undefined): NodeSize {
  return defaultSize ?? { width: 240, height: 160 };
}

/**
 * 类型守卫辅助：从 audioInput 节点读取策略输入字段。
 *
 * 按 node.type 收窄到 AudioInputNodeData，避免双重断言。
 * 返回归一化的 `computeAudioInputSize` 输入字段（segmentsCount / segmentModeEnabled / hasAudioUrl）。
 *
 * 纯函数。
 */
function readAudioInputNodeData(node: GraphNode): {
  segmentsCount: number;
  segmentModeEnabled: boolean;
  hasAudioUrl: boolean;
} {
  const data = node.data as AudioInputNodeData;
  const segments = data.segments;
  const segmentsCount = Array.isArray(segments) ? segments.length : 0;
  const segmentModeEnabled = data.segmentModeEnabled === true;
  const audioUrl = data.audioUrl;
  const hasAudioUrl = typeof audioUrl === "string" && audioUrl.trim().length > 0;
  return { segmentsCount, segmentModeEnabled, hasAudioUrl };
}

/**
 * 计算单个节点的 Layout Model 尺寸。
 *
 * 纯函数：相同输入产出相同输出。
 */
function computeNodeSize(params: {
  node: GraphNode;
  mediaAssets: ProjectMediaAssets;
  urlIndex: UrlIndex;
  defaultSizeByNodeType: Readonly<Record<GraphNodeType, NodeSize | undefined>>;
}): NodeSize {
  const { node, mediaAssets, urlIndex, defaultSizeByNodeType } = params;
  const defaultSize = defaultSizeByNodeType[node.type];
  switch (node.type) {
    case "model":
      // 模型节点退出画布（打开阶段拒绝旧数据），不参与 Layout Model；
      // 尺寸按 defaultSize 兜底，避免旧引擎路径残留。
      return defaultSize ?? { width: 240, height: 160 };
    case "imageInput":
    case "videoInput":
      return computeMediaNodeSize({
        node,
        mediaAssets,
        urlIndex,
        defaultSize,
      });
    case "asset":
      // 资产节点承载 image/video 媒体：节点比例必须与媒体比例一致（媒体尺寸层同口径）。
      return computeAssetNodeSize({ node, mediaAssets, defaultSize });
    case "audioInput":
      // audioInput 改裁 layoutModel：按分段数派生（分段全量渲染不做内部滚动）。
      return computeAudioInputSize({
        chrome: resolveChromeOverhead(node.type, undefined),
        ...readAudioInputNodeData(node),
      });
    case "textInput":
      return computeStaticNodeSize(defaultSize);
    case "group":
      // group 节点尺寸由 buildGroupDerivedSize 派生；阶段 1 返回 defaultSize 占位
      return defaultSize ?? { width: 220, height: 56 };
    case "agent":
      // Agent 容器形态尺寸由 buildGroupDerivedSize 派生（与组同一投影层机制，含两层嵌套
      // 时把成员 Agent 容器按容器形态范围计入组包围盒）；Layout Model 恒为静态 defaultSize
      // （单节点形态 240×64，注册表 agentNodeDefinition.defaultSize），无成员时由既有静态
      // 尺寸路径消费。成员几何不进 Layout Model（位置变化不触发本模型重算，AG-CN-012
      // 派生不落盘）。
      return defaultSize ?? { width: 240, height: 64 };
    default: {
      // 兜底：未知节点类型返回 defaultSize
      return defaultSize ?? { width: 240, height: 160 };
    }
  }
}

/**
 * 构建内容指纹（semanticKey）。
 *
 * 基于节点列表的 stable 子集：nodeId + type + contentSignature。
 *
 * 纯函数。
 */
function buildSemanticKey(nodes: ReadonlyArray<GraphNode>): string {
  const parts: string[] = [];
  for (const node of nodes) {
    const defaultPart = `${node.id}:${node.type}`;
    if (node.type === "imageInput" || node.type === "videoInput") {
      const mediaData = readMediaNodeData(node);
      const assetId = mediaData.assetId ?? "";
      const url = mediaData.url ?? "";
      parts.push(`${defaultPart}:a${assetId}:u${url}`);
    } else if (node.type === "asset") {
      // asset 节点尺寸由 assetId 指向的媒体 meta 派生，assetId / mediaType 纳入指纹。
      const assetData = node.data as { mediaType?: string; assetId?: string | null | undefined };
      const assetId = typeof assetData.assetId === "string" ? assetData.assetId : "";
      const mediaType = typeof assetData.mediaType === "string" ? assetData.mediaType : "";
      parts.push(`${defaultPart}:a${assetId}:t${mediaType}`);
    } else if (node.type === "audioInput") {
      // audioInput 尺寸由分段数/分段模式/有无 audioUrl 派生，全部纳入指纹。
      const audioData = readAudioInputNodeData(node);
      parts.push(
        `${defaultPart}:n${audioData.segmentsCount}:m${audioData.segmentModeEnabled ? 1 : 0}:u${audioData.hasAudioUrl ? 1 : 0}`,
      );
    } else {
      parts.push(defaultPart);
    }
  }
  return parts.join("|");
}

/**
 * Layout Model 主纯函数。
 *
 * spec 输入：
 * - nodeGraph / mediaAssets / urlIndex / defaultSize 表
 *
 * spec 输出：
 * - byNodeId / semanticKey / revision
 *
 * 纯函数性：相同输入产出相同输出，无副作用。
 *
 * @param input Layout Model 输入（spec 契约）
 */
export function computeLayoutModel(input: LayoutModelInput): LayoutModelOutput {
  const { nodeGraph, mediaAssets, urlIndex, defaultSizeByNodeType } = input;
  const byNodeId: Record<string, NodeSize> = {};
  const nodes = Array.isArray(nodeGraph.nodes) ? nodeGraph.nodes : [];
  for (const node of nodes) {
    if (node === null || node === undefined) continue;
    byNodeId[node.id] = computeNodeSize({
      node,
      mediaAssets,
      urlIndex,
      defaultSizeByNodeType,
    });
  }
  const semanticKey = buildSemanticKey(nodes);
  return {
    byNodeId,
    semanticKey,
    revision: LAYOUT_MODEL_REVISION,
  };
}

// 显式 re-export 既有纯函数，便于上层调用方集中导入（模型节点退出画布后，
// 结果区布局相关再导出已移除，避免被旧结果区渲染再次依赖）。

