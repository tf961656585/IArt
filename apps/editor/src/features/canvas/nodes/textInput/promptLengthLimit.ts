"use client";

/**
 * Prompt 长度前置校验：全链路单一事实源。
 *
 * 承载角色：
 * - 字符计数（Unicode 码点数，统一口径）。
 * - 从模型 schema 取 prompt 字段的 maxLength 上限。
 * - 单次校验 + 超限错误类型 + 统一 toast 文案。
 *
 * 设计原则：
 * - 约束随模型走。一个文本节点可连多个模型，模型节点也可接收多段拼接 prompt，
 *   因此限制的归属是“模型能力”，而非“文本节点”。文本节点经出边反查下游模型取最严格值；
 *   模型节点 Inspector 取自身 modelId 的上限。
 * - 即时反馈（计数器）测“原始拼接值”（软提示），提交硬拦截测“trim 后值”（硬拒绝），
 *   两者口径差异仅为首尾空白，可接受。
 * - 两层不可互替：单段不超不代表多段拼接后不超。
 */

import { traverseFields, isDataField } from "@/features/workspace/schema/helpers";
import type {
  SchemaFieldValidation,
  SchemaFormDefinition,
} from "@/features/workspace/schema/types";

/**
 * 字符计数：按 Unicode 码点数。
 *
 * 中英文 + ASCII 下与“字符数”直觉一致；对 emoji 友好（1 个 emoji = 1 码点）。
 * 若模型官方口径为 UTF-16 code unit 或字节，只需改本函数单点。
 */
export function countPromptCharacters(str: string | null | undefined): number {
  if (str === null || str === undefined) return 0;
  return Array.from(str).length;
}

/**
 * 从 schema 查找指定字段的 maxLength 上限。
 *
 * @param schema 模型的 SchemaFormDefinition（由 projection 的 validation_rules.max_length 映射而来）
 * @param fieldKey 目标字段名；通常是 prompt 的 canonical key（"prompt"）。若未命中回退到 "prompt"。
 * @returns maxLength 数值；schema 无该字段或该字段无 maxLength 时返回 undefined
 */
export function getPromptMaxLengthFromSchema(
  schema: SchemaFormDefinition<string> | null | undefined,
  fieldKey: string | undefined,
): number | undefined {
  if (!schema) return undefined;
  const keys = [];
  if (fieldKey) keys.push(fieldKey);
  if (fieldKey !== "prompt") keys.push("prompt");

  for (const key of keys) {
    const validation = findFieldValidation(schema, key);
    const max = readMaxLength(validation);
    if (max !== undefined) return max;
  }
  return undefined;
}

function findFieldValidation(
  schema: SchemaFormDefinition<string>,
  fieldKey: string,
): SchemaFieldValidation<string> | undefined {
  let result: SchemaFieldValidation<string> | undefined;
  traverseFields(schema.fields, (field) => {
    if (result !== undefined) return;
    if (!isDataField(field)) return;
    if (field.key === fieldKey) {
      result = field.validation;
    }
  });
  return result;
}

function readMaxLength(
  validation: SchemaFieldValidation<string> | undefined,
): number | undefined {
  if (!validation) return undefined;
  const max = validation.maxLength;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) {
    return max;
  }
  return undefined;
}

/**
 * 校验单次 prompt 的长度。
 *
 * @returns ok=false 表示超限，携带 actual/limit 供调用方组织反馈。
 */
export function checkPromptLength(params: {
  prompt: string | null | undefined;
  limit: number | undefined;
}): { ok: boolean; actual: number; limit: number | undefined } {
  const limit = params.limit;
  if (limit === undefined || limit === null) {
    return { ok: true, actual: 0, limit: undefined };
  }
  const actual = countPromptCharacters(params.prompt);
  return { ok: actual <= limit, actual, limit };
}

/**
 * 提交硬拦截专用错误。
 *
 * 沿旧节点执行引擎（已退役）冒泡，
 * 在 pipeline 顶层被捕获并转成 toast.error + return null（不创建 task）。
 */
export class PromptLengthExceededError extends Error {
  readonly modelId: string;
  readonly actual: number;
  readonly limit: number;
  readonly fieldKey: string | undefined;

  constructor(params: {
    modelId: string;
    actual: number;
    limit: number;
    fieldKey: string | undefined;
  }) {
    super(
      `Prompt length ${params.actual} exceeds limit ${params.limit} for model ${params.modelId}`,
    );
    this.name = "PromptLengthExceededError";
    this.modelId = params.modelId;
    this.actual = params.actual;
    this.limit = params.limit;
    this.fieldKey = params.fieldKey;
  }
}

/**
 * 统一 toast 文案。
 */
export function formatPromptLengthError(error: PromptLengthExceededError): string {
  return `提示词总长 ${error.actual} 超过 ${error.modelId} 的 ${error.limit} 字符上限，请精简后重试。`;
}

/**
 * 类型守卫：是否为 prompt 长度超限错误。
 */
export function isPromptLengthExceededError(
  error: unknown,
): error is PromptLengthExceededError {
  return error instanceof PromptLengthExceededError;
}
