import { toast } from 'sonner';

import { revealFilesUrl, type RevealFilesUrlResult } from './electronBridge';

export type RevealFilesUrlWithToastOptions = {
  projectPath: string | null | undefined;
};

const getRevealFilesUrlToastMessage = (result: RevealFilesUrlResult): { level: 'success' | 'warning' | 'error'; message: string } => {
  if (result.ok) {
    return { level: 'success', message: '已打开文件所在位置' };
  }

  switch (result.reason) {
    case 'not-found':
      return { level: 'error', message: '没有找到这个文件（已打开媒体目录）' };
    case 'missing-project-path':
      return { level: 'error', message: '还没有打开项目，无法定位文件。' };
    case 'not-files-url':
      return { level: 'warning', message: '这个地址无法识别。' };
    case 'missing-url':
      return { level: 'warning', message: '这个文件还没有保存下来，找不到它的位置。' };
    case 'invalid-file-key':
      return { level: 'warning', message: '这个文件的标识无效。' };
    case 'unsafe-file-key':
      return { level: 'warning', message: '这个文件的位置不在项目允许的范围内，已停止打开。' };
    case 'path-outside-media':
      return { level: 'warning', message: '这个文件不在项目的媒体目录里，无法打开。' };
    case 'not-in-electron':
      return { level: 'warning', message: '当前环境无法打开文件所在位置。' };
    default:
      return { level: 'error', message: '没能打开文件所在位置，请重试。' };
  }
};

export const revealFilesUrlWithToast = async (
  url: string,
  options: RevealFilesUrlWithToastOptions | undefined = undefined
): Promise<RevealFilesUrlResult> => {
  const result = await revealFilesUrl(url, (options !== null && options !== undefined ? options.projectPath : undefined) ?? null);
  const toastInfo = getRevealFilesUrlToastMessage(result);

  if (toastInfo.level === 'success') {
    toast.success(toastInfo.message);
    return result;
  }
  if (toastInfo.level === 'warning') {
    toast.warning(toastInfo.message);
    return result;
  }

  toast.error(toastInfo.message);
  return result;
};
