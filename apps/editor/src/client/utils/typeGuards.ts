
export type UnknownRecord = Record<string, unknown>;
export type DynamicRecord<Value = unknown, Key extends string = string> = Record<Key, Value>;

export const isUnknownRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const isRecord = isUnknownRecord;

export const toStringSafe = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toString() : undefined;
  return undefined;
};
