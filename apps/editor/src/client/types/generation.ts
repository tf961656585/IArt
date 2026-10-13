import type { GenerationPayload, GenerationResult } from '../adapters/types';

/**
 * 生成载荷与任务相关的类型定义
 * - SchemaGenerationPayload 名称保留以兼容现有调用方，但内容已不依赖 schema
 * - meta 保留临时任务 id 等辅助字段
 */
export interface SchemaGenerationMeta extends Record<string, unknown> {
  _tempTaskId: string | undefined;
  _historyId: string | undefined;
}

export interface SchemaGenerationPayload extends GenerationPayload<Record<string, unknown> | FormData> {
  input: string | undefined;
  prompt: string | undefined;
  meta: SchemaGenerationMeta | undefined;
}

export type StartGenerationResult = GenerationResult | null;

export type GenerationTaskPayload = SchemaGenerationPayload | string;

export type GenerationTaskResult = GenerationResult | null | undefined;

export type StartGenerationHandler = (payload: GenerationTaskPayload | undefined) => Promise<StartGenerationResult>;
