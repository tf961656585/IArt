export { cn } from "@iart/ui"

/**
 * Safe type cast for cross-boundary type conversion.
 * Prefer proper type narrowing or shared types; use only when
 * the type mismatch is intentional (e.g., mock objects, test fixtures).
 */
export function cast<T>(value: unknown): T {
  return value as T;
}
