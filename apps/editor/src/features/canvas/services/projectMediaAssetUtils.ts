import type { ProjectMediaType } from "@iart/contracts";

import { isUnknownRecord, type UnknownRecord } from "@/client/utils/typeGuards";

export const normalizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const normalizeFiniteNumber = (value: unknown): number | null =>
  Number.isFinite(value) ? Number(value) : null;

export const normalizeAspectRatio = (value: unknown): number | null => {
  const normalized = normalizeFiniteNumber(value);
  if (!normalized || normalized <= 0) return null;
  return normalized;
};

export const normalizeMediaType = (value: unknown): ProjectMediaType | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (
    normalized === "image" ||
    normalized === "video" ||
    normalized === "audio"
  ) {
    return normalized;
  }
  return null;
};

export const asUnknownRecord = (value: unknown): UnknownRecord | null =>
  isUnknownRecord(value) ? value : null;

export const requireUnknownRecord = (
  value: unknown,
  reason: string | undefined,
): UnknownRecord => {
  if (isUnknownRecord(value)) {
    return value;
  }
  throw new Error(reason ?? "invalid-media-asset-record");
};

export const throwInvalidMediaAssetError = (
  reason = "invalid-media-asset-record",
): never => {
  throw new Error(reason);
};
