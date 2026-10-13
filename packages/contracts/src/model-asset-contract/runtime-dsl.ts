import type { ModelAssetExecutionDriver } from './protocol-constants';
import {
  PUBLIC_RELAY_TARGET_TYPE,
  type PublicRelayTargetType,
} from '../public-relay-contract';

export type ModelAssetNodeProjectionRuntimeCondition =
  | {
      op: 'and' | 'or';
      conditions: ModelAssetNodeProjectionRuntimeCondition[];
    }
  | {
      op: 'not';
      condition: ModelAssetNodeProjectionRuntimeCondition;
    }
  | {
      op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'includes' | 'excludes';
      field: string;
      value: unknown;
    }
  | {
      op: 'truthy' | 'falsy';
      field: string;
    };

export type ModelAssetNodeProjectionRuntimeComputeOperator =
  | 'coalesce'
  | 'concat'
  | 'join'
  | 'array'
  | 'compact_array'
  | 'object'
  | 'compact_object'
  | 'normalize_enum'
  | 'assert_non_empty'
  | 'assert_array_length'
  | 'parse_line_pairs'
  | 'scale_number'
  | 'clamp_number'
  | 'map_array'
  | 'build_content_blocks'
  | 'prepare_audio_url'
  | 'resolve_auto_audio_flag';

export const MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS = [
  'trim',
  'toLowerCase',
  'toUpperCase',
  'toNumber',
  'ensureArray',
  'first',
  'extractUrls',
  'extractFirstUrl',
  'extractFirstBase64DataUrl',
  'extractFirstFile',
  'splitLines',
  'compactArray',
  'last',
  'shotListToTimeline',
  'timelineToScript',
  'firstUploadFile',
  'firstUploadFileOrUrl',
  'allUploadFiles',
] as const;

export type ModelAssetNodeProjectionRuntimeValueTransform =
  (typeof MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS)[number];

export const MODEL_ASSET_MEDIA_TARGET_SHAPE = Object.freeze({
  MULTIPART_FILE: 'multipart_file',
  PUBLIC_URL: 'public_url',
  INLINE_DATA: 'inline_data',
  FILE_DATA_URI: 'file_data_uri',
});

export type ModelAssetMediaTargetShape =
  (typeof MODEL_ASSET_MEDIA_TARGET_SHAPE)[keyof typeof MODEL_ASSET_MEDIA_TARGET_SHAPE];

/**
 * multipart 请求体中，数组字段的 part 命名规则。
 *
 * - `indexed`（默认）：数组展开为 `${name}[0]`、`${name}[1]`，与既有 multipart 行为一致。
 * - `repeated`：数组展开为同名重复 part（`${name}` 出现多次），用于要求同名重复字段的后端。
 *
 * 只在 `media_target=multipart_file` 的目标路径上生效；其它形态忽略。
 */
export const MODEL_ASSET_MULTIPART_ARRAY_NAMING = Object.freeze({
  INDEXED: 'indexed',
  REPEATED: 'repeated',
});

export type ModelAssetMultipartArrayNaming =
  (typeof MODEL_ASSET_MULTIPART_ARRAY_NAMING)[keyof typeof MODEL_ASSET_MULTIPART_ARRAY_NAMING];

export interface ModelAssetNodeProjectionRuntimeMediaTargetMeta {
  /**
   * 字段最终被远端消费的媒体形态；不表达 json/multipart 等请求体传输格式。
   */
  media_target: ModelAssetMediaTargetShape | undefined;
  /**
   * 当 media_target=multipart_file 时，数组 part 的命名规则（indexed / repeated）。
   * 缺省按 indexed 处理，保证既有 multipart 包行为不变。
   */
  multipart_array_naming: ModelAssetMultipartArrayNaming | undefined;
}

export interface ModelAssetNodeProjectionRuntimeLiteralValueRule {
  kind: 'literal';
  value: unknown;
}

export interface ModelAssetNodeProjectionRuntimeFieldValueRule
  extends ModelAssetNodeProjectionRuntimeMediaTargetMeta {
  kind: 'field';
  field_key: string;
  transforms: ModelAssetNodeProjectionRuntimeValueTransform[] | undefined;
  fallback: ModelAssetNodeProjectionRuntimeValueRule | undefined;
}

export interface ModelAssetNodeProjectionRuntimeItemValueRule {
  kind: 'item';
  path: string | undefined;
}

export interface ModelAssetNodeProjectionRuntimeNormalizeEnumOptions {
  allowed_values: Array<string | number | boolean>;
  fallback: string | number | boolean | undefined;
}

export interface ModelAssetNodeProjectionRuntimeAssertNonEmptyOptions {
  message: string | undefined;
}

export interface ModelAssetNodeProjectionRuntimeAssertArrayLengthOptions {
  min_items: number | undefined;
  max_items: number | undefined;
  message: string | undefined;
}

export interface ModelAssetNodeProjectionRuntimeParseLinePairsOptions {
  left_key: string;
  right_key: string;
  pair_delimiter: string | undefined;
  message: string | undefined;
}

export interface ModelAssetNodeProjectionRuntimeNumberRoundOptions {
  round: 'none' | 'round' | 'floor' | 'ceil' | undefined;
}

export interface ModelAssetNodeProjectionRuntimeScaleNumberOptions
  extends ModelAssetNodeProjectionRuntimeNumberRoundOptions {
  factor: number;
}

export interface ModelAssetNodeProjectionRuntimeClampNumberOptions
  extends ModelAssetNodeProjectionRuntimeNumberRoundOptions {
  min: number | undefined;
  max: number | undefined;
}

export interface ModelAssetNodeProjectionRuntimeMapArrayOptions {
  source: ModelAssetNodeProjectionRuntimeValueRule;
  item: ModelAssetNodeProjectionRuntimeValueRule;
  prepend: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  append: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  max_items: number | undefined;
  skip_if_empty: boolean | undefined;
}

export interface ModelAssetNodeProjectionRuntimePrepareAudioUrlOptions {
  source: ModelAssetNodeProjectionRuntimeValueRule;
  allowed_mime_types: string[] | undefined;
  allowed_extensions: string[] | undefined;
  max_size_bytes: number | undefined;
  min_duration_seconds: number | undefined;
  max_duration_seconds: number | undefined;
}

export interface ModelAssetNodeProjectionRuntimeResolveAutoAudioFlagOptions {
  audio_source: ModelAssetNodeProjectionRuntimeValueRule;
  auto_audio: ModelAssetNodeProjectionRuntimeValueRule | undefined;
}

export interface ModelAssetNodeProjectionRuntimeContentTextPartOption {
  part_kind: 'text';
  value: ModelAssetNodeProjectionRuntimeValueRule;
  skip_if_empty: boolean | undefined;
}

export interface ModelAssetNodeProjectionRuntimeContentInlineDataPartOption {
  part_kind: 'inline_data';
  value: ModelAssetNodeProjectionRuntimeValueRule;
  multiple: boolean | undefined;
  max_items: number | undefined;
  skip_if_empty: boolean | undefined;
}

export type ModelAssetNodeProjectionRuntimeContentPartOption =
  | ModelAssetNodeProjectionRuntimeContentTextPartOption
  | ModelAssetNodeProjectionRuntimeContentInlineDataPartOption;

/**
 * build_content_blocks 输出形状。
 *
 * 同一份 parts 声明要落到不同远端协议的请求体结构时，用此字段选择输出形状，
 * 而不是为每个协议各写一套 operator：
 *
 * - `gemini_contents`（缺省）：Gemini generateContent 形状，返回
 *   `[{ role, parts: [{ text } | { inline_data: { mime_type, data } }] }]`。
 * - `interactions_input`：Gemini Interactions 形状，返回扁平数组
 *   `[{ type: "text", text } | { type: "image", mime_type, data }]`，
 *   用于 `body.input`，不产生 role/parts 容器。
 *
 * 缺省值保证既有包行为完全不变。
 */
export const MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE = Object.freeze({
  GEMINI_CONTENTS: 'gemini_contents',
  INTERACTIONS_INPUT: 'interactions_input',
});

export type ModelAssetContentBlocksOutputShape =
  (typeof MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE)[keyof typeof MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE];

export interface ModelAssetNodeProjectionRuntimeBuildContentBlocksOptions {
  role: string | undefined;
  parts: ModelAssetNodeProjectionRuntimeContentPartOption[];
  /**
   * 输出形状；缺省 `gemini_contents`。见 MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE。
   */
  output_shape: ModelAssetContentBlocksOutputShape | undefined;
}

export interface ModelAssetNodeProjectionRuntimeComputeBaseValueRule
  extends ModelAssetNodeProjectionRuntimeMediaTargetMeta {
  kind: 'compute';
  cache_key: string | undefined;
}

export interface ModelAssetNodeProjectionRuntimeCoalesceComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'coalesce' | 'concat' | 'array' | 'compact_array';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
}

export interface ModelAssetNodeProjectionRuntimeJoinComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'join';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  delimiter: string | undefined;
}

export interface ModelAssetNodeProjectionRuntimeObjectComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'object' | 'compact_object';
  entries: Record<string, ModelAssetNodeProjectionRuntimeValueRule> | undefined;
}

export interface ModelAssetNodeProjectionRuntimeNormalizeEnumComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'normalize_enum';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  options: ModelAssetNodeProjectionRuntimeNormalizeEnumOptions;
}

export interface ModelAssetNodeProjectionRuntimeAssertNonEmptyComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'assert_non_empty';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  options: ModelAssetNodeProjectionRuntimeAssertNonEmptyOptions | undefined;
}

export interface ModelAssetNodeProjectionRuntimeAssertArrayLengthComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'assert_array_length';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  options: ModelAssetNodeProjectionRuntimeAssertArrayLengthOptions;
}

export interface ModelAssetNodeProjectionRuntimeParseLinePairsComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'parse_line_pairs';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  options: ModelAssetNodeProjectionRuntimeParseLinePairsOptions;
}

export interface ModelAssetNodeProjectionRuntimeScaleNumberComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'scale_number';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  options: ModelAssetNodeProjectionRuntimeScaleNumberOptions;
}

export interface ModelAssetNodeProjectionRuntimeClampNumberComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'clamp_number';
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  options: ModelAssetNodeProjectionRuntimeClampNumberOptions;
}

export interface ModelAssetNodeProjectionRuntimeMapArrayComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'map_array';
  options: ModelAssetNodeProjectionRuntimeMapArrayOptions;
}

export interface ModelAssetNodeProjectionRuntimeBuildContentBlocksComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'build_content_blocks';
  options: ModelAssetNodeProjectionRuntimeBuildContentBlocksOptions;
}

export interface ModelAssetNodeProjectionRuntimePrepareAudioUrlComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'prepare_audio_url';
  options: ModelAssetNodeProjectionRuntimePrepareAudioUrlOptions;
}

export interface ModelAssetNodeProjectionRuntimeResolveAutoAudioFlagComputeValueRule
  extends ModelAssetNodeProjectionRuntimeComputeBaseValueRule {
  operator: 'resolve_auto_audio_flag';
  options: ModelAssetNodeProjectionRuntimeResolveAutoAudioFlagOptions;
}

export type ModelAssetNodeProjectionRuntimeComputeValueRule =
  | ModelAssetNodeProjectionRuntimeCoalesceComputeValueRule
  | ModelAssetNodeProjectionRuntimeJoinComputeValueRule
  | ModelAssetNodeProjectionRuntimeObjectComputeValueRule
  | ModelAssetNodeProjectionRuntimeNormalizeEnumComputeValueRule
  | ModelAssetNodeProjectionRuntimeAssertNonEmptyComputeValueRule
  | ModelAssetNodeProjectionRuntimeAssertArrayLengthComputeValueRule
  | ModelAssetNodeProjectionRuntimeParseLinePairsComputeValueRule
  | ModelAssetNodeProjectionRuntimeScaleNumberComputeValueRule
  | ModelAssetNodeProjectionRuntimeClampNumberComputeValueRule
  | ModelAssetNodeProjectionRuntimeMapArrayComputeValueRule
  | ModelAssetNodeProjectionRuntimeBuildContentBlocksComputeValueRule
  | ModelAssetNodeProjectionRuntimePrepareAudioUrlComputeValueRule
  | ModelAssetNodeProjectionRuntimeResolveAutoAudioFlagComputeValueRule;

export interface ModelAssetNodeProjectionRuntimeWhenValueRule {
  kind: 'when';
  condition: ModelAssetNodeProjectionRuntimeCondition;
  truthy: ModelAssetNodeProjectionRuntimeValueRule;
  falsy: ModelAssetNodeProjectionRuntimeValueRule | undefined;
}

export interface ModelAssetNodeProjectionRuntimePreRequestOutputValueRule {
  kind: 'pre_request_output';
  pre_request_id: string;
  output_key: string;
}

export type ModelAssetNodeProjectionRuntimeValueRule =
  | ModelAssetNodeProjectionRuntimeLiteralValueRule
  | ModelAssetNodeProjectionRuntimeFieldValueRule
  | ModelAssetNodeProjectionRuntimeItemValueRule
  | ModelAssetNodeProjectionRuntimeComputeValueRule
  | ModelAssetNodeProjectionRuntimeWhenValueRule
  | ModelAssetNodeProjectionRuntimePreRequestOutputValueRule;

export interface PreRequestDefinition {
  id: string;
  endpoint: string;
  method: string;
  body: Record<string, ModelAssetNodeProjectionRuntimeValueRule>;
  output_mapping: Record<string, string>;
}

export type PreRequestOutputMap = Record<string, Record<string, unknown>>;

export const MODEL_ASSET_URL_INPUT_UPLOAD_MODE = Object.freeze({
  PUBLIC_RELAY: 'public_relay',
});

export type ModelAssetUrlInputUploadMode =
  (typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE)[keyof typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE];

export const MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE = PUBLIC_RELAY_TARGET_TYPE;

export type ModelAssetUrlInputUploadTargetType = PublicRelayTargetType;

export interface ModelAssetRuntimeDefaultsMap {
  endpoint: string | undefined;
  method: string | undefined;
  contentType: unknown | undefined;
  headers: unknown | undefined;
}

export interface ModelAssetNodeProjectionRuntimeMeta {
  provider_id: string;
  default_task_type: 'text' | 'image' | 'video' | 'audio' | 'multimodal' | string;
  mode: 'text' | 'image' | 'video' | string;
  execution_driver: ModelAssetExecutionDriver;
  payload_format: 'json' | 'multipart' | 'stream' | undefined;
  /**
   * 运行时条件求值的 payload_format。
   *
   * 与 `payload_format` 互斥：两者同时声明视为坏包。用于单节点承载多种远端接口语义的场景
   * （例如同一个生成类节点在不连参考资产时走文生图接口、连参考资产时走图生图接口，
   * 两种接口的传输格式不同）。
   *
   * 求值时机：请求构造期（Runtime Backend 在主循环求值 payload_rules 之前先求值此规则，
   * 结果写入请求级状态）。求值结果必须落入 `json | multipart | stream` 枚举。
   *
   * 语义详细边界见 `docs/model-assets/21-模型资产规则DSL规范.md` 的「请求体格式语义」段。
   */
  payload_format_rule: ModelAssetNodeProjectionRuntimeValueRule | undefined;
  aliases: string[] | undefined;
  route_segment: string | undefined;
  workspace: {
    task_list_position: 'left' | 'right' | 'bottom' | undefined;
    task_queue: {
      enabled: boolean | undefined;
      max_concurrent: number | undefined;
    } | undefined;
  } | undefined;
  api_defaults: ModelAssetRuntimeDefaultsMap | undefined;
  payload_rules: Record<string, ModelAssetNodeProjectionRuntimeValueRule> | undefined;
  pre_requests: PreRequestDefinition[] | undefined;
  url_input_upload_mode: ModelAssetUrlInputUploadMode | undefined;
  url_input_upload_target_type: ModelAssetUrlInputUploadTargetType | undefined;
  capabilities: {
    task_group: string | undefined;
    media_input_mode: string | undefined;
    ui_guards: string[] | undefined;
    execution_traits: string[] | undefined;
  } | undefined;
}
