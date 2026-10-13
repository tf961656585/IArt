/**
 * 测试工厂函数：提供 ModelAssetNodeProjection、RuntimeMeta 和 ModelNodeData 的最小合法构造。
 * 供所有测试文件复用，避免 inline 构造遗漏必填字段。
 */
import type {
  ModelAssetNodeProjection,
  ModelAssetNodeProjectionRuntimeMeta,
} from '@iart/contracts/model-asset-contract';

export function createTestRuntimeMeta(
  overrides?: Partial<ModelAssetNodeProjectionRuntimeMeta>,
): ModelAssetNodeProjectionRuntimeMeta {
  return {
    provider_id: 'test-provider',
    default_task_type: 'text',
    mode: 'text',
    adapter_key: 'test-adapter',
    ...overrides,
  };
}

export function createTestProjection(
  overrides?: Partial<ModelAssetNodeProjection>,
): ModelAssetNodeProjection {
  return {
    model_id: 'test-model-id',
    node_type: 'model',
    group_key: 'test-group',
    capability: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      supports_async_task: false,
    },
    ports: { inputs: [], outputs: [] },
    parameter_schema: {
      schema_type: 'object',
      fields: [],
      required_fields: [],
      default_values: {},
      validation_rules: [],
    },
    execution_profile: {
      task_type: 'text',
      supports_async_task: false,
    },
    visibility: { visible: true, order: 0 },
    runtime: createTestRuntimeMeta(),
    ...overrides,
  };
}
