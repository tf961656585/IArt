/**
 * 文件作用：适配器类型定义
 * - 定义任务类型 (TaskType) 与 GenerationAdapter 接口
 * - Adapter 负责实现 generate / 可选的 cancel 等能力
 * - 该文件使用中文注释以满足项目注释规范
 */

import type { ModelConfigEntry } from '../config/models.config';

export type TaskType = 'text' | 'image' | 'video' | 'audio' | 'multimodal';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type JsonArray = JsonValue[];

export type GenerationBody = JsonValue | Record<string, unknown> | FormData | undefined;

/**
 * 统一的 API 请求配置结构
 */
export interface ApiRequestConfig {
  endpoint: string | undefined;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  contentType: string | null | undefined;
  taskType: TaskType | undefined;
  responseHandling: Record<string, unknown> | undefined;
}

/**
 * 生成请求的载荷结构
 */
export type GenerationPayload<TBody = GenerationBody> = Record<string, unknown> & {
  body: TBody | undefined;
  api: ApiRequestConfig | undefined;
  meta: Record<string, unknown> | undefined;
};

/**
 * 适配器上下文：由调用方提供，用于在适配器内部获取 provider/taskType/model 等信息
 */
export interface AdapterContext extends Record<string, unknown> {
  provider: string;
  taskType: TaskType;
  model: string | undefined;
  modelConfig: ModelConfigEntry | undefined;
  onStream: (partial: unknown) => void | undefined;
  /**
   * Optional metadata passed to backend Task creation.
   * - Used by Hub to persist task/output mapping even if Editor reloads.
   */
  taskMeta: Record<string, unknown> | undefined;
  /**
   * Callback invoked when a backend task is accepted.
   * Use this to record taskId for task recovery before waiting for completion.
   */
  onTaskAccepted: (taskId: string) => void | undefined;
}

/**
 * 正式异步受理结果：Canvas 执行主链只认该结构。
 */
export interface BackendTaskPendingGeneration {
  __backend_task_pending: true;
  taskId: string;
  raw: unknown | undefined;
  modelId: string | undefined;
}

export type GenerationResult =
  | BackendTaskPendingGeneration
  | JsonValue
  | Record<string, unknown>
  | Array<unknown>
  | FormData
  | null
  | undefined;

/**
 * Compat 边界：历史 queryStatus 参数结构。
 * 禁止在 Canvas 正式执行主链新增依赖。
 */
export interface CompatAdapterStatusQuery {
  endpoint: string;
  /**
   * 若已提前解析完成，可提供 resolvedEndpoint，适配器可优先使用该值避免重复 resolve。
   */
  resolvedEndpoint: string | undefined;
  /**
   * 追加到查询字符串的参数（可选），会在最终请求前统一转为字符串。
   */
  searchParams: Record<string, string | number | boolean | null | undefined> | undefined;
  /**
   * 可选：覆盖或追加的请求头。
   */
  headers: Record<string, string> | undefined;
  /**
   * 可选：HTTP 方法。默认 GET。
   */
  method: string | undefined;
  /**
   * 可选：请求体（部分 provider 的查询接口需要 POST）。
   */
  body: unknown | undefined;
  /**
   * 是否需要由适配器调用 resolveApiEndpoint，默认为 true。
   */
  resolveEndpoint: boolean | undefined;
  /**
   * 关联的历史 requestId，仅用于 compat 日志或调试。
   */
  requestId: string | undefined;
}

export interface CompatAdapterQueryOptions extends Record<string, unknown> {
  /**
   * 触发查询时所处的适配器上下文。
   */
  context: AdapterContext | undefined;
  /**
   * 任务的历史 requestId（与 CompatAdapterStatusQuery.requestId 保持一致）。
   */
  requestId: string | undefined;
}

/**
 * Compat 边界：历史 submitted/requestId 结构。
 * 禁止在 Canvas 正式执行主链新增依赖。
 */
export interface CompatSubmittedGeneration {
  submitted: true;
  taskId: string | undefined;
  task_id: string | undefined;
  requestId: string | undefined;
  raw: unknown | undefined;
}

/**
 * GenerationAdapter 接口
 * - generate: 提交生成请求，返回同步结果或 backend task pending
 * - cancel: 可选，取消任务的能力
 */
export interface GenerationAdapter<TPayload = GenerationPayload, TResult = GenerationResult> {
  generate: (...args: [payload: TPayload | undefined] | [payload: TPayload | undefined, ctx: AdapterContext | undefined]) => Promise<TResult>;
}

export type CancellableGenerationAdapter<TPayload = GenerationPayload, TResult = GenerationResult> =
  GenerationAdapter<TPayload, TResult> &
  Partial<Record<'cancel', (...args: [taskId: string | undefined] | [taskId: string | undefined, ctx: AdapterContext | undefined]) => Promise<unknown> | undefined>>;

/**
 * Compat 边界：历史 queryStatus 能力。
 * 禁止在 Canvas 正式执行主链新增依赖。
 */
export interface CompatStatusQueryAdapter {
  queryStatus: (query: CompatAdapterStatusQuery, opts: CompatAdapterQueryOptions | undefined) => Promise<unknown>;
}
