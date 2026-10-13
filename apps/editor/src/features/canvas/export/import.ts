import type { ImportValidationResult } from './types';
import { importNodeGraphFromBundle, isBundleFile } from './importBundle';

/**
 * 从文件导入 NodeGraph
 * 仅支持 Bundle 格式（.iarts）
 */
export const importNodeGraphFromFile = async (
  file: File
): Promise<ImportValidationResult> => {
  // 检测文件类型
  if (!isBundleFile(file)) {
    return {
      valid: false,
      errors: ['不支持的文件格式，请使用 .iarts 格式文件'],
      warnings: [],
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  // Bundle 格式：使用专门的导入逻辑
  const result = await importNodeGraphFromBundle(file, {
    onProgress: undefined,
    signal: undefined,
  });
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    nodeGraph: result.nodeGraph,
    mediaAssets: result.mediaAssets,
  };
};
