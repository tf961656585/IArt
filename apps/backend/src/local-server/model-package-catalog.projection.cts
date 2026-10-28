import type { ModelAssetLocalizationBundle } from "@iart/contracts/model-asset-contract";
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts/model-asset-contract/protocol-constants";
import { derivePortDataTypeFromComponent } from "@iart/contracts/model-asset-contract/port-data-type-mapping";
import type {
  CatalogMode,
  CatalogModeParameterOverride,
  CatalogParameterField,
  CatalogPort,
  CatalogProjection,
  CatalogRawObject,
  VariantPayloadOverridesMap,
} from "./model-package-catalog.types.cts";
import {
  ensureExistingFile,
  ensureRelativeChildPath,
  isObjectRecord,
  normalizeString,
  normalizeStringArray,
  notNullish,
  safeReadJsonFile,
  uniq,
} from "./model-package-catalog.shared.cts";
import {
  readLocalizationResources,
  rewriteProjectionLocalizationKeys,
  toModelAssetLocalizationNamespace,
  validateLocalizationTargets,
  type LocaleResources,
} from "./model-package-catalog.localization.cts";
import {
  normalizeDefaultValues,
  normalizeParameterField,
  normalizePort,
  normalizeValidationRule,
  validateParameterSchema,
  validatePortFieldKeyConsistency,
} from "./model-package-catalog.parameter-schema.cts";
import { normalizeFormalTaskExecutionPlan } from "./model-package-catalog.task-plan.cts";
import {
  normalizeRuntimeMeta,
  validateRuntimeMeta,
} from "./model-package-catalog.runtime.cts";
import { validatePayloadRuleFieldKeys } from "./model-package-catalog.payload-rule-validation.cts";

type CatalogRuntimeRaw = {
  execution_driver: unknown | undefined;
  executionDriver: unknown | undefined;
  role: unknown | undefined;
};

type CatalogExecutionProfileRaw = {
  task_type: unknown | undefined;
  taskType: unknown | undefined;
  supports_async_task: unknown | undefined;
  supportsAsyncTask: unknown | undefined;
};

type CatalogDisplayRaw = {
  description: unknown | undefined;
  group_key: unknown | undefined;
  groupKey: unknown | undefined;
  icon_ref: unknown | undefined;
  iconRef: unknown | undefined;
  visible: unknown | undefined;
  order: unknown | undefined;
  badges: unknown | undefined;
  variant_group: unknown | undefined;
  variant_label: unknown | undefined;
  variant_order: unknown | undefined;
  variant_default: unknown | undefined;
};

const emptyCatalogDisplay: CatalogDisplayRaw = {
  description: undefined,
  group_key: undefined,
  groupKey: undefined,
  icon_ref: undefined,
  iconRef: undefined,
  visible: undefined,
  order: undefined,
  badges: undefined,
  variant_group: undefined,
  variant_label: undefined,
  variant_order: undefined,
  variant_default: undefined,
};

const asCatalogRuntimeRaw = (value: unknown): CatalogRuntimeRaw | null =>
  isObjectRecord(value) ? (value as CatalogRuntimeRaw) : null;

const asCatalogExecutionProfileRaw = (
  value: unknown,
): CatalogExecutionProfileRaw | null =>
  isObjectRecord(value) ? (value as CatalogExecutionProfileRaw) : null;

const asCatalogDisplayRaw = (value: unknown): CatalogDisplayRaw =>
  isObjectRecord(value) ? (value as CatalogDisplayRaw) : emptyCatalogDisplay;

/**
 * 从 display 区域提取 variant 元数据。
 * 如果 variant_group 不存在或为空，返回 undefined。
 */
const normalizeVariantMeta = (
  display: CatalogDisplayRaw,
  modelId: string,
): CatalogProjection['variant_meta'] => {
  const groupKey = typeof display.variant_group === 'string' && display.variant_group !== ''
    ? display.variant_group
    : undefined;
  if (groupKey === undefined) return undefined;
  const order = typeof display.variant_order === 'number' && Number.isFinite(display.variant_order)
    ? display.variant_order
    : 0;
  const payloadOverrides: VariantPayloadOverridesMap = {};
  return {
    group_key: groupKey,
    label: modelId,
    order,
    payload_overrides: payloadOverrides,
  };
};

/**
 * 从 parameter_schema.fields 中声明了 data_source IN ("connection", "both") 的字段
 * 自动推导 input_ports。
 *
 * 推导规则：
 * - field_key -> port.id 和 port.field_key
 * - component -> data_type（通过 COMPONENT_TO_PORT_DATA_TYPE 映射表）
 * - component_props.maxFiles > 1 -> multiple: true
 * - required -> port.required
 * - label -> port.name
 * - description -> port.description
 */
const deriveInputPortsFromDataSources = (
  fields: CatalogParameterField[],
): CatalogPort[] => {
  const ports: CatalogPort[] = [];
  for (const field of fields) {
    const ds = field.data_source;
    if (ds !== "connection" && ds !== "both") {
      continue;
    }
    const dataType = derivePortDataTypeFromComponent(field.component);
    const maxFiles =
      field.component_props !== undefined &&
      field.component_props !== null &&
      field.component_props.maxFiles !== undefined
        ? field.component_props.maxFiles
        : undefined;
    const multiple = maxFiles !== undefined && maxFiles > 1;
    ports.push({
      id: field.field_key,
      name: field.label,
      data_type: dataType,
      field_key: field.field_key,
      required: field.required,
      multiple,
      max_connections:
        maxFiles !== undefined && maxFiles > 0 ? maxFiles : undefined,
      description: field.description,
      visible_when: field.visible_when,
    });
  }
  return ports;
};

/**
 * 规范化 modes 顶层结构。
 * 如果 modes 不存在或格式无效，返回 undefined。
 */
export const normalizeModes = (value: unknown): CatalogMode[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const modes: CatalogMode[] = [];
  for (const item of value) {
    if (!isObjectRecord(item)) continue;
    const key = normalizeString(item.key);
    const label = normalizeString(item.label);
    if (!key || !label) continue;
    const overridesSource = item.parameter_overrides || item.parameterOverrides;
    if (!isObjectRecord(overridesSource)) continue;
    const parameter_overrides: Record<string, CatalogModeParameterOverride> = {};
    for (const [fieldKey, overrideRaw] of Object.entries(overridesSource)) {
      if (!isObjectRecord(overrideRaw)) continue;
      const override: CatalogModeParameterOverride = {
        visibility: undefined,
        required: undefined,
        default_value: undefined,
      };
      const visibility = normalizeString(overrideRaw.visibility);
      if (visibility === "visible" || visibility === "hidden") {
        override.visibility = visibility;
      }
      if (typeof overrideRaw.required === "boolean") {
        override.required = overrideRaw.required;
      }
      if ("default_value" in overrideRaw || "defaultValue" in overrideRaw) {
        override.default_value = overrideRaw.default_value !== undefined
          ? overrideRaw.default_value
          : overrideRaw.defaultValue;
      }
      parameter_overrides[fieldKey] = override;
    }
    modes.push({ key, label, parameter_overrides });
  }
  return modes.length > 0 ? modes : undefined;
};

/**
 * 合并 data_source 推导端口与旧 node_definition.json 端口。
 *
 * 策略：
 * 1. 从 parameter_schema.fields 中筛选 data_source IN ("connection", "both") 的字段，自动推导端口
 * 2. 旧 node_definition.json input_ports 中，没有对应 data_source 声明的字段保留（兼容）
 * 3. 有 data_source 声明的字段优先使用推导结果
 */
const mergeInputPorts = (
  derivedPorts: CatalogPort[],
  legacyPorts: CatalogPort[],
  fields: CatalogParameterField[],
): CatalogPort[] => {
  const derivedFieldKeys = new Set(derivedPorts.map((p) => p.field_key));
  const fieldKeyToDataSource = new Map<
    string,
    "connection" | "form" | "both" | undefined
  >();
  for (const field of fields) {
    fieldKeyToDataSource.set(field.field_key, field.data_source);
  }

  const result: CatalogPort[] = [...derivedPorts];

  for (const legacyPort of legacyPorts) {
    if (derivedFieldKeys.has(legacyPort.field_key)) {
      continue;
    }
    const ds = fieldKeyToDataSource.get(legacyPort.field_key);
    if (ds === "connection" || ds === "both") {
      continue;
    }
    result.push(legacyPort);
  }

  return result;
};

/**
 * 从包目录构建投影与本地化束（磁盘入口）：读 runtime_model / node_definition / locales 与
 * resources 文件后，交给 buildProjectionFromPackageSources 走与内存态源完全相同的投影路径。
 */
export const buildProjectionFromPackage = ({
  packageDir,
  packageId,
  manifest,
}: {
  packageDir: string;
  packageId: string;
  manifest: CatalogRawObject;
}): {
  projection: CatalogProjection;
  localizationBundle: ModelAssetLocalizationBundle;
} => {
  const entryModel = isObjectRecord(manifest.entry_model)
    ? manifest.entry_model
    : null;
  const nodeDefinitionRef = isObjectRecord(manifest.node_definition)
    ? manifest.node_definition
    : null;
  if (!entryModel) {
    throw new Error("manifest.entry_model_missing");
  }
  if (!nodeDefinitionRef) {
    throw new Error("manifest.node_definition_missing");
  }
  // protocol_format（接口格式声明，可选）：仅 undefined 视为未声明；
  // 其余值必须是kebab/dot 风格 slug，非法值直接判坏包
  const protocolFormat = (() => {
    if (manifest.protocol_format === undefined) return undefined;
    const normalized = normalizeString(manifest.protocol_format);
    if (!normalized || !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
      throw new Error(
        `manifest.protocol_format_invalid:${String(manifest.protocol_format)}`,
      );
    }
    return normalized;
  })();
  const modelFilePath = ensureRelativeChildPath(
    packageDir,
    entryModel.relative_path,
  );
  const nodeFilePath = ensureRelativeChildPath(
    packageDir,
    nodeDefinitionRef.relative_path,
  );
  ensureExistingFile(modelFilePath, "entry_model_file_missing");
  ensureExistingFile(nodeFilePath, "node_definition_file_missing");
  const runtimeModel = safeReadJsonFile(modelFilePath);
  if (!isObjectRecord(runtimeModel)) {
    throw new Error("runtime_model_invalid");
  }
  const node = safeReadJsonFile(nodeFilePath);
  if (!isObjectRecord(node)) {
    throw new Error("node_definition_invalid");
  }
  if (!Array.isArray(manifest.resources)) {
    throw new Error("manifest.resources_missing");
  }
  const resources = manifest.resources;
  for (const resource of resources) {
    if (!isObjectRecord(resource)) {
      throw new Error("manifest.resource_invalid");
    }
    const resourcePath = ensureRelativeChildPath(
      packageDir,
      resource.relative_path,
    );
    ensureExistingFile(resourcePath, "manifest.resource_missing");
  }
  const localizationResources = readLocalizationResources({
    packageDir,
    manifest,
  });
  return buildProjectionFromPackageSources({
    packageId,
    entryModelModelId: normalizeString(entryModel.model_id),
    protocolFormat,
    runtimeModel,
    node,
    localizationResources,
  });
};

/**
 * 从内存态包源构建投影与本地化束（与包目录入口同一条投影路径）。
 *
 * 合成投影（自建生成模型声明 × 族模板，docs/custom-providers/生成模型自建声明试点-design.md
 * §3.1/§3.3）必须走与已装包完全相同的规范化、本地化校验（validateLocalizationTargets）与
 * 键重写（rewriteProjectionLocalizationKeys）流水线——禁止在合成侧另写一份投影构建或硬编码
 * 文案。包文件与 manifest 形状的磁盘校验留在 buildProjectionFromPackage，本函数只消费已读入
 * 内存的源。
 */
export const buildProjectionFromPackageSources = ({
  packageId,
  entryModelModelId,
  protocolFormat,
  runtimeModel,
  node,
  localizationResources,
}: {
  packageId: string;
  /** manifest.entry_model.model_id（包身份声明的模型 id，与 runtime_model.model_id 必须一致）。 */
  entryModelModelId: string;
  /** manifest.protocol_format 规范化结果（包装入口已校验 slug 形态）。 */
  protocolFormat: string | undefined;
  runtimeModel: CatalogRawObject;
  /** node_definition 的内存形态（端口与分组声明）。 */
  node: CatalogRawObject;
  localizationResources: LocaleResources;
}): {
  projection: CatalogProjection;
  localizationBundle: ModelAssetLocalizationBundle;
} => {
  const modelIdInManifest = entryModelModelId;
  if (!modelIdInManifest) {
    throw new Error("manifest.entry_model_model_id_missing");
  }
  const runtimeModelId = normalizeString(runtimeModel.model_id);
  if (!runtimeModelId) {
    throw new Error("runtime_model.model_id_missing");
  }
  if (modelIdInManifest !== runtimeModelId) {
    throw new Error("entry_model_model_id_mismatch");
  }
  if (runtimeModel.role !== undefined) {
    const role = normalizeString(runtimeModel.role).toLowerCase();
    if (role !== "generator" && role !== "processor") {
      throw new Error(
        `runtime_model.role_invalid:${String(runtimeModel.role)}`,
      );
    }
  }
  if (!normalizeString(node.node_type)) {
    throw new Error("node_definition.node_type_missing");
  }
  validateLocalizationTargets({
    packageId,
    resources: localizationResources,
    runtimeModel,
    nodeDefinition: node,
  });
  const localizationBundle: ModelAssetLocalizationBundle = {
    package_id: packageId,
    namespace: toModelAssetLocalizationNamespace(packageId),
    resources: localizationResources,
  };
  const capability = isObjectRecord(runtimeModel.capability)
    ? runtimeModel.capability
    : null;
  if (!capability) {
    throw new Error("runtime_model.capability_missing");
  }
  const capabilityConstraints = capability.constraints;
  if (capabilityConstraints !== undefined) {
    if (!Array.isArray(capabilityConstraints)) {
      throw new Error("runtime_model.capability_constraints_invalid");
    }
    const invalidConstraintIndex = capabilityConstraints.findIndex(
      (item) => !isObjectRecord(item),
    );
    if (invalidConstraintIndex >= 0) {
      throw new Error(
        `runtime_model.capability_constraints_item_invalid:${invalidConstraintIndex}`,
      );
    }
  }
  const parameterSchema = isObjectRecord(runtimeModel.parameter_schema)
    ? runtimeModel.parameter_schema
    : null;
  if (!parameterSchema) {
    throw new Error("runtime_model.parameter_schema_missing");
  }
  validateParameterSchema(parameterSchema);
  validateRuntimeMeta(runtimeModel.runtime);
  const normalizedFields = Array.isArray(parameterSchema.fields)
    ? parameterSchema.fields.map((field, index) =>
        normalizeParameterField(field, index),
      )
    : [];
  const requiredFieldsSource =
    parameterSchema.required_fields || parameterSchema.requiredFields;
  const requiredFields = Array.isArray(requiredFieldsSource)
    ? uniq(
        requiredFieldsSource
          .map((field) => normalizeString(field))
          .filter((field) => field.length > 0),
      )
    : normalizedFields
        .filter((field) => field.required)
        .map((field) => field.field_key);
  const defaultValuesSource =
    parameterSchema.default_values || parameterSchema.defaultValues;
  const defaultValues = normalizeDefaultValues(
    defaultValuesSource,
    normalizedFields,
  );
  const executionProfileCandidate =
    runtimeModel.execution_profile || runtimeModel.executionProfile;
  const executionProfileSource = asCatalogExecutionProfileRaw(
    executionProfileCandidate,
  );
  const taskType =
    normalizeString(
      (executionProfileSource !== null
        ? executionProfileSource.task_type
        : undefined) ||
        (executionProfileSource !== null
          ? executionProfileSource.taskType
          : undefined),
    ) ||
    normalizeString(
      runtimeModel.default_task_type || runtimeModel.defaultTaskType,
    ) ||
    "image";
  const display = asCatalogDisplayRaw(runtimeModel.display);
  const runtimeMeta = asCatalogRuntimeRaw(runtimeModel.runtime);
  const normalizedRole = (() => {
    const role = normalizeString(
      runtimeModel.role ||
        node.role ||
        (runtimeMeta !== null ? runtimeMeta.role : undefined),
    ).toLowerCase();
    if (role === "processor") return "processor";
    return "generator";
  })();
  const normalizedInputPorts = (() => {
    const legacyInputPorts = node.input_ports || node.inputPorts;
    const legacyNormalized = Array.isArray(legacyInputPorts)
      ? legacyInputPorts.map((item, index) =>
          normalizePort(item, "input", index),
        )
      : [];
    const derivedPorts = deriveInputPortsFromDataSources(normalizedFields);
    if (derivedPorts.length > 0) {
      return mergeInputPorts(derivedPorts, legacyNormalized, normalizedFields);
    }
    return legacyNormalized;
  })();
  const normalizedOutputPorts = (() => {
    const outputPorts = node.output_ports || node.outputPorts;
    return Array.isArray(outputPorts)
      ? outputPorts.map((item, index) =>
          normalizePort(item, "output", index),
        )
      : [];
  })();
  validatePortFieldKeyConsistency({
    inputPorts: normalizedInputPorts,
    parameterFields: normalizedFields,
    packageId,
  });
  const projection: CatalogProjection = {
    package_id: packageId,
    model_id: runtimeModelId,
    protocol_format: protocolFormat,
    display_label: runtimeModelId,
    shell_model_id: undefined,
    node_type: "model",
    role: normalizedRole,
    description: undefined,
    group_key:
      normalizeString(node.group_key || node.groupKey) ||
      normalizeString(display.group_key || display.groupKey) ||
      normalizeString(runtimeModel.provider_id || runtimeModel.providerId) ||
      "other",
    icon_ref:
      normalizeString(node.icon_ref || node.iconRef) ||
      normalizeString(display.icon_ref || display.iconRef) ||
      undefined,
    capability: {
      input_modalities:
        normalizeStringArray(
          capability.input_modalities || capability.inputModalities,
        ) || [],
      output_modalities:
        normalizeStringArray(
          capability.output_modalities || capability.outputModalities,
        ) || [],
      supports_async_task:
        capability.supports_async_task === true ||
        capability.supportsAsyncTask === true,
      supports_streaming:
        capability.supports_streaming === true ||
        capability.supportsStreaming === true,
      supports_multi_image:
        capability.supports_multi_image === true ||
        capability.supportsMultiImage === true,
      supports_reference_media:
        capability.supports_reference_media === true ||
        capability.supportsReferenceMedia === true,
      constraints: Array.isArray(capabilityConstraints)
        ? capabilityConstraints
        : [],
    },
    ports: {
      inputs: normalizedInputPorts,
      outputs: normalizedOutputPorts,
    },
    parameter_schema: {
      schema_type: "object",
      fields: normalizedFields,
      required_fields: requiredFields,
      default_values: defaultValues,
      validation_rules: (() => {
        const validationRules =
          parameterSchema.validation_rules || parameterSchema.validationRules;
        return Array.isArray(validationRules)
          ? validationRules
              .map((item) => normalizeValidationRule(item))
              .filter(notNullish)
          : [];
      })(),
    },
    // prompt_field 在 payload_rules 规范化完成后（validatePayloadRuleFieldKeys / 推导）
    // 统一填充；此处占位，保持 CatalogProjection 结构稳定。
    prompt_field: undefined,
    execution_profile: {
      task_type: taskType,
      supports_async_task:
        (executionProfileSource !== null
          ? executionProfileSource.supports_async_task
          : undefined) === true ||
        (executionProfileSource !== null
          ? executionProfileSource.supportsAsyncTask
          : undefined) === true ||
        capability.supports_async_task === true ||
        capability.supportsAsyncTask === true,
    },
    visibility: {
      visible: display.visible !== false,
      order: Number.isFinite(Number(display.order)) ? Number(display.order) : 0,
      badges: normalizeStringArray(display.badges),
    },
    runtime: (() => {
      const normalized = normalizeRuntimeMeta(runtimeModel.runtime, {
        providerId: normalizeString(
          runtimeModel.provider_id || runtimeModel.providerId,
        ),
        modelId: runtimeModelId,
        taskType,
      });
      return normalized;
    })(),
    task_execution_plan: normalizeFormalTaskExecutionPlan(runtimeModel),
    modes: normalizeModes(runtimeModel.modes),
    variant_meta: (() => {
      const meta = normalizeVariantMeta(display, runtimeModelId);
      if (meta === undefined) return undefined;
      // payload_overrides 在 projection 构建完成后填充
      return meta;
    })(),
    variant_group: undefined,
  };
  // 从 runtime.payload_rules 中提取 body.model 的 literal 值，填充到 variant_meta.payload_overrides
  if (projection.variant_meta !== undefined) {
    const payloadRules = projection.runtime.payload_rules;
    if (payloadRules !== undefined) {
      const bodyModelRule = payloadRules['body.model'];
      if (
        bodyModelRule !== undefined &&
        bodyModelRule !== null &&
        typeof bodyModelRule === 'object' &&
        'kind' in bodyModelRule &&
        bodyModelRule.kind === 'literal' &&
        'value' in bodyModelRule
      ) {
        const literalValue = (bodyModelRule as { kind: string; value: unknown }).value;
        if (typeof literalValue === 'string') {
          projection.variant_meta.payload_overrides = { 'body.model': literalValue };
        }
      }
    }
  }
  validatePayloadRuleFieldKeys(projection);
  // 提示词映射字段：直接从包源顶层 prompt_field 声明规范化（方案 B 单一事实源）。
  // 引用保留键 `__prompt` 的 payload_rules 已在 validatePayloadRuleFieldKeys 通过；
  // 声明存在性与一致性由 tooling source-package-validator 严把关，此处只做投射。
  const promptFieldRaw = isObjectRecord(runtimeModel.prompt_field)
    ? runtimeModel.prompt_field
    : null;
  if (promptFieldRaw !== null) {
    const promptFieldKey = normalizeString(promptFieldRaw.field_key);
    if (promptFieldKey !== MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) {
      throw new Error(
        `runtime_model.prompt_field_invalid_key:${promptFieldKey ?? "missing"}`,
      );
    }
    const promptRules = Array.isArray(promptFieldRaw.validation_rules)
      ? promptFieldRaw.validation_rules
          .map((item) => normalizeValidationRule(item))
          .filter(notNullish)
      : [];
    projection.prompt_field = {
      field_key: promptFieldKey,
      required: promptFieldRaw.required === true,
      validation_rules: promptRules,
    };
  }
  return {
    projection: rewriteProjectionLocalizationKeys(projection, packageId),
    localizationBundle,
  };
};
