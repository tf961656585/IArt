import { isRecord, normalizeString } from './shared';

export const validateFormalTaskExecutionPlan = (
  runtimeModel: Record<string, unknown>,
): void => {
  const resultRule = isRecord(runtimeModel['result_rule']) ? runtimeModel['result_rule'] : null;
  const requestStrategy = isRecord(runtimeModel['request_strategy']) ? runtimeModel['request_strategy'] : null;
  const hasPollingStrategy = isRecord(runtimeModel['polling_strategy']);
  const resultOutputMapping = isRecord(runtimeModel['result_output_mapping'])
    ? runtimeModel['result_output_mapping']
    : null;
  const hasResultAcquisitionStrategy =
    runtimeModel['result_acquisition_strategy'] !== undefined &&
    runtimeModel['result_acquisition_strategy'] !== null;
  const capability = isRecord(runtimeModel['capability']) ? runtimeModel['capability'] : null;
  const executionProfile = isRecord(runtimeModel['execution_profile'])
    ? runtimeModel['execution_profile']
    : null;
  const outputModalities = Array.isArray(capability?.['output_modalities'])
    ? capability['output_modalities'].map((item) => normalizeString(item)).filter(Boolean)
    : [];

  if (!resultRule) throw new Error('runtime_model.result_rule_missing');
  if (!requestStrategy) {
    throw new Error('runtime_model.task_execution_plan_request_strategy_missing');
  }
  if (Object.prototype.hasOwnProperty.call(requestStrategy, 'async_mode')) {
    throw new Error('runtime_model.request_strategy_async_mode_not_allowed');
  }

  const mode = normalizeString(resultRule['mode']).toLowerCase();
  if (mode !== 'sync' && mode !== 'async') {
    throw new Error(`runtime_model.result_rule_mode_invalid:${String(resultRule['mode'])}`);
  }
  const modeIsAsync = mode === 'async';
  if (capability && (capability['supports_async_task'] === true) !== modeIsAsync) {
    throw new Error('runtime_model.capability_supports_async_task_mode_mismatch');
  }
  if (executionProfile && (executionProfile['supports_async_task'] === true) !== modeIsAsync) {
    throw new Error('runtime_model.execution_profile_supports_async_task_mode_mismatch');
  }

  validateModeTopology(mode, hasPollingStrategy, hasResultAcquisitionStrategy);
  validateResultOutputMapping(outputModalities, resultOutputMapping);
  if (modeIsAsync && hasResultAcquisitionStrategy) {
    validateResultAcquisitionStrategy(runtimeModel['result_acquisition_strategy']);
  }
};

const validateModeTopology = (
  mode: string,
  hasPollingStrategy: boolean,
  hasResultAcquisitionStrategy: boolean,
) => {
  if (mode === 'sync') {
    if (hasPollingStrategy) throw new Error('runtime_model.sync_mode_polling_strategy_not_allowed');
    if (hasResultAcquisitionStrategy) {
      throw new Error('runtime_model.sync_mode_result_acquisition_strategy_not_allowed');
    }
    return;
  }
  if (!hasPollingStrategy) throw new Error('runtime_model.async_mode_polling_strategy_missing');
};

const validateResultOutputMapping = (
  outputModalities: string[],
  resultOutputMapping: Record<string, unknown> | null,
) => {
  if (outputModalities.length > 0 && !resultOutputMapping) {
    throw new Error('runtime_model.result_output_mapping_missing');
  }
  if (!resultOutputMapping) return;
  const responseMode = normalizeString(resultOutputMapping['response_mode']).toLowerCase();
  if (responseMode !== 'structured_payload' && responseMode !== 'binary_media') {
    throw new Error(`runtime_model.result_output_mapping_response_mode_invalid:${String(resultOutputMapping['response_mode'])}`);
  }
  const rules = resultOutputMapping['output_mapping_rules'];
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('runtime_model.result_output_mapping_rules_missing');
  }
  rules.forEach((rule, index) => {
    if (!isRecord(rule)) throw new Error(`runtime_model.result_output_mapping_rule_invalid:${index}`);
    if (!normalizeString(rule['target'])) {
      throw new Error(`runtime_model.result_output_mapping_rule_target_missing:${index}`);
    }
    const source = isRecord(rule['source']) ? rule['source'] : null;
    if (!source) throw new Error(`runtime_model.result_output_mapping_rule_source_missing:${index}`);
    if (normalizeString(source['kind']) !== 'response') {
      throw new Error(`runtime_model.result_output_mapping_rule_source_kind_invalid:${index}`);
    }
    if (!normalizeString(source['path'])) {
      throw new Error(`runtime_model.result_output_mapping_rule_source_path_missing:${index}`);
    }
  });
};

const validateResultAcquisitionStrategy = (value: unknown): void => {
  if (!isRecord(value)) throw new Error('runtime_model.result_acquisition_strategy_invalid');
  const acquisitionMode = normalizeString(value['acquisition_mode']);
  if (acquisitionMode !== 'fetch_final_result') {
    throw new Error(`runtime_model.result_acquisition_strategy_mode_invalid:${acquisitionMode || '(empty)'}`);
  }
  if (!isRecord(value['request_strategy'])) {
    throw new Error('runtime_model.result_acquisition_strategy_request_strategy_missing');
  }
  if (value['output_mapping_rules'] !== undefined) {
    throw new Error('runtime_model.result_acquisition_strategy_output_mapping_rules_not_allowed');
  }
  if (value['download_required_condition'] !== undefined) {
    throw new Error('runtime_model.result_acquisition_strategy_download_condition_not_allowed');
  }
  if (value['response_mode'] !== undefined) {
    throw new Error('runtime_model.result_acquisition_strategy_response_mode_not_allowed');
  }
};
