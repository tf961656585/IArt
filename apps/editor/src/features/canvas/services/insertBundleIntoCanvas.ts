import type { GraphNode, NodePosition } from '../types';
import { importNodeGraphFromBundle } from '../export/importBundle';
import { useCanvasStore } from '../store/canvasStore';
import { createAbortError, type BundleImportProgressCallback } from '../export/bundleTypes';
import { buildClipboardPayloadFromNodeGraphSnippet } from './snippetTransfer';
import {
  applyImportedAssetIdMapToNodeGraph,
  normalizeProjectMediaAssets,
} from './projectMediaAssets';
import { getCurrentProjectPath, importBundleRuntimeAssets } from '../storage';

export async function insertBundleIntoCanvas(params: {
  file: File;
  targetPosition: NodePosition | undefined;
  onProgress: BundleImportProgressCallback | undefined;
  signal: AbortSignal | undefined;
}): Promise<{ insertedNodes: GraphNode[]; warnings: string[] }> {
  const ensureNotAborted = (currentSignal: AbortSignal | undefined) => {
    if ((currentSignal !== null && currentSignal !== undefined ? currentSignal.aborted : undefined)) {
      throw createAbortError();
    }
  };

  const result = await importNodeGraphFromBundle(params.file, {
    onProgress: params.onProgress,
    signal: params.signal,
  });
  if (!result.valid || !result.nodeGraph) {
    throw new Error(result.errors[0] ?? '导入失败');
  }

  ensureNotAborted(params.signal);

  const state = useCanvasStore.getState();
  let remappedImport = {
    nodeGraph: result.nodeGraph,
    mediaAssets: normalizeProjectMediaAssets(result.mediaAssets ?? {}),
  };
  const projectPath = await getCurrentProjectPath();
  if (projectPath && Object.keys(remappedImport.mediaAssets).length > 0) {
    const imported = await importBundleRuntimeAssets(projectPath, remappedImport.mediaAssets);
    remappedImport = {
      nodeGraph: applyImportedAssetIdMapToNodeGraph(remappedImport.nodeGraph, imported.assetIdMap ?? {}),
      mediaAssets: normalizeProjectMediaAssets(imported.mediaAssetsPatch ?? {}),
    };
    if (Object.keys(imported.mediaAssetsPatch ?? {}).length > 0) {
      state.setProjectMediaAssets(
        normalizeProjectMediaAssets(imported.mediaAssetsPatch),
        { source: 'user-action' },
      );
    }
  }

  ensureNotAborted(params.signal);

  const payload = buildClipboardPayloadFromNodeGraphSnippet({ nodeGraph: remappedImport.nodeGraph });

  // 降级注释与 bundle 显式 annotations 不进剪贴板 payload（注释是画布级实体，spec：
  // 画布注释.md「注释不随选区片段导出与导入」；导入边界的降级产物由插入方直接写入 store，
  // 这是导入 canonicalization 的一部分，与片段格式排除口径不冲突）。
  const bundleAnnotations = remappedImport.nodeGraph.annotations ?? [];
  if (payload.nodes.length === 0 && bundleAnnotations.length === 0) {
    throw new Error('这个文件里没有可导入的内容');
  }

  ensureNotAborted(params.signal);

  // pasteClipboardPayload 会落 1 条历史；注释批量单独落 1 条历史（若 paste 与注释同时发生，
  // 用户撤销需要分两步回退——但 paste 内部对 nodes/edges 已是单条历史，注释作为画布级
  // 实体单独成条符合「注释变更独立入栈」的撤销口径）。
  const pasteStore = useCanvasStore.getState();
  const inserted =
    payload.nodes.length > 0
      ? pasteStore.pasteClipboardPayload(payload, params.targetPosition)
      : { nodes: [] as GraphNode[], edges: [] };

  if (bundleAnnotations.length > 0) {
    useCanvasStore.getState().insertAnnotationsBatch(bundleAnnotations, {
      // 注释位置沿用原画布坐标；仅当指定 targetPosition 时整体偏移到目标点附近
      offset: params.targetPosition ?? undefined,
      saveHistory: payload.nodes.length === 0,
    });
  }

  return { insertedNodes: inserted.nodes, warnings: result.warnings };
}
