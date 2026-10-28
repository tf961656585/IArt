import type { ModelAssetRuntimeRecord } from "@iart/model-asset-runtime";
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts/model-asset-contract/protocol-constants";
import {
  defaultCustomInterfaceFormatContentType,
  type CustomInterfaceFormatPayloadFormat,
} from "@iart/contracts";
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
  type PlainObject,
  type ProjectionRuntimeRaw,
} from "./request-assembler-shared.cts";
import { materializeSubtree } from "./model-input-preparation/model-input-materializer.cts";
import { readValueByPath } from "./task-engine-polling-utils.cts";
import { normalizeTaskPollingStrategy } from "./model-package-catalog.task-plan.cts";
import { executePreRequestPolling } from "./request-assembler-pre-request-polling.cts";
import {
  appendQueryEntries,
  normalizeFixedHeaders,
  normalizeQueryEntries,
  readStaticQueryParamNames,
  replaceJsonPlaceholders,
  replaceUrlTemplatePlaceholders,
} from "./request-wire-utils.cts";
import type { UnknownRecord } from "./utils.cts";

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
  const cloned = cloneValue(formalPlan.polling_strategy);
  const payloadMeta = isPlainObject(payload) ? readOpenField(payload, "meta") : undefined;
  const taskType = isPlainObject(payloadMeta) ? normalizeString(readOpenField(payloadMeta, "taskType")) : "";
  if (taskType) {
    applyPollingTaskTypePlaceholders(cloned, taskType);
  }
  return cloned;
};

/**
 * 轮询请求里的 `{taskType}` 占位在组装期就有值（来自 `meta.taskType`），先替换掉。
 *
 * 地址模板按「路径保留原文、查询串编码」替换；请求头 / 查询参数 / 请求体里的字符串
 * 按原文替换。任务标识类占位（`{id}` / `{operation_name}` 等）在派发期才有值，
 * 由 `buildPollingRequestFromPlan` 处理。
 */
const applyPollingTaskTypePlaceholders = (strategy: unknown, taskType: string): void => {
  if (!isPlainObject(strategy)) return;
  const request = readOpenField(strategy, "request");
  if (!isPlainObject(request)) return;
  const values = { taskType };
  const template =
    normalizeString(readOpenField(request, "url_template")) ||
    normalizeString(readOpenField(request, "urlTemplate"));
  if (template) {
    writeOpenField(request, "url_template", replaceUrlTemplatePlaceholders(template, values));
  }
  for (const key of ["headers", "query", "body"]) {
    const value = readOpenField(request, key);
    if (value !== undefined && value !== null) {
      writeOpenField(request, key, replaceJsonPlaceholders(value, values));
    }
  }
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

/**
 * 运行期请求体形态归一：历史 `stream` 等未知声明按 JSON 处理（与改造前一致）。
 *
 * 动态 `payload_format_rule` 的求值结果由调用方经 `resolvedPayloadFormat` 传入；组装期
 * 拿不到时回落投影的静态声明，再回落 `json`。
 */
const normalizePayloadFormat = (value: unknown): CustomInterfaceFormatPayloadFormat => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "multipart" || normalized === "form" || normalized === "text") {
    return normalized;
  }
  return "json";
};

/**
 * 提交请求的 Content-Type。
 *
 * 优先级（与改造前同序，只把「没有声明」时的兜底从固定 JSON 改为按请求体形态取默认）：
 * 1. 用户显式 `api.contentType`（含显式 `null` = 该分支没有固定 Content-Type，multipart 用）；
 * 2. 投影 `api_defaults.contentType`；
 * 3. `defaultCustomInterfaceFormatContentType(payload_format)`（multipart → 不写）。
 */
const resolveSubmitContentType = (
  payloadApi: PayloadApiRaw,
  runtimeDefaults: PayloadApiRaw,
  payloadFormat: CustomInterfaceFormatPayloadFormat,
): unknown => {
  if (Object.prototype.hasOwnProperty.call(payloadApi, "contentType")) {
    return payloadApi.contentType;
  }
  if (Object.prototype.hasOwnProperty.call(runtimeDefaults, "contentType")) {
    return runtimeDefaults.contentType;
  }
  return defaultCustomInterfaceFormatContentType(payloadFormat);
};

/**
 * 纯文本正文（`payload_format = 'text'`）的形状守卫：整个请求体**就是**提示词原文。
 *
 * 两类错误都必须在这里显式失败，不能静默降级：
 * - 投影里出现 `body.<path>` 请求体参数规则：文本格式没有可命名的字段，规则求值会让
 *   正文变成对象（或按规则顺序被最后一条覆盖），发出去的内容与用户声明不符；
 * - 求值后的正文不是字符串（空提示词 / 参数规则覆盖了正文）：发送期再猜类型只会把
 *   错误推到上游。
 */
const assertTextPayloadBodyShape = (
  runtime: ProjectionRuntimeRaw | null | undefined,
  modelId: string,
  requestBody: unknown,
): void => {
  const payloadRules = runtime !== null && runtime !== undefined && isPlainObject(runtime.payload_rules)
    ? runtime.payload_rules
    : null;
  const bodyFieldTargets = payloadRules === null
    ? []
    : Object.keys(payloadRules).filter((target) => target.startsWith("body."));
  if (bodyFieldTargets.length > 0) {
    throw invalidArguments(
      `model ${modelId}: payload_format "text" forbids request body fields, but payload_rules declares ${bodyFieldTargets.join(", ")}. The whole request body must be the prompt text.`,
    );
  }
  if (typeof requestBody !== "string") {
    throw invalidArguments(
      `model ${modelId}: payload_format "text" requires the prompt as the plain request body, got ${requestBody === undefined || requestBody === null ? "no body" : typeof requestBody}.`,
    );
  }
};

/**
 * 提交地址 = 相对 endpoint + `api.query` 合并。
 *
 * - 查询参数名与路径里的静态查询串（`?task_ids=...`）重名时直接报错：同一个参数出现两次，
 *   后写会覆盖先写或拼出重复键，用户看不到任何提示；
 * - 值按重复键展开（数组 → `a=1&a=2`），`undefined` / `null` 跳过，空字符串保留。
 */
const buildSubmitUrl = (
  endpointUrl: string,
  queryDeclaration: unknown,
  modelId: string,
): string => {
  const entries = normalizeQueryEntries(
    queryDeclaration,
    `model ${modelId} submit request`,
  );
  if (entries.length === 0) return endpointUrl;
  const staticNames = new Set(readStaticQueryParamNames(endpointUrl));
  for (const entry of entries) {
    if (staticNames.has(entry.name)) {
      throw invalidArguments(
        `model ${modelId} submit request: query parameter "${entry.name}" is already declared in the endpoint path`,
      );
    }
  }
  return appendQueryEntries(endpointUrl, entries);
};

const buildExecutionPlanFromPayload = (
  projection: PlainObject,
  modelId: string,
  payload: PlainObject,
  resolvedPayloadFormat?: string,
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
  const payloadFormat = normalizePayloadFormat(
    normalizeString(resolvedPayloadFormat) ||
      (runtime !== null && runtime !== undefined ? runtime.payload_format : undefined),
  );
  const formFieldStyle = normalizeString(runtime !== null && runtime !== undefined ? runtime.form_field_style : undefined) || undefined;
  const formArrayStyle = normalizeString(runtime !== null && runtime !== undefined ? runtime.form_array_style : undefined) || undefined;
  const contentType = resolveSubmitContentType(payloadApi, runtimeDefaults, payloadFormat);
  const headers = normalizeFixedHeaders(
    payloadApi.headers,
    `model ${modelId} submit request`,
  );
  if (typeof contentType === "string" && contentType.trim()) {
    headers["content-type"] = contentType.trim();
  }
  const requestBody = Object.prototype.hasOwnProperty.call(payload, "body")
    ? cloneValue(payloadRaw.body)
    : undefined;
  if (payloadFormat === "text") {
    assertTextPayloadBodyShape(runtime, modelId, requestBody);
  }
  // 相对 endpoint 透传；origin 由任务派发前 ExecutionSnapshot.base_url 决算（spec 03 §8）。
  const resolvedEndpoint = resolveAbsoluteEndpoint(endpoint);
  const submitUrl = buildSubmitUrl(resolvedEndpoint, payloadApi.query, modelId);
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
        url: submitUrl,
        method,
        headers,
        body: requestBody,
        // 请求体形态随请求下发：发送期据此序列化（multipart / 表单 / 纯文本）。
        // 表单正文保持对象原样——模型 ID 注入发生在发送前，先编码会让注入落到字符串上。
        payload_format: payloadFormat,
        form_field_style: formFieldStyle,
        form_array_style: formArrayStyle,
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
  resolvedFormatOut?: { payloadFormat?: string },
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
    argumentsWithoutReservedPrompt(readOpenField(inputRecord, "arguments")),
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
  // 动态形态的求值结果同时回传给组装入口：`submit_request.payload_format` 需要它来
  // 决定发送期序列化（multipart / 表单 / 纯文本），组装层不能只拿到静态声明。
  if (resolvedFormatOut !== undefined && dynamicPayloadFormat) {
    resolvedFormatOut.payloadFormat = dynamicPayloadFormat;
  }
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

/**
 * 提示词只从草稿顶层 prompt（或旧媒体加工链的 arguments.prompt）进入合并层。
 * 历史草稿可能把保留键 `__prompt` 当普通参数存下来；这里剥掉它，避免文字区清空后
 * 旧参数值被当成提示词发出去。
 */
const argumentsWithoutReservedPrompt = (argumentsValue: unknown): unknown => {
  if (!isPlainObject(argumentsValue)) return argumentsValue;
  const record = argumentsValue as UnknownRecord;
  if (!(MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY in record)) return argumentsValue;
  const next: UnknownRecord = { ...record };
  delete next[MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY];
  loggingModule.logDebug("[request-assembler] ignored reserved __prompt in arguments", {
    key: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
  });
  return next;
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

  const resolvedFormat: { payloadFormat?: string } = {};
  const payload = await buildRuntimePayloadFromRules(inputRecord, projection, projectPath, preRequestOutputs, resolvedFormat);
  applyPayloadOverrides(payload, payload_overrides);
  return buildExecutionPlanFromPayload(projection, modelId, payload, resolvedFormat.payloadFormat);
};

export {
  assembleExecutionPlanFromPrebuiltPayload,
  assembleGenerationTaskRequest,
  buildExecutionPlanFromPayload,
  // 任务重新查询（failed → polling）需要按「当前接口格式与配方」重建轮询策略：
  // 与提交组装共用同一份实现，禁止在 requery 侧另写一份 polling_strategy 组装。
  buildPollingStrategyFromProjection,
  buildRuntimePayloadFromRules,
  resolveAbsoluteEndpoint,
  resolveProjectionByModelId,
};
