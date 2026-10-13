import {
  findRuntimeProjectedModelConfigForCapability,
  type ModelConfigEntry,
} from './models.config';
import {
  hasModelCapability,
  type ModelCapabilityKey,
} from '@/features/models/modelDefinition';

const toStringSet = (value: unknown): Set<string> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0),
  );
};

const hasAssetCapability = (config: ModelConfigEntry | null | undefined, key: ModelCapabilityKey): boolean => {
  const assetCapabilities = config !== null && config !== undefined ? config.assetCapabilities : undefined;
  if (assetCapabilities === undefined) return false;
  const uiGuards = toStringSet(assetCapabilities.uiGuards);
  const executionTraits = toStringSet(assetCapabilities.executionTraits);
  return uiGuards.has(key) || executionTraits.has(key);
};

export const hasModelCapabilityFlag = (
  config: ModelConfigEntry | null | undefined,
  key: ModelCapabilityKey,
  modelId: string | null | undefined,
): boolean => {
  const target =
    config ??
    findRuntimeProjectedModelConfigForCapability(modelId);
  if (target && (hasModelCapability(target, key) || hasAssetCapability(target, key))) {
    return true;
  }
  return false;
};
