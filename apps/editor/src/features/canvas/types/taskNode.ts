import type { RuntimeTaskFailure } from '@iart/contracts';

/**
 * 任务节点 / 资产节点画布投影的 Editor-local 类型（Todo 6）。
 *
 * 任务/资产节点投影容器是 Editor-local 对象，归 Editor 内部类型（AGENTS.md 契约层级判定）；
 * 其持有的运行域引用结构（RuntimeTaskFailure / RuntimeRef）由 packages/contracts 定义。
 * 禁止在本文件复制跨边界 DTO 字段 schema（AGENTS.md 单一事实源）。
 *
 * 单一事实源：任务节点数据 / 资产节点数据的唯一 owner 是本文件；
 * features/promptdock/projection/projectionTypes.ts 从这里 import 并复用，不得并列维护副本。
 */

/**
 * 任务节点运行状态（Editor-local 视图）。
 *
 * 值集合对齐 contracts `UNIFIED_GENERATION_STATUSES`（submitting/generating/polling/downloading/
 * succeeded/failed），并扩展本地终态 'cancelled'。contracts 当前尚未登记 'cancelled'
 *（Todo 4 会给 unified-generation 补 'cancelled'），消费运行域状态时先做本地兼容判断
 *（'cancelled'/'canceled'）。TODO(acceptance: 待 Todo 4 契约就绪后移除兼容)。
 */
export type TaskNodeStatus =
  | 'submitting'
  | 'generating'
  | 'polling'
  | 'downloading'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** 任务节点数据（一个 batch 内的单个 RuntimeTask 投影）。 */
export type TaskNodeData = {
  /** 显示标签（header 直接显示 model_id，不翻译，AGENTS.md「Model ID 唯一性与显示规则」） */
  label: string;
  modelId: string;
  taskId: string;
  /** 0-based 任务索引（固定任务成员关系排序） */
  taskIndex: number;
  batchId: string;
  status: TaskNodeStatus;
  progressPercent: number | null;
  progressPhase: string | null;
  errorMessage: string | null;
  failure: RuntimeTaskFailure | null;
  /**
   * 远端任务号（RuntimeTaskView.remoteRequestId 的本地投影）。
   *
   * 供「重新查询结果」资格判定消费（contracts `isRequeryEligibleFailure` 要求非空）。
   * 可选：存量持久化节点没有该键，读作 undefined；投影在通知/快照到达后补真实值。
   */
  remoteRequestId?: string | null;
  /**
   * 累计重新查询次数（RuntimeTaskView.metadata.requeryCount 的本地投影）。
   * 仅用于等待态胶囊副行「重新查询结果」；首次提交的普通轮询为 0/undefined。
   */
  requeryCount?: number;
  createdAt: number;
  updatedAt: number;
};

/** 资产节点数据（正式资产呈现，保留来源关联以支持溯源与「复用」）。 */
export type AssetNodeData = {
  label: string;
  /** 来源 batch/快照引用（服务溯源与「复用」） */
  sourceBatchId: string;
  sourceTaskId: string;
  sourceModelId: string;
  mediaType: 'image' | 'video' | 'audio';
  assetId: string;
  /**
   * 媒体工具加工血缘（spec：docs/editor/媒体工具加工.md「产出与非破坏」）：
   * 加工产出的独立资产节点持有 {源资产 id, 工具标识}；源资产引用与工具标识由本字段
   * （资产节点 payload = 资产 metadata 的画布投影）承载，不进入画布关系。
   * 任务生成资产无此字段。可选字段向后兼容：旧 payload 无此键，读取为 undefined。
   */
  derivedFrom?: {
    sourceAssetId: string;
    /** 工具注册 id（如 crop / mirrorX / frameCapture） */
    tool: string;
  } | undefined;
  /**
   * 扩图（异步 AI 加工）进行态：持有扩图任务的 RuntimeTask 引用。
   * 扩图产出的资产节点以该节点为 target（spec 媒体工具加工：加工是资产上的动作），
   * 成功投影后清除并回填新 assetId（结果资产替换占位资产）。
   */
  outpaintTaskId?: string | undefined;
};

/** 任务投影终态处理策略（morph / 保留 / 移除）。 */
export type TaskProjectionDisposition =
  | { kind: 'morph'; assets: AssetNodeData[] }
  | {
      kind: 'retain';
      status: TaskNodeStatus;
      errorMessage: string | null;
      failure: RuntimeTaskFailure | null;
    }
  | { kind: 'remove' };
