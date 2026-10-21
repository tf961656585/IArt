import type { ModelAssetRuntimeRecord } from "@iart/model-asset-runtime";
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts/model-asset-contract/protocol-constants";
import * as loggingModule from "./logging.cts";
import { getFetchDispatcher } from "./fetch-dispatcher.cts";
import { findProjectionByModelIdOrAlias, type FindProjectionResult } from "./model-package-catalog.cts";
import type { CatalogPreRequestDefinition, CatalogRawObject, PreRequestBodyPayload, PreRequestOutputMap, PreRequestOutputPayload, VariantPayloadOverridesMap } from "./model-package-catalog.types.cts";
import {
  invalidArguments,
  modelUnavailable,
} from "./errors.cts";
import {
  evaluateRule,
  resolveUploadUrlOptions,
} from "./request-assembler-runtime.cts";
import {
  normalizeMediaInputBuckets,
} from "./media-input-bucket-normalizer.cts";
import { injectMentionsIntoReferenceBlobs } from "./request-assembler-mention.cts";
import {
  assignNestedValue,
  asPayloadApiRaw,
  asPayloadRaw,
  asProjectionRaw,
  asProjectionRuntimeRaw,
  asRequestAssemblerInputRaw,
  asTaskExecutionPlanRaw,
  cloneValue,
  isPlainObject,
  mergeFieldMaps,
  normalizeString,
  readOpenField,
  writeOpenField,
  type AssemblerContext,
  type EvaluateState,
  type HeaderMap,
  type PlainObject,
} from "./request-assembler-shared.cts";
import { materializeSubtree } from "./model-input-preparation/model-input-materializer.cts";
import { readValueByPath } from "./task-engine-polling-utils.cts";
import { normalizeTaskPollingStrategy } from "./model-package-catalog.task-plan.cts";
import { executePreRequestPolling } from "./request-assembler-pre-request-polling.cts";

type FetchInitWithDispatcher = RequestInit & { dispatcher: unknown | undefined };

const MEDIA_UPLOAD_COMPONENT_TO_KIND: Record<string, string> = {
  imageupload: "image",
  videoupload: "video",
  audioupload: "audio",
  file: "file",
};

interface MediaFieldInfo {
  fieldKey: string;
  required: boolean;
}

/**
 * 从 projection 的 parameter_schema 中收集所有媒体类型字段及其 required 标记。
 * 匹配 component 为 imageUpload/videoupload/audioupload/file（不区分大小写）的字段。
 * required 判定：field.required === true 或 field_key 出现在 required_fields 中。
 */
const collectMediaFieldKeysFromProjection = (
  projection: PlainObject,
): MediaFieldInfo[] => {
  const parameterSchema = readOpenField(projection, "parameter_schema");
  if (!isPlainObject(parameterSchema)) return [];
  const schemaFields = readOpenField(parameterSchema, "fields");
  if (!Array.isArray(schemaFields)) return [];
  const requiredFieldsRaw = readOpenField(parameterSchema, "required_fields");
  const requiredFieldsSet = new Set<string>(
    Array.isArray(requiredFieldsRaw)
      ? requiredFieldsRaw.filter((v: unknown): v is string => typeof v === "string")
      : [],
  );
  const infos: MediaFieldInfo[] = [];
  for (const field of schemaFields) {
    if (!isPlainObject(field)) continue;
    const fieldKey = normalizeString(readOpenField(field, "field_key"));
    const component = normalizeString(readOpenField(field, "component")).toLowerCase();
    if (!fieldKey) continue;
    if (!(component in MEDIA_UPLOAD_COMPONENT_TO_KIND)) continue;
    const fieldRequired = readOpenField(field, "required");
    const required = fieldRequired === true || requiredFieldsSet.has(fieldKey);
    infos.push({ fieldKey, required });
  }
  return infos;
};

type PayloadApiRaw = NonNullable<ReturnType<typeof asPayloadApiRaw>>;
type PayloadRaw = NonNullable<ReturnType<typeof asPayloadRaw>>;
type RequestAssemblerInputRaw = NonNullable<ReturnType<typeof asRequestAssemblerInputRaw>>;

const resolveProjectionByModelId = (
  modelId: unknown,
  context: AssemblerContext,
): FindProjectionResult => {
  const baseDir = context.baseDir || undefined;
  const normalizedModelId = normalizeString(modelId);
  const result = findProjectionByModelIdOrAlias(normalizedModelId, { baseDir });
  if (!result) {
    throw modelUnavailable(normalizedModelId);
  }
  return result;
};

const buildPollingStrategyFromProjection = (
  projection: PlainObject,
  endpoint: unknown,
  payload: PlainObject | undefined,
): unknown => {
  const projectionRaw = asProjectionRaw(projection);
  const formalPlan = asTaskExecutionPlanRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.task_execution_plan : undefined));
  void endpoint;
  if (!formalPlan || !isPlainObject(formalPlan.polling_strategy)) return null;
  const resultRule = isPlainObject(formalPlan.result_rule)
    ? formalPlan.result_rule
    : {};
  if (
    normalizeString((resultRule as { mode: unknown | undefined }).mode).toLowerCase() !==
    "async"
  ) {
    return null;
  }
  type PollingRequestDynamic = {
    url_template: string | undefined;
    urlTemplate: string | undefined;
  };
  type PayloadMetaDynamic = {
    taskType: string | undefined;
  };
  type PayloadDynamic = {
    meta: PayloadMetaDynamic | undefined;
  };
  type ClonedPollingStrategyDynamic = {
    request: PollingRequestDynamic | undefined;
  };
  const cloned = cloneValue(formalPlan.polling_strategy) as ClonedPollingStrategyDynamic;
  const pollingRequest = cloned.request;
  if (pollingRequest === undefined) {
    return cloned;
  }
  const template =
    normalizeString(pollingRequest.url_template) ||
    normalizeString(pollingRequest.urlTemplate);
  if (template && payload) {
    const payloadRaw = isPlainObject(payload) ? payload as PayloadDynamic : ({} as PayloadDynamic);
    const payloadMeta = payloadRaw.meta;
    const taskType = normalizeString(payloadMeta === undefined ? undefined : payloadMeta.taskType);
    if (taskType) {
      const replaced = template.replace(/\{taskType\}/g, taskType);
      if (replaced !== template) {
        pollingRequest.url_template = replaced;
      }
    }
  }
  return cloned;
};

/**
 * 解析模型能力包的 endpoint 相对路径。
 *
 * - 绝对 URL 原样返回（历史 prebuilt_payload 兼容）；
 * - 相对路径以 "/" 开头透传，最终 origin 由任务派发前的 ExecutionSnapshot.base_url
 *   决定（spec 03 §8 / spec 45 §5.2：payload 组装期不冻结 base_url，也不解析 override）。
 * - 旧 override 解析已随 spec 03 删除（PC-08），此处不保留任何 override fallback。
 */
const resolveAbsoluteEndpoint = (endpoint: unknown) => {
  const normalizedEndpoint = normalizeString(endpoint);
  if (!normalizedEndpoint) {
    throw invalidArguments("Model endpoint missing");
  }
  const isAbsoluteUrl = /^https?:\/\//i.test(normalizedEndpoint);
  if (isAbsoluteUrl) {
    return normalizedEndpoint;
  }
  return normalizedEndpoint.startsWith("/") ? normalizedEndpoint : `/${normalizedEndpoint}`;
};

const buildExecutionPlanFromPayload = (
  projection: PlainObject,
  modelId: string,
  payload: PlainObject,
) => {
  const projectionRaw = asProjectionRaw(projection);
  const runtime = asProjectionRuntimeRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.runtime : undefined));
  const runtimeDefaults = asPayloadApiRaw((runtime !== null && runtime !== undefined ? runtime.api_defaults : undefined)) ?? ({} as PayloadApiRaw);
  const payloadRaw = asPayloadRaw(payload) ?? ({} as PayloadRaw);
  const payloadApi = asPayloadApiRaw(payloadRaw.api) ?? ({} as PayloadApiRaw);
  const endpoint = normalizeString(
    payloadApi.endpoint || runtimeDefaults.endpoint,
  );
  const method =
    normalizeString(payloadApi.method || runtimeDefaults.method) || "POST";
  const contentType =
    payloadApi.contentType !== undefined
      ? payloadApi.contentType
      : Object.prototype.hasOwnProperty.call(runtimeDefaults, "contentType")
        ? runtimeDefaults.contentType
        : "application/json";
  const headers = {} as { "content-type": unknown | undefined; "Content-Type": unknown | undefined };
  if (isPlainObject(payloadApi.headers)) {
    for (const [key, value] of Object.entries(payloadApi.headers as Record<string, unknown>)) {
      writeOpenField(headers, key, value);
    }
  }
  const headerMap: HeaderMap = {
    contentTypeLower: readOpenField(headers, "content-type"),
    contentTypeCanonical: readOpenField(headers, "Content-Type"),
  };
  if (
    typeof contentType === "string" &&
    contentType.trim() &&
    !headerMap.contentTypeLower &&
    !headerMap.contentTypeCanonical
  ) {
    writeOpenField(headers, "content-type", contentType.trim());
  }
  const requestBody = Object.prototype.hasOwnProperty.call(payload, "body")
    ? cloneValue(payloadRaw.body)
    : undefined;
  // 相对 endpoint 透传；origin 由任务派发前 ExecutionSnapshot.base_url 决算（spec 03 §8）。
  const resolvedEndpoint = resolveAbsoluteEndpoint(endpoint);
  const formalPlan = asTaskExecutionPlanRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.task_execution_plan : undefined));
  if (!formalPlan || !isPlainObject(formalPlan.result_rule)) {
    throw invalidArguments(
      `Model ${modelId} missing formal task_execution_plan`,
    );
  }
  const pollingStrategy = buildPollingStrategyFromProjection(
    projection,
    resolvedEndpoint,
    payloadRaw as PlainObject,
  );
  const resultRule = isPlainObject(formalPlan.result_rule)
    ? cloneValue(formalPlan.result_rule)
    : { submit_response_id_path: "/id" };
  const resultAcquisitionStrategy = isPlainObject(
    formalPlan.result_acquisition_strategy,
  )
    ? cloneValue(formalPlan.result_acquisition_strategy)
    : null;
  const resultOutputMapping = isPlainObject(formalPlan.result_output_mapping)
    ? cloneValue(formalPlan.result_output_mapping)
    : null;
  return {
    projection,
    executionPlan: {
      model_id: modelId,
      submit_request: {
        url: resolvedEndpoint,
        method,
        headers,
        body: requestBody,
      },
      polling_strategy: pollingStrategy,
      result_rule: resultRule,
      result_acquisition_strategy: resultAcquisitionStrategy,
      result_output_mapping: resultOutputMapping,
      metadata: {
        modelId,
        model_id: modelId,
        packageId: normalizeString((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.package_id : undefined)),
        endpoint,
      },
      auto_start: true,
    },
  };
};

const applyPayloadOverrides = (
  payload: PlainObject,
  overrides: VariantPayloadOverridesMap | undefined,
): void => {
  if (overrides === undefined) return;
  for (const [path, value] of Object.entries(overrides)) {
    assignNestedValue(payload, path, value);
  }
};

const assembleExecutionPlanFromPrebuiltPayload = (
  input: unknown,
  context: AssemblerContext,
) => {
  const inputRecord = asRequestAssemblerInputRaw(input) ?? ({} as RequestAssemblerInputRaw);
  const modelId = normalizeString(inputRecord.model_id);
  const { projection, payload_overrides } = resolveProjectionByModelId(modelId, context);
  const payload = isPlainObject(inputRecord.payload) ? inputRecord.payload : ({} as PlainObject);
  applyPayloadOverrides(payload, payload_overrides);
  return buildExecutionPlanFromPayload(projection, modelId, payload);
};

const buildRuntimePayloadFromRules = async (
  input: unknown,
  projection: PlainObject,
  projectPath: string | null,
  preRequestOutputs: PreRequestOutputMap | undefined,
) => {
  const inputRecord = isPlainObject(input) ? input : {};
  const projectionRaw = asProjectionRaw(projection);
  const projectionRuntime = asProjectionRuntimeRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.runtime : undefined));
  const runtime: PlainObject = {};
  const payloadRules = projectionRuntime !== null && projectionRuntime !== undefined && isPlainObject(projectionRuntime.payload_rules)
    ? projectionRuntime.payload_rules
    : {};
  const mediaInputFields = await normalizeMediaInputBuckets(
    readOpenField(inputRecord, "media_inputs"),
    projection,
    projectPath,
  );
  const mediaInputFieldsEntries = Object.entries(mediaInputFields);
  const mediaInputFieldsSummary = mediaInputFieldsEntries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : 0}`).join(", ");
  loggingModule.logDebug("[request-assembler] buildRuntimePayloadFromRules: mediaInputBuckets", { summary: mediaInputFieldsSummary || "(empty)" });
  // 逐必填素材位判空。
  //
  // 这条判据以前的写法是「全部桶里一条媒体都没有」才检查，于是多素材位模型上
  // 「首帧空、尾帧有图」会整条放行——必填位缺失被别的位的存在掩盖，失败推到上游。
  // 现在逐个必填字段键判：该位既没有分桶到的媒体、参数里也没有非空值，才判缺失。
  // 可选媒体字段（required=false）为空时放行，支持纯文生图等不传图的场景。
  const mediaFieldInfos = collectMediaFieldKeysFromProjection(projection);
  const requiredMediaFieldKeys = mediaFieldInfos.filter((info) => info.required);
  if (requiredMediaFieldKeys.length > 0) {
    const argumentsObj = readOpenField(inputRecord, "arguments");
    const argumentsSource = isPlainObject(argumentsObj) ? argumentsObj : {};
    const argumentsMap = new Map<string, unknown>(Object.entries(argumentsSource));
    const missingKeys: string[] = [];
    for (const { fieldKey } of requiredMediaFieldKeys) {
      const bucketed = mediaInputFields[fieldKey];
      if (Array.isArray(bucketed) && bucketed.length > 0) continue;
      const argValue = argumentsMap.get(fieldKey);
      const hasArgValue =
        argValue !== undefined && argValue !== null && argValue !== "" &&
        !(Array.isArray(argValue) && argValue.length === 0);
      if (!hasArgValue) missingKeys.push(fieldKey);
    }
    if (missingKeys.length > 0) {
      loggingModule.logWarn("[request-assembler] buildRuntimePayloadFromRules: media_inputs_required_but_empty", { requiredFields: requiredMediaFieldKeys.map((i) => i.fieldKey), missingKeys });
      throw invalidArguments(
        `media_inputs_required_but_empty: model declares required media input fields (${missingKeys.join(", ")}) but no media was bound to them. Attach media to each required slot (via media_inputs field_key) before submitting.`,
      );
    }
  }
  const fields = mergeFieldMaps(
    readOpenField(inputRecord, "arguments"),
    mediaInputFields,
    readOpenField(inputRecord, "input_assets"),
    promptFields(inputRecord),
  ) as ModelAssetRuntimeRecord;
  loggingModule.logDebug("[request-assembler] buildRuntimePayloadFromRules: fields after merge", { keys: Object.keys(fields) });
  const state = { fields, runtime, projection, currentItem: undefined, projectPath } satisfies EvaluateState;
  // payload_format 支持静态声明（payload_format 字符串）与运行时条件求值（payload_format_rule 值规则）两种形态。
  // 后者用于单节点承载多种远端接口语义的场景（如文生图 JSON + 图生图 multipart 合并节点）。
  // 求值时机：请求构造期，在主循环求值 payload_rules 之前先求值此规则，结果写入 state.runtime.payloadFormat
  // 供 resolveUploadUrlOptions 等下游读取。静态声明时直接使用字符串值。
  const staticPayloadFormat = normalizeString((projectionRuntime !== null && projectionRuntime !== undefined ? projectionRuntime.payload_format : undefined));
  const payloadFormatRule = (projectionRuntime !== null && projectionRuntime !== undefined ? projectionRuntime.payload_format_rule : undefined);
  let dynamicPayloadFormat = staticPayloadFormat;
  if (payloadFormatRule !== undefined) {
    const evaluatedFormat = await evaluateRule(payloadFormatRule, state, {
      uploadOptions: undefined,
      item: undefined,
      targetPath: undefined,
      preRequestOutputs: preRequestOutputs,
    });
    const normalized = normalizeString(evaluatedFormat);
    if (normalized) {
      dynamicPayloadFormat = normalized;
    }
  }
  // 写入 state.runtime 供下游 resolveUploadUrlOptionsFromContext 读取（per-request 求值结果）
  writeOpenField(state.runtime, "payloadFormat", dynamicPayloadFormat || undefined);
  loggingModule.logDebug("[request-assembler] buildRuntimePayloadFromRules: resolved payloadFormat", { staticPayloadFormat, hasRule: payloadFormatRule !== undefined, dynamicPayloadFormat });
  const pending: Array<[string, Promise<unknown>]> = [];
  for (const [targetPath, rule] of Object.entries(payloadRules)) {
    const value = evaluateRule(rule, state, {
      uploadOptions: resolveUploadUrlOptions(projection, targetPath, dynamicPayloadFormat || undefined),
      item: undefined,
      targetPath: undefined,
      preRequestOutputs: preRequestOutputs,
    });
    pending.push([targetPath, value]);
  }
  const entries = await Promise.all(
    pending.map(
      async ([targetPath, promise]) => [targetPath, await promise] as const,
    ),
  );
  const payload = { api: {}, body: {}, meta: {} } as PlainObject;
  for (const [targetPath, value] of entries) {
    assignNestedValue(payload, targetPath, value);
  }
  // mention 注入（后端物化层，不进 payload_rules DSL，spec §5.4 / §7.3）：
  // 依据编辑器传入的 mention_map（"@锚点 → 素材" 映射），为被提示词 @ 的
  // referenceBlob 补 mention。失败不阻塞任务（防御性跳过）。
  injectMentionsIntoReferenceBlobs(
    payload,
    readOpenField(inputRecord, "mention_map"),
    mediaInputFields,
  );
  return payload;
};

const extractPreRequestDefinitions = (
  projection: PlainObject,
): CatalogPreRequestDefinition[] => {
  const projectionRaw = asProjectionRaw(projection);
  const projectionRuntime = asProjectionRuntimeRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.runtime : undefined));
  if (projectionRuntime === null || projectionRuntime === undefined) return [];
  const preRequestsRaw = projectionRuntime.pre_requests;
  if (!Array.isArray(preRequestsRaw)) return [];
  const results: CatalogPreRequestDefinition[] = [];
  for (const item of preRequestsRaw) {
    if (item === null || item === undefined || typeof item !== "object") continue;
    const record = item as CatalogRawObject;
    const id = normalizeString(record.id);
    const endpoint = normalizeString(record.endpoint);
    const method = normalizeString(record.method);
    if (!id || !endpoint || !method) {
      loggingModule.logDebug("[request-assembler] extractPreRequestDefinitions: skipping pre_request with missing id/endpoint/method", undefined);
      continue;
    }
    const bodyRaw = record.body;
    const body = isPlainObject(bodyRaw) ? bodyRaw as CatalogRawObject : {} as CatalogRawObject;
    const outputMappingRaw = record.output_mapping;
    const outputMapping: Record<string, string> = isPlainObject(outputMappingRaw)
      ? Object.fromEntries(
          Object.entries(outputMappingRaw as CatalogRawObject).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
    const pollingRaw = record.polling;
    const polling = pollingRaw
      ? normalizeTaskPollingStrategy(pollingRaw)
      : null;
    const submit_response_id_path = normalizeString(record.submit_response_id_path) || null;
    results.push({ id, endpoint, method, body, output_mapping: outputMapping, polling, submit_response_id_path });
  }
  return results;
};

const evaluatePreRequestBody = async (
  bodyRules: CatalogRawObject,
  state: EvaluateState,
): Promise<PreRequestBodyPayload> => {
  const result: PreRequestBodyPayload = {};
  for (const [key, rule] of Object.entries(bodyRules)) {
    const value = await evaluateRule(rule, state, {
      uploadOptions: undefined,
      item: undefined,
      targetPath: undefined,
      preRequestOutputs: undefined,
    });
    result[key] = value;
  }
  return result;
};

const materializePreRequestMedia = async (
  body: PreRequestBodyPayload,
  projectPath: string | null,
): Promise<PreRequestBodyPayload> => {
  const materializeCtx = {
    projectPath,
    targetType: "",
    taskId: undefined,
    multipartMode: false,
    events: [] as Array<{ type: string; detail: object }>,
  };
  const result: PreRequestBodyPayload = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === "") {
      result[key] = value;
      continue;
    }
    const prepared = await materializeSubtree(materializeCtx, value, `pre_request.${key}`);
    if (!prepared.ok) {
      throw new Error(`pre_request media materialization failed for key "${key}": ${prepared.message}`);
    }
    result[key] = prepared.value;
  }
  return result;
};

const executePreRequest = async (
  preRequest: CatalogPreRequestDefinition,
  fields: ModelAssetRuntimeRecord,
  projection: PlainObject,
  projectPath: string | null,
): Promise<PreRequestOutputPayload> => {
  const state: EvaluateState = {
    fields,
    runtime: {},
    projection,
    currentItem: undefined,
    projectPath,
  };
  const body = await evaluatePreRequestBody(preRequest.body as CatalogRawObject, state);
  const materializedBody = await materializePreRequestMedia(body, projectPath);
  const endpoint = resolveAbsoluteEndpoint(preRequest.endpoint);
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const response = await fetch(endpoint, {
    method: preRequest.method,
    headers,
    body: JSON.stringify(materializedBody),
    dispatcher: getFetchDispatcher(),
  } as FetchInitWithDispatcher);
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(`pre_request "${preRequest.id}" failed: HTTP ${response.status} ${response.statusText}: ${responseText.substring(0, 500)}`);
  }
  let responseData: unknown;
  try {
    responseData = await response.json();
  } catch {
    throw new Error(`pre_request "${preRequest.id}" failed: response is not valid JSON`);
  }

  responseData = await executePreRequestPolling({
    responseData,
    preRequest,
    resolveEndpoint: (endpoint: string) => resolveAbsoluteEndpoint(endpoint),
  });

  const output: PreRequestOutputPayload = {};
  for (const [outputKey, jsonPath] of Object.entries(preRequest.output_mapping)) {
    const current = readValueByPath(responseData, jsonPath, { silent: true, parseJsonString: undefined });
    output[outputKey] = current;
    if (current === undefined) {
      throw new Error(
        `pre_request "${preRequest.id}" output_key "${outputKey}" resolved to undefined from path "${jsonPath}". Response data does not contain expected value at this path.`
      );
    }
  }
  return output;
};

/**
 * PromptDock 草稿的顶层 prompt 投影为参数合并层中的保留键 `__prompt` 字段。
 *
 * 模型能力包以 `field_key: "__prompt"`（MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY）在
 * payload_rules / pre_requests 中引用提示词暂存键；产品层 prompt 由 PromptDock 草稿
 * 顶层承载，不进入模型参数表单、不参与参数校验。合并时注入为最后一个源，
 * 覆盖参数表单中残留的同名值，保证 payload 与 pre_request 取到的都是本次草稿 prompt。
 *
 * 兼容旧形态：canvas 媒体加工（outpaint 等）仍经 `/api/tasks` 以 arguments.prompt 提交
 * 提示词（无顶层 prompt 字段）。此处把该旧形态也归一为 `__prompt`，二者同源不双写。
 */
const promptFields = (inputRecord: PlainObject): PlainObject => {
  const topLevelPrompt = readOpenField(inputRecord, "prompt");
  if (typeof topLevelPrompt === "string" && topLevelPrompt.length > 0) {
    return { [MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY]: topLevelPrompt };
  }
  const argumentsObj = readOpenField(inputRecord, "arguments");
  const legacyArgumentsPrompt = isPlainObject(argumentsObj)
    ? readOpenField(argumentsObj, "prompt")
    : undefined;
  return typeof legacyArgumentsPrompt === "string" && legacyArgumentsPrompt.length > 0
    ? { [MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY]: legacyArgumentsPrompt }
    : {};
};

const executePreRequests = async (
  preRequests: CatalogPreRequestDefinition[],
  fields: ModelAssetRuntimeRecord,
  projection: PlainObject,
  projectPath: string | null,
): Promise<PreRequestOutputMap> => {
  const outputMap: PreRequestOutputMap = {};
  for (const preRequest of preRequests) {
    loggingModule.logDebug("[request-assembler] executePreRequests: executing pre_request", { id: preRequest.id, endpoint: preRequest.endpoint });
    const output = await executePreRequest(preRequest, fields, projection, projectPath);
    outputMap[preRequest.id] = output;
  }
  return outputMap;
};

const assembleGenerationTaskRequest = async (
  input: unknown,
  context: AssemblerContext,
) => {
  const inputRecord = asRequestAssemblerInputRaw(input) ?? ({} as RequestAssemblerInputRaw);
  const modelId = normalizeString(inputRecord.model_id);
  const { projection, payload_overrides } = resolveProjectionByModelId(modelId, context);
  const projectPath = context.projectPath;

  const preRequests = extractPreRequestDefinitions(projection);
  let preRequestOutputs: PreRequestOutputMap | undefined = undefined;
  if (preRequests.length > 0) {
    const mediaInputFields = await normalizeMediaInputBuckets(
      readOpenField(inputRecord, "media_inputs"),
      projection,
      projectPath,
    );
    const fields = mergeFieldMaps(
      readOpenField(inputRecord, "arguments"),
      mediaInputFields,
      readOpenField(inputRecord, "input_assets"),
      promptFields(inputRecord),
    ) as ModelAssetRuntimeRecord;
    loggingModule.logDebug("[request-assembler] assembleGenerationTaskRequest: executing pre_requests", { count: preRequests.length, modelId });
    preRequestOutputs = await executePreRequests(preRequests, fields, projection, projectPath);
  }

  const payload = await buildRuntimePayloadFromRules(inputRecord, projection, projectPath, preRequestOutputs);
  applyPayloadOverrides(payload, payload_overrides);
  return buildExecutionPlanFromPayload(projection, modelId, payload);
};

export {
  assembleExecutionPlanFromPrebuiltPayload,
  assembleGenerationTaskRequest,
  buildRuntimePayloadFromRules,
  resolveAbsoluteEndpoint,
  resolveProjectionByModelId,
};
