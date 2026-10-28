/**
 * 画板节点类型定义
 * - 定义节点的基本结构、节点类型
 * - 支持模型/输入等节点类型
 */

import type { CSSProperties } from 'react';
import type { DynamicRecord } from '@/client/utils/typeGuards';
import type { SchemaFormValues } from '@/features/workspace/schema/types';
import type { RuntimeRef, RuntimeTaskFailure } from '@iart/contracts';
import type { ResizeKernel } from '@iart/contracts/media-processing-contract';
import type { UnifiedGenerationProgress } from '@iart/contracts/unified-generation';
import type { UNIFIED_GENERATION_STATUSES } from '@iart/contracts/unified-generation';
import type { ResultAreaEmbeddedData } from './nodeDataTypes';
import type { PromptCollectionItem } from './promptCollection';

/** 节点类型 */
export type GraphNodeType =
  | 'model'         // 模型节点（AI 生成）——已退役，仅迁移期识别后拒绝
  | 'textInput'     // 文本素材节点
  | 'imageInput'    // 图片素材节点（可承接/提供图片数据）
  | 'videoInput'    // 视频素材节点
  | 'audioInput'    // 音频素材节点
  | 'task'          // 任务节点（RuntimeTask 画布投影）
  | 'asset'         // 资产节点（正式资产呈现，含来源关联）
  | 'agent'         // Agent 节点 / Agent 容器（agent 会话锚点，只持 agentSessionId 稳定引用；可持有成员）
  | 'group';        // 节点组（容器节点，逻辑组织容器，非数据流节点）

/** 节点位置 */
export interface NodePosition {
  x: number;
  y: number;
}

/** 节点尺寸 */
export interface NodeSize {
  width: number;
  height: number;
}

/**
 * desired size 的生命周期状态。
 * - pending：已提交，actual measured size 尚未收敛。pending 态主导投影，驱动节点朝目标尺寸变化。
 * - accepted：actual 已收敛到 desired。投影让位回 measured；accepted 态 desired 保留作幂等记录。
 *
 * pending→accepted 是单向迁移，不可回退（spec：画布节点尺寸管理架构.md）。
 */
export type DesiredSizeState = 'pending' | 'accepted';

/**
 * 业务意图尺寸（desired size）。
 *
 * 合并了原 proposal/preview/declared 三态为单一概念。
 * size 表达"节点应该变成多大"；state 表达生命周期；semanticKey 用于幂等去重。
 */
export type DesiredSize = {
  size: NodeSize;
  state: DesiredSizeState;
  semanticKey: string;
};

export type NodeSizeProposalSource =
  | 'embeddedResultAreaAutoSize'
  | 'resultAreaAutoScale';

/**
 * 尺寸提案（producer 提交参数）。
 * source/priority/reason 是 producer 计算过程的中间产物，不进 store；
 * store 内部只保留 DesiredSize（size/state/semanticKey）。
 */
export type NodeSizeProposal = {
  nodeId: string;
  source: NodeSizeProposalSource;
  semanticKey: string;
  desiredSize: NodeSize;
  priority: number;
  reason: string;
};


/** 媒体元数据（用于保持画布节点比例、自适应尺寸） */
export interface MediaMeta {
  width: number;
  height: number;
  aspectRatio: number;
}

/** 图片元数据（别名） */
export type ImageMeta = MediaMeta;

/** 视频元数据 */
export interface VideoMeta extends MediaMeta {
  /** 视频帧率（后端 ffmpeg 解析填入；旧数据为 undefined） */
  fps: number | undefined;
}

export type ImageDerivedOp =
  | { type: 'resize'; percent: number; kernel: ResizeKernel | undefined }
  | { type: 'crop'; x: number; y: number; width: number; height: number }
  | {
      type: 'split';
      rows: number;
      cols: number;
      horizontalPercents: number[];
      verticalPercents: number[];
      tile: { row: number; col: number; index: number };
    }
  | { type: 'outpaint'; aspectRatio: string; imageSize: string }
  | { type: 'mirrorX' }
  | { type: 'mirrorY' }
  | { type: 'rotate'; deg: 90 | 180 | 270 }
  | { type: 'annotate' }
  | { type: 'edgeDetect'; mode: 'sobel' | undefined; threshold: number }
  | { type: 'chromaKey'; targetColor: { r: number; g: number; b: number }; tolerance: number; feather: number }
  | { type: 'differenceKey'; threshold: number; softness: number }
  | { type: 'smartSplit'; alphaThreshold: number; minArea: number; dilateIterations: number; padding: number; tile: { index: number; x: number; y: number; width: number; height: number } }
  | { type: 'videoSpriteSheet'; rows: number; cols: number; frameWidth: number; frameHeight: number }
  // 视频截帧弹窗产出血缘标签（媒体工具加工弹窗形态，非节点类型）
  | { type: 'videoFrameCapture'; timeSec: number; sourceAssetId: string | undefined; sourceSlotId: string | undefined };

/** 节点任务信息 */
export interface NodeTaskInfo {
  /** 后端正式任务ID（ack 后写入，正式任务链路唯一标识） */
  taskId: string | undefined;
  /** 模型/厂商返回的远程任务ID/请求ID（用于远程追踪/排障） */
  remoteRequestId: string | undefined;
  /** 多 prompt 场景下的任务索引 */
  taskIndex: number | undefined;
  /** 模型标识 */
  modelId: string;
  /** 兼容旧调用方的模型 key */
  /** 任务状态 */
  status: (typeof UNIFIED_GENERATION_STATUSES)[number] | undefined;
  /** submitting 子阶段等最小进度信息 */
  progress: UnifiedGenerationProgress | null | undefined;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后更新时间戳 */
  updatedAt: number;
  /** 错误信息 */
  error: string | undefined;
  /** 运行域结构化失败事实的本地运行时投影。 */
  failure: RuntimeTaskFailure | null | undefined;
  /** 自动补位批次 ID（存在时表示该任务属于某个自动补位批次） */
  batchId: string | undefined;
}

/** 节点内容缓存 */
export interface NodeContentCache {
  /** base64数据 */
  data: string;
  /** MIME类型 */
  mimeType: string;
  /** 原始URL */
  originalUrl: string;
  /** 缓存时间戳 */
  cachedAt: number;
}

/** 节点数据基类 */
export interface NodeDataBase {
  /** 节点显示标签 */
  label: string | undefined;
  /** 节点描述 */
  description: string | undefined;
  /** 运行时最小稳定引用，正式持久化只保留该结构，不保留任务真相投影。 */
  runtimeRef: RuntimeRef | undefined;
}

export type ModelFormValues = SchemaFormValues<string>;
export type ModelPortMapping = DynamicRecord<string>;
export type InlineAdvancedGroupExpansionMap = DynamicRecord<boolean>;
export type InputEdgeOrderMap = DynamicRecord<string[], string>;
export type CanvasElementStyle = Pick<
  CSSProperties,
  | 'opacity'
  | 'zIndex'
  | 'width'
  | 'height'
  | 'minWidth'
  | 'minHeight'
  | 'maxWidth'
  | 'maxHeight'
  | 'overflow'
  | 'pointerEvents'
  | 'transform'
  | 'display'
  | 'visibility'
>;

/** 模型节点执行偏好 */
export interface ExecutionPreferences {
  /** 默认批量执行数量 */
  batchCount: number | undefined;
  /** 策略档位 Key（undefined 表示使用策略默认 Key） */
  policyTierKey: string | undefined;
}

/** 模型节点数据 */
export interface ModelNodeData extends NodeDataBase {
  /** grouped node 的稳定壳子身份；单模型节点为空 */
  shellModelId: string | undefined;
  /** 对应的模型 key（来自 models.config.ts） */
  modelId: string;
  /** 当前选中的 override 声明 id（用户级 override 引用，spec docs/custom-providers/00 §5.5）。
   * undefined = 未选择（走默认渠道）。切换只改此字段，不改 modelId/端口/参数骨架。 */
  currentOverrideId?: string | undefined;
  /** 表单配置值 */
  formValues: ModelFormValues;
  /** 端口到表单字段的映射 */
  portMapping: ModelPortMapping | undefined;
  /** 节点内快捷参数是否收起（默认展开） */
  inlineControlsCollapsed: boolean | undefined;
  /** 节点内高级参数分组展开状态（默认全部收起） */
  inlineAdvancedGroupsExpanded: InlineAdvancedGroupExpansionMap | undefined;
  /** 最近一次异步任务对应的执行 ID（用于 source-task 精确匹配） */
  lastExecutionId: string | undefined;
  /** 异步生命周期正式状态（由 task index source-task 投影回写） */
  taskInfo: NodeTaskInfo | undefined;
  /** 节点执行偏好（独立于模型参数 formValues） */
  executionPreferences: ExecutionPreferences | undefined;
  /**
   * 提示词预设快照（Inspector prompt 字段 / 插入时缓存）
   * - key 为 presetId
   * - 用于执行时将 `[[pp:<presetId>]]` 展开为完整 content（与文本输入节点同一主口径）
   */
  promptPresetSnapshots: Record<string, PromptCollectionItem> | undefined;
  /**
   * 内嵌结果区（生成结果展示面）。
   * resultArea 已从独立 GraphNode 退化为 model 的 data 子结构，
   * 归属就是 model 自身。详见 ResultAreaEmbeddedData。
   */
  resultArea: ResultAreaEmbeddedData;
}

/** 节点组数据 */
export interface GroupNodeData extends NodeDataBase {
  /** 组名，显示在组节点左上角 */
  name: string;
  /** 折叠态；false 为展开（默认），true 为收起 */
  collapsed: boolean;
  /** 组色（视觉锚点）。undefined 表示未设置，渲染层回退默认色；创建组时生成非 undefined 默认色 */
  color: string | undefined;
}

import type {
  AudioInputNodeData,
  ImageInputNodeData,
  TextInputNodeData,
  VideoInputNodeData,
} from './nodeDataTypes';
import type { AssetNodeData, TaskNodeData } from './taskNode';
import type { AgentNodeData } from './agentNode';
export type { AgentNodeData } from './agentNode';
export type {
  AudioInputNodeData,
  ImageInputNodeData,
  MediaSlotType,
  PromptInterviewMediaType,
  PromptInterviewNodeData,
  PromptInterviewNodeDataV1,
  PromptInterviewResultV1,
  PromptInterviewSpecV1,
  PromptInterviewTurnV1,
  ResultAreaEmbeddedData,
  ResultAreaFormalMediaSlot,
  ResultAreaFormalSlot,
  ResultAreaFormalSlotOrigin,
  ResultAreaFormalTaskSlot,
  ResultAreaMediaSlot,
  ResultAreaNodeData,
  ResultAreaRuntimeProjectionBySlotKey,
  ResultAreaSlot,
  ResultAreaSlotRuntimeProjection,
  ResultAreaSlotView,
  ResultAreaSlotOrigin,
  ResultAreaTaskSlot,
  TaskSlotErrorDetails,
  TextInputNodeData,
  TextInputSegment,
  TextInputSeparatorPreset,
  VideoInputNodeData,
} from './nodeDataTypes';
export type { AssetNodeData, TaskNodeData, TaskNodeStatus, TaskProjectionDisposition } from './taskNode';

/** 节点数据联合类型 */
export type GraphNodeData =
  | ModelNodeData
  | TextInputNodeData
  | ImageInputNodeData
  | VideoInputNodeData
  | AudioInputNodeData
  | TaskNodeData
  | AssetNodeData
  | AgentNodeData
  | GroupNodeData;

/** 画板节点 */
export interface GraphNode<T extends GraphNodeData = GraphNodeData> {
  /** 节点唯一标识 */
  id: string;
  /** 节点类型 */
  type: GraphNodeType;
  /** 节点位置 */
  position: NodePosition;
  /** 节点数据 */
  data: T;
  /** 是否可拖拽 */
  draggable: boolean | undefined;
  /** 节点尺寸（运行时字段，不持久化） */
  size: NodeSize | undefined;
  /** 节点样式 */
  style: CanvasElementStyle | undefined;
  /**
   * 所属容器节点 id（组 | Agent 容器）；undefined 表示自由节点（不属于任何容器）。
   * 单一归属：一个节点至多持有该字段，写入另一容器 id 即一次原子迁移（AG-CN-002）。
   * 约束（AG-CN-001）：组节点自身必须为 undefined（组不得成为任何容器的成员）；
   * Agent 容器可指向组，不得指向 Agent 容器；任何容器不得指向自身。
   */
  groupId: string | undefined;
}

/** 创建画板节点的工厂函数参数 */
export interface CreateNodeParams<T extends GraphNodeData = GraphNodeData> {
  type: GraphNodeType;
  position: NodePosition;
  data: T;
}

/** 生成唯一节点 ID */
export function generateNodeId(): string {
  return `node_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** 创建画板节点 */
export function createGraphNode<T extends GraphNodeData>(
  params: CreateNodeParams<T>
): GraphNode<T> {
  return {
    id: generateNodeId(),
    type: params.type,
    position: params.position,
    data: params.data,
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
}

