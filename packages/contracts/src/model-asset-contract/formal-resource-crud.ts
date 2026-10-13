export const MODEL_ASSET_ERROR_CODE = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  DELETE_BLOCKED: 'DELETE_BLOCKED',
  CODE_CONFLICT: 'CODE_CONFLICT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
});

export type ModelAssetErrorCode =
  (typeof MODEL_ASSET_ERROR_CODE)[keyof typeof MODEL_ASSET_ERROR_CODE];

export type ModelAssetSortOrder = 'asc' | 'desc';

export interface ModelAssetResponseMeta {
  request_id: string | undefined;
  server_time: string | undefined;
}

export interface ModelAssetPaginationMeta extends ModelAssetResponseMeta {
  page: number;
  page_size: number;
  total: number;
}

export interface ModelAssetResponse<TData, TMeta extends ModelAssetResponseMeta = ModelAssetResponseMeta> {
  data: TData;
  meta: TMeta;
}

export interface ModelAssetListPayload<TItem> {
  items: TItem[];
}

export type ModelAssetListResponse<TItem> = ModelAssetResponse<
  ModelAssetListPayload<TItem>,
  ModelAssetPaginationMeta
>;

export type ModelAssetDetailResponse<TData> = ModelAssetResponse<TData>;

export interface ModelAssetFieldError {
  field: string;
  code: string;
  message: string;
}

export interface ModelAssetError {
  code: ModelAssetErrorCode;
  message: string;
  details: ModelAssetErrorDetails | undefined;
  field_errors: ModelAssetFieldError[] | undefined;
}

export interface ModelAssetErrorResponse {
  errors: ModelAssetError[];
  meta: ModelAssetResponseMeta;
}

export interface ModelAssetAuditFields {
  created_at: string;
  updated_at: string;
}

export type ModelAssetFormalDynamicMap = Record<string, unknown>;
export type ModelAssetFormalDynamicList = ModelAssetFormalDynamicMap[];

export interface ModelAssetReferenceSummary {
  id: string;
  code: string;
}

export interface ModelAssetParameterField {
  key: string;
  label: string;
  value_type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  required: boolean;
  default_value: unknown | undefined;
  enum_options: unknown[] | undefined;
  constraints: ModelAssetFormalDynamicMap | undefined;
}

export type ModelAssetRuleSourceKind =
  | 'literal'
  | 'input'
  | 'runtime'
  | 'auth_value'
  | 'system_setting'
  | 'response';

export interface ModelAssetRuleSource {
  kind: ModelAssetRuleSourceKind;
  path: string | undefined;
}

export interface ModelAssetMappingRule {
  target: string;
  source: ModelAssetRuleSource;
  literal_value: unknown | undefined;
  format: string | undefined;
  required: boolean | undefined;
  default_value: unknown | undefined;
}

export interface ModelAssetConditionNode {
  path: string | undefined;
  op:
    | 'all'
    | 'any'
    | 'not'
    | 'exists'
    | 'missing'
    | 'empty'
    | 'not_empty'
    | 'eq'
    | 'neq'
    | 'in'
    | 'not_in'
    | 'contains';
  value: unknown | undefined;
  children: ModelAssetConditionNode[] | undefined;
}

export const MODEL_ASSET_FORMAL_RESOURCE_TYPE = Object.freeze({
  PROVIDER: 'provider',
  MODEL_FAMILY: 'model_family',
  MODEL: 'model',
  CAPABILITY: 'capability',
  PARAMETER_SCHEMA: 'parameter_schema',
  REQUEST_STRATEGY: 'request_strategy',
  POLLING_STRATEGY: 'polling_strategy',
  RESULT_RULE: 'result_rule',
  RESULT_ACQUISITION_STRATEGY: 'result_acquisition_strategy',
  RESULT_OUTPUT_MAPPING: 'result_output_mapping',
  AUTH_STRATEGY: 'auth_strategy',
  DISPLAY_METADATA: 'display_metadata',
  ICON_ASSET: 'icon_asset',
});

export type ModelAssetFormalStrategyType =
  | 'capability'
  | 'parameter_schema'
  | 'request_strategy'
  | 'polling_strategy'
  | 'result_rule'
  | 'result_acquisition_strategy'
  | 'result_output_mapping'
  | 'auth_strategy'
  | 'display_metadata';

export type ModelAssetFormalResourceType =
  | 'provider'
  | 'model_family'
  | 'model'
  | ModelAssetFormalStrategyType
  | 'icon_asset';

export interface ModelAssetResourceListQuery {
  page: number | undefined;
  page_size: number | undefined;
  keyword: string | undefined;
  sort_by: string | undefined;
  sort_order: ModelAssetSortOrder | undefined;
  provider_id: string | undefined;
  family_id: string | undefined;
}

export interface ModelAssetWriteIssue {
  code: string;
  message: string;
  resource_type: ModelAssetFormalResourceType;
  resource_id: string | undefined;
  field_path: string | undefined;
}

export interface ModelAssetDeleteBlockedReference {
  resource_type: ModelAssetFormalResourceType;
  resource_id: string;
  message: string;
}

export interface ModelAssetErrorDetails {
  references: ModelAssetDeleteBlockedReference[] | undefined;
  issues: ModelAssetWriteIssue[] | undefined;
  cause: string | undefined;
}

export interface ModelAssetFormalProvider extends ModelAssetAuditFields {
  id: string;
  code: string;
  website_url: string | null;
  docs_url: string | null;
  icon_ref: ModelAssetReferenceSummary | null;
}

export interface ModelAssetFormalModelFamily extends ModelAssetAuditFields {
  id: string;
  provider_id: string;
  code: string;
  description: string | null;
  icon_ref: ModelAssetReferenceSummary | null;
}

export interface ModelAssetFormalModel extends ModelAssetAuditFields {
  id: string;
  family_id: string;
  code: string;
  vendor_model_name: string;
  kind: 'generator' | 'processor' | string;
  capability_ref: ModelAssetReferenceSummary | null;
  parameter_schema_ref: ModelAssetReferenceSummary | null;
  request_strategy_ref: ModelAssetReferenceSummary | null;
  polling_strategy_ref: ModelAssetReferenceSummary | null;
  result_rule_ref: ModelAssetReferenceSummary | null;
  result_output_mapping_ref: ModelAssetReferenceSummary | null;
  auth_strategy_ref: ModelAssetReferenceSummary | null;
  display_ref: ModelAssetReferenceSummary | null;
  icon_ref: ModelAssetReferenceSummary | null;
}

export interface ModelAssetFormalCapability extends ModelAssetAuditFields {
  id: string;
  code: string;
  input_modalities: string[];
  output_modalities: string[];
  supports_async_task: boolean;
  supports_streaming: boolean;
  supports_multi_image: boolean;
  supports_reference_media: boolean;
  constraints: ModelAssetFormalDynamicList;
}

export interface ModelAssetFormalParameterSchema extends ModelAssetAuditFields {
  id: string;
  code: string;
  schema_type: 'object';
  fields: ModelAssetParameterField[];
  required_fields: string[];
  default_values: ModelAssetFormalDynamicMap;
  validation_rules: ModelAssetFormalDynamicList;
}

export interface ModelAssetFormalRequestStrategy extends ModelAssetAuditFields {
  id: string;
  code: string;
  request_stage: 'submit' | 'result_fetch' | string;
  protocol: 'http' | string;
  endpoint: string;
  method: 'POST' | 'GET' | string;
  header_rules: ModelAssetMappingRule[];
  body_rules: ModelAssetMappingRule[];
  query_rules: ModelAssetMappingRule[];
}

export interface ModelAssetFormalPollingStrategy extends ModelAssetAuditFields {
  id: string;
  code: string;
  protocol: 'http' | string;
  endpoint: string;
  method: 'POST' | 'GET' | string;
  header_rules: ModelAssetMappingRule[];
  body_rules: ModelAssetMappingRule[];
  query_rules: ModelAssetMappingRule[];
  poll_interval_ms: number;
}

export interface ModelAssetFormalResultRule extends ModelAssetAuditFields {
  id: string;
  code: string;
  mode: 'sync' | 'async';
  submit_accept_condition: ModelAssetConditionNode | null;
  success_condition: ModelAssetConditionNode | null;
  failure_condition: ModelAssetConditionNode | null;
  result_acquisition_strategy_ref: ModelAssetReferenceSummary | null;
  error_mapping_rules: ModelAssetMappingRule[];
}

export interface ModelAssetFormalResultAcquisitionStrategy extends ModelAssetAuditFields {
  id: string;
  code: string;
  acquisition_mode: 'fetch_final_result';
  identity_source: 'remote_request_id' | 'query_response_path' | 'submit_response_path' | string;
  identity_path: string | null;
  request_strategy_ref: ModelAssetReferenceSummary | null;
  success_condition: ModelAssetConditionNode | null;
  failure_condition: ModelAssetConditionNode | null;
  note: string | null;
}

export interface ModelAssetFormalResultOutputMapping extends ModelAssetAuditFields {
  id: string;
  code: string;
  response_mode: 'structured_payload' | 'binary_media';
  download_required_condition: ModelAssetConditionNode | null;
  output_mapping_rules: ModelAssetMappingRule[];
  note: string | null;
}

export interface ModelAssetFormalAuthStrategy extends ModelAssetAuditFields {
  id: string;
  code: string;
  auth_type: 'bearer' | string;
  inject_to: 'header' | string;
  key_name: string;
  value_source: string;
}

export interface ModelAssetFormalDisplayMetadata extends ModelAssetAuditFields {
  id: string;
  code: string;
  description: string | null;
  group_key: string | null;
  tags: string[];
  order: number | null;
  visible: boolean;
  badge: string | null;
}

export interface ModelAssetFormalIconAsset extends ModelAssetAuditFields {
  id: string;
  code: string;
  media_type: string;
}

export type ModelAssetFormalResource =
  | ModelAssetFormalProvider
  | ModelAssetFormalModelFamily
  | ModelAssetFormalModel
  | ModelAssetFormalCapability
  | ModelAssetFormalParameterSchema
  | ModelAssetFormalRequestStrategy
  | ModelAssetFormalPollingStrategy
  | ModelAssetFormalResultRule
  | ModelAssetFormalResultAcquisitionStrategy
  | ModelAssetFormalResultOutputMapping
  | ModelAssetFormalAuthStrategy
  | ModelAssetFormalDisplayMetadata
  | ModelAssetFormalIconAsset;

export interface ModelAssetFormalResourceMap {
  provider: ModelAssetFormalProvider;
  model_family: ModelAssetFormalModelFamily;
  model: ModelAssetFormalModel;
  capability: ModelAssetFormalCapability;
  parameter_schema: ModelAssetFormalParameterSchema;
  request_strategy: ModelAssetFormalRequestStrategy;
  polling_strategy: ModelAssetFormalPollingStrategy;
  result_rule: ModelAssetFormalResultRule;
  result_acquisition_strategy: ModelAssetFormalResultAcquisitionStrategy;
  result_output_mapping: ModelAssetFormalResultOutputMapping;
  auth_strategy: ModelAssetFormalAuthStrategy;
  display_metadata: ModelAssetFormalDisplayMetadata;
  icon_asset: ModelAssetFormalIconAsset;
}

export interface ModelAssetCreateProviderInput {
  code: string;
  website_url: string | null | undefined;
  docs_url: string | null | undefined;
  icon_ref_id: string | null | undefined;
}

export type ModelAssetUpdateProviderInput = Partial<ModelAssetCreateProviderInput>;

export interface ModelAssetCreateModelFamilyInput {
  provider_id: string;
  code: string;
  description: string | null | undefined;
  icon_ref_id: string | null | undefined;
}

export type ModelAssetUpdateModelFamilyInput = Partial<ModelAssetCreateModelFamilyInput>;

export interface ModelAssetCreateModelInput {
  family_id: string;
  code: string;
  vendor_model_name: string;
  kind: 'generator' | 'processor' | string;
  capability_ref_id: string;
  parameter_schema_ref_id: string;
  request_strategy_ref_id: string;
  polling_strategy_ref_id: string | null | undefined;
  result_rule_ref_id: string;
  result_output_mapping_ref_id: string | null | undefined;
  auth_strategy_ref_id: string;
  display_ref_id: string | null | undefined;
  icon_ref_id: string | null | undefined;
}

export type ModelAssetUpdateModelInput = Partial<ModelAssetCreateModelInput>;

export interface ModelAssetCreateCapabilityInput {
  code: string;
  input_modalities: string[] | undefined;
  output_modalities: string[] | undefined;
  supports_async_task: boolean | undefined;
  supports_streaming: boolean | undefined;
  supports_multi_image: boolean | undefined;
  supports_reference_media: boolean | undefined;
  constraints: ModelAssetFormalDynamicList | undefined;
}

export type ModelAssetUpdateCapabilityInput = Partial<ModelAssetCreateCapabilityInput>;

export interface ModelAssetCreateParameterSchemaInput {
  code: string;
  schema_type: 'object';
  fields: ModelAssetParameterField[] | undefined;
  required_fields: string[] | undefined;
  default_values: ModelAssetFormalDynamicMap | undefined;
  validation_rules: ModelAssetFormalDynamicList | undefined;
}

export type ModelAssetUpdateParameterSchemaInput = Partial<ModelAssetCreateParameterSchemaInput>;

export interface ModelAssetCreateRequestStrategyInput {
  code: string;
  request_stage: 'submit' | 'result_fetch' | string;
  protocol: 'http' | string;
  endpoint: string;
  method: 'POST' | 'GET' | string;
  header_rules: ModelAssetMappingRule[] | undefined;
  body_rules: ModelAssetMappingRule[] | undefined;
  query_rules: ModelAssetMappingRule[] | undefined;
}

export type ModelAssetUpdateRequestStrategyInput = Partial<ModelAssetCreateRequestStrategyInput>;

export interface ModelAssetCreatePollingStrategyInput {
  code: string;
  protocol: 'http' | string;
  endpoint: string;
  method: 'POST' | 'GET' | string;
  header_rules: ModelAssetMappingRule[] | undefined;
  body_rules: ModelAssetMappingRule[] | undefined;
  query_rules: ModelAssetMappingRule[] | undefined;
  poll_interval_ms: number | undefined;
}

export type ModelAssetUpdatePollingStrategyInput = Partial<ModelAssetCreatePollingStrategyInput>;

export interface ModelAssetCreateResultRuleInput {
  code: string;
  mode: 'sync' | 'async';
  submit_accept_condition: ModelAssetConditionNode | null | undefined;
  success_condition: ModelAssetConditionNode | null | undefined;
  failure_condition: ModelAssetConditionNode | null | undefined;
  result_acquisition_strategy_ref_id: string | null | undefined;
  error_mapping_rules: ModelAssetMappingRule[] | undefined;
}

export type ModelAssetUpdateResultRuleInput = Partial<ModelAssetCreateResultRuleInput>;

export interface ModelAssetCreateResultAcquisitionStrategyInput {
  code: string;
  acquisition_mode: 'fetch_final_result';
  identity_source: 'remote_request_id' | 'query_response_path' | 'submit_response_path' | string;
  identity_path: string | null | undefined;
  request_strategy_ref_id: string | null | undefined;
  success_condition: ModelAssetConditionNode | null | undefined;
  failure_condition: ModelAssetConditionNode | null | undefined;
  note: string | null | undefined;
}

export interface ModelAssetCreateResultOutputMappingInput {
  code: string;
  response_mode: 'structured_payload' | 'binary_media';
  download_required_condition: ModelAssetConditionNode | null | undefined;
  output_mapping_rules: ModelAssetMappingRule[] | undefined;
  note: string | null | undefined;
}

export type ModelAssetUpdateResultAcquisitionStrategyInput =
  Partial<ModelAssetCreateResultAcquisitionStrategyInput>;

export type ModelAssetUpdateResultOutputMappingInput =
  Partial<ModelAssetCreateResultOutputMappingInput>;

export interface ModelAssetCreateAuthStrategyInput {
  code: string;
  auth_type: 'bearer' | string | undefined;
  inject_to: 'header' | string | undefined;
  key_name: string | undefined;
  value_source: string | undefined;
}

export type ModelAssetUpdateAuthStrategyInput = Partial<ModelAssetCreateAuthStrategyInput>;

export interface ModelAssetCreateDisplayMetadataInput {
  code: string;
  description: string | null | undefined;
  group_key: string | null | undefined;
  tags: string[] | undefined;
  order: number | null | undefined;
  visible: boolean | undefined;
  badge: string | null | undefined;
}

export type ModelAssetUpdateDisplayMetadataInput = Partial<ModelAssetCreateDisplayMetadataInput>;

export interface ModelAssetCreateIconAssetInput {
  code: string;
}

export type ModelAssetUpdateIconAssetInput = Partial<ModelAssetCreateIconAssetInput>;

export interface ModelAssetCreateResourceInputMap {
  provider: ModelAssetCreateProviderInput;
  model_family: ModelAssetCreateModelFamilyInput;
  model: ModelAssetCreateModelInput;
  capability: ModelAssetCreateCapabilityInput;
  parameter_schema: ModelAssetCreateParameterSchemaInput;
  request_strategy: ModelAssetCreateRequestStrategyInput;
  polling_strategy: ModelAssetCreatePollingStrategyInput;
  result_rule: ModelAssetCreateResultRuleInput;
  result_acquisition_strategy: ModelAssetCreateResultAcquisitionStrategyInput;
  result_output_mapping: ModelAssetCreateResultOutputMappingInput;
  auth_strategy: ModelAssetCreateAuthStrategyInput;
  display_metadata: ModelAssetCreateDisplayMetadataInput;
  icon_asset: ModelAssetCreateIconAssetInput;
}

export interface ModelAssetUpdateResourceInputMap {
  provider: ModelAssetUpdateProviderInput;
  model_family: ModelAssetUpdateModelFamilyInput;
  model: ModelAssetUpdateModelInput;
  capability: ModelAssetUpdateCapabilityInput;
  parameter_schema: ModelAssetUpdateParameterSchemaInput;
  request_strategy: ModelAssetUpdateRequestStrategyInput;
  polling_strategy: ModelAssetUpdatePollingStrategyInput;
  result_rule: ModelAssetUpdateResultRuleInput;
  result_acquisition_strategy: ModelAssetUpdateResultAcquisitionStrategyInput;
  result_output_mapping: ModelAssetUpdateResultOutputMappingInput;
  auth_strategy: ModelAssetUpdateAuthStrategyInput;
  display_metadata: ModelAssetUpdateDisplayMetadataInput;
  icon_asset: ModelAssetUpdateIconAssetInput;
}

export interface ModelAssetWriteResult<TResource> {
  resource: TResource;
  written_at: string;
}

export type ModelAssetWriteResponse<TResource> = ModelAssetResponse<ModelAssetWriteResult<TResource>>;
