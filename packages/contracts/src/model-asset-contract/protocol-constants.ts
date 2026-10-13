export const MODEL_ASSET_CONTRACT_VERSION = 8;

export const MODEL_ASSET_API_PREFIX = '/api/model-assets';
export const MODEL_ASSET_WS_PATH = '/ws/model-assets';
export const MODEL_ASSET_NODE_PROJECTIONS_ROUTE = `${MODEL_ASSET_API_PREFIX}/node-projections`;

export const MODEL_ASSET_SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;

export type ModelAssetLocale = (typeof MODEL_ASSET_SUPPORTED_LOCALES)[number];

export type ModelAssetNodeProjectionDataType = 'text' | 'image' | 'video' | 'audio' | 'url' | 'any';
export type ModelAssetNodeRole = 'generator' | 'processor';

export const MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS = [
  'text',
  'textarea',
  'select',
  'switch',
  'number',
  'radio',
  'toggle',
  'file',
  'imageUpload',
  'imageSize',
] as const;

/**
 * 提示词保留字段键（payload 合并空间专用，不是参数表单字段）。
 *
 * 模型能力包的 `payload_rules` 引用该键，把 PromptDock 草稿顶层 prompt 填进远端请求；
 * `parameter_schema.fields` / `required_fields` / `default_values` 禁止出现该键——
 * 提示词不是模型参数，参数面板不承载提示词（spec docs/model-assets/17 与
 * docs/editor/节点参数呈现分层.md）。
 */
export const MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY = '__prompt' as const;

export type ModelAssetNodeProjectionFieldComponent =
  (typeof MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS)[number];

/**
 * 模型能力包可声明的执行驱动。
 *
 * **不含 `chat_streaming`**：对话模型（LLM）只由用户在主窗口自建声明，软件不内置对话模型包，
 * 能力包格式也不承载这一族。对话模型的执行链（chat adapter、对话流式引擎、agent 会话）
 * 照常服务自建模型，只是不再由包声明。
 */
export const MODEL_ASSET_SUPPORTED_EXECUTION_DRIVERS = [
  'http_formal_task',
  'local_edge',
] as const;

export type ModelAssetExecutionDriver = (typeof MODEL_ASSET_SUPPORTED_EXECUTION_DRIVERS)[number];

export type ModelAssetProviderId = string;

export const RUNTIME_VALUE_RULE_KIND_PRE_REQUEST_OUTPUT = 'pre_request_output';
