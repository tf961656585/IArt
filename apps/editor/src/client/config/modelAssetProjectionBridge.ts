import type { SubmitFormalCanvasTaskOptions } from '@/client/api/client';
import { submitFormalCanvasTask } from '@/client/api/client';
import type { UnknownRecord } from '@/client/utils/typeGuards';
import type {
  ModelAssetNodeProjection,
  ModelAssetNodeProjectionPromptField,
} from '@iart/contracts/model-asset-contract';
import type { ModelAssetInputContract, ModelConfigEntry } from './models.config';
import {
  buildSchema,
  normalizeMode,
  normalizePortDataType,
  normalizeProviderId,
  normalizeTaskType,
  toNodeGraphPorts,
} from './modelAssetSchemaProjection';
import { isObjectRecord, normalizeString } from './modelAssetProjectionShared';

const MEDIA_DATA_TYPES_FOR_PARAMETER_SCHEMA = new Set(['image', 'video', 'audio']);

const buildParameterSchemaFromModelConfig = (
  modelConfig: ModelConfigEntry,
): unknown | undefined => {
  const inputs = modelConfig.nodeGraphPorts !== undefined ? modelConfig.nodeGraphPorts.inputs : undefined;
  if (inputs === undefined || inputs.length === 0) return undefined;
  const mediaFields: Array<{ field_key: string; component: string }> = [];
  for (const port of inputs) {
    if (port.dataType !== undefined && MEDIA_DATA_TYPES_FOR_PARAMETER_SCHEMA.has(port.dataType)) {
      mediaFields.push({ field_key: port.fieldKey, component: 'imageUpload' });
    }
  }
  if (mediaFields.length === 0) return undefined;
  return { fields: mediaFields };
};

const BACKEND_FORMAL_TASK_ADAPTER: ModelConfigEntry['adapter'] = {
  generate: async (...args) => {
    const [payload, ctx] = args;
    const modelConfig = ctx !== null && ctx !== undefined ? ctx.modelConfig : undefined;
    const modelId =
      normalizeString((modelConfig !== null && modelConfig !== undefined ? modelConfig.modelId : undefined))
      || normalizeString((ctx !== null && ctx !== undefined ? ctx.model : undefined))
      || normalizeString((modelConfig !== null && modelConfig !== undefined ? modelConfig.modelId : undefined));
    if (!modelId) throw new Error('还没有选择模型，请先选择要使用的模型再提交。');
    const taskMeta = ctx !== undefined && ctx !== null && isObjectRecord(ctx.taskMeta) ? ctx.taskMeta : undefined;
    const onTaskAccepted = ctx !== undefined && ctx !== null && typeof ctx.onTaskAccepted === 'function'
      ? ctx.onTaskAccepted
      : undefined;
    const parameterSchema = modelConfig !== null && modelConfig !== undefined
      ? buildParameterSchemaFromModelConfig(modelConfig)
      : undefined;
    const taskOptions: SubmitFormalCanvasTaskOptions = {
      modelId,
      payload,
      metadata: taskMeta,
      parameterSchema,
      ...(onTaskAccepted !== undefined ? { onTaskAccepted } : {}),
    };
    const result = await submitFormalCanvasTask(taskOptions);
    return {
      ...result,
      modelId,
    };
  },
};

type RuntimeDefaultsInput = {
  endpoint: unknown | undefined;
  method: unknown | undefined;
  contentType: unknown | undefined;
  headers: unknown | undefined;
} | null | undefined;

type RuntimeDefaultsProjection = {
  endpoint: unknown | undefined;
  method: unknown | undefined;
  contentType: unknown | undefined;
  headers: unknown | undefined;
};

const toRuntimeDefaultsRecord = (defaults: RuntimeDefaultsInput): RuntimeDefaultsProjection | null => {
  if (!defaults) return null;
  const projected: RuntimeDefaultsProjection = {
    endpoint: undefined,
    method: undefined,
    contentType: undefined,
    headers: undefined,
  };
  if (defaults.endpoint !== undefined) projected.endpoint = defaults.endpoint;
  if (defaults.method !== undefined) projected.method = defaults.method;
  if (defaults.contentType !== undefined) projected.contentType = defaults.contentType;
  if (defaults.headers !== undefined) projected.headers = defaults.headers;
  return Object.keys(projected).length > 0 ? projected : null;
};

type RawModelAssetNodeProjection = UnknownRecord & {
  package_id: unknown | undefined;
  model_id: unknown | undefined;
  shell_model_id: unknown | undefined;
  node_type: unknown | undefined;
  group_key: unknown | undefined;
  capability: unknown | undefined;
  ports: unknown | undefined;
  parameter_schema: unknown | undefined;
  execution_profile: unknown | undefined;
  visibility: unknown | undefined;
};

const isModelAssetNodeProjection = (value: unknown): value is ModelAssetNodeProjection => {
  if (!isObjectRecord(value)) return false;
  const projection = value as RawModelAssetNodeProjection;
  return (
    normalizeString(projection.node_type) === 'model'
    && normalizeString(projection.model_id).length > 0
    && normalizeString(projection.group_key).length > 0
    && isObjectRecord(projection.capability)
    && isObjectRecord(projection.ports)
    && isObjectRecord(projection.parameter_schema)
    && isObjectRecord(projection.execution_profile)
    && isObjectRecord(projection.visibility)
  );
};

const uniq = <T,>(items: T[]): T[] => Array.from(new Set(items));

const toAssetCapabilities = (
  projection: ModelAssetNodeProjection,
): ModelConfigEntry['assetCapabilities'] => {
  const caps = (projection.runtime !== null && projection.runtime !== undefined ? projection.runtime.capabilities : undefined);
  if (!caps) return undefined;
  const taskGroup = normalizeString(caps.task_group) || undefined;
  const mediaInputMode = normalizeString(caps.media_input_mode) || undefined;
  const uiGuards = Array.isArray(caps.ui_guards)
    ? caps.ui_guards.map((item) => normalizeString(item)).filter(Boolean)
    : undefined;
  const executionTraits = Array.isArray(caps.execution_traits)
    ? caps.execution_traits.map((item) => normalizeString(item)).filter(Boolean)
    : undefined;
  if (!taskGroup && !mediaInputMode && !(uiGuards !== null && uiGuards !== undefined ? uiGuards.length : undefined) && !(executionTraits !== null && executionTraits !== undefined ? executionTraits.length : undefined)) return undefined;
  const result: NonNullable<ModelConfigEntry['assetCapabilities']> = {
    taskGroup,
    mediaInputMode,
    uiGuards: uiGuards !== undefined && uiGuards.length > 0 ? uiGuards : undefined,
    executionTraits: executionTraits !== undefined && executionTraits.length > 0 ? executionTraits : undefined,
  };
  return result;
};

const readPromptMaxLength = (
  promptField: ModelAssetNodeProjectionPromptField | undefined,
): number | undefined => {
  if (!promptField) return undefined;
  const rules = Array.isArray(promptField.validation_rules)
    ? promptField.validation_rules
    : [];
  for (const rule of rules) {
    const type = normalizeString(rule.type).toLowerCase();
    if (type !== 'max_length' && type !== 'maxlength') continue;
    const numeric = Number(rule.value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return undefined;
};

const toAssetInputContract = (
  projection: ModelAssetNodeProjection,
): ModelAssetInputContract | undefined => {
  // 提示词映射字段来自投影顶层 prompt_field 声明（方案 B），不再从 parameter_schema.fields
  // 里扫描 "prompt"。保留键 `__prompt` 是参数合并空间的暂存键，不进入参数表单。
  const promptFieldKey =
    projection.prompt_field !== undefined && projection.prompt_field.field_key
      ? projection.prompt_field.field_key
      : undefined;
  const promptMaxLength = readPromptMaxLength(projection.prompt_field);
  const requiredSource =
    Array.isArray(projection.parameter_schema.required_fields) && projection.parameter_schema.required_fields.length > 0
      ? projection.parameter_schema.required_fields
      : projection.parameter_schema.fields.filter((field) => field.required === true).map((field) => field.field_key);
  const requiredFieldKeys = uniq(requiredSource.map((fieldKey) => normalizeString(fieldKey)).filter(Boolean));
  const imageInputFieldKeys = uniq(
    projection.ports.inputs
      .filter((port) => normalizePortDataType(port.data_type) === 'image')
      .map((port) => normalizeString(port.field_key))
      .filter(Boolean),
  );
  if (!promptFieldKey && promptMaxLength === undefined && requiredFieldKeys.length === 0 && imageInputFieldKeys.length === 0) return undefined;
  return {
    promptFieldKey,
    promptMaxLength,
    requiredFieldKeys: requiredFieldKeys.length > 0 ? requiredFieldKeys : undefined,
    imageInputFieldKeys: imageInputFieldKeys.length > 0 ? imageInputFieldKeys : undefined,
  };
};

const toCapabilityFlags = (
  projection: ModelAssetNodeProjection,
): ModelConfigEntry['capabilities'] => {
  const caps = (projection.runtime !== null && projection.runtime !== undefined ? projection.runtime.capabilities : undefined);
  if (!caps) return undefined;
  const keys = [
    ...(Array.isArray(caps.ui_guards) ? caps.ui_guards : []),
    ...(Array.isArray(caps.execution_traits) ? caps.execution_traits : []),
  ].map((item) => normalizeString(item)).filter(Boolean);
  if (keys.length === 0) return undefined;
  return Object.fromEntries(keys.map((key) => [key, true]));
};

const getProjectionLogMeta = (projection: unknown): { packageId: string | undefined; modelId: string | undefined } => {
  if (!isObjectRecord(projection)) {
    return {
      packageId: undefined,
      modelId: undefined,
    };
  }
  const record = projection as RawModelAssetNodeProjection;
  const packageId = normalizeString(record.package_id);
  const modelId = normalizeString(record.model_id);
  return {
    packageId: packageId || undefined,
    modelId: modelId || undefined,
  };
};

const warnProjectionDropped = (projection: unknown, reason: string, details: UnknownRecord | undefined) => {
  console.warn('[model-asset] projection dropped', {
    reason,
    ...getProjectionLogMeta(projection),
    ...(details ?? {}),
  });
};

const resolveAdapter = () => BACKEND_FORMAL_TASK_ADAPTER;

export const buildModelConfigFromNodeProjection = (
  projection: ModelAssetNodeProjection,
): ModelConfigEntry | null => {
  try {
    const runtime = projection.runtime;
    if (!runtime) {
      warnProjectionDropped(projection, 'runtime_missing', undefined);
      return null;
    }
    const providerId = normalizeProviderId(runtime.provider_id);
    if (!providerId) {
      warnProjectionDropped(projection, 'provider_invalid', { providerId: runtime.provider_id });
      return null;
    }

    const normalizedModelId = normalizeString(projection.model_id) || projection.model_id;
    const normalizedDisplayLabel = normalizeString(projection.display_label) || normalizedModelId;
    const normalizedShellModelId = normalizeString(projection.shell_model_id) || undefined;
    const taskType = normalizeTaskType(runtime.default_task_type || projection.execution_profile.task_type);
    const schema = buildSchema(projection);
    const workspace = runtime.workspace;
    const taskQueue = workspace !== undefined ? workspace.task_queue : undefined;
    const taskListPosition = workspace !== undefined ? workspace.task_list_position : undefined;
    const config: ModelConfigEntry = {
      providerId,
      groupId: normalizeString(projection.group_key) || providerId,
      label: normalizedDisplayLabel,
      modelId: normalizedModelId,
      defaultTaskType: taskType,
      mode: normalizeMode(runtime.mode, taskType),
      adapter: resolveAdapter(),
      defaults: undefined,
      visible: undefined,
      role: undefined,
      description: undefined,
      aliases: undefined,
      routeSegment: undefined,
      workspace: {
        form: { kind: 'schema', load: async () => schema },
        taskList: {
          position:
            taskListPosition === 'left'
            || taskListPosition === 'right'
            || taskListPosition === 'bottom'
              ? taskListPosition
              : 'bottom',
        },
        taskQueue: {
          enabled: (taskQueue !== undefined ? taskQueue.enabled : undefined) !== false,
          maxConcurrent: taskQueue !== undefined ? taskQueue.max_concurrent : undefined,
        },
        resultExtractor: undefined,
        dock: undefined,
        output: undefined,
      },
      canvasPortSpec: undefined,
      i18n: undefined,
      nodeGraphPorts: undefined,
      videoGenMode: undefined,
      capabilities: undefined,
      assetCapabilities: undefined,
      assetInputContract: undefined,
      variantGroup: undefined,
      canvasInspector: {
        properties: projection.parameter_schema.fields
          .map((field) => field.field_key)
          .filter((fieldKey) => fieldKey !== 'prompt'),
      },
    };

    const nodeGraphPorts = toNodeGraphPorts(projection);
    if (nodeGraphPorts) {
      config.nodeGraphPorts = nodeGraphPorts;
    }
    config.visible = projection.visibility.visible !== false;
    config.role = projection.role === 'processor' ? 'processor' : 'generator';
    const capabilityFlags = toCapabilityFlags(projection);
    if (capabilityFlags) config.capabilities = capabilityFlags;
    const capabilities = toAssetCapabilities(projection);
    if (capabilities) config.assetCapabilities = capabilities;
    const inputContract = toAssetInputContract(projection);
    if (inputContract) config.assetInputContract = inputContract;
    const defaults = toRuntimeDefaultsRecord(runtime.api_defaults);
    if (defaults) config.defaults = defaults;
    const aliases = Array.isArray(runtime.aliases)
      ? runtime.aliases.map((item) => normalizeString(item)).filter(Boolean)
      : [];
    if (aliases.length > 0) config.aliases = aliases;
    if (normalizedShellModelId && !(config.aliases ?? []).includes(normalizedShellModelId)) {
      config.aliases = [...(config.aliases ?? []), normalizedShellModelId];
    }
    const routeSegment = normalizeString(runtime.route_segment);
    if (routeSegment) config.routeSegment = routeSegment;
    // 映射 variant_group（snake_case → camelCase）
    const variantGroup = projection.variant_group;
    if (variantGroup) {
      config.variantGroup = {
        groupKey: variantGroup.group_key,
        shellModelId: variantGroup.shell_model_id,
        defaultModelId: variantGroup.default_model_id,
        variants: variantGroup.variants.map((v) => ({
          modelId: v.model_id,
          label: v.label,
          order: v.order,
        })),
      };
    }
    return config;
  } catch (error) {
    warnProjectionDropped(projection, 'projection_invalid', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export const buildModelConfigsFromNodeProjections = (projections: unknown[]): ModelConfigEntry[] => {
  const configs = projections
    .map((rawProjection) => {
      if (!isModelAssetNodeProjection(rawProjection)) {
        warnProjectionDropped(rawProjection, 'projection_invalid', {
          error: isObjectRecord(rawProjection)
            ? 'projection must be a model asset node projection'
            : 'projection must be a non-null object',
        });
        return null;
      }
      return buildModelConfigFromNodeProjection(rawProjection);
    })
    .filter((config): config is ModelConfigEntry => Boolean(config));
  const droppedCount = projections.length - configs.length;
  if (droppedCount > 0) {
    console.warn('[model-asset] projection mapping summary', {
      total: projections.length,
      mapped: configs.length,
      dropped: droppedCount,
    });
  }

  return configs;
};
