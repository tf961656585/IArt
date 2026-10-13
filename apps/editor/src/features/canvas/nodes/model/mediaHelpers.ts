import { normalizeMediaInput } from '@/features/canvas/services/mediaDataContract';
import type { UploadFileItem } from '@/features/canvas/services/mediaDataContract';

export type { UploadFileItem } from '@/features/canvas/services/mediaDataContract';

const isRuntimeBlobLike = (value: unknown): value is Blob | File =>
  typeof Blob !== 'undefined' && value instanceof Blob;

/**
 * 将任意媒体输入规范化为 UploadFileItem 格式
 * 内部调用 mediaDataContract.normalizeMediaInput，保持向后兼容
 */
export const normalizeUploadItems = (value: unknown, maxFiles: number | undefined): UploadFileItem[] => {
  const results: UploadFileItem[] = [];

  const pushResult = (item: UploadFileItem): void => {
    if (typeof maxFiles === 'number' && results.length >= maxFiles) return;
    results.push(item);
  };

  const normalizeUploadLikeItem = (item: UploadFileItem): void => {
    const normalizedSrc = typeof item.src === 'string' ? item.src.trim() : '';
    const normalizedFile = isRuntimeBlobLike(item.file) ? (item.file as File) : undefined;
    const keepDistortedFile = item.file != null && !normalizedFile && !normalizedSrc;

    if (!normalizedFile && !normalizedSrc && !keepDistortedFile) {
      return;
    }

    const normalizedId = typeof item.id === 'string' && item.id ? item.id : undefined;
    pushResult({
      id: normalizedId,
      file: normalizedFile ?? (keepDistortedFile ? item.file : undefined),
      src: normalizedSrc || undefined,
    });
  };

  const process = (input: unknown): void => {
    if (typeof maxFiles === 'number' && results.length >= maxFiles) return;

    if (Array.isArray(input)) {
      for (const subItem of input) {
        process(subItem);
      }
      return;
    }

    if (input && typeof input === 'object' && !Array.isArray(input) && ('file' in input || 'src' in input || 'id' in input)) {
      normalizeUploadLikeItem(input as UploadFileItem);
      return;
    }

    const remaining = typeof maxFiles === 'number' ? Math.max(0, maxFiles - results.length) : undefined;
    const items = normalizeMediaInput(input, remaining);
    for (const item of items) {
      const normalizedId = item.id || undefined;
      switch (item.source.type) {
        case 'file':
          pushResult({
            id: normalizedId,
            file: item.source.file as File,
            src: undefined,
          });
          break;
        case 'url':
          pushResult({
            id: normalizedId,
            file: undefined,
            src: item.source.url,
          });
          break;
      }
    }
  };

  process(value);
  return results;
};
