import type { SchemaFormDefinition } from '@/features/workspace/schema/types';
import type { ModelAssetNodeProjection } from '@iart/contracts/model-asset-contract';
import type { ModelConfigEntry } from '../../models.config';

export const createProjection = (
  overrides: Partial<ModelAssetNodeProjection> = {},
): ModelAssetNodeProjection => ({
  package_id: 'zimage',
  model_id: 'z-image-turbo',
  node_type: 'model',
  description: 'z-image-turbo 同步文生图模型',
  group_key: 'alibaba',
  icon_ref: 'provider-alibaba-icon',
  capability: {
    input_modalities: ['text'],
    output_modalities: ['image'],
    supports_async_task: false,
    constraints: [],
  },
  ports: {
    inputs: [
      {
        id: 'prompt',
        name: '提示词',
        data_type: 'text',
        field_key: 'prompt',
        required: true,
      },
    ],
    outputs: [
      {
        id: 'image',
        name: '图像',
        data_type: 'image',
        field_key: 'output_image',
        multiple: true,
      },
    ],
  },
  parameter_schema: {
    schema_type: 'object',
    fields: [
      {
        field_key: 'prompt',
        label: '提示词',
        component: 'textarea',
        data_source: 'form',
        required: true,
        default_value: '',
      },
      {
        field_key: 'size',
        label: '分辨率',
        component: 'select',
        data_source: 'form',
        required: true,
        default_value: '1536x1536',
        enum_options: [{ value: '1536x1536', label: '1:1' }],
      },
    ],
    required_fields: ['prompt', 'size'],
    default_values: {
      prompt: '',
      size: '1536x1536',
    },
    validation_rules: [],
  },
  execution_profile: {
    task_type: 'image',
    supports_async_task: false,
  },
  visibility: {
    visible: true,
    order: 1,
  },
  runtime: {
    provider_id: 'alibaba',
    default_task_type: 'image',
    mode: 'image',
    execution_driver: 'http_formal_task',
    payload_format: 'json',
    payload_format_rule: undefined,
    aliases: ['z-image'],
    route_segment: undefined,
    workspace: undefined,
    api_defaults: {
      endpoint: '/v1/images/generations',
      method: 'POST',
      contentType: 'application/json',
      headers: undefined,
    },
    payload_rules: {
      'api.endpoint': {
        kind: 'literal',
        value: '/v1/images/generations',
      },
      'body.model': {
        kind: 'literal',
        value: 'z-image-turbo',
      },
      'body.prompt': {
        kind: 'field',
        field_key: 'prompt',
        transforms: ['trim'],
        fallback: undefined,
        media_target: undefined,
        multipart_array_naming: undefined,
      },
      'body.size': {
        kind: 'field',
        field_key: 'size',
        transforms: undefined,
        fallback: undefined,
        media_target: undefined,
        multipart_array_naming: undefined,
      },
    },
    url_input_upload_mode: undefined,
    url_input_upload_target_type: undefined,
    capabilities: undefined,
    pre_requests: undefined,
  },
  ...overrides,
});

export const requireProjectionRuntime = (
  projection: ModelAssetNodeProjection,
): NonNullable<ModelAssetNodeProjection['runtime']> => {
  if (!projection.runtime) {
    throw new Error('missing_projection_runtime');
  }
  return projection.runtime;
};

export const loadConfigSchema = async (
  config: ModelConfigEntry,
): Promise<SchemaFormDefinition<string>> => {
  const form = config.workspace?.form;
  if (!form || form.kind !== 'schema') {
    throw new Error('missing_schema_form');
  }
  const schemaModule = await form.load();
  if ('default' in schemaModule && schemaModule.default) {
    return schemaModule.default;
  }
  if ('schema' in schemaModule) {
    return schemaModule.schema;
  }
  if ('meta' in schemaModule && 'fields' in schemaModule && 'payload' in schemaModule) {
    return schemaModule;
  }
  throw new Error('invalid_schema_module');
};
