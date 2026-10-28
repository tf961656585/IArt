import type { ModelAssetLocalizationBundle, ModelAssetNodeProjectionRuntimeValueRule } from "@iart/contracts/model-asset-contract";
import type { CatalogRawObject } from "./model-package-catalog.raw-object.cts";
export type { CatalogRawObject };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export interface CatalogImageConstraints {
  allowedMimeTypes: string[] | undefined | undefined;
  minWidth: number | undefined | undefined;
  minHeight: number | undefined | undefined;
  maxWidth: number | undefined | undefined;
  maxHeight: number | undefined | undefined;
  disallowPngTransparency: boolean | undefined | undefined;
}
export interface CatalogComponentChoiceOption {
  id: string | undefined | undefined;
  value: JsonValue | undefined;
  ratio: number | undefined | undefined;
  label: string | undefined | undefined;
  description: string | undefined | undefined;
  resolution: { width: number; height: number } | undefined | undefined;
}
export interface CatalogImageSizeLevelOption {
  id: string;
  label: string | undefined | undefined;
  /** 级别语义：总像素预算（如 1K = 1024² = 1048576），不再是长边像素 */
  pixelBudget: number;
}
export interface CatalogImageSizeAspectPreset {
  id: string;
  label: string | undefined | undefined;
  ratio: number;
}
export interface CatalogImageSizeConstrainedResolutionConstraints {
  dimensionMultiple: number;
  maxLongEdge: number;
  minPixels: number;
  maxPixels: number;
  maxAspectRatio: number;
}
export interface CatalogComponentProps {
  mode: string | undefined | undefined;
  minRows: number | undefined | undefined;
  maxRows: number | undefined | undefined;
  accept: string | undefined | undefined;
  maxFiles: number | undefined | undefined;
  showCounter: boolean | undefined | undefined;
  maxSizeMB: number | undefined | undefined;
  imageConstraints: CatalogImageConstraints | undefined | undefined;
  allowMultiple: boolean | undefined | undefined;
  imageResizeMode: string | undefined | undefined;
  clearable: boolean | undefined | undefined;
  exclusive: boolean | undefined | undefined;
  sizeOptions: CatalogComponentChoiceOption[] | undefined | undefined;
  aspectField: string | undefined | undefined;
  aspectOptions: CatalogComponentChoiceOption[] | undefined | undefined;
  allowAuto: boolean | undefined | undefined;
  sizeLevels: CatalogImageSizeLevelOption[] | undefined | undefined;
  aspectPresets: CatalogImageSizeAspectPreset[] | undefined | undefined;
  presetOptions: CatalogComponentChoiceOption[] | undefined | undefined;
  customPresets: CatalogComponentChoiceOption[] | undefined | undefined;
  constraints: CatalogImageSizeConstrainedResolutionConstraints | undefined | undefined;
}
export interface CatalogApiDefaults {
  endpoint: string | undefined | undefined;
  method: string | undefined | undefined;
  contentType: JsonValue | undefined | undefined;
  headers: JsonValue | undefined | undefined;
}
/**
 * 默认值表：键空间 = parameter_schema.fields[].field_key，不设白名单——
 * 模型能力包可为任意字段键声明默认值，投影层透传不裁剪（`__prompt` 保留键除外）。
 */
export type CatalogDefaultValues = Record<string, JsonValue | undefined>;
/**
 * 请求策略只承载「打到哪个地址、用什么方法」。
 *
 * 请求头 / 查询参数 / 请求体的实际取值为**单一规则树**（`runtime.payload_rules` 的
 * `api.headers.*` / `api.query.*` / `body.*`），不在这里再维护一份规则数组：
 * 历史 `header_rules` / `body_rules` / `query_rules` 从未被执行，已随 2026-10-27
 * 请求落点批次删除（口径见 `docs/model-assets/21-模型资产规则DSL规范.md`）。
 */
export interface CatalogTaskRequestStrategy {
  request_stage: string;
  protocol: string;
  endpoint: string;
  method: string;
}

/** 轮询请求的一条查询参数；值里的 `{id}` 等占位在派发时替换。 */
export interface CatalogTaskPollingHttpQueryEntry {
  name: string;
  value: string;
}

export interface CatalogTaskPollingHttpRequest {
  url_template: string;
  method: string;
  /** 轮询请求头（固定值，可含任务标识占位）。 */
  headers: Record<string, string>;
  /** 轮询查询参数（固定值，可含任务标识占位）；路径静态查询串由运行时合并。 */
  query: CatalogTaskPollingHttpQueryEntry[];
  body: JsonValue | undefined;
  /** POST 轮询的请求体形态；`form` 按表单编码发送。 */
  body_format: 'json' | 'form';
  content_type: string | null;
}
export interface CatalogTaskPollingPolicy {
  intervalMs: number;
  maxAttempts: number;
  successPath: string | undefined | undefined;
  successFieldPaths: string[];
  successStatuses: string[];
  statusFieldPaths: string[];
  failureStatuses: string[];
  failureCodePaths: string[];
  failureMessagePaths: string[];
}
export interface CatalogTaskPollingStrategy {
  request: CatalogTaskPollingHttpRequest;
  polling: CatalogTaskPollingPolicy;
}
export interface CatalogTaskResultRule {
  mode: string;
  submit_response_id_path: string;
  submit_accept_condition: CatalogTaskResultCondition | null | undefined | undefined;
  success_condition: CatalogTaskResultCondition | null | undefined | undefined;
  failure_condition: CatalogTaskResultCondition | null | undefined | undefined;
  /** 失败判定命中时展示给用户的失败原因（接口配方声明，可选）。 */
  failure_reason: string | undefined;
  error_mapping_rules: CatalogTaskOutputMappingRule[];
  note: string | undefined | undefined;
}
export interface CatalogTaskOutputMappingSource {
  kind: string;
  path: string;
}
export interface CatalogTaskOutputMappingRule {
  target: string;
  source: CatalogTaskOutputMappingSource;
  required: boolean;
  default_value: JsonValue | undefined | undefined;
}
export type CatalogTaskResultIdentityPath = string | string[] | null;
export type CatalogTaskResultConditionValue = JsonPrimitive | JsonPrimitive[];
export interface CatalogTaskResultCondition {
  op: string;
  path: string | undefined | undefined;
  field: string | undefined | undefined;
  value: CatalogTaskResultConditionValue | undefined | undefined;
  children: CatalogTaskResultCondition[] | undefined | undefined;
  condition: CatalogTaskResultCondition | undefined | undefined;
}
export interface CatalogTaskResultAcquisitionStrategy {
  acquisition_mode: string;
  identity_source: string;
  identity_path: CatalogTaskResultIdentityPath | undefined | undefined;
  request_strategy: CatalogTaskRequestStrategy | null | undefined | undefined;
  /** 最终结果形态：`binary`（字节流）或 `json`（结构化载荷）。 */
  accept: string | undefined;
  /** `accept = binary` 时的媒体类型（落盘扩展名与资产类型判定）。 */
  media_type: string | undefined;
  success_condition: CatalogTaskResultCondition | null | undefined | undefined;
  failure_condition: CatalogTaskResultCondition | null | undefined | undefined;
  /**
   * 结果获取请求的固定请求头（从接口格式 `api.headers.*` 字面量规则派生，随策略冻结）。
   * 鉴权头不在这里——它由 `requires_auth` + 执行快照协议在请求时注入。
   */
  request_headers: Record<string, string>;
  /** 最终结果请求是否携带与提交同源的鉴权头（缺省 false）。 */
  requires_auth: boolean;
  note: string | undefined | undefined;
}
export interface CatalogTaskResultOutputMapping {
  response_mode: string;
  /**
   * 产物地址是否需要与提交同源的鉴权头（缺省 false）。
   * 下载链路据此注入适配器声明的鉴权形态；为真但取不到凭证时必须收口失败。
   */
  requires_auth: boolean;
  download_required_condition: CatalogTaskResultCondition | null | undefined | undefined;
  output_mapping_rules: CatalogTaskOutputMappingRule[];
  note: string | undefined | undefined;
}
export interface CatalogParameterLayout {
  colSpan: number | undefined | undefined;
  dockPresentation: string | undefined | undefined;
}
export type RuntimeValueRule = ModelAssetNodeProjectionRuntimeValueRule;
export interface RuntimeValueRuleMap {
  [key: string]: RuntimeValueRule | undefined;
}
export type PreRequestBodyPayload = Record<string, unknown>;
export type PreRequestOutputPayload = Record<string, unknown>;
export interface CatalogPreRequestDefinition {
  id: string;
  endpoint: string;
  method: string;
  body: PreRequestBodyPayload;
  output_mapping: Record<string, string>;
  polling: CatalogTaskPollingStrategy | null | undefined;
  submit_response_id_path: string | null | undefined;
}
export type PreRequestOutputMap = Record<string, PreRequestOutputPayload>;
export interface CatalogCapability {
  input_modalities: string[];
  output_modalities: string[];
  supports_async_task: boolean;
  supports_streaming: boolean;
  supports_multi_image: boolean;
  supports_reference_media: boolean;
  constraints: JsonValue[];
}
export interface CatalogPort {
  id: string;
  name: string;
  data_type: string;
  field_key: string;
  required: boolean;
  multiple: boolean;
  max_connections: number | undefined | undefined;
  description: string | undefined | undefined;
  visible_when: CatalogVisibleWhen | undefined;
}
export interface CatalogPorts {
  inputs: CatalogPort[];
  outputs: CatalogPort[];
}
export interface CatalogValidationRule {
  type: string;
  value: JsonValue | undefined | undefined;
  message: string | undefined | undefined;
}
export interface CatalogPromptField {
  field_key: string;
  required: boolean;
  validation_rules: CatalogValidationRule[];
}
export interface CatalogEnumOption {
  value: JsonValue | undefined;
  label: string | undefined | undefined;
}
export interface CatalogVisibleWhen {
  field: string;
  op: "eq" | "neq" | "in" | "not_in";
  value: string | number | boolean | Array<string | number | boolean>;
}
export interface CatalogParameterField {
  field_key: string;
  label: string;
  description: string | undefined | undefined;
  component: string;
  component_props: CatalogComponentProps | undefined | undefined;
  data_source: 'connection' | 'form' | 'both' | undefined;
  required: boolean;
  default_value: JsonValue | undefined | undefined;
  enum_options: CatalogEnumOption[] | undefined | undefined;
  validation_rules: CatalogValidationRule[] | undefined | undefined;
  layout: CatalogParameterLayout | undefined | undefined;
  visible_when: CatalogVisibleWhen | undefined;
  metadata: CatalogRawObject | undefined | undefined;
}
export interface CatalogParameterSchema {
  schema_type: "object";
  fields: CatalogParameterField[];
  required_fields: string[];
  default_values: CatalogDefaultValues;
  validation_rules: CatalogValidationRule[];
}
export interface CatalogExecutionProfile {
  task_type: string;
  supports_async_task: boolean;
}
export interface CatalogVisibility {
  visible: boolean;
  order: number;
  badges: string[] | undefined | undefined;
}
export interface CatalogRuntimeWorkspace {
  task_list_position: string | undefined | undefined;
  task_queue: | { enabled: boolean; max_concurrent: number | undefined }
    | undefined | undefined;
}
export interface CatalogRuntimeCapabilities {
  task_group: string | undefined | undefined;
  media_input_mode: string | undefined | undefined;
  ui_guards: string[] | undefined | undefined;
  execution_traits: string[] | undefined | undefined;
}
export interface CatalogRuntimeMeta {
  provider_id: string;
  default_task_type: string;
  mode: string;
  execution_driver: string;
  aliases: string[];
  route_segment: string | undefined | undefined;
  workspace: CatalogRuntimeWorkspace | undefined | undefined;
  payload_format: string | undefined | undefined;
  /**
   * 运行时条件求值的 payload_format（与 payload_format 互斥）。
   * 用于单节点承载多种远端接口语义的场景（如文生图 JSON + 图生图 multipart 合并节点）。
   */
  payload_format_rule: ModelAssetNodeProjectionRuntimeValueRule | undefined | undefined;
  /** `payload_format = 'form'` 时的嵌套字段编码形态（`dotted` / `bracket`）。 */
  form_field_style: string | undefined | undefined;
  /** `payload_format = 'form'` 时的数组编码形态（`repeat` / `bracket` / `index`）。 */
  form_array_style: string | undefined | undefined;
  url_input_upload_mode: string | undefined | undefined; url_input_upload_target_type: string | undefined | undefined;
  api_defaults: CatalogApiDefaults | undefined | undefined;
  payload_rules: RuntimeValueRuleMap | undefined | undefined;
  pre_requests: CatalogPreRequestDefinition[] | undefined | undefined;
  capabilities: CatalogRuntimeCapabilities | undefined | undefined;
}
export interface CatalogFormalTaskExecutionPlan {
  request_strategy: CatalogTaskRequestStrategy;
  polling_strategy: CatalogTaskPollingStrategy | null;
  result_rule: CatalogTaskResultRule;
  result_acquisition_strategy: CatalogTaskResultAcquisitionStrategy | null;
  result_output_mapping: CatalogTaskResultOutputMapping | null;
  pre_requests: CatalogPreRequestDefinition[] | null;
}
export interface CatalogModeParameterOverride {
  visibility: "visible" | "hidden" | undefined;
  required: boolean | undefined;
  default_value: JsonValue | undefined;
}
export interface CatalogMode {
  key: string;
  label: string;
  parameter_overrides: Record<string, CatalogModeParameterOverride>;
}
export type VariantPayloadOverridesMap = Record<string, unknown>;
export interface CatalogVariantMeta {
  group_key: string;
  label: string;
  order: number;
  payload_overrides: VariantPayloadOverridesMap;
}
export interface CatalogVariantGroupVariant {
  model_id: string;
  shell_model_id: string | undefined | undefined;
  label: string;
  order: number;
  payload_overrides: VariantPayloadOverridesMap | undefined;
}
export interface CatalogVariantGroup {
  group_key: string;
  shell_model_id: string;
  default_model_id: string;
  variants: CatalogVariantGroupVariant[];
}
export interface CatalogProjection {
  package_id: string;
  model_id: string;
  /**
   * 接口格式声明（manifest.protocol_format，可选）：包所属接口格式的分组键，
   * 为「接口格式包 + 型号清单」演进预留；未声明时为 undefined。
   */
  protocol_format: string | undefined;
  display_label: string;
  shell_model_id: string | undefined;
  node_type: string;
  role: string;
  description: string | undefined | undefined;
  group_key: string;
  icon_ref: string | undefined | undefined;
  capability: CatalogCapability;
  ports: CatalogPorts;
  parameter_schema: CatalogParameterSchema;
  /**
   * 提示词映射字段声明（方案 B）：payload_rules 引用了保留键 `__prompt` 时存在。
   * field_key 固定为 `__prompt`（不进参数表单）；required 与 validation_rules 表达提示词
   * 自身约束（供 Editor 提示词长度守卫消费）。缺省/undefined = 模型不消费提示词。
   */
  prompt_field: CatalogPromptField | undefined;
  execution_profile: CatalogExecutionProfile;
  visibility: CatalogVisibility;
  runtime: CatalogRuntimeMeta;
  task_execution_plan: CatalogFormalTaskExecutionPlan | null;
  modes: CatalogMode[] | undefined;
  variant_meta: CatalogVariantMeta | undefined;
  variant_group: CatalogVariantGroup | undefined;
}
export interface ModelPackageCatalog {
  loaded_at: string;
  package_root: string;
  projections: CatalogProjection[];
  bindable_models: Array<{
    model_id: string;
    package_id: string;
    display_label: string;
  }>;
  localization_bundles: ModelAssetLocalizationBundle[];
  diagnostics: Array<{
    package_id: string;
    code: string;
    message: string;
    model_id: string | undefined;
  }>;
  variantModelToMain: Map<string, { projection: CatalogProjection; payload_overrides: VariantPayloadOverridesMap | undefined }>;
}
