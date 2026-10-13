import {
  findModelConfig,
  listRuntimeProjectedModelConfigs,
  type ModelConfigEntry,
} from './models.config';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts';

const GENERIC_RUNTIME_I2I_PROMPT_FIELD_KEY = MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY;

const hasPortOfType = (
  ports: Array<{ dataType: string | undefined }> | undefined,
  dataType: string,
): boolean =>
  Array.isArray(ports) &&
  ports.some((port) => typeof (port !== null && port !== undefined ? port.dataType : undefined) === 'string' && port.dataType === dataType);

const matchesGenericRuntimeI2iInputContract = (
  config: ModelConfigEntry | null | undefined,
): boolean => {
  const imageInputFieldKey = resolveGenericRuntimeI2iImageInputFieldKey(config);
  if (!imageInputFieldKey) return false;

  const contract = (config !== null && config !== undefined ? config.assetInputContract : undefined);
  if (!contract) return false;

  if (contract.promptFieldKey && contract.promptFieldKey !== GENERIC_RUNTIME_I2I_PROMPT_FIELD_KEY) {
    return false;
  }

  const requiredFieldKeys = Array.isArray(contract.requiredFieldKeys)
    ? contract.requiredFieldKeys.filter((fieldKey) => typeof fieldKey === 'string' && fieldKey.length > 0)
    : [];
  const allowedRequiredFields = new Set([
    GENERIC_RUNTIME_I2I_PROMPT_FIELD_KEY,
    imageInputFieldKey,
  ]);
  return requiredFieldKeys.every((fieldKey) => allowedRequiredFields.has(fieldKey));
};

export const resolveGenericRuntimeI2iImageInputFieldKey = (
  config: ModelConfigEntry | null | undefined,
): string | null => {
  const contract = (config !== null && config !== undefined ? config.assetInputContract : undefined);
  if (!contract) return null;
  const imageInputFieldKeys = Array.isArray(contract.imageInputFieldKeys)
    ? contract.imageInputFieldKeys.filter((fieldKey) => typeof fieldKey === 'string' && fieldKey.length > 0)
    : [];
  return imageInputFieldKeys.length === 1 ? imageInputFieldKeys[0] ?? null : null;
};

export const isRuntimeProjectedImageToImageModel = (
  config: ModelConfigEntry | null | undefined,
): config is ModelConfigEntry => {
  if (!config) return false;
  if (config.visible === false) return false;
  if (config.role === 'processor') return false;
  if ((config.assetCapabilities !== null && config.assetCapabilities !== undefined ? config.assetCapabilities.mediaInputMode : undefined) === 'url_only') return false;
  if (!matchesGenericRuntimeI2iInputContract(config)) return false;
  return (
    hasPortOfType((config.nodeGraphPorts !== null && config.nodeGraphPorts !== undefined ? config.nodeGraphPorts.inputs : undefined), 'image') &&
    hasPortOfType((config.nodeGraphPorts !== null && config.nodeGraphPorts !== undefined ? config.nodeGraphPorts.outputs : undefined), 'image')
  );
};

export const listRuntimeProjectedImageToImageModels = (): ModelConfigEntry[] =>
  listRuntimeProjectedModelConfigs().filter((config) => isRuntimeProjectedImageToImageModel(config));

export const resolveRuntimeProjectedImageToImageModel = (
  modelId: string | null | undefined,
): ModelConfigEntry | null => {
  const config = findModelConfig(modelId);
  return isRuntimeProjectedImageToImageModel(config) ? config : null;
};

/* 对话模型的筛选口径曾在这里：按 `chat_streaming` 特征值从已装能力包投影里筛。
   对话模型已收敛为「只由用户自建声明」，能力包投影里不再有对话模型，该口径整体作废——
   对话模型的候选与判定统一取对话模型目录（`/api/chat-model-catalog`），见
   `features/canvas/services/textInputAiEditModelOptions.ts` 与 PromptDock 的服务行。 */
