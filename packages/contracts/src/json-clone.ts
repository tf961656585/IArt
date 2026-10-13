export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };
type JsonCloneValue = JsonValue | undefined;
type JsonCloneObjectMap = { [key: string]: JsonCloneValue };

const cloneJsonUnknown = (value: unknown, seen: WeakSet<object>, inArray: boolean): JsonCloneValue => {
  if (value === null || value === undefined) return inArray ? null : value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('BigInt is not JSON-compatible');
  if (typeof value === 'function' || typeof value === 'symbol') return inArray ? null : undefined;
  if (value instanceof Date) return value.toJSON();
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) throw new TypeError('Cannot clone circular JSON value');
  seen.add(value);
  if (Array.isArray(value)) {
    const cloned = value.map((item): JsonValue => cloneJsonUnknown(item, seen, true) ?? null);
    seen.delete(value);
    return cloned;
  }
  const cloned: JsonCloneObjectMap = {};
  for (const [key, child] of Object.entries(value)) {
    const next = cloneJsonUnknown(child, seen, false);
    if (next !== undefined) cloned[key] = next;
  }
  seen.delete(value);
  return cloned;
};

export const cloneJsonValue = <T,>(value: T): T =>
  cloneJsonUnknown(value, new WeakSet<object>(), false) as T;
