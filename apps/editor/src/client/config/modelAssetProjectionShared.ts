import { type SchemaBuiltinTransform, type SchemaCondition, type SchemaValueTransform } from '@/features/workspace/schema/types';
import type { UnknownRecord } from '@/client/utils/typeGuards';
import type {
  ModelAssetNodeProjectionRuntimeCondition,
} from '@iart/contracts/model-asset-contract';
import { normalizeString as normalizeStringShared } from '@iart/contracts';

const ALL_BUILTIN_TRANSFORMS: readonly SchemaBuiltinTransform[] = [
  'trim',
  'toLowerCase',
  'toUpperCase',
  'toNumber',
  'ensureArray',
  'first',
  'splitLines',
  'compactArray',
  'last',
  'shotListToTimeline',
  'timelineToScript',
];

const KNOWN_TRANSFORMS = new Set<SchemaBuiltinTransform>(ALL_BUILTIN_TRANSFORMS);

export type RuntimeUploadOptionsRaw = {
  url_input_upload_mode: unknown | undefined;
  url_input_upload_target_type: unknown | undefined;
};

export type RuntimeProjectionContext = UnknownRecord & RuntimeUploadOptionsRaw;

export const normalizeString = normalizeStringShared;

export const isObjectRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isEmptyRuntimeValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.every((item) => isEmptyRuntimeValue(item));
  if (isObjectRecord(value)) return Object.values(value).every((item) => isEmptyRuntimeValue(item));
  return false;
};

export const compactRuntimeArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => !isEmptyRuntimeValue(item));
};

export const compactRuntimeObject = (value: unknown): UnknownRecord => {
  if (!isObjectRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => !isEmptyRuntimeValue(item)),
  );
};

export const toNumberOrUndefined = (value: unknown): number | undefined =>
  Number.isFinite(Number(value)) ? Number(value) : undefined;

export const toBooleanOrUndefined = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

export const normalizeRoundMode = (value: unknown): 'none' | 'round' | 'floor' | 'ceil' => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'floor' || normalized === 'ceil' || normalized === 'none') return normalized;
  return 'round';
};

export const applyRoundMode = (value: number, mode: 'none' | 'round' | 'floor' | 'ceil'): number => {
  if (mode === 'none') return value;
  if (mode === 'floor') return Math.floor(value);
  if (mode === 'ceil') return Math.ceil(value);
  return Math.round(value);
};

export const normalizeTransforms = (value: unknown): SchemaValueTransform<string>[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const transforms = value
    .map((item) => normalizeString(item))
    .filter((item): item is SchemaBuiltinTransform =>
      KNOWN_TRANSFORMS.has(item as SchemaBuiltinTransform),
    );
  return transforms.length > 0 ? transforms : undefined;
};

export const normalizeRuntimeCondition = (
  condition: ModelAssetNodeProjectionRuntimeCondition,
): SchemaCondition<string> | null => {
  const op = normalizeString(condition.op).toLowerCase();

  if (op === 'and' || op === 'or') {
    const candidate = condition as { conditions: ModelAssetNodeProjectionRuntimeCondition[] | undefined };
    const childConditions = Array.isArray(candidate.conditions)
      ? candidate.conditions
          .map((child) => normalizeRuntimeCondition(child))
          .filter((child): child is SchemaCondition<string> => Boolean(child))
      : [];
    if (childConditions.length === 0) return null;
    return { op, conditions: childConditions };
  }

  if (op === 'not') {
    const nested = normalizeRuntimeCondition(
      (condition as { condition: ModelAssetNodeProjectionRuntimeCondition }).condition,
    );
    return nested ? { op: 'not', condition: nested } : null;
  }

  if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'includes', 'excludes'].includes(op)) {
    const field = normalizeString((condition as { field: string | undefined }).field);
    if (!field) return null;
    return {
      op: op as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'includes' | 'excludes',
      field,
      value: (condition as { value: unknown | undefined }).value,
    };
  }

  if (op === 'truthy' || op === 'falsy') {
    const field = normalizeString((condition as { field: string | undefined }).field);
    return field ? { op, field } : null;
  }

  return null;
};
