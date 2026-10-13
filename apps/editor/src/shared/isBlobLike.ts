/**
 * Check whether a value is Blob-like (has an arrayBuffer method).
 *
 * Shared utility for Editor-side code only.
 */
export const isBlobLike = (value: unknown): value is Blob => {
  return !!value && typeof (value as Blob).arrayBuffer === 'function';
};
