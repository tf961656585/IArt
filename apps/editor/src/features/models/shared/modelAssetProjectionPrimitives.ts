import type { TaskType } from '@/client/adapters/types';
import type {
  ModelAssetNodeProjection,
  ModelAssetNodeProjectionParameterField,
  ModelAssetNodeProjectionPort,
  ModelAssetNodeProjectionVisibleWhen,
} from '@iart/contracts/model-asset-contract';
import type {
  ModelConfigEntry,
  ModelMode,
  NodeGraphPortConfig,
} from '@/client/config/models.config';
import type { ProviderId } from '@/client/config/providers.config';
import type { SchemaConditionExpression } from '@/features/workspace/schema/types';
import { normalizeString } from '@/client/config/modelAssetProjectionShared';

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export const normalizeMode = (value: string, fallback: string): ModelMode => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'text' || normalized === 'image' || normalized === 'video') return normalized;
  const fallbackNormalized = normalizeString(fallback).toLowerCase();
  if (fallbackNormalized === 'video') return 'video';
  if (fallbackNormalized === 'text' || fallbackNormalized === 'audio') return 'text';
  return 'image';
};

export const normalizeTaskType = (value: string): TaskType => {
  const normalized = normalizeString(value).toLowerCase();
  if (
    normalized === 'text'
    || normalized === 'image'
    || normalized === 'video'
    || normalized === 'audio'
    || normalized === 'multimodal'
  ) {
    return normalized;
  }
  return 'image';
};

export const normalizeProviderId = (value: string): ProviderId | null => {
  const normalized = normalizeString(value);
  return PROVIDER_ID_PATTERN.test(normalized) ? normalized : null;
};

export const normalizePortDataType = (value: string): NodeGraphPortConfig['dataType'] => {
  const normalized = normalizeString(value).toLowerCase();
  if (
    normalized === 'text'
    || normalized === 'image'
    || normalized === 'video'
    || normalized === 'audio'
    || normalized === 'url'
    || normalized === 'any'
  ) {
    return normalized;
  }
  return 'any';
};

/**
 * 把端口声明的 visible_when（eq/neq/in/not_in）转换为 Editor 内部求值器消费的
 * SchemaConditionExpression（eq/ne/includes/excludes）。
 * 与字段层 normalizeVisibleWhen（modelAssetSchemaProjection.ts）语义对齐。
 */
const normalizePortVisibleWhen = (
  visibleWhen: ModelAssetNodeProjectionVisibleWhen | undefined,
): SchemaConditionExpression<string> | undefined => {
  if (visibleWhen === null || visibleWhen === undefined) return undefined;
  const op = visibleWhen.op;
  if (op === 'eq') {
    return { op: 'eq', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'neq') {
    return { op: 'ne', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'in') {
    return { op: 'includes', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'not_in') {
    return { op: 'excludes', field: visibleWhen.field, value: visibleWhen.value };
  }
  return undefined;
};

const buildPortConfig = (
  port: ModelAssetNodeProjectionPort,
  dataSourceMap: Map<string, 'connection' | 'form' | 'both'>,
): NodeGraphPortConfig => {
  const config: NodeGraphPortConfig = {
    id: port.id,
    name: port.name,
    dataType: normalizePortDataType(port.data_type),
    fieldKey: port.field_key,
    canonicalKey: undefined,
    description: undefined,
    required: undefined,
    multiple: undefined,
    maxConnections: undefined,
    dataSource: undefined,
    visibleWhen: undefined,
  };
  if (port.description) config.description = port.description;
  if (port.required !== undefined) config.required = port.required;
  if (port.multiple !== undefined) config.multiple = port.multiple;
  if (port.max_connections !== undefined) config.maxConnections = port.max_connections;
  const ds = dataSourceMap.get(port.field_key);
  if (ds) config.dataSource = ds;
  const visibleWhen = normalizePortVisibleWhen(port.visible_when);
  if (visibleWhen) config.visibleWhen = visibleWhen;
  return config;
};

const buildFieldDataSourceMap = (
  fields: ModelAssetNodeProjectionParameterField[],
): Map<string, 'connection' | 'form' | 'both'> => {
  const map = new Map<string, 'connection' | 'form' | 'both'>();
  for (const field of fields) {
    if (field.data_source !== undefined) {
      map.set(field.field_key, field.data_source);
    }
  }
  return map;
};

export const toNodeGraphPorts = (
  projection: ModelAssetNodeProjection,
): ModelConfigEntry['nodeGraphPorts'] => {
  const dataSourceMap = buildFieldDataSourceMap(projection.parameter_schema.fields);
  const inputs = projection.ports.inputs.map((port) => buildPortConfig(port, dataSourceMap));
  const outputs = projection.ports.outputs.map((port) => buildPortConfig(port, dataSourceMap));
  return { inputs, outputs };
};
