import path from 'node:path';
import { validateModelAssetLocalization } from '../model-asset-localization-validator';
import {
  MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
  MODEL_ASSET_URL_INPUT_UPLOAD_MODE,
  MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE,
} from '@iart/contracts';
import type { SourceManifest, ValidatedPackage } from './types';
import {MODEL_SELECTOR_FIELD_KEYS,SUPPORTED_FIELD_COMPONENTS,SUPPORTED_PAYLOAD_FORMATS,assertLegacyKeyAbsent,ensureFileExists,ensureRelativeChildPath,isModelAssetExecutionDriver,isModelAssetProviderId,isImageParameterField,isRecord,normalizeString,
  normalizeUrlInputUploadMode,
  normalizeUrlInputUploadTargetType,
  readJson,
} from './shared';
import { validateImageSizeConstrainedResolutionField } from './image-size-constrained-validator';
import { validateMediaTargetRuleSet, validateValueRule } from './runtime-rule-validator';
import { validateFormalTaskExecutionPlan } from './formal-task-execution-plan-validator';
import { validateFieldDataSource, validateFieldVisibleWhen, validateModes } from './field-meta-validator';
import { extractVariantMeta, validateVariantDisplayFields } from './variant-validator';

/* 参数表单不再有「允许空 fields」的例外：那是给对话模型包的（对话没有生成参数表），
   而对话模型已不再由能力包承载。 */
const validateParameterSchema = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error('runtime_model.parameter_schema_missing');
  }
  if (!Array.isArray(value['fields']) || value['fields'].length === 0) {
    throw new Error('runtime_model.parameter_schema_fields_missing');
  }

  value['fields'].forEach((field, index) => {
    if (!isRecord(field)) {
      throw new Error(`runtime_model.parameter_schema_field_invalid:${index}`);
    }
    const fieldKey = normalizeString(field['field_key'] || field['fieldKey']);
    // 提示词保留键禁止进入参数表单：prompt 是 PromptDock 草稿顶层输入，不是模型参数。
    if (fieldKey === 'prompt' || fieldKey === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) {
      throw new Error(
        `runtime_model.parameter_schema_prompt_field_not_allowed:${fieldKey}`,
      );
    }
    const component = normalizeString(field['component']).toLowerCase();
    if (!component) {
      throw new Error(`runtime_model.parameter_schema_component_missing:${index}`);
    }
    if (!SUPPORTED_FIELD_COMPONENTS.has(component)) {
      throw new Error(`runtime_model.parameter_schema_component_unsupported:${component}`);
    }
    validateImageSizeConstrainedResolutionField(field, index);
    validateFieldDataSource(field, index);
    validateFieldVisibleWhen(field, index);
  });

  for (const reservedKeySource of ['required_fields', 'requiredFields']) {
    const requiredFields = value[reservedKeySource];
    if (!Array.isArray(requiredFields)) continue;
    requiredFields.forEach((key, index) => {
      const normalized = normalizeString(key);
      if (normalized === 'prompt' || normalized === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) {
        throw new Error(
          `runtime_model.parameter_schema_required_prompt_field_not_allowed:${normalized}@${index}`,
        );
      }
    });
  }
};

const validateCapability = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error('runtime_model.capability_missing');
  }

  const constraints = value['constraints'];
  if (constraints === undefined) {
    return;
  }
  if (!Array.isArray(constraints)) {
    throw new Error('runtime_model.capability_constraints_invalid');
  }
  constraints.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`runtime_model.capability_constraints_item_invalid:${index}`);
    }
  });
};

const validateRuntimeMeta = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error('runtime_model.runtime_missing');
  }

  assertLegacyKeyAbsent(
    value,
    'providerId',
    'runtime_model.runtime.provider_id_legacy_key_not_allowed:providerId',
  );
  assertLegacyKeyAbsent(
    value,
    'modelKey',
    'runtime_model.runtime.model_key_legacy_key_not_allowed:modelKey',
  );
  assertLegacyKeyAbsent(
    value,
    'model_key',
    'runtime_model.runtime.model_key_legacy_key_not_allowed:model_key',
  );
  assertLegacyKeyAbsent(
    value,
    'adapterKey',
    'runtime_model.runtime.adapter_key_legacy_key_not_allowed:adapterKey',
  );
  assertLegacyKeyAbsent(
    value,
    'payloadRules',
    'runtime_model.runtime.payload_rules_legacy_key_not_allowed:payloadRules',
  );
  assertLegacyKeyAbsent(
    value,
    'payloadFormat',
    'runtime_model.runtime.payload_format_legacy_key_not_allowed:payloadFormat',
  );
  assertLegacyKeyAbsent(
    value,
    'urlInputUploadMode',
    'runtime_model.runtime.url_input_upload_mode_legacy_key_not_allowed:urlInputUploadMode',
  );
  assertLegacyKeyAbsent(
    value,
    'urlInputUploadTargetType',
    'runtime_model.runtime.url_input_upload_target_type_legacy_key_not_allowed:urlInputUploadTargetType',
  );

  const apiDefaults = value['api_defaults'];
  if (apiDefaults !== undefined) {
    if (!isRecord(apiDefaults)) {
      throw new Error('runtime_model.runtime.api_defaults_invalid');
    }
    ['timeoutMs', 'retries', 'retryDelayMs'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(apiDefaults, key)) {
        throw new Error(`runtime_model.runtime.api_defaults_remote_request_governance_forbidden:${key}`);
      }
    });
  }

  const providerId = normalizeString(value['provider_id']);
  if (!providerId) {
    throw new Error('runtime_model.runtime.provider_id_missing');
  }
  if (!isModelAssetProviderId(providerId)) {
    throw new Error(`runtime_model.runtime.provider_id_invalid:${providerId}`);
  }

  const payloadFormat = normalizeString(value['payload_format']);
  if (payloadFormat && !SUPPORTED_PAYLOAD_FORMATS.has(payloadFormat.toLowerCase())) {
    throw new Error(`runtime_model.runtime.payload_format_unknown:${payloadFormat}`);
  }

  // payload_format_rule: 运行时条件求值的 payload_format（与 payload_format 互斥）。
  // 用于单节点承载多种远端接口语义的场景（如文生图 + 图生图合并节点）。
  const payloadFormatRule = value['payload_format_rule'];
  if (payloadFormatRule !== undefined) {
    if (payloadFormat) {
      throw new Error('runtime_model.runtime.payload_format_and_rule_mutually_exclusive');
    }
    validateValueRule(payloadFormatRule);
  }

  if (value['url_input_upload_mode'] !== undefined) {
    normalizeUrlInputUploadMode(
      value['url_input_upload_mode'],
      `runtime_model.runtime.url_input_upload_mode_invalid:${String(value['url_input_upload_mode'])}`,
    );
  }
  if (value['url_input_upload_target_type'] !== undefined) {
    normalizeUrlInputUploadTargetType(
      value['url_input_upload_target_type'],
      `runtime_model.runtime.url_input_upload_target_type_invalid:${String(
        value['url_input_upload_target_type'],
      )}`,
    );
  }
  if (
    normalizeUrlInputUploadMode(value['url_input_upload_mode'], 'runtime_model.runtime.url_input_upload_mode_invalid') ===
      MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY &&
    !normalizeUrlInputUploadTargetType(
      value['url_input_upload_target_type'],
      'runtime_model.runtime.url_input_upload_target_type_invalid',
    )
  ) {
    throw new Error('runtime_model.runtime.url_input_upload_target_type_missing');
  }

  if (value['adapter_key'] !== undefined) {
    throw new Error('runtime_model.runtime.adapter_key_legacy_not_allowed');
  }
  const executionDriver = normalizeString(value['execution_driver']);
  if (!executionDriver) {
    throw new Error('runtime_model.runtime.execution_driver_missing');
  }
  if (!isModelAssetExecutionDriver(executionDriver)) {
    throw new Error(`runtime_model.runtime.execution_driver_unknown:${executionDriver}`);
  }

  /* 对话模型（chat_streaming）已不再是能力包可声明的执行驱动：这一族只由用户自建声明承载，
     因此这里不再有对话专属的校验分支（原 chat-streaming-validator.ts）。 */

  const capabilities = value['capabilities'];
  if (capabilities !== undefined) {
    if (!isRecord(capabilities)) {
      throw new Error('runtime_model.runtime.capabilities_invalid');
    }
    if (capabilities['url_input_upload_mode'] !== undefined) {
      throw new Error('runtime_model.runtime.url_input_upload_mode_wrong_location');
    }
    if (capabilities['url_input_upload_target_type'] !== undefined) {
      throw new Error('runtime_model.runtime.url_input_upload_target_type_wrong_location');
    }
  }

  const payloadRules = value['payload_rules'];
  if (payloadRules !== undefined) {
    if (!isRecord(payloadRules)) {
      throw new Error('runtime_model.runtime.payload_rules_invalid');
    }
    Object['entries'](payloadRules).forEach(([target, rule]) => {
      if (!normalizeString(target)) {
        throw new Error('runtime_model.runtime.payload_rules_target_empty');
      }
      validateValueRule(rule);
    });
    validateMediaTargetRuleSet(payloadRules as Record<string, never>, {
      payloadFormat: payloadFormat || 'json',
      payloadFormatRule: payloadFormatRule !== undefined ? payloadFormatRule : undefined,
      urlInputUploadMode: normalizeString(value['url_input_upload_mode']),
      urlInputUploadTargetType: normalizeString(value['url_input_upload_target_type']),
      preRequests: Array.isArray(value['pre_requests']) ? value['pre_requests'] as unknown[] : undefined,
    });
  }

  if (value['polling'] !== undefined) {
    throw new Error('runtime_model.runtime.polling_not_supported');
  }
  if (value['result_extractor'] !== undefined) {
    throw new Error('runtime_model.runtime.result_extractor_not_supported');
  }

  if (capabilities === undefined) {
    return;
  }

  const taskGroup =
    normalizeString(capabilities['task_group']) || normalizeString(capabilities['taskGroup']);
  if (
    capabilities['task_group'] !== undefined ||
    capabilities['taskGroup'] !== undefined
  ) {
    if (!taskGroup) {
      throw new Error('runtime_model.runtime.capabilities_task_group_invalid');
    }
  }

  const mediaInputMode =
    normalizeString(capabilities['media_input_mode']) || normalizeString(capabilities['mediaInputMode']);
  if (
    capabilities['media_input_mode'] !== undefined ||
    capabilities['mediaInputMode'] !== undefined
  ) {
    if (!mediaInputMode) {
      throw new Error('runtime_model.runtime.capabilities_media_input_mode_invalid');
    }
  }

  const uiGuards = capabilities['ui_guards'] ?? capabilities['uiGuards'];
  if (uiGuards !== undefined) {
    if (!Array.isArray(uiGuards)) {
      throw new Error('runtime_model.runtime.capabilities_ui_guards_invalid');
    }
    uiGuards.forEach((item) => {
      if (!normalizeString(item)) {
        throw new Error('runtime_model.runtime.capabilities_ui_guards_invalid');
      }
    });
  }

  const executionTraits = capabilities['execution_traits'] ?? capabilities['executionTraits'];
  if (executionTraits !== undefined) {
    if (!Array.isArray(executionTraits)) {
      throw new Error('runtime_model.runtime.capabilities_execution_traits_invalid');
    }
    executionTraits.forEach((item) => {
      if (!normalizeString(item)) {
        throw new Error('runtime_model.runtime.capabilities_execution_traits_invalid');
      }
    });
  }
};

const validateSingleModelNodeRule = (
  runtimeModel: Record<string, unknown>,
  nodeDefinition: Record<string, unknown>,
): void => {
  if (normalizeString(nodeDefinition['node_type']).toLowerCase() !== 'model') {
    return;
  }

  const parameterSchema = isRecord(runtimeModel['parameter_schema']) ? runtimeModel['parameter_schema'] : null;
  const fields = Array.isArray(parameterSchema?.['fields']) ? parameterSchema['fields'] : [];
  const hasSelectorField = fields.some((field) => {
    if (!isRecord(field)) return false;
    const fieldKey = normalizeString(field['field_key'] || field['fieldKey']).toLowerCase();
    return MODEL_SELECTOR_FIELD_KEYS.has(fieldKey);
  });

  if (hasSelectorField) {
    throw new Error('runtime_model.parameter_schema_secondary_model_selector_not_allowed');
  }
};

const collectFieldKeysFromPayloadRule = (
  value: unknown,
  fieldKeys: Set<string> = new Set<string>(),
): Set<string> => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectFieldKeysFromPayloadRule(item, fieldKeys));
    return fieldKeys;
  }

  if (!isRecord(value)) {
    return fieldKeys;
  }

  if (normalizeString(value['kind']) === 'field') {
    const fieldKey = normalizeString(value['field_key']);
    if (fieldKey) {
      fieldKeys.add(fieldKey);
    }
  }

  Object.values(value).forEach((item) => collectFieldKeysFromPayloadRule(item, fieldKeys));
  return fieldKeys;
};

/**
 * 提示词映射声明一致性（方案 B）：
 * 1. 若 payload_rules 引用了保留键 `__prompt`，则必须同时声明顶级 `prompt_field.field_key === "__prompt"`
 *    （提示词约束的单一事实源，不再是 parameter_schema 字段）。
 * 2. 声明了 `prompt_field` 但 payload_rules 未引用保留键，按坏包拒绝（声而不引、或引而不声都是裂变）。
 * 3. `prompt_field.required` / `validation_rules` 形态校验由投影层 contracts 承担，这里只校验映射关系。
 */
const validatePromptFieldDeclaration = (runtimeModel: Record<string, unknown>): void => {
  const runtime = isRecord(runtimeModel['runtime']) ? runtimeModel['runtime'] : null;
  const fieldKeys = collectFieldKeysFromPayloadRule(runtime?.['payload_rules']);
  const referencesPrompt = fieldKeys.has(MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY);

  const promptFieldRaw = runtimeModel['prompt_field'];
  const promptField = isRecord(promptFieldRaw) ? promptFieldRaw : null;
  const declaredFieldKey = promptField ? normalizeString(promptField['field_key']) : undefined;

  if (referencesPrompt && declaredFieldKey !== MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) {
    throw new Error(
      `runtime_model.prompt_field_declaration_missing: payload_rules references "__prompt" but prompt_field.field_key is ${declaredFieldKey ?? 'missing'}`,
    );
  }
  if (!referencesPrompt && declaredFieldKey === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) {
    throw new Error(
      'runtime_model.prompt_field_declaration_unused: prompt_field declares "__prompt" but payload_rules never references it',
    );
  }
};

const uniqSortedStrings = (values: string[]): string[] =>
  Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));

const collectRuntimePayloadImageFieldKeys = (
  runtimeModel: Record<string, unknown>,
): string[] => {
  const parameterSchema = isRecord(runtimeModel['parameter_schema'])
    ? runtimeModel['parameter_schema']
    : null;
  const fields = Array.isArray(parameterSchema?.['fields']) ? parameterSchema['fields'] : [];
  const runtime = isRecord(runtimeModel['runtime']) ? runtimeModel['runtime'] : null;
  const referencedFieldKeys = collectFieldKeysFromPayloadRule(runtime?.['payload_rules']);

  return uniqSortedStrings(
    fields
      .filter((field) => isImageParameterField(field))
      .map((field) => normalizeString((field as Record<string, unknown>)['field_key']))
      .filter((fieldKey) => referencedFieldKeys.has(fieldKey)),
  );
};

const collectDeclaredNodeImageFieldKeys = (
  nodeDefinition: Record<string, unknown>,
): string[] => {
  const inputPorts = Array.isArray(nodeDefinition['input_ports']) ? nodeDefinition['input_ports'] : [];
  return uniqSortedStrings(
    inputPorts
      .filter((port) => isRecord(port) && normalizeString(port['data_type']) === 'image')
      .map((port) => normalizeString((port as Record<string, unknown>)['field_key'])),
  );
};

const validateRuntimeImageInputPorts = (
  runtimeModel: Record<string, unknown>,
  nodeDefinition: Record<string, unknown>,
): void => {
  const payloadImageFieldKeys = collectRuntimePayloadImageFieldKeys(runtimeModel);
  if (payloadImageFieldKeys.length === 0) {
    return;
  }

  const declaredImageFieldKeys = collectDeclaredNodeImageFieldKeys(nodeDefinition);
  const missingFieldKeys = payloadImageFieldKeys.filter(
    (fieldKey) => !declaredImageFieldKeys.includes(fieldKey),
  );
  if (missingFieldKeys.length > 0) {
    throw new Error(
      `node_definition.payload_image_field_missing:${missingFieldKeys.join(',')}`,
    );
  }

  const extraFieldKeys = declaredImageFieldKeys.filter(
    (fieldKey) => !payloadImageFieldKeys.includes(fieldKey),
  );
  if (extraFieldKeys.length > 0) {
    throw new Error(
      `node_definition.payload_image_field_extra:${extraFieldKeys.join(',')}`,
    );
  }
};

const collectPublicUrlFieldKeysFromPayloadRule = (
  value: unknown,
  fieldKeys: Set<string> = new Set<string>(),
  insidePublicUrlTarget = false,
): Set<string> => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPublicUrlFieldKeysFromPayloadRule(item, fieldKeys, insidePublicUrlTarget));
    return fieldKeys;
  }

  if (!isRecord(value)) {
    return fieldKeys;
  }

  const isPublicUrlTarget = insidePublicUrlTarget || normalizeString(value['media_target']) === 'public_url';
  if (isPublicUrlTarget && normalizeString(value['kind']) === 'field') {
    const fieldKey = normalizeString(value['field_key']);
    if (fieldKey) fieldKeys.add(fieldKey);
  }

  Object.values(value).forEach((item) => collectPublicUrlFieldKeysFromPayloadRule(item, fieldKeys, isPublicUrlTarget));
  return fieldKeys;
};

const validateSelfHostedPublicUrlFieldsAreImages = (
  runtimeModel: Record<string, unknown>,
): void => {
  const runtime = isRecord(runtimeModel['runtime']) ? runtimeModel['runtime'] : null;
  if (
    normalizeString(runtime?.['url_input_upload_target_type']) !==
    MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL
  ) {
    return;
  }

  const parameterSchema = isRecord(runtimeModel['parameter_schema'])
    ? runtimeModel['parameter_schema']
    : null;
  const fields = Array.isArray(parameterSchema?.['fields']) ? parameterSchema['fields'] : [];
  const fieldByKey = new Map(
    fields
      .filter((field) => isRecord(field))
      .map((field) => [normalizeString(field['field_key']), field as Record<string, unknown>] as const)
      .filter(([fieldKey]) => Boolean(fieldKey)),
  );
  const publicUrlFieldKeys = Array.from(
    collectPublicUrlFieldKeysFromPayloadRule(runtime?.['payload_rules']),
  );
  const invalidFieldKeys = publicUrlFieldKeys.filter((fieldKey) => {
    const field = fieldByKey.get(fieldKey);
    return !field || !isImageParameterField(field);
  });
  if (invalidFieldKeys.length > 0) {
    throw new Error(
      `runtime_model.runtime.public_url_self_hosted_non_image_field:${uniqSortedStrings(invalidFieldKeys).join(',')}`,
    );
  }
};

const validateRuntimeModel = (value: unknown, expectedModelId: string): void => {
  if (!isRecord(value)) {
    throw new Error('runtime_model_invalid');
  }
  assertLegacyKeyAbsent(
    value,
    'modelKey',
    'runtime_model.model_key_legacy_key_not_allowed:modelKey',
  );
  assertLegacyKeyAbsent(
    value,
    'model_key',
    'runtime_model.model_key_legacy_key_not_allowed:model_key',
  );
  const display = isRecord(value['display']) ? value['display'] : null;
  if (display) {
    assertLegacyKeyAbsent(
      display,
      'display_name',
      'runtime_model.display.display_name_legacy_key_not_allowed:display_name',
    );
  }
  const modelId = normalizeString(value['model_id']);
  if (!modelId) {
    throw new Error('runtime_model.model_id_missing');
  }
  if (modelId !== expectedModelId) {
    throw new Error('entry_model_model_id_mismatch');
  }
  validateCapability(value['capability']);
  if (value['role'] !== undefined) {
    const role = normalizeString(value['role']).toLowerCase();
    if (role !== 'generator' && role !== 'processor') {
      throw new Error(`runtime_model.role_invalid:${String(value['role'])}`);
    }
  }
  validateVariantDisplayFields(display);
  validateParameterSchema(value['parameter_schema']);
  validateRuntimeMeta(value['runtime']);
  validateSelfHostedPublicUrlFieldsAreImages(value);
  validatePromptFieldDeclaration(value);

  validateModes(value);
  validateFormalTaskExecutionPlan(value);
};

const validateNodeDefinition = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error('node_definition_invalid');
  }
  assertLegacyKeyAbsent(
    value,
    'display_name',
    'node_definition.display_name_legacy_key_not_allowed:display_name',
  );
  const nodeType = normalizeString(value['node_type']);
  if (!nodeType) {
    throw new Error('node_definition.node_type_missing');
  }
};

export const validateSourcePackage = async (sourceDir: string): Promise<ValidatedPackage> => {
  const packageIdByDir = path.basename(sourceDir);
  const manifestPath = path.join(sourceDir, 'manifest.json');
  await ensureFileExists(manifestPath, 'manifest_missing');

  const manifestRaw = await readJson(manifestPath);
  if (!isRecord(manifestRaw)) {
    throw new Error('manifest_invalid');
  }

  const manifest = manifestRaw as SourceManifest;
  assertLegacyKeyAbsent(
    manifest as Record<string, unknown>,
    'display_name',
    'manifest.display_name_legacy_key_not_allowed:display_name',
  );
  const packageId = normalizeString(manifest.package_id);
  if (!packageId) {
    throw new Error('manifest.package_id_missing');
  }
  if (packageId !== packageIdByDir) {
    throw new Error('manifest.package_id_mismatch');
  }

  if (!isRecord(manifest.entry_model)) {
    throw new Error('manifest.entry_model_missing');
  }
  if (!isRecord(manifest.node_definition)) {
    throw new Error('manifest.node_definition_missing');
  }

  const modelId = normalizeString(manifest.entry_model['model_id']);
  if (!modelId) {
    throw new Error('manifest.entry_model_model_id_missing');
  }

  const entryModelPath = ensureRelativeChildPath(
    sourceDir,
    normalizeString(manifest.entry_model['relative_path']),
  );
  const nodeDefinitionPath = ensureRelativeChildPath(
    sourceDir,
    normalizeString(manifest.node_definition['relative_path']),
  );

  await ensureFileExists(entryModelPath, 'entry_model_file_missing');
  await ensureFileExists(nodeDefinitionPath, 'node_definition_file_missing');

  const runtimeModel = await readJson(entryModelPath);
  validateRuntimeModel(runtimeModel, modelId);

  const nodeDefinition = await readJson(nodeDefinitionPath);
  validateNodeDefinition(nodeDefinition);
  validateSingleModelNodeRule(runtimeModel as Record<string, unknown>, nodeDefinition as Record<string, unknown>);
  validateRuntimeImageInputPorts(
    runtimeModel as Record<string, unknown>,
    nodeDefinition as Record<string, unknown>,
  );
  const localizationResult = await validateModelAssetLocalization({
    packageId,
    sourceDir,
    manifest,
    runtimeModel: runtimeModel as Record<string, unknown>,
    nodeDefinition: nodeDefinition as Record<string, unknown>,
  });
  if (localizationResult.errors.length > 0) {
    throw new Error(localizationResult.errors.join('|'));
  }

  if (!Array.isArray(manifest.resources)) {
    throw new Error('manifest.resources_missing');
  }

  const resourcePaths: string[] = [];
  for (const resource of manifest.resources) {
    if (!isRecord(resource)) {
      throw new Error('manifest.resource_invalid');
    }
    const resourcePath = ensureRelativeChildPath(sourceDir, normalizeString(resource['relative_path']));
    await ensureFileExists(resourcePath, 'manifest.resource_missing');
    resourcePaths.push(resourcePath);
  }

  const variantMeta = extractVariantMeta(runtimeModel);

  return {
    packageId,
    sourceDir,
    manifestPath,
    manifest,
    modelId,
    entryModelPath,
    nodeDefinitionPath,
    resourcePaths,
    localePaths: localizationResult.localePaths,
    variantMeta,
  };
};