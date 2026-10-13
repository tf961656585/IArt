import {
  MODEL_ASSET_MEDIA_TARGET_SHAPE,
  MODEL_ASSET_URL_INPUT_UPLOAD_MODE,
  MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE,
  type ModelAssetMultipartArrayNaming,
  type ModelAssetNodeProjectionRuntimeCondition,
} from "@iart/contracts/model-asset-contract";
import {
  collectMediaTargetRules,
  collectPublicUrlFieldTargets,
  evaluateRuntimeCondition,
} from "@iart/model-asset-runtime";
import { findProjectionByModelIdOrAlias } from "../model-package-catalog.cts";
import type { CatalogProjection } from "../model-package-catalog.types.cts";
import { logDebug } from "../logging.cts";
import {
  isPlainObject,
  normalizeString,
  readField,
  stripPayloadBodyPrefix,
} from "./model-input-source.cts";

/* ── path hint utilities (merged from model-input-public-url-path.cts) ── */

const normalizePathSegment = (value: string) =>
  value.toLowerCase().replace(/[_-]/g, "");

const splitFieldPathSegments = (fieldPath: string) =>
  fieldPath
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

const MEDIA_SOURCE_PATH_SEGMENTS = new Set([
  "asseturl",
  "audio",
  "audiourl",
  "data",
  "file",
  "image",
  "images",
  "imageurl",
  "media",
  "src",
  "url",
  "video",
  "videourl",
]);

const STRUCTURED_URL_CONTAINER_SEGMENTS = new Set([
  "audiourl",
  "imageurl",
  "videourl",
]);

const hasPublicUrlMediaPathHint = (fieldPath: string) =>
  splitFieldPathSegments(fieldPath).some((segment) =>
    MEDIA_SOURCE_PATH_SEGMENTS.has(normalizePathSegment(segment)),
  );

const isStructuredUrlContainerPath = (fieldPath: string) => {
  const segments = splitFieldPathSegments(fieldPath);
  const terminal = segments.at(-1);
  return terminal
    ? STRUCTURED_URL_CONTAINER_SEGMENTS.has(normalizePathSegment(terminal))
    : false;
};

const joinPublicUrlChildPath = (fieldPath: string, key: string | number) =>
  typeof key === "number" ? `${fieldPath}[${key}]` : `${fieldPath}.${key}`;

type RuntimeRaw = object & {
  payload_rules: unknown | undefined;
  payload_format: unknown | undefined;
  payload_format_rule: unknown | undefined;
  url_input_upload_mode: unknown | undefined;
  url_input_upload_target_type: unknown | undefined;
};

const emptyRuntimeRaw: RuntimeRaw = {
  payload_rules: undefined,
  payload_format: undefined,
  payload_format_rule: undefined,
  url_input_upload_mode: undefined,
  url_input_upload_target_type: undefined,
};
const emptyPayloadRules = {};

type PublicUrlFieldPolicy = {
  targetPath: string;
  requestBodyPath: string;
};

type MultipartFileFieldPolicy = {
  targetPath: string;
  requestBodyPath: string;
  multipartArrayNaming: ModelAssetMultipartArrayNaming | undefined;
};

type InlineDataFieldPolicy = {
  targetPath: string;
  requestBodyPath: string;
};

type ModelInputPolicy = {
  modelId: string;
  projection: object;
  payloadFormat: string;
  publicUrl: {
    mode: "public_relay";
    targetType: string;
    fields: PublicUrlFieldPolicy[];
  } | null;
  multipartFiles: {
    fields: MultipartFileFieldPolicy[];
  } | null;
  inlineData: {
    fields: InlineDataFieldPolicy[];
  } | null;
};

const asRuntimeRaw = (value: unknown): RuntimeRaw | null =>
  isPlainObject(value) ? (value as RuntimeRaw) : null;

const normalizeTargetType = (value: unknown) => {
  const normalized = normalizeString(value);
  if (
    normalized ===
      MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL ||
    normalized ===
      MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL
  ) {
    return normalized;
  }
  return "";
};

const resolveProjectionByModelIdForPreparation = (modelId: string): CatalogProjection => {
  const result = findProjectionByModelIdOrAlias(modelId);
  if (!result) {
    throw new Error(
      `Model projection unavailable for input preparation: ${modelId || "(empty)"}`,
    );
  }
  return result.projection;
};

/**
 * 从 payload_format_rule 求值运行期 payload format。
 *
 * 输入准备期独立于请求构造期：请求构造期（request-assembler）已对 payload_format_rule
 * 求值并用于传输决策，但求值结果是 per-request 内存态，不传递到输入准备期。此函数在
 * 输入准备期复用轻量纯比较函数 evaluateRuntimeCondition 对同一规则独立求值，condition
 * 是纯比较（ne/eq/truthy 等），输入确定性强、两层结果必然一致。
 *
 * fields 即组装后的 body：condition 的 field 路径（如 "image"）直接从 body 读取，
 * 与请求构造期从 merged fields 读取语义一致（body 的顶层字段就是模型输入字段）。
 *
 * 参数类型用 unknown + 内部类型守卫收窄，避免对跨边界传入的规则对象做类型断言。
 */
const isRuntimeCondition = (value: unknown): value is ModelAssetNodeProjectionRuntimeCondition => {
  if (!isPlainObject(value)) return false;
  const op = normalizeString(readField(value, "op"));
  return (
    op === "and" ||
    op === "or" ||
    op === "not" ||
    op === "eq" ||
    op === "ne" ||
    op === "gt" ||
    op === "gte" ||
    op === "lt" ||
    op === "lte" ||
    op === "includes" ||
    op === "excludes" ||
    op === "truthy" ||
    op === "falsy"
  );
};

/**
 * 开放结构边界类型：condition 求值需要从 body 按字段名读取值，
 * body 是 request-assembler 组装的请求体，字段名天然开放。
 * 命名遵循 stable-business-types guard 的 Dynamic* 开放结构约定。
 */
type DynamicEvalFields = Record<string, unknown>;

const isStringKeyedObject = (value: unknown): value is DynamicEvalFields => {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const resolvePayloadFormatFromRule = async (
  rule: unknown,
  body: unknown,
): Promise<string> => {
  if (!isPlainObject(rule)) return "";
  const ruleKind = normalizeString(readField(rule, "kind"));
  if (ruleKind === "literal") {
    return normalizeString(readField(rule, "value"));
  }
  if (ruleKind === "when") {
    const condition = readField(rule, "condition");
    if (!isRuntimeCondition(condition)) {
      logDebug(
        "[model-input-policy] resolvePayloadFormatFromRule: invalid condition structure, falling back to json",
        { ruleKind },
      );
      return "";
    }
    const fields: DynamicEvalFields = isStringKeyedObject(body)
      ? body
      : {};
    const passes = await evaluateRuntimeCondition(condition, {
      fields,
      currentItem: undefined,
    });
    const branch = passes
      ? readField(rule, "truthy")
      : readField(rule, "falsy");
    if (branch === undefined || branch === null) {
      logDebug(
        "[model-input-policy] resolvePayloadFormatFromRule: rule branch missing, falling back to json",
        { ruleKind, branch: passes ? "truthy" : "falsy" },
      );
      return "";
    }
    const branchValue = isPlainObject(branch)
      ? normalizeString(readField(branch, "value"))
      : "";
    if (!branchValue) {
      logDebug(
        "[model-input-policy] resolvePayloadFormatFromRule: rule branch value empty, falling back to json",
        { ruleKind, branch: passes ? "truthy" : "falsy" },
      );
    }
    return branchValue;
  }
  logDebug(
    "[model-input-policy] resolvePayloadFormatFromRule: unsupported rule kind, falling back to json",
    { ruleKind },
  );
  return "";
};

const resolveModelInputPolicy = async (params: {
  modelId: unknown;
  projection: unknown | undefined;
  body: unknown;
}): Promise<ModelInputPolicy> => {
  const modelId = normalizeString(params.modelId);
  if (!modelId) {
    throw new Error("Missing model_id for input preparation");
  }
  const projection = isPlainObject(params.projection)
    ? params.projection
    : resolveProjectionByModelIdForPreparation(modelId);
  const runtime =
    asRuntimeRaw(readField(projection, "runtime")) ?? emptyRuntimeRaw;
  // 优先级：静态 payload_format > payload_format_rule 求值 > 默认 "json"。
  // gpt-image-2 等合并节点只声明 payload_format_rule（无静态 payload_format），
  // 必须在此求值，否则永远 fallback 到 json，multipart 不生效。
  let payloadFormat = normalizeString(runtime.payload_format);
  if (!payloadFormat) {
    payloadFormat = await resolvePayloadFormatFromRule(
      runtime.payload_format_rule,
      params.body,
    );
  }
  payloadFormat = payloadFormat || "json";
  const uploadMode = normalizeString(runtime.url_input_upload_mode);
  const targetType = normalizeTargetType(runtime.url_input_upload_target_type);
  if (uploadMode !== MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY) {
    const payloadRules = isPlainObject(runtime.payload_rules)
      ? runtime.payload_rules
      : emptyPayloadRules;
    let multipartFilesPolicy: ModelInputPolicy["multipartFiles"] = null;
    if (payloadFormat === "multipart") {
      const allTargets = collectMediaTargetRules(
        payloadRules as Record<string, never>,
      );
      const multipartTargets = allTargets.filter(
        (item) => item.mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.MULTIPART_FILE,
      );
      if (multipartTargets.length > 0) {
        const multipartFields: MultipartFileFieldPolicy[] = [];
        for (const targetRule of multipartTargets) {
          const requestBodyPath = stripPayloadBodyPrefix(targetRule.targetPath);
          if (!requestBodyPath) continue;
          multipartFields.push({
            targetPath: targetRule.targetPath,
            requestBodyPath,
            multipartArrayNaming: targetRule.multipartArrayNaming,
          });
        }
        if (multipartFields.length > 0) {
          multipartFilesPolicy = { fields: multipartFields };
        }
      }
    }
    // inline_data 策略：收集 payload_rules 中 media_target === "inline_data" 的规则
    // 但排除由 build_content_blocks operator 处理的顶层规则（operator 已自行转换 inline_data）
    let inlineDataPolicy: ModelInputPolicy["inlineData"] = null;
    if (payloadFormat !== "multipart") {
      const allTargets = collectMediaTargetRules(
        payloadRules as Record<string, never>,
      );
      const inlineDataTargets = allTargets.filter(
        (item) => item.mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.INLINE_DATA,
      );
      if (inlineDataTargets.length > 0) {
        const inlineDataFields: InlineDataFieldPolicy[] = [];
        for (const targetRule of inlineDataTargets) {
          const requestBodyPath = stripPayloadBodyPrefix(targetRule.targetPath);
          if (!requestBodyPath) continue;
          // 检查该路径的规则是否是 build_content_blocks operator
          const ruleValue = readField(payloadRules, targetRule.targetPath);
          if (isPlainObject(ruleValue)) {
            const kind = normalizeString(readField(ruleValue, "kind"));
            const operator = normalizeString(readField(ruleValue, "operator"));
            if (kind === "compute" && operator === "build_content_blocks") {
              continue;
            }
          }
          inlineDataFields.push({ targetPath: targetRule.targetPath, requestBodyPath });
        }
        if (inlineDataFields.length > 0) {
          inlineDataPolicy = { fields: inlineDataFields };
        }
      }
    }

    return {
      modelId,
      projection,
      payloadFormat,
      publicUrl: null,
      multipartFiles: multipartFilesPolicy,
      inlineData: inlineDataPolicy,
    };
  }
  if (!targetType) {
    throw new Error("Model input public relay targetType missing");
  }
  const payloadRules = isPlainObject(runtime.payload_rules)
    ? runtime.payload_rules
    : emptyPayloadRules;
  const fields: PublicUrlFieldPolicy[] = [];
  for (const targetRule of collectPublicUrlFieldTargets(
    payloadRules as Record<string, never>,
  )) {
    const requestBodyPath = stripPayloadBodyPrefix(targetRule.targetPath);
    if (!requestBodyPath) continue;
    fields.push({ targetPath: targetRule.targetPath, requestBodyPath });
  }
  return {
    modelId,
    projection,
    payloadFormat,
    publicUrl: {
      mode: MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY,
      targetType,
      fields,
    },
    multipartFiles: null,
    inlineData: null,
  };
};

export {
  type ModelInputPolicy,
  type MultipartFileFieldPolicy,
  type InlineDataFieldPolicy,
  type PublicUrlFieldPolicy,
  resolveModelInputPolicy,
  resolveProjectionByModelIdForPreparation,
  hasPublicUrlMediaPathHint,
  isStructuredUrlContainerPath,
  joinPublicUrlChildPath,
};
