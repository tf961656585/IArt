import type { ProjectMediaType, RuntimeRef } from "@iart/contracts";
import type { AudioSegment } from "./audioSegment";
import type { PromptCollectionItem } from "./promptCollection";
import type {
  ImageMeta,
  NodeContentCache,
  NodeDataBase,
  NodeTaskInfo,
  VideoMeta,
} from "./node";

export type PromptInterviewMediaType = "image" | "video";

export type PromptInterviewSpecV1 = {
  subject: string | undefined;
  action: string | undefined;
  setting: string | undefined;
  timeOfDay: string | undefined;
  style: string | undefined;
  composition: string | undefined;
  camera: string | undefined;
  lighting: string | undefined;
  colorPalette: string | undefined;
  materials: string | undefined;
  mood: string | undefined;
  motion: string | undefined;
  constraints: string | undefined;
  avoid: string | undefined;
  additionalDetails: string | undefined;
};

export type PromptInterviewTurnV1 = {
  id: string;
  createdAt: string;
  questionId: string;
  question: string;
  answer: string;
  mode: "choice" | "free" | "skip" | "suggestion";
  suggestions: string[] | undefined;
};

export type PromptInterviewResultV1 = {
  prompt: string;
  updatedAt: string;
};

export type PromptInterviewNodeDataV1 = {
  version: 1;
  profileId: string;
  mediaType: PromptInterviewMediaType;
  status: "in_progress" | "done";
  turns: PromptInterviewTurnV1[];
  spec: PromptInterviewSpecV1;
  result: PromptInterviewResultV1 | undefined;
  updatedAt: string;
};

export type PromptInterviewNodeData = PromptInterviewNodeDataV1;

/** 文本素材节点数据 */
export interface TextInputNodeData extends NodeDataBase {
  /**
   * 文本段列表（从上到下拼接为最终提示词）
   * - local: 本地可编辑段
   * - upstream: 上游连线只读段（由连线自动生成/移除）
   */
  segments: TextInputSegment[];
  /** 记录最近一次由上游执行写入的执行 ID，便于任务索引匹配/排障 */
  lastExecutionId: string | undefined;
  /** 最近一次写入的上游节点 ID */
  lastSourceNodeId: string | undefined;
  /** 最近一次写入的上游输出端口 */
  lastSourcePortId: string | undefined;
  /** 分隔符预设 */
  separator: TextInputSeparatorPreset | undefined;
  /** 自定义分隔符（separator=custom 时生效） */
  customSeparator: string | undefined;
  /**
   * 提示词预设快照（插入时缓存）
   * - key 为 presetId
   * - 用于执行时将 `[[pp:<presetId>]]` 展开为完整 content
   */
  promptPresetSnapshots: Record<string, PromptCollectionItem> | undefined;
  /** 可选任务信息（用于输出索引回写等场景） */
  taskInfo: NodeTaskInfo | undefined;
  /** 提示词采访（多轮问答）状态与结果 */
  promptInterview: PromptInterviewNodeData | undefined;
}

export type TextInputSeparatorPreset =
  | "comma" // ", "
  | "space" // " "
  | "newline" // "\n"
  | "doubleNewline" // "\n\n"
  | "none" // ""
  | "custom"; // customSeparator

export type TextInputSegment = {
  kind: "local";
  id: string;
  enabled: boolean;
  text: string;
};

/** 图片素材节点数据 */
export interface ImageInputNodeData extends NodeDataBase {
  /** 媒体资产 ID */
  assetId: string | null | undefined;
  /** 图片 URL 或 base64 */
  imageUrl: string | null;
  /** 图片尺寸元信息（用于保持节点宽高比） */
  imageMeta: ImageMeta | null | undefined;
  /** 记录最近一次由上游执行写入的执行 ID，便于快照展示 */
  lastExecutionId: string | undefined;
  /** 最近一次写入的上游节点 ID */
  lastSourceNodeId: string | undefined;
  /** 最近一次写入的上游输出端口 */
  lastSourcePortId: string | undefined;
  /** 数据来源标记 */
  valueSource: "upload" | "upstream" | undefined;
  /** 媒体落盘失败提示（仅本地播放策略） */
  mediaError: string | undefined;
  /** 关联的生成任务信息 */
  taskInfo: NodeTaskInfo | undefined;
  /**
   * 缓存的内容（base64格式）
   * @deprecated 已废弃，仅用于迁移兼容
   */
  cachedContent: NodeContentCache | undefined;
}

/** 视频素材节点数据 */
export interface VideoInputNodeData extends NodeDataBase {
  /** 媒体资产 ID */
  assetId: string | null | undefined;
  /** 视频 URL */
  videoUrl: string | null;
  /** 视频尺寸元信息（用于保持节点宽高比） */
  videoMeta: VideoMeta | null | undefined;
  /** 数据来源标记 */
  valueSource: "upload" | "upstream" | undefined;
  /** 媒体落盘失败提示（仅本地播放策略） */
  mediaError: string | undefined;
  /** 记录最近一次由上游执行写入的执行 ID，便于快照展示 */
  lastExecutionId: string | undefined;
  /** 最近一次写入的上游节点 ID */
  lastSourceNodeId: string | undefined;
  /** 最近一次写入的上游输出端口 */
  lastSourcePortId: string | undefined;
  /** 关联的生成任务信息 */
  taskInfo: NodeTaskInfo | undefined;
  /**
   * 缓存的内容（base64格式）
   * @deprecated 已废弃，仅用于迁移兼容
   */
  cachedContent: NodeContentCache | undefined;
}

/** 音频素材节点数据 */
export interface AudioInputNodeData extends NodeDataBase {
  /** 媒体资产 ID（与 Image/Video 对称，上传时写入） */
  assetId: string | null | undefined;
  /** 音频 URL */
  audioUrl: string | null;
  /** 数据来源标记 */
  valueSource: "upload" | "upstream" | undefined;
  /** 媒体落盘失败提示（仅本地播放策略） */
  mediaError: string | undefined;
  /** 记录最近一次由上游执行写入的执行 ID，便于快照展示 */
  lastExecutionId: string | undefined;
  /** 最近一次写入的上游节点 ID */
  lastSourceNodeId: string | undefined;
  /** 最近一次写入的上游输出端口 */
  lastSourcePortId: string | undefined;
  /** 关联的生成任务信息 */
  taskInfo: NodeTaskInfo | undefined;
  /**
   * 缓存的内容（base64格式）
   * @deprecated 已废弃，仅用于迁移兼容
   */
  cachedContent: NodeContentCache | undefined;
  /** 音频总时长（秒），加载后自动填充 */
  duration: number | undefined;
  /** 分段列表 */
  segments: AudioSegment[] | undefined;
  /** 分段模式是否启用（有分段时为 true） */
  segmentModeEnabled: boolean | undefined;
}

export type MediaSlotType = ProjectMediaType | "text";

export interface TaskSlotErrorDetails {
  backendMessage: string | undefined;
  /**
   * 面向用户的可读提示。
   * 与 packages/contracts 的 RuntimeTaskFailure.userMessage 对齐；
   * 上游 task-engine 在网络类异常下产出，Editor 消费侧必须透传，不得截留。
   */
  userMessage: string | undefined;
  /**
   * 该失败是否允许以重试语义继续推进。
   * 与 packages/contracts 的 RuntimeTaskFailure.retryable 对齐。
   */
  retryable: boolean | undefined;
}

export interface ResultAreaFormalSlotOrigin {
  sourceNodeId: string | undefined;
  executionId: string | undefined;
  batchId: string | undefined;
  taskId: string | undefined;
}

/**
 * 结果区正式 slot 记录（单一结构）。
 *
 * 设计说明：Task Slot 与 Media Slot 在类型层是同一结构（字段集合相同），
 * 区分靠 itemType（内容种类 text/media）+ 运行时阶段语义（assetId/textValue
 * 是否已落定），不靠类型判别字段。详见
 * docs/runtime/模型节点内嵌结果区正式内容与运行时状态边界.md
 * 「ResultAreaSlot 的对象口径」段。
 *
 * 字段必需性：
 * - id / targetKey / createdAt / updatedAt 是 slot 身份与时间戳，必填。
 * - itemType / assetId / textValue 在 allocated 等未落定阶段允许为空。
 * - runtimeRef / origin 在新写入 slot 应尽量补齐，旧数据可能缺失。
 */
export interface ResultAreaFormalSlot {
  /** slot 的唯一标识，由前端生成 */
  id: string;
  /** 用于 Hub task index 对齐的稳定 key（写入 taskMeta.targetNodeId） */
  targetKey: string;
  createdAt: number;
  updatedAt: number;
  /**
   * 内容种类判别字段。
   * - "media" 时正式内容看 assetId
   * - "text" 时正式内容看 textValue
   * - undefined 表示尚未落定（allocated 等阶段）
   */
  itemType: "media" | "text" | undefined;
  /**
   * 正式内容面（media 项）：媒体资产 ID。
   * 允许为空，表示坏项/运行时卡片当前无已落定媒体内容。
   */
  assetId: string | null | undefined;
  /**
   * 正式内容面（text 项）：文本内容。
   * 允许为空，表示坏项/运行时卡片当前无已落定文本内容。
   */
  textValue: string | null | undefined;
  runtimeRef: RuntimeRef | undefined;
  /** 正式来源归属；用于跨批次合并时判定 slot 属于哪次执行。 */
  origin: ResultAreaFormalSlotOrigin | undefined;
}

/**
 * @deprecated 语义别名，指向合并后的 ResultAreaFormalSlot。
 * Task Slot 与 Media Slot 在类型层已无差异，保留别名仅为兼容现有 import。
 * task/media 是运行时阶段语义（in-flight vs 已落定），非类型差异。
 */
export type ResultAreaFormalTaskSlot = ResultAreaFormalSlot;

/**
 * @deprecated 语义别名，指向合并后的 ResultAreaFormalSlot。
 * Task Slot 与 Media Slot 在类型层已无差异，保留别名仅为兼容现有 import。
 */
export type ResultAreaFormalMediaSlot = ResultAreaFormalSlot;

export interface ResultAreaSlotRuntimeProjection {
  nodeId: string;
  slotId: string;
  taskId: string | undefined;
  taskInfo: NodeTaskInfo | undefined;
  value: string | null | undefined;
  mediaType: MediaSlotType | undefined;
  displayAspectRatio: number | undefined;
  expectedAspectRatio: number | undefined;
  errorDetails: TaskSlotErrorDetails | undefined;
  updatedAt: number;
}

export type ResultAreaRuntimeProjectionKey = `${string}:${string}`;
export type ResultAreaRuntimeProjectionBySlotKey = Record<
  ResultAreaRuntimeProjectionKey,
  ResultAreaSlotRuntimeProjection
>;

export type ResultAreaSlotView = ResultAreaFormalSlot & {
  taskInfo: NodeTaskInfo | undefined;
  value: string | null | undefined;
  mediaType: MediaSlotType | undefined;
  displayAspectRatio: number | undefined;
  expectedAspectRatio: number | undefined;
  errorDetails: TaskSlotErrorDetails | undefined;
};

export type ResultAreaSlot = ResultAreaFormalSlot;
export type ResultAreaSlotOrigin = ResultAreaFormalSlotOrigin;
/**
 * 语义别名：Task Slot 表达任务仍在进行中或失败后的过渡态展示。
 * 类型层与 Media Slot 同构，区分靠运行时阶段语义（assetId/textValue 是否落定）。
 */
export type ResultAreaTaskSlot = ResultAreaFormalSlot;
/**
 * 语义别名：Media Slot 表达已经形成正式展示内容的结果项。
 * 类型层与 Task Slot 同构，区分靠运行时阶段语义（assetId/textValue 是否落定）。
 */
export type ResultAreaMediaSlot = ResultAreaFormalSlot;

/**
 * 结果区内嵌数据（model 节点的子结构）。
 *
 * resultArea 不再是独立 GraphNode，退化为 ModelNodeData.resultArea。
 * 归属就是 model 自身，不需要 sourceNodeId。
 *
 * targetKeyId：折叠前 resultArea 节点 id 的冻结值。Hub 侧 task-store /
 * project-document / outputsByNodeId bucket 持久化的 targetKey
 * （`result-area_<targetKeyId>_<itemId>`）必须保持原值不变，
 * 否则破坏跨进程数据对齐。该 id 不再对应任何现存 GraphNode。
 */
export interface ResultAreaEmbeddedData {
  slots: ResultAreaFormalSlot[];
  /** 输出端口声明；只有这里的 slot id 会暴露为下游可连接端口 */
  outputSlotIds: string[];
  collapsed: boolean;
  /**
   * 冻结的 resultArea 节点 id（迁移前）。用于构造 Hub 对齐 targetKey，
   * 不再对应任何 GraphNode。新创建的 model 用 generateNodeId() 生成新值。
   */
  targetKeyId: string;
}

/**
 * @deprecated 迁移用：旧版独立 resultArea 节点数据结构。
 * 仅在数据迁移（prepareLoadedNodeGraph）中用于识别和折叠旧节点，
 * 新代码不应使用。
 */
export interface ResultAreaNodeData extends NodeDataBase {
  slots: ResultAreaFormalSlot[];
  /** 输出端口声明；只有这里的 slot id 会暴露为下游可连接端口 */
  outputSlotIds: string[] | undefined;
  collapsed: boolean;
  /** 可选：记录关联的上游模型节点，便于复用关系 */
  sourceNodeId: string | undefined;
}
