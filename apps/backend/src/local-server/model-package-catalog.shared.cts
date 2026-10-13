import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CatalogRawObject,
  JsonValue,
} from "./model-package-catalog.types.cts";

export const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export const safeReadJsonFile = (filePath: string): unknown => {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as unknown;
};

export const ensureExistingFile = (filePath: string, errorCode: string) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(errorCode);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(errorCode);
  }
};

export const ensureRelativeChildPath = (
  rootDir: string,
  relativePath: unknown,
) => {
  const normalized = normalizeString(relativePath).replace(/\\/g, "/");
  if (!normalized) {
    throw new Error("relative_path_required");
  }
  if (path.isAbsolute(normalized)) {
    throw new Error("absolute_path_not_allowed");
  }
  const resolved = path.resolve(rootDir, normalized);
  const normalizedRoot = path.resolve(rootDir);
  if (
    resolved !== normalizedRoot &&
    !resolved.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error("path_traversal_not_allowed");
  }
  return resolved;
};

export const uniq = <T,>(items: T[]) => {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

export const isObjectRecord = (value: unknown): value is CatalogRawObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isJsonValue = (value: unknown): value is JsonValue | undefined =>
  value !== undefined;

export const setJsonValue = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: JsonValue | undefined,
) => {
  if (isJsonValue(value)) {
    target[key] = value as T[K];
  }
};

export const requireObjectRecord = (
  value: unknown,
  errorCode: string,
): CatalogRawObject => {
  if (!isObjectRecord(value)) {
    throw new Error(errorCode);
  }
  return value;
};

export const notNullish = <T,>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

export const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => normalizeString(item))
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
};

export const normalizeFiniteNumber = (value: unknown) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  return numberValue;
};

export const normalizePositiveInteger = (value: unknown) => {
  const numberValue = normalizeFiniteNumber(value);
  if (
    numberValue === null ||
    numberValue <= 0 ||
    !Number.isInteger(numberValue)
  ) {
    return null;
  }
  return numberValue;
};
