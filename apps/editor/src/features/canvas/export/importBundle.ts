/**
 * Bundle 导入模块
 * - 从 .iarts ZIP 打包格式导入 NodeGraph
 * - 自动将媒体存入本地磁盘
 */

import JSZip from 'jszip';
import { generateNodeGraphId } from '../types/nodeGraph';
import {
  findMissingReferencedProjectMediaAssetIds,
  hydrateNodeGraphResultAreaItems,
  normalizeProjectMediaAssets,
  sanitizeNodeGraphResultAreaItemsForPersistence,
} from '../services/projectMediaAssets';
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_PATHS,
  createAbortError,
  type BundleManifest,
  type BundleImportOptions,
  type BundleImportResult,
  type BundleProjectDocument,
} from './bundleTypes';
import { validateImportPayload } from './validation';
import { getBundleAssetHandlers } from './bundleHandlers';
import { stripNodeRuntimeProjectionForPersistence } from '../utils/nodeRuntimeProjectionStrip';
import { getResolvedExpandInlineParamsOnStartup } from '@/client/utils/hubCanvasStartupConfig';
import { isUnknownRecord, type UnknownRecord } from '@/client/utils/typeGuards';

type RawProjectDocument = UnknownRecord & {
  mediaAssets: unknown | undefined;
  nodeGraph: unknown | undefined;
};

/**
 * 校验 Bundle 清单
 */
function validateManifest(
  manifest: unknown,
  errors: string[],
  warnings: string[]
): manifest is BundleManifest {
  if (!manifest || typeof manifest !== 'object') {
    errors.push('文件格式不合法或已损坏');
    return false;
  }

  const m = manifest as Partial<BundleManifest>;

  if (m.format !== 'iarts-bundle') {
    errors.push('文件格式不合法或已损坏');
    return false;
  }

  if (typeof m.version !== 'number') {
    errors.push('文件格式不合法或已损坏');
    return false;
  }

  if (m.version > BUNDLE_FORMAT_VERSION) {
    warnings.push(
      `文件版本高于当前应用支持版本，可能存在兼容性问题`
    );
  }

  if (!m.mediaManifest || typeof m.mediaManifest !== 'object') {
    errors.push('文件格式不合法或已损坏');
    return false;
  }

  if ('filesManifest' in m && m.filesManifest !== undefined && (typeof m.filesManifest !== 'object' || !m.filesManifest)) {
    errors.push('文件格式不合法或已损坏');
    return false;
  }

  return true;
}

/**
 * 从 Bundle 文件导入项目文档
 */
export async function importNodeGraphFromBundle(
  file: File,
  options: BundleImportOptions | undefined
): Promise<BundleImportResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const onProgress = (options !== null && options !== undefined ? options.onProgress : undefined);
  const signal = (options !== null && options !== undefined ? options.signal : undefined);
  const ensureNotAborted = (currentSignal: AbortSignal | undefined) => {
    if ((currentSignal !== null && currentSignal !== undefined ? currentSignal.aborted : undefined)) {
      throw createAbortError();
    }
  };

  ensureNotAborted(signal);
  if (onProgress) {
    onProgress({ stage: 'zip', messageKey: 'bundle.import.zip', processed: undefined, total: undefined, percent: undefined });
  }

  // 1. 解析 ZIP 文件
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (error) {
    console.warn('[bundle-import] parse zip failed', error);
    return {
      valid: false,
      errors: ['文件格式不合法或已损坏'],
      warnings: [],
      nodeGraph: undefined,
      mediaAssets: undefined,
      manifest: undefined,
    };
  }

  ensureNotAborted(signal);

  // 2. 读取并校验 manifest.json
  if (onProgress) {
    onProgress({ stage: 'manifest', messageKey: 'bundle.import.manifest', processed: undefined, total: undefined, percent: undefined });
  }
  const manifestFile = zip.file(BUNDLE_PATHS.MANIFEST);
  if (!manifestFile) {
    return {
      valid: false,
      errors: ['文件格式不合法或已损坏'],
      warnings: [],
      nodeGraph: undefined,
      mediaAssets: undefined,
      manifest: undefined,
    };
  }

  let manifest: BundleManifest;
  try {
    const manifestText = await manifestFile.async('text');
    ensureNotAborted(signal);
    const parsed: unknown = JSON.parse(manifestText);
    if (!validateManifest(parsed, errors, warnings)) {
      return { valid: false, errors, warnings, nodeGraph: undefined, mediaAssets: undefined, manifest: undefined };
    }
    manifest = parsed;
  } catch (error) {
    console.warn('[bundle-import] parse manifest failed', error);
    return {
      valid: false,
      errors: ['文件格式不合法或已损坏'],
      warnings: [],
      nodeGraph: undefined,
      mediaAssets: undefined,
      manifest: undefined,
    };
  }

  // 3. 读取 project.json
  ensureNotAborted(signal);
  if (onProgress) {
    onProgress({ stage: 'project', messageKey: 'bundle.import.nodeGraph', processed: undefined, total: undefined, percent: undefined });
  }
  const projectFile = zip.file(BUNDLE_PATHS.PROJECT);
  if (!projectFile) {
    return {
      valid: false,
      errors: ['文件格式不合法或已损坏'],
      warnings: [],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  let rawProjectDocument: RawProjectDocument | null = null;
  try {
    const projectText = await projectFile.async('text');
    ensureNotAborted(signal);
    const parsedProject: unknown = JSON.parse(projectText);
    if (!isUnknownRecord(parsedProject)) {
      return {
        valid: false,
        errors: ['文件格式不合法或已损坏'],
        warnings: [],
        manifest,
        nodeGraph: undefined,
        mediaAssets: undefined,
      };
    }
    rawProjectDocument = parsedProject as RawProjectDocument;
  } catch (error) {
    console.warn('[bundle-import] parse project failed', error);
    return {
      valid: false,
      errors: ['文件格式不合法或已损坏'],
      warnings: [],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  if (zip.file('nodeGraph.json')) {
    return {
      valid: false,
      errors: ['这个文件来自较旧版本，请用新版重新导出后再导入'],
      warnings,
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  // 4. 使用现有校验逻辑
  ensureNotAborted(signal);
  if (onProgress) {
    onProgress({ stage: 'validate', messageKey: 'bundle.import.validate', processed: undefined, total: undefined, percent: undefined });
  }
  let expandInlineParamsOnStartup: boolean;
  try {
    expandInlineParamsOnStartup = await getResolvedExpandInlineParamsOnStartup(undefined);
  } catch (error) {
    console.warn('[bundle-import] read startup config failed', error);
    return {
      valid: false,
      errors: ['读取导入设置失败，请重新打开项目后再试'],
      warnings,
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }
  const projectDocumentForValidation: { nodeGraph: unknown | undefined } = {
    nodeGraph: (rawProjectDocument !== null && rawProjectDocument !== undefined ? rawProjectDocument.nodeGraph : undefined),
  };
  const validation = validateImportPayload(
    projectDocumentForValidation,
    { modelInlineControlsCollapsedDefault: !expandInlineParamsOnStartup },
  );
  if (!validation.valid || !validation.nodeGraph) {
    return {
      valid: false,
      errors: [...errors, ...validation.errors],
      warnings: [...warnings, ...validation.warnings],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  // 5. 生成新的 NodeGraph ID
  const nodeGraphId = generateNodeGraphId();
  let projectDocument: BundleProjectDocument;
  try {
    projectDocument = {
      mediaAssets: normalizeProjectMediaAssets((rawProjectDocument !== null && rawProjectDocument !== undefined ? rawProjectDocument.mediaAssets : undefined)),
      nodeGraph: {
        ...validation.nodeGraph,
        id: nodeGraphId,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return {
      valid: false,
      errors: [message],
      warnings: [...warnings, ...validation.warnings],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  // 6. 通过 handlers 导入资源并更新引用
  for (const handler of getBundleAssetHandlers()) {
    ensureNotAborted(signal);
    const next = handler.import
      ? await handler.import({
          zip,
          nodeGraphId,
          projectDocument,
          manifest,
          errors,
          warnings,
          onProgress,
          signal,
        })
      : undefined;
    if (next) {
      projectDocument = next;
    }
  }

  // 7. 如果有致命错误，返回失败
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings: [...warnings, ...validation.warnings],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  let normalizedMediaAssets: ReturnType<typeof normalizeProjectMediaAssets>;
  try {
    normalizedMediaAssets = normalizeProjectMediaAssets(projectDocument.mediaAssets);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return {
      valid: false,
      errors: [message],
      warnings: [...warnings, ...validation.warnings],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }
  const missingAssetIds = findMissingReferencedProjectMediaAssetIds(
    projectDocument.nodeGraph,
    normalizedMediaAssets,
  );
  if (missingAssetIds.length > 0) {
    return {
      valid: false,
      errors: [
        `文件里缺少生成结果的素材：${missingAssetIds.join(', ')}`,
      ],
      warnings: [...warnings, ...validation.warnings],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }
  let sanitizedNodeGraph;
  try {
    const resultAreaSanitized = sanitizeNodeGraphResultAreaItemsForPersistence(
      projectDocument.nodeGraph,
      normalizedMediaAssets,
    );
    // 剥离异步生命周期节点（model/input 类）的 taskInfo 运行态投影，
    // 与 SQLite delta、导出 bundle 保持同口径。依据见
    // docs/runtime/模型节点内嵌结果区正式内容与运行时状态边界.md
    // 「异步生命周期节点的 taskInfo 持久化边界」段。
    sanitizedNodeGraph = {
      ...resultAreaSanitized,
      nodes: resultAreaSanitized.nodes.map(stripNodeRuntimeProjectionForPersistence),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return {
      valid: false,
      errors: [message],
      warnings: [...warnings, ...validation.warnings],
      manifest,
      nodeGraph: undefined,
      mediaAssets: undefined,
    };
  }

  return {
    valid: true,
    errors: [],
    warnings: [...warnings, ...validation.warnings],
    nodeGraph: hydrateNodeGraphResultAreaItems(sanitizedNodeGraph, normalizedMediaAssets),
    mediaAssets: normalizedMediaAssets,
    manifest,
  };
}

/**
 * 检测文件是否为 Bundle 格式
 */
export function isBundleFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.iarts') || name.endsWith('.iarts.zip');
}
