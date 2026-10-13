import type { ResultAreaSlot, ResultAreaSlotOrigin } from "../types/node";
import { pickMatchKey } from "./runtimeRef";

type ResultAreaSlotOriginInput = {
  sourceNodeId: string | null | undefined | undefined;
  executionId: string | null | undefined | undefined;
  batchId: string | null | undefined | undefined;
  taskId: string | null | undefined | undefined;
};

const readOriginString = (value: unknown): string | undefined => {
  const normalized = pickMatchKey(value);
  return normalized ?? undefined;
};

export const normalizeResultAreaSlotOrigin = (
  origin: ResultAreaSlotOriginInput | null | undefined,
): ResultAreaSlotOrigin | undefined => {
  if (!origin || typeof origin !== "object") return undefined;
  const next: ResultAreaSlotOrigin = {
    sourceNodeId: readOriginString(origin.sourceNodeId),
    executionId: readOriginString(origin.executionId),
    batchId: readOriginString(origin.batchId),
    taskId: readOriginString(origin.taskId),
  };
  if (!next.sourceNodeId && !next.executionId && !next.batchId && !next.taskId) {
    return undefined;
  }
  return next;
};

export const mergeResultAreaSlotOrigin = (
  existing: ResultAreaSlotOriginInput | null | undefined,
  patch: ResultAreaSlotOriginInput,
): ResultAreaSlotOrigin | undefined =>
  normalizeResultAreaSlotOrigin({
    sourceNodeId: readOriginString(patch.sourceNodeId) ?? (existing !== null && existing !== undefined ? existing.sourceNodeId : undefined),
    executionId: readOriginString(patch.executionId) ?? (existing !== null && existing !== undefined ? existing.executionId : undefined),
    batchId: readOriginString(patch.batchId) ?? (existing !== null && existing !== undefined ? existing.batchId : undefined),
    taskId: readOriginString(patch.taskId) ?? (existing !== null && existing !== undefined ? existing.taskId : undefined),
  });

export const readResultAreaSlotOriginBatchId = (
  slot: ResultAreaSlot,
): string | null => pickMatchKey((slot.origin !== null && slot.origin !== undefined ? slot.origin.batchId : undefined));

export const readResultAreaSlotOriginTaskId = (
  slot: ResultAreaSlot,
): string | null => pickMatchKey((slot.origin !== null && slot.origin !== undefined ? slot.origin.taskId : undefined));
