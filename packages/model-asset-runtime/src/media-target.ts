import {
  MODEL_ASSET_MEDIA_TARGET_SHAPE,
  type ModelAssetMediaTargetShape,
  MODEL_ASSET_MULTIPART_ARRAY_NAMING,
  type ModelAssetMultipartArrayNaming,
} from "@iart/contracts/model-asset-contract";
import type { ModelAssetRuntimeValueTransform } from "./index";

const PUBLIC_URL_TRANSFORMS = new Set<string>(["extractUrls", "extractFirstUrl"]);
const MULTIPART_FILE_TRANSFORMS = new Set<string>(["extractFirstFile", "firstUploadFile", "allUploadFiles"]);
const INLINE_DATA_TRANSFORMS = new Set<string>(["extractFirstBase64DataUrl"]);

const normalizeRuntimeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isRuntimeRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeRuntimeTransforms = (
  value: unknown,
): ModelAssetRuntimeValueTransform[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const transforms = value
    .map((item) => normalizeRuntimeString(item))
    .filter((item): item is ModelAssetRuntimeValueTransform => Boolean(item));
  return transforms.length > 0 ? transforms : undefined;
};

export const MODEL_ASSET_MEDIA_TARGET_SHAPES = new Set<string>(
  Object.values(MODEL_ASSET_MEDIA_TARGET_SHAPE),
);

export const MODEL_ASSET_MULTIPART_ARRAY_NAMINGS = new Set<string>(
  Object.values(MODEL_ASSET_MULTIPART_ARRAY_NAMING),
);

export const normalizeMediaTargetShape = (
  value: unknown,
): ModelAssetMediaTargetShape | undefined => {
  const normalized = normalizeRuntimeString(value);
  if (!normalized) return undefined;
  if (!MODEL_ASSET_MEDIA_TARGET_SHAPES.has(normalized)) {
    throw new Error(`runtime_model.runtime.payload_rules_media_target_unknown:${normalized}`);
  }
  return normalized as ModelAssetMediaTargetShape;
};

/**
 * 校验并归一化 multipart_array_naming。
 * 空值返回 undefined（调用方按默认 indexed 处理）。
 * 非法值抛错，由打包校验在 build 阶段暴露。
 */
export const normalizeMultipartArrayNaming = (
  value: unknown,
): ModelAssetMultipartArrayNaming | undefined => {
  const normalized = normalizeRuntimeString(value);
  if (!normalized) return undefined;
  if (!MODEL_ASSET_MULTIPART_ARRAY_NAMINGS.has(normalized)) {
    throw new Error(`runtime_model.runtime.payload_rules_multipart_array_naming_unknown:${normalized}`);
  }
  return normalized as ModelAssetMultipartArrayNaming;
};

export const validateMediaTargetShape = (value: unknown): void => {
  if (value === undefined) return;
  normalizeMediaTargetShape(value);
};

const readRuleMediaTarget = (rule: unknown): ModelAssetMediaTargetShape | undefined =>
  isRuntimeRecord(rule) ? normalizeMediaTargetShape(rule["media_target"]) : undefined;

const readRuleMultipartArrayNaming = (
  rule: unknown,
): ModelAssetMultipartArrayNaming | undefined =>
  isRuntimeRecord(rule)
    ? normalizeMultipartArrayNaming(rule["multipart_array_naming"])
    : undefined;

const collectNestedValueRules = (rule: Record<string, unknown>): unknown[] => {
  const children: unknown[] = [];
  const args = rule["args"];
  if (Array.isArray(args)) children.push(...args);
  for (const key of ["fallback", "truthy", "falsy"]) {
    if (rule[key] !== undefined) children.push(rule[key]);
  }
  const entries = rule["entries"];
  if (isRuntimeRecord(entries)) children.push(...Object.values(entries));
  const options = rule["options"];
  if (isRuntimeRecord(options)) {
    for (const key of ["source", "item", "images", "audio_source", "auto_audio"]) {
      if (options[key] !== undefined) children.push(options[key]);
    }
    for (const key of ["prepend", "append"]) {
      const list = options[key];
      if (Array.isArray(list)) children.push(...list);
    }
    const parts = options["parts"];
    if (Array.isArray(parts)) {
      parts.forEach((part) => {
        if (isRuntimeRecord(part) && part["value"] !== undefined) children.push(part["value"]);
      });
    }
  }
  return children;
};

export const valueRuleUsesMediaTransform = (rule: unknown): boolean => {
  if (!isRuntimeRecord(rule)) return false;
  const transforms = normalizeRuntimeTransforms(rule["transforms"]) ?? [];
  if (
    transforms.some(
      (transform) =>
        PUBLIC_URL_TRANSFORMS.has(transform) ||
        MULTIPART_FILE_TRANSFORMS.has(transform) ||
        INLINE_DATA_TRANSFORMS.has(transform),
    )
  ) {
    return true;
  }
  const operator = normalizeRuntimeString(rule["operator"]).toLowerCase();
  if (operator === "build_content_blocks") return true;
  return collectNestedValueRules(rule).some((child) => valueRuleUsesMediaTransform(child));
};

export type ModelAssetMediaTargetRule = {
  targetPath: string;
  mediaTarget: ModelAssetMediaTargetShape;
  multipartArrayNaming: ModelAssetMultipartArrayNaming | undefined;
};

export const collectMediaTargetsFromValueRule = (
  targetPath: string,
  rule: unknown,
): ModelAssetMediaTargetRule[] => {
  const collected: ModelAssetMediaTargetRule[] = [];
  const visit = (current: unknown): void => {
    if (!isRuntimeRecord(current)) return;
    const mediaTarget = readRuleMediaTarget(current);
    if (mediaTarget) {
      const multipartArrayNaming = readRuleMultipartArrayNaming(current);
      collected.push({ targetPath, mediaTarget, multipartArrayNaming });
    }
    collectNestedValueRules(current).forEach((child) => visit(child));
  };
  visit(rule);
  return collected;
};

export const collectMediaTargetRules = (
  payloadRules: Record<string, unknown> | undefined,
): ModelAssetMediaTargetRule[] =>
  payloadRules
    ? Object.entries(payloadRules).flatMap(([targetPath, rule]) =>
        collectMediaTargetsFromValueRule(targetPath, rule),
      )
    : [];

export const collectPublicUrlFieldTargets = (
  payloadRules: Record<string, unknown> | undefined,
): ModelAssetMediaTargetRule[] =>
  collectMediaTargetRules(payloadRules).filter(
    (item) => item.mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.PUBLIC_URL,
  );

export type ModelAssetMediaTargetValidationContext = {
  payloadFormat: string | undefined | undefined;
  /**
   * 当 `payloadFormat` 是静态字符串无法满足 `multipart_file` 校验时，检查此规则。
   * 若规则的 truthy 分支字面量集合包含 `multipart`，视为字段声明合法。
   * 打包期不执行规则求值，只做静态字面量收集。
   */
  payloadFormatRule: unknown | undefined;
  urlInputUploadMode: string | undefined | undefined;
  urlInputUploadTargetType: string | undefined | undefined;
  preRequests: unknown[] | undefined | undefined;
};

/**
 * 从值规则递归收集所有 literal 节点的字面量值。
 * 用于打包期在不执行求值的前提下判断"某条件分支是否可能产出特定字面量"。
 */
const collectLiteralValuesFromValueRule = (rule: unknown): unknown[] => {
  if (!isRuntimeRecord(rule)) return [];
  const literals: unknown[] = [];
  if (normalizeRuntimeString(rule['kind']) === 'literal') {
    literals.push(rule['value']);
  }
  // 递归进入 args / fallback / truthy / falsy / entries / options 子树
  for (const child of collectNestedValueRules(rule as Record<string, unknown>)) {
    literals.push(...collectLiteralValuesFromValueRule(child));
  }
  return literals;
};

const payloadFormatRuleProducesMultipart = (
  payloadFormatRule: unknown,
): boolean => {
  const literals = collectLiteralValuesFromValueRule(payloadFormatRule);
  return literals.some(
    (value) => typeof value === 'string' && value.toLowerCase() === 'multipart',
  );
};

const collectPublicUrlTargetsFromPreRequests = (
  preRequests: unknown[] | undefined,
): number => {
  if (!Array.isArray(preRequests)) return 0;
  let count = 0;
  for (const preRequest of preRequests) {
    if (!isRuntimeRecord(preRequest)) continue;
    const body = preRequest["body"];
    if (!isRuntimeRecord(body)) continue;
    for (const rule of Object.values(body)) {
      const mediaTarget = readRuleMediaTarget(rule);
      if (mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.PUBLIC_URL) {
        count += 1;
      }
    }
  }
  return count;
};

export const validateMediaTargetRuleSet = (
  payloadRules: Record<string, unknown> | undefined,
  context: ModelAssetMediaTargetValidationContext = { payloadFormat: undefined, payloadFormatRule: undefined, urlInputUploadMode: undefined, urlInputUploadTargetType: undefined, preRequests: undefined },
): void => {
  if (!payloadRules) return;
  const payloadFormat = normalizeRuntimeString(context.payloadFormat) || "json";
  const payloadFormatRule = context.payloadFormatRule;
  const uploadMode = normalizeRuntimeString(context.urlInputUploadMode);
  const uploadTargetType = normalizeRuntimeString(context.urlInputUploadTargetType);
  let publicUrlFieldCount = 0;

  for (const [targetPath, rule] of Object.entries(payloadRules)) {
    if (targetPath === "body.input_uploads" || targetPath.endsWith(".input_uploads")) {
      throw new Error(`runtime_model.runtime.payload_rules_input_uploads_reserved:${targetPath}`);
    }
    const targetRules = collectMediaTargetsFromValueRule(targetPath, rule);
    if (valueRuleUsesMediaTransform(rule) && targetRules.length === 0) {
      throw new Error(`runtime_model.runtime.payload_rules_media_target_missing:${targetPath}`);
    }
    for (const targetRule of targetRules) {
      if (targetRule.mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.PUBLIC_URL) {
        publicUrlFieldCount += 1;
        if (uploadMode !== "public_relay") {
          throw new Error(`runtime_model.runtime.payload_rules_public_url_upload_mode_missing:${targetPath}`);
        }
        if (!uploadTargetType) {
          throw new Error(`runtime_model.runtime.payload_rules_public_url_target_type_missing:${targetPath}`);
        }
      }
      if (
        targetRule.mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.MULTIPART_FILE &&
        payloadFormat !== "multipart" &&
        !payloadFormatRuleProducesMultipart(payloadFormatRule)
      ) {
        throw new Error(`runtime_model.runtime.payload_rules_multipart_file_payload_format_invalid:${targetPath}`);
      }
      if (
        targetRule.mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.MULTIPART_FILE &&
        !targetPath.startsWith("body.")
      ) {
        throw new Error(`runtime_model.runtime.payload_rules_multipart_file_target_invalid:${targetPath}`);
      }
      // multipart_array_naming 只允许声明在 multipart_file 目标上
      if (
        targetRule.multipartArrayNaming !== undefined &&
        targetRule.mediaTarget !== MODEL_ASSET_MEDIA_TARGET_SHAPE.MULTIPART_FILE
      ) {
        throw new Error(`runtime_model.runtime.payload_rules_multipart_array_naming_target_invalid:${targetPath}`);
      }
    }
  }

  const preRequestPublicUrlCount = collectPublicUrlTargetsFromPreRequests(context.preRequests);

  if (uploadMode === "public_relay" && publicUrlFieldCount === 0 && preRequestPublicUrlCount === 0) {
    throw new Error("runtime_model.runtime.url_input_upload_mode_without_public_url_target");
  }
};
