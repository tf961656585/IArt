import {
  ClipboardWriteTextResponseSchema,
  type ClipboardWriteTextResponse,
} from '@iart/contracts';

type WriteTextClipboardParams = {
  text: string | null | undefined;
  clipboard: {
    writeText: (text: string) => void;
  } | null | undefined;
};

const normalizeString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/**
 * 把文本写入系统剪贴板。
 *
 * 安全校验：空文本返回 empty-text，不调 clipboard.writeText。
 * 返回值在返回前用 ClipboardWriteTextResponseSchema.parse() 校验，确保跨进程响应合规。
 */
export const writeTextClipboard = ({
  text,
  clipboard,
}: WriteTextClipboardParams): ClipboardWriteTextResponse => {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return ClipboardWriteTextResponseSchema.parse({
      ok: false,
      reason: 'empty-text',
    });
  }

  if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== 'function') {
    return ClipboardWriteTextResponseSchema.parse({
      ok: false,
      reason: 'write-failed',
    });
  }

  try {
    clipboard.writeText(normalizedText);
    return ClipboardWriteTextResponseSchema.parse({ ok: true });
  } catch {
    return ClipboardWriteTextResponseSchema.parse({
      ok: false,
      reason: 'write-failed',
    });
  }
};
