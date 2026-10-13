import type { RuntimeRef } from '@iart/contracts';

export const pickMatchKey = (value: unknown | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const normalizeRuntimeRef = (value: unknown): RuntimeRef | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as RuntimeRef;
  const taskId = pickMatchKey(record.taskId);
  const resultId = pickMatchKey(record.resultId);
  const assetId = pickMatchKey(record.assetId);
  if (!taskId && !resultId && !assetId) return null;
  return { taskId: taskId ?? null, resultId: resultId ?? null, assetId: assetId ?? null };
};
