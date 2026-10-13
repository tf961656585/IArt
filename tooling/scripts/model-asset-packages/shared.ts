import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MODEL_ASSET_URL_INPUT_UPLOAD_MODE,
  MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE,
  MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS,
} from '@iart/contracts/model-asset-contract';
import {
  isRecord,
  normalizeString,
} from '@iart/model-asset-runtime';
export {
  MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORM_LIST as SUPPORTED_RUNTIME_VALUE_TRANSFORM_LIST,
  MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS as SUPPORTED_RUNTIME_VALUE_TRANSFORMS,
  assertLegacyKeyAbsent,
  hasOwn,
  isModelAssetExecutionDriver,
  isModelAssetProviderId,
  isRecord,
  normalizeString,
  validateTrimmedStringArray,
  type ModelAssetRuntimeValueTransform as SupportedRuntimeValueTransform,
} from '@iart/model-asset-runtime';

export const MODEL_SELECTOR_FIELD_KEYS = new Set(['model', 'modelid', 'model_id']);

export const SUPPORTED_FIELD_COMPONENTS = new Set(
  MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS.map((item) => item.toLowerCase()),
);

export const SUPPORTED_PAYLOAD_FORMATS = new Set(['json', 'multipart', 'stream']);
export const SUPPORTED_URL_INPUT_UPLOAD_MODES = new Set(
  Object.values(MODEL_ASSET_URL_INPUT_UPLOAD_MODE),
);
export const SUPPORTED_URL_INPUT_UPLOAD_TARGET_TYPES = new Set(
  Object.values(MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE),
);

export const isImageParameterField = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) {
    return false;
  }
  const component = normalizeString(value['component']);
  if (component === 'imageUpload') {
    return true;
  }
  if (component !== 'file') {
    return false;
  }
  return normalizeString((value['component_props'] as Record<string, unknown> | undefined)?.['accept'])
    .toLowerCase()
    .includes('image/');
};

export const normalizeUrlInputUploadMode = (
  value: unknown,
  errorCode: string,
): (typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE)[keyof typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE] | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (!SUPPORTED_URL_INPUT_UPLOAD_MODES.has(normalized as (typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE)[keyof typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE])) {
    throw new Error(errorCode);
  }
  return normalized as (typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE)[keyof typeof MODEL_ASSET_URL_INPUT_UPLOAD_MODE];
};

export const normalizeUrlInputUploadTargetType = (
  value: unknown,
  errorCode: string,
):
  | (typeof MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE)[keyof typeof MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE]
  | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (
    !SUPPORTED_URL_INPUT_UPLOAD_TARGET_TYPES.has(
      normalized as (typeof MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE)[keyof typeof MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE],
    )
  ) {
    throw new Error(errorCode);
  }
  return normalized as (typeof MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE)[keyof typeof MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE];
};

export const ensureRelativeChildPath = (rootDir: string, relativePath: string): string => {
  const normalized = normalizeString(relativePath).replace(/\\/g, '/');
  if (!normalized) {
    throw new Error('relative_path_required');
  }
  if (path.isAbsolute(normalized)) {
    throw new Error('absolute_path_not_allowed');
  }
  const resolved = path.resolve(rootDir, normalized);
  const normalizedRoot = path.resolve(rootDir);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('path_traversal_not_allowed');
  }
  return resolved;
};

export const readJson = async (filePath: string): Promise<unknown> => {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
};

export const ensureFileExists = async (filePath: string, errorCode: string): Promise<void> => {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new Error(errorCode);
  }
  if (!stat.isFile()) {
    throw new Error(errorCode);
  }
};
