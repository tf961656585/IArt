import type { ModelConfigEntry } from './models.config';
import {
  findModelConfig,
  findVariantGroupOwner,
  resolveCanvasModelConfig,
} from './models.config';

const normalizeId = (value: string | null | undefined): string => {
  return value !== null && value !== undefined ? value.trim() : '';
};

export const resolveCanvasModelConfigByNodeData = (params: {
  shellModelId: string | null | undefined;
  modelId: string | null | undefined;
}): ModelConfigEntry | undefined =>
  resolveCanvasModelConfig({
    shellModelId: params.shellModelId,
    modelId: params.modelId,
  });

export const resolveModelDisplayConfig = (params: {
  shellModelId: string | null | undefined;
  modelId: string | null | undefined;
}): ModelConfigEntry | undefined => {
  const shellModelId = normalizeId(params.shellModelId);
  if (shellModelId) {
    const shellConfig = findModelConfig(shellModelId);
    if (shellConfig !== undefined) {
      return shellConfig;
    }
  }

  const modelId = normalizeId(params.modelId);
  if (!modelId) return undefined;
  return findVariantGroupOwner(modelId) ?? findModelConfig(modelId);
};

export const resolveModelDisplayLabel = (params: {
  shellModelId: string | null | undefined;
  modelId: string | null | undefined;
  fallbackLabel: string | null | undefined;
}): string => {
  const displayConfig = resolveModelDisplayConfig(params);
  if (displayConfig !== undefined) {
    return displayConfig.label;
  }

  const fallbackLabel = normalizeId(params.fallbackLabel);
  if (fallbackLabel) return fallbackLabel;

  const modelId = normalizeId(params.modelId);
  if (modelId) return modelId;

  const shellModelId = normalizeId(params.shellModelId);
  if (shellModelId) return shellModelId;

  return 'Model';
};
