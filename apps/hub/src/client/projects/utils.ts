import type { SelectFolderResult, OpenEditorWindowResult } from '@iart/backend-sdk';

/**
 * projects 域纯函数工具。
 *
 * 从 vanilla 侧 controller-helpers 复制而来（projects-controller-files.ts /
 * projects-controller-open-result.ts），供 React 迁移侧复用；原文件保持不变。
 */

export function getElectronFilePath(file: File): string {
  try {
    if (typeof window !== 'undefined' && window.electron && typeof window.electron.getPathForFile === 'function') {
      return window.electron.getPathForFile(file) || '';
    }
  } catch {
    return '';
  }

  return '';
}

export function formatSelectFolderFailure(result: SelectFolderResult | null | undefined, fallbackMessage: string | undefined): string {
  if (!result || typeof result !== 'object') {
    return fallbackMessage || '没能选择文件夹，请重试';
  }

  if (typeof result.userMessage === 'string' && result.userMessage.trim()) {
    return result.userMessage.trim();
  }

  if (result.errorCode === 'window_unavailable') return '当前窗口已关闭，请重新打开后重试';
  if (result.errorCode === 'dialog_open_failed') return '没能打开文件夹选择窗口，请重试';
  if (result.errorCode === 'environment_unavailable') return '请在桌面应用中选择保存位置';

  return fallbackMessage || '没能选择文件夹，请重试';
}

export function safeFileName(value: string): string {
  const normalized: string = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_一-龥]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'canvas';
}

export function inferNameFromFile(file: File | null | undefined): string {
  if (!file || !file.name) return '';
  return file.name.replace(/.iarts.zip$/i, '').replace(/.iarts$/i, '').trim();
}

export function parseDownloadFileName(contentDisposition: string | null | undefined): string {
  if (!contentDisposition) return '';

  const utf8Match: RegExpExecArray | null = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const match: RegExpExecArray | null = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return match && match[1] ? match[1] : '';
}

export function downloadBlobFile(fileName: string, blob: Blob): void {
  const url: string = URL.createObjectURL(blob);
  const link: HTMLAnchorElement = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 0);
}

export function createBlankNodeGraph(name: string): Record<string, unknown> {
  const now: string = new Date().toISOString();
  const id: string = 'ng_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

  return {
    id,
    name,
    status: 'draft',
    nodes: [],
    edges: [],
    groups: [],
    variables: [],
    settings: {
      autoSave: true,
      executionTimeout: 0,
      maxConcurrentNodes: 3,
      continueOnFailure: false,
      enableLogging: true,
      snapToGrid: false,
      snapGrid: [15, 15],
    },
    viewport: { zoom: 1, x: 0, y: 0 },
    meta: {
      version: '1.0.0',
      createdAt: now,
      updatedAt: now,
      tags: [],
    },
  };
}

export const getOpenEditorWindowFailureStatus = (
  result: OpenEditorWindowResult,
  fallback: string,
): string => {
  if (result.ok) return '';
  if (result.code === 'invalid-project-folder') {
    return '项目目录无效，请重新选择';
  }
  return fallback;
};
