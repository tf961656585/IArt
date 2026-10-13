import {
  ClipboardWriteTextResponseSchema,
  ClipboardWriteImageResponseSchema,
  type ClipboardWriteTextResponse,
  type ClipboardWriteImageResponse,
} from '@iart/contracts';
import type { ElectronBridge } from './types';

const isString = (value: unknown): value is string => typeof value === 'string';

const getBrowserElectronBridge = (): ElectronBridge | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.electron ?? null;
};

/**
 * 把文本写入系统剪贴板。
 *
 * 失败语义：
 * - not-in-browser / not-in-electron：运行环境不支持
 * - empty-text：空文本
 * - invoke-failed：IPC 调用抛错或响应无法被 schema 校验
 *
 * 主进程已对响应做 .parse()，这里再用 safeParse() 兜底防御主进程畸形数据（双边界校验）。
 */
export const writeTextToClipboard = async (
  text: string,
): Promise<ClipboardWriteTextResponse> => {
  const api = getBrowserElectronBridge();
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'not-in-browser' };
  }
  if (api === null || typeof api.writeTextToClipboard !== 'function') {
    return { ok: false, reason: 'not-in-electron' };
  }

  const trimmedText = isString(text) ? text.trim() : '';
  if (!trimmedText) {
    return { ok: false, reason: 'empty-text' };
  }

  try {
    const result = await api.writeTextToClipboard(trimmedText);
    const parsed = ClipboardWriteTextResponseSchema.safeParse(result);
    if (parsed.success) {
      return parsed.data;
    }
    console.warn('writeTextToClipboard: invalid response from main', {
      error: parsed.error.message,
      result,
    });
    return { ok: false, reason: 'invoke-failed' };
  } catch (error) {
    console.warn('writeTextToClipboard: failed to write text', error);
    return { ok: false, reason: 'invoke-failed' };
  }
};

/**
 * 把 local-media:// URL 指向的图像写入系统剪贴板。
 *
 * 失败语义：
 * - not-in-browser / not-in-electron：运行环境不支持
 * - missing-url：url 为空
 * - invoke-failed：IPC 调用抛错或响应无法被 schema 校验
 * - 其它 reason（missing-project-path / not-files-url / unsafe-file-key / not-found / read-failed 等）来自主进程
 *
 * 主进程已对响应做 .parse()，这里再用 safeParse() 兜底防御主进程畸形数据。
 */
export const writeImageFromUrlToClipboard = async (
  url: string,
  projectPath: string | null,
): Promise<ClipboardWriteImageResponse> => {
  const api = getBrowserElectronBridge();
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'not-in-browser' };
  }
  if (api === null || typeof api.writeImageFromUrlToClipboard !== 'function') {
    return { ok: false, reason: 'not-in-electron' };
  }

  const trimmedUrl = isString(url) ? url.trim() : '';
  if (!trimmedUrl) {
    return { ok: false, reason: 'missing-url' };
  }

  try {
    const result = await api.writeImageFromUrlToClipboard(
      trimmedUrl,
      projectPath ?? null,
    );
    const parsed = ClipboardWriteImageResponseSchema.safeParse(result);
    if (parsed.success) {
      return parsed.data;
    }
    console.warn('writeImageFromUrlToClipboard: invalid response from main', {
      error: parsed.error.message,
      result,
    });
    return { ok: false, reason: 'invoke-failed' };
  } catch (error) {
    console.warn('writeImageFromUrlToClipboard: failed to write image', error);
    return { ok: false, reason: 'invoke-failed' };
  }
};
